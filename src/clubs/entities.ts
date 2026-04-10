/**
 * Clubs domain — entity CRUD (posts, asks, gifts, opportunities, services).
 *
 * This module implements the internal entity model behind the public `content.*`
 * API. Events share the same entity/version backbone but are handled separately
 * in `clubs/events.ts` because they carry event-specific fields and RSVP logic.
 */

import type { Pool } from 'pg';
import type { CreateEntityInput, EntitySummary, ListEntitiesInput, SetEntityLoopInput, UpdateEntityInput } from '../contract.ts';
import { AppError } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor, decodeCursor } from '../schemas/fields.ts';

// ── clientKey comparison helpers ──────────────────────────

/** Compare two timestamps that may come from different formats (ISO input vs Postgres text output). */
export function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const aN = a ?? null;
  const bN = b ?? null;
  if (aN === null && bN === null) return true;
  if (aN === null || bN === null) return false;
  const aMs = new Date(aN).getTime();
  const bMs = new Date(bN).getTime();
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return aN === bN;
  return aMs === bMs;
}

/** Key-order-independent JSON comparison. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

type EntityRow = {
  entity_id: string;
  entity_version_id: string;
  club_id: string;
  kind: EntitySummary['kind'];
  open_loop: boolean | null;
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  version_no: number;
  state: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  effective_at: string;
  expires_at: string | null;
  version_created_at: string;
  content: Record<string, unknown> | null;
  entity_created_at: string;
};

function mapEntityRow(row: EntityRow): EntitySummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    kind: row.kind,
    openLoop: row.open_loop,
    author: { memberId: row.author_member_id, publicName: row.author_public_name, handle: row.author_handle },
    version: {
      versionNo: row.version_no,
      state: row.state as EntitySummary['version']['state'],
      title: row.title,
      summary: row.summary,
      body: row.body,
      effectiveAt: row.effective_at,
      expiresAt: row.expires_at,
      createdAt: row.version_created_at,
      content: row.content ?? {},
    },
    createdAt: row.entity_created_at,
  };
}

const ENTITY_SELECT = `
  e.id as entity_id, cev.id as entity_version_id, e.club_id, e.kind, e.open_loop,
  e.author_member_id, m.public_name as author_public_name, m.handle as author_handle,
  cev.version_no, cev.state,
  cev.title, cev.summary, cev.body,
  cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
  cev.created_at::text as version_created_at, cev.content,
  e.created_at::text as entity_created_at
`;

function initialOpenLoopForKind(kind: CreateEntityInput['kind']): boolean | null {
  return kind === 'ask' || kind === 'gift' || kind === 'service' || kind === 'opportunity'
    ? true
    : null;
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES['entity'];
  await client.query(
    `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('entity_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

export async function readEntitySummary(client: DbClient, entityId: string, entityVersionId?: string): Promise<EntitySummary | null> {
  const result = await client.query<EntityRow>(
    `select ${ENTITY_SELECT}
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     join members m on m.id = e.author_member_id
     where e.id = $1 and e.deleted_at is null
       and ($2::text is null or cev.id = $2)`,
    [entityId, entityVersionId ?? null],
  );
  return result.rows[0] ? mapEntityRow(result.rows[0]) : null;
}

export async function createEntity(pool: Pool, input: CreateEntityInput): Promise<EntitySummary> {
  return withTransaction(pool, async (client) => {
    // Idempotent if clientKey provided — return existing entity on duplicate
    let entityId: string;
    if (input.clientKey) {
      const existing = await client.query<{
        id: string; club_id: string; kind: string;
        title: string | null; summary: string | null; body: string | null;
        expires_at: string | null; content: Record<string, unknown> | null;
      }>(
        `select e.id, e.club_id, e.kind::text as kind,
                cev.title, cev.summary, cev.body, cev.expires_at::text as expires_at, cev.content
         from entities e
         join current_entity_versions cev on cev.entity_id = e.id
         where e.author_member_id = $1 and e.client_key = $2`,
        [input.authorMemberId, input.clientKey],
      );
      if (existing.rows[0]) {
        const orig = existing.rows[0];
        // Strict idempotency: same key + different payload → 409
        if (
          orig.club_id !== input.clubId
          || orig.kind !== input.kind
          || orig.title !== (input.title ?? null)
          || orig.summary !== (input.summary ?? null)
          || orig.body !== (input.body ?? null)
          || !timestampsEqual(orig.expires_at, input.expiresAt)
          || !jsonEqual(orig.content ?? {}, input.content ?? {})
        ) {
          throw new AppError(409, 'client_key_conflict',
            'This clientKey was already used with a different payload. Use a unique key per entity.');
        }
        const summary = await readEntitySummary(client, orig.id);
        if (summary) return summary;
      }
    }
    const entityResult = await client.query<{ id: string; created_at: string }>(
      `insert into entities (club_id, kind, author_member_id, open_loop, client_key) values ($1, $2, $3, $4, $5)
       returning id, created_at::text as created_at`,
      [input.clubId, input.kind, input.authorMemberId, initialOpenLoopForKind(input.kind), input.clientKey ?? null],
    );
    const entity = entityResult.rows[0];
    if (!entity) throw new AppError(500, 'missing_row', 'Created entity row was not returned');
    entityId = entity.id;

    const versionResult = await client.query<{ id: string }>(
      `insert into entity_versions (entity_id, version_no, state, title, summary, body, expires_at, content, created_by_member_id)
       values ($1, 1, 'published', $2, $3, $4, $5, $6::jsonb, $7)
       returning id`,
      [entity.id, input.title, input.summary, input.body, input.expiresAt, JSON.stringify(input.content), input.authorMemberId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new AppError(500, 'missing_row', 'Created entity version row was not returned');

    const summary = await readEntitySummary(client, entity.id, version.id);
    if (!summary) throw new AppError(500, 'missing_row', 'Created entity could not be reloaded');

    // Club activity
    await appendClubActivity(client, {
      clubId: summary.clubId,
      entityId: summary.entityId,
      entityVersionId: summary.entityVersionId,
      topic: 'entity.version.published',
      createdByMemberId: input.authorMemberId,
    });

    await enqueueEmbeddingJob(client, version.id);
    return summary;
  });
}

export async function updateEntity(pool: Pool, input: UpdateEntityInput): Promise<EntitySummary | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      entity_id: string; club_id: string; author_member_id: string;
      version_id: string; version_no: number;
      title: string | null; summary: string | null; body: string | null;
      expires_at: string | null; content: Record<string, unknown> | null;
    }>(
      `select e.id as entity_id, e.club_id, e.author_member_id,
              cev.id as version_id, cev.version_no,
              cev.title, cev.summary, cev.body, cev.expires_at::text as expires_at, cev.content
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[]) and e.author_member_id = $3
         and e.deleted_at is null and cev.state = 'published'`,
      [input.entityId, input.accessibleClubIds, input.actorMemberId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    const nextVersionResult = await client.query<{ id: string }>(
      `insert into entity_versions (entity_id, version_no, state, title, summary, body, expires_at, content, supersedes_version_id, created_by_member_id)
       values ($1, $2, 'published', $3, $4, $5, $6, $7::jsonb, $8, $9) returning id`,
      [
        current.entity_id, current.version_no + 1,
        input.patch.title !== undefined ? input.patch.title : current.title,
        input.patch.summary !== undefined ? input.patch.summary : current.summary,
        input.patch.body !== undefined ? input.patch.body : current.body,
        input.patch.expiresAt !== undefined ? input.patch.expiresAt : current.expires_at,
        JSON.stringify(input.patch.content !== undefined ? input.patch.content : current.content ?? {}),
        current.version_id, input.actorMemberId,
      ],
    );
    const nextVersion = nextVersionResult.rows[0];
    if (!nextVersion) throw new AppError(500, 'missing_row', 'Updated entity version row was not returned');

    const summary = await readEntitySummary(client, current.entity_id, nextVersion.id);
    if (!summary) throw new AppError(500, 'missing_row', 'Updated entity could not be reloaded');

    await appendClubActivity(client, {
      clubId: summary.clubId,
      entityId: summary.entityId,
      entityVersionId: summary.entityVersionId,
      topic: 'entity.version.published',
      createdByMemberId: input.actorMemberId,
    });

    await enqueueEmbeddingJob(client, nextVersion.id);
    return summary;
  });
}

export async function removeEntity(pool: Pool, input: {
  entityId: string; clubIds: string[]; actorMemberId: string; reason?: string | null;
  skipAuthCheck?: boolean; kindFilter?: string;
}): Promise<EntitySummary | null> {
  return withTransaction(pool, async (client) => {
    // Check if already removed — idempotent return
    const alreadyRemoved = await client.query<EntityRow>(
      `select ${ENTITY_SELECT}
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       join members m on m.id = e.author_member_id
       where e.id = $1 and e.club_id = any($2::text[])
         and e.deleted_at is null and cev.state = 'removed'`,
      [input.entityId, input.clubIds],
    );
    if (alreadyRemoved.rows[0]) {
      // Auth check even on already-removed entities (existence-hiding)
      if (!input.skipAuthCheck && alreadyRemoved.rows[0].author_member_id !== input.actorMemberId) {
        return null;
      }
      return mapEntityRow(alreadyRemoved.rows[0]);
    }

    const kindClause = input.kindFilter ? `and e.kind = '${input.kindFilter}'` : `and e.kind <> 'event'`;
    const currentResult = await client.query<{
      entity_id: string; club_id: string; author_member_id: string;
      version_id: string; version_no: number;
    }>(
      `select e.id as entity_id, e.club_id, e.author_member_id,
              cev.id as version_id, cev.version_no
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[])
         and e.deleted_at is null and cev.state = 'published'
         ${kindClause}`,
      [input.entityId, input.clubIds],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
      return null; // existence-hiding: matches entities.update behavior
    }

    const removeVersion = await client.query<{ id: string }>(
      `insert into entity_versions (entity_id, version_no, state, reason, supersedes_version_id, created_by_member_id)
       values ($1, $2, 'removed', $3, $4, $5) returning id`,
      [current.entity_id, current.version_no + 1, input.reason ?? null, current.version_id, input.actorMemberId],
    );

    // Emit removal activity
    if (removeVersion.rows[0]) {
      await appendClubActivity(client, {
        clubId: current.club_id,
        entityId: current.entity_id,
        entityVersionId: removeVersion.rows[0].id,
        topic: 'entity.removed',
        createdByMemberId: input.actorMemberId,
      });
    }

    return readEntitySummary(client, current.entity_id);
  });
}

async function setEntityLoopState(
  pool: Pool,
  input: SetEntityLoopInput,
  nextOpenLoop: boolean,
): Promise<EntitySummary | null> {
  return withTransaction(pool, async (client) => {
    const updateResult = await client.query<{ entity_id: string }>(
      `update entities e
       set open_loop = $4
       from current_entity_versions cev
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.author_member_id = $3
         and e.deleted_at is null
         and e.open_loop is not null
         and cev.entity_id = e.id
         and cev.state = 'published'
       returning e.id as entity_id`,
      [input.entityId, input.accessibleClubIds, input.actorMemberId, nextOpenLoop],
    );

    const entityId = updateResult.rows[0]?.entity_id;
    if (!entityId) return null;

    if (nextOpenLoop) {
      await client.query(
        `delete from signal_background_matches
         where source_id = $1
           and match_kind in ('ask_to_member', 'offer_to_ask')`,
        [entityId],
      );
    } else {
      await client.query(
        `update signal_background_matches
         set state = 'expired'
         where source_id = $1 and state = 'pending'
           and match_kind in ('ask_to_member', 'offer_to_ask')`,
        [entityId],
      );
    }

    return readEntitySummary(client, entityId);
  });
}

export async function closeEntityLoop(pool: Pool, input: SetEntityLoopInput): Promise<EntitySummary | null> {
  return setEntityLoopState(pool, input, false);
}

export async function reopenEntityLoop(pool: Pool, input: SetEntityLoopInput): Promise<EntitySummary | null> {
  return setEntityLoopState(pool, input, true);
}

export type PaginatedEntities = { results: EntitySummary[]; hasMore: boolean; nextCursor: string | null };

export async function listEntities(pool: Pool, input: ListEntitiesInput & {
  rawCursor?: string | null;
}): Promise<PaginatedEntities> {
  if (input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null };

  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
  const prefixPattern = trimmedQuery ? `${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
  const fetchLimit = input.limit + 1;
  const isQueryMode = !!trimmedQuery;

  // Decode cursor: query mode uses 3-part (score, effective_at, entity_id),
  // chronological mode uses 2-part (effective_at, entity_id).
  let cursorScore: number | null = null;
  let cursorEffectiveAt: string | null = null;
  let cursorEntityId: string | null = null;

  if (input.rawCursor) {
    if (isQueryMode) {
      const [score, effectiveAt, entityId] = decodeCursor(input.rawCursor, 3);
      cursorScore = Number(score);
      cursorEffectiveAt = effectiveAt;
      cursorEntityId = entityId;
    } else {
      const [effectiveAt, entityId] = decodeCursor(input.rawCursor, 2);
      cursorEffectiveAt = effectiveAt;
      cursorEntityId = entityId;
    }
  }

  const result = await pool.query<EntityRow & { _relevance_score: number }>(
    `with scope as (select unnest($1::text[]) as club_id)
     select ${ENTITY_SELECT},
       case
         when $3::text is null then 0
         when lower(coalesce(le.title, '')) = lower($3::text) then 400
         when lower(coalesce(le.title, '')) like lower($5::text) escape '\\' then 250
         when lower(coalesce(le.summary, '')) like lower($5::text) escape '\\' then 175
         when lower(coalesce(le.body, '')) like lower($5::text) escape '\\' then 120
         when coalesce(le.title, '') ilike $4 escape '\\' then 90
         when coalesce(le.summary, '') ilike $4 escape '\\' then 60
         when coalesce(le.body, '') ilike $4 escape '\\' then 30
         else 0
       end as _relevance_score
     from scope s
     join live_entities le on le.club_id = s.club_id::short_id
     join entities e on e.id = le.entity_id
     join current_entity_versions cev on cev.id = le.entity_version_id
     join members m on m.id = e.author_member_id
     where le.kind = any($2::entity_kind[])
       and (
         le.open_loop is null
         or le.open_loop = true
         or ($10::text is not null and e.author_member_id = $10 and $11::boolean)
       )
       and ($4::text is null
         or coalesce(le.title, '') ilike $4 escape '\\'
         or coalesce(le.summary, '') ilike $4 escape '\\'
         or coalesce(le.body, '') ilike $4 escape '\\')
       -- Chronological cursor: only applied when NOT in query-mode cursor ($9 is null)
       and ($9::int is not null or $7::timestamptz is null
         or le.effective_at < $7
         or (le.effective_at = $7 and le.entity_id < $8))
       -- Query-mode cursor: 3-part (score, effective_at, entity_id) DESC
       and ($9::int is null
         or (case
               when $3::text is null then 0
               when lower(coalesce(le.title, '')) = lower($3::text) then 400
               when lower(coalesce(le.title, '')) like lower($5::text) escape '\\' then 250
               when lower(coalesce(le.summary, '')) like lower($5::text) escape '\\' then 175
               when lower(coalesce(le.body, '')) like lower($5::text) escape '\\' then 120
               when coalesce(le.title, '') ilike $4 escape '\\' then 90
               when coalesce(le.summary, '') ilike $4 escape '\\' then 60
               when coalesce(le.body, '') ilike $4 escape '\\' then 30
               else 0
             end) < $9
         or ((case
               when $3::text is null then 0
               when lower(coalesce(le.title, '')) = lower($3::text) then 400
               when lower(coalesce(le.title, '')) like lower($5::text) escape '\\' then 250
               when lower(coalesce(le.summary, '')) like lower($5::text) escape '\\' then 175
               when lower(coalesce(le.body, '')) like lower($5::text) escape '\\' then 120
               when coalesce(le.title, '') ilike $4 escape '\\' then 90
               when coalesce(le.summary, '') ilike $4 escape '\\' then 60
               when coalesce(le.body, '') ilike $4 escape '\\' then 30
               else 0
             end) = $9
             and (le.effective_at < $7 or (le.effective_at = $7 and le.entity_id < $8))))
     order by _relevance_score desc,
       le.effective_at desc, le.entity_id desc
     limit $6`,
    [
      input.clubIds,
      input.kinds,
      trimmedQuery,
      likePattern,
      prefixPattern,
      fetchLimit,
      cursorEffectiveAt,
      cursorEntityId,
      cursorScore,
      input.actorMemberId,
      input.includeClosed,
    ],
  );

  const rows = result.rows.map(mapEntityRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();

  // Build cursor from the last returned row
  const lastIdx = rows.length - 1;
  const lastRow = lastIdx >= 0 ? result.rows[lastIdx] : null;
  let nextCursor: string | null = null;
  if (lastRow && rows.length > 0) {
    if (isQueryMode) {
      nextCursor = encodeCursor([String(lastRow._relevance_score), rows[lastIdx].version.effectiveAt, rows[lastIdx].entityId]);
    } else {
      nextCursor = encodeCursor([rows[lastIdx].version.effectiveAt, rows[lastIdx].entityId]);
    }
  }

  return { results: rows, hasMore, nextCursor };
}

// ── Club activity helper ────────────────────────────────────

export async function appendClubActivity(client: DbClient, input: {
  clubId: string;
  entityId?: string;
  entityVersionId?: string;
  topic: string;
  createdByMemberId: string | null;
  payload?: Record<string, unknown>;
  audience?: 'members' | 'clubadmins' | 'owners';
}): Promise<void> {
  await client.query(
    `insert into club_activity (club_id, entity_id, entity_version_id, topic, payload, created_by_member_id, audience)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      input.clubId,
      input.entityId ?? null,
      input.entityVersionId ?? null,
      input.topic,
      JSON.stringify(input.payload ?? {}),
      input.createdByMemberId,
      input.audience ?? 'members',
    ],
  );
}
