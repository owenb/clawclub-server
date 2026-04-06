/**
 * Club plane — entity CRUD (posts, opportunities, services, asks).
 *
 * No member name JOINs — the clubs DB has no members table.
 * Author display info is enriched by the composition layer.
 */

import type { Pool } from 'pg';
import type { CreateEntityInput, EntitySummary, ListEntitiesInput, UpdateEntityInput } from '../contract.ts';
import { AppError } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';

type EntityRow = {
  entity_id: string;
  entity_version_id: string;
  club_id: string;
  kind: EntitySummary['kind'];
  author_member_id: string;
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

/** Map a row to EntitySummary. Author names are empty — enriched by composition layer. */
function mapEntityRow(row: EntityRow): EntitySummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    kind: row.kind,
    author: { memberId: row.author_member_id, publicName: '', handle: null },
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
  e.id as entity_id, cev.id as entity_version_id, e.club_id, e.kind,
  e.author_member_id, cev.version_no, cev.state,
  cev.title, cev.summary, cev.body,
  cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
  cev.created_at::text as version_created_at, cev.content,
  e.created_at::text as entity_created_at
`;

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES['entity'];
  await client.query(
    `insert into app.embeddings_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('entity_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

export async function readEntitySummary(client: DbClient, entityId: string, entityVersionId?: string): Promise<EntitySummary | null> {
  const result = await client.query<EntityRow>(
    `select ${ENTITY_SELECT}
     from app.entities e
     join app.current_entity_versions cev on cev.entity_id = e.id
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
      const existing = await client.query<{ id: string }>(
        `select id from app.entities where author_member_id = $1 and client_key = $2`,
        [input.authorMemberId, input.clientKey],
      );
      if (existing.rows[0]) {
        const summary = await readEntitySummary(client, existing.rows[0].id);
        if (summary) return summary;
      }
    }
    const entityResult = await client.query<{ id: string; created_at: string }>(
      `insert into app.entities (club_id, kind, author_member_id, client_key) values ($1, $2, $3, $4)
       returning id, created_at::text as created_at`,
      [input.clubId, input.kind, input.authorMemberId, input.clientKey ?? null],
    );
    const entity = entityResult.rows[0];
    if (!entity) throw new AppError(500, 'missing_row', 'Created entity row was not returned');
    entityId = entity.id;

    const versionResult = await client.query<{ id: string }>(
      `insert into app.entity_versions (entity_id, version_no, state, title, summary, body, expires_at, content, created_by_member_id)
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
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[]) and e.author_member_id = $3
         and e.deleted_at is null and cev.state = 'published'`,
      [input.entityId, input.accessibleClubIds, input.actorMemberId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    const nextVersionResult = await client.query<{ id: string }>(
      `insert into app.entity_versions (entity_id, version_no, state, title, summary, body, expires_at, content, supersedes_version_id, created_by_member_id)
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
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[])
         and e.deleted_at is null and cev.state = 'removed'`,
      [input.entityId, input.clubIds],
    );
    if (alreadyRemoved.rows[0]) {
      return mapEntityRow(alreadyRemoved.rows[0]);
    }

    const kindClause = input.kindFilter ? `and e.kind = '${input.kindFilter}'` : `and e.kind <> 'event'`;
    const currentResult = await client.query<{
      entity_id: string; club_id: string; author_member_id: string;
      version_id: string; version_no: number;
    }>(
      `select e.id as entity_id, e.club_id, e.author_member_id,
              cev.id as version_id, cev.version_no
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[])
         and e.deleted_at is null and cev.state = 'published'
         ${kindClause}`,
      [input.entityId, input.clubIds],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
      throw new AppError(403, 'forbidden', 'Only the author can remove this entity');
    }

    const removeVersion = await client.query<{ id: string }>(
      `insert into app.entity_versions (entity_id, version_no, state, reason, supersedes_version_id, created_by_member_id)
       values ($1, $2, 'removed', $3, $4, $5) returning id`,
      [current.entity_id, current.version_no + 1, input.reason ?? null, current.version_id, input.actorMemberId],
    );

    // Emit removal activity
    if (removeVersion.rows[0]) {
      await appendClubActivity(client, {
        clubId: input.clubIds[0]!,
        entityId: current.entity_id,
        entityVersionId: removeVersion.rows[0].id,
        topic: 'entity.removed',
        createdByMemberId: input.actorMemberId,
      });
    }

    return readEntitySummary(client, current.entity_id);
  });
}

export async function listEntities(pool: Pool, input: ListEntitiesInput): Promise<EntitySummary[]> {
  if (input.clubIds.length === 0) return [];

  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
  const prefixPattern = trimmedQuery ? `${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;

  const result = await pool.query<EntityRow>(
    `with scope as (select unnest($1::text[]) as club_id)
     select ${ENTITY_SELECT}
     from scope s
     join app.live_entities le on le.club_id = s.club_id::app.short_id
     join app.entities e on e.id = le.entity_id
     join app.current_entity_versions cev on cev.id = le.entity_version_id
     where le.kind = any($2::app.entity_kind[])
       and ($4::text is null
         or coalesce(le.title, '') ilike $4 escape '\\'
         or coalesce(le.summary, '') ilike $4 escape '\\'
         or coalesce(le.body, '') ilike $4 escape '\\')
     order by
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
       end desc,
       le.effective_at desc, le.entity_id desc
     limit $6`,
    [input.clubIds, input.kinds, trimmedQuery, likePattern, prefixPattern, input.limit],
  );

  return result.rows.map(mapEntityRow);
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
    `insert into app.club_activity (club_id, entity_id, entity_version_id, topic, payload, created_by_member_id, audience)
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
