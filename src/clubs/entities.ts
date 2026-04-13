/**
 * Clubs domain — unified content CRUD and threaded public content reads.
 */

import type { Pool } from 'pg';
import type {
  ContentEntity,
  ContentThreadSummary,
  CreateEntityInput,
  EventFields,
  IncludedBundle,
  ListEntitiesInput,
  ReadContentThreadInput,
  SetEntityLoopInput,
  UpdateEntityInput,
  WithIncluded,
} from '../contract.ts';
import { AppError } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor, decodeCursor } from '../schemas/fields.ts';
import {
  applyContentMentionLimitsForUpdate,
  copyEntityVersionMentions,
  emptyContentMentions,
  emptyIncludedBundle,
  extractContentMentionCandidates,
  hasPotentialMentionChar,
  insertEntityVersionMentions,
  loadEntityVersionMentions,
  loadEntityVersionMentionsForVersion,
  mergeIncludedBundles,
  resolvePublicContentMentions,
  type ContentMentionField,
  type ContentMentionsByField,
} from '../mentions.ts';

type ContentEntityRow = {
  ord?: number;
  entity_id: string;
  content_thread_id: string;
  club_id: string;
  kind: ContentEntity['kind'];
  open_loop: boolean | null;
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  author_display_name: string;
  entity_version_id: string;
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
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
  viewer_response: string | null;
  yes_count: number | null;
  maybe_count: number | null;
  no_count: number | null;
  waitlist_count: number | null;
  attendees: Array<{
    membershipId: string;
    memberId: string;
    publicName: string;
    handle: string | null;
    response: 'yes' | 'maybe' | 'no' | 'waitlist';
    note: string | null;
    createdAt: string;
  }> | null;
};

type ThreadSummaryRow = {
  thread_id: string;
  club_id: string;
  first_entity_id: string;
  entity_count: number;
  last_activity_at: string;
};

type CurrentEntityForUpdateRow = {
  entity_id: string;
  club_id: string;
  content_thread_id: string;
  kind: ContentEntity['kind'];
  author_member_id: string;
  version_id: string;
  version_no: number;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
  content: Record<string, unknown> | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
};

type ExistingClientKeyRow = {
  id: string;
  club_id: string;
  content_thread_id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
  content: Record<string, unknown> | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
  is_thread_subject: boolean;
};

const LOOPABLE_KINDS = new Set(['ask', 'gift', 'service', 'opportunity']);

const CONTENT_ENTITY_SELECT = `
  requested.ord,
  e.id as entity_id,
  e.content_thread_id,
  e.club_id,
  e.kind::text as kind,
  e.open_loop,
  e.author_member_id,
  m.public_name as author_public_name,
  m.handle as author_handle,
  m.display_name as author_display_name,
  cev.id as entity_version_id,
  cev.version_no,
  cev.state::text as state,
  cev.title,
  cev.summary,
  cev.body,
  cev.effective_at::text as effective_at,
  cev.expires_at::text as expires_at,
  cev.created_at::text as version_created_at,
  cev.content,
  e.created_at::text as entity_created_at,
  evd.location,
  evd.starts_at::text as starts_at,
  evd.ends_at::text as ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
`;

function canonicalJson(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(obj[key])).join(',') + '}';
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left === right;
  return leftMs === rightMs;
}

function canonicalizeEventFields(event?: EventFields | Partial<EventFields> | null): EventFields | null {
  if (!event) return null;
  return {
    location: event.location ?? null,
    startsAt: event.startsAt ?? null,
    endsAt: event.endsAt ?? null,
    timezone: event.timezone ?? null,
    recurrenceRule: event.recurrenceRule ?? null,
    capacity: event.capacity ?? null,
  };
}

function eventFieldsEqual(row: ExistingClientKeyRow | CurrentEntityForUpdateRow, event?: EventFields | null): boolean {
  const normalized = canonicalizeEventFields(event);
  if (normalized === null) {
    return [
      row.location,
      row.starts_at,
      row.ends_at,
      row.timezone,
      row.recurrence_rule,
      row.capacity,
    ].every(value => value === null);
  }
  return (row.location ?? null) === normalized.location
    && timestampsEqual(row.starts_at, normalized.startsAt)
    && timestampsEqual(row.ends_at, normalized.endsAt)
    && (row.timezone ?? null) === normalized.timezone
    && (row.recurrence_rule ?? null) === normalized.recurrenceRule
    && (row.capacity ?? null) === normalized.capacity;
}

function initialOpenLoopForKind(kind: CreateEntityInput['kind']): boolean | null {
  return LOOPABLE_KINDS.has(kind) ? true : null;
}

function parseIsoDate(value: string | null, fieldName: string): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_input', `${fieldName} must be a valid ISO 8601 timestamp`);
  }
  return parsed;
}

function validateResolvedEventFields(event: EventFields | null): EventFields | null {
  if (!event) return null;
  if (!event.location || !event.startsAt) {
    throw new AppError(400, 'invalid_input', 'Event entities require both event.location and event.startsAt');
  }
  const startsAt = parseIsoDate(event.startsAt, 'event.startsAt');
  const endsAt = parseIsoDate(event.endsAt, 'event.endsAt');
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new AppError(400, 'invalid_input', 'event.endsAt must be after or equal to event.startsAt');
  }
  if (event.capacity !== null && event.capacity <= 0) {
    throw new AppError(400, 'invalid_input', 'event.capacity must be greater than zero');
  }
  return event;
}

function mapContentEntityRow(row: ContentEntityRow): ContentEntity {
  const isRemoved = row.state === 'removed';
  return {
    entityId: row.entity_id,
    contentThreadId: row.content_thread_id,
    clubId: row.club_id,
    kind: row.kind,
    openLoop: row.open_loop,
    author: {
      memberId: row.author_member_id,
      publicName: row.author_public_name,
      handle: row.author_handle,
      displayName: row.author_display_name,
    },
    version: {
      versionNo: row.version_no,
      state: row.state as ContentEntity['version']['state'],
      title: isRemoved ? '[redacted]' : row.title,
      summary: isRemoved ? '[redacted]' : row.summary,
      body: isRemoved ? '[redacted]' : row.body,
      effectiveAt: row.effective_at,
      expiresAt: isRemoved ? null : row.expires_at,
      createdAt: row.version_created_at,
      content: isRemoved ? {} : (row.content ?? {}),
      mentions: emptyContentMentions(),
    },
    event: isRemoved || row.kind !== 'event'
      ? null
      : {
        location: row.location,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        timezone: row.timezone,
        recurrenceRule: row.recurrence_rule,
        capacity: row.capacity,
      },
    rsvps: isRemoved || row.kind !== 'event'
      ? null
      : {
        viewerResponse: row.viewer_response as 'yes' | 'maybe' | 'no' | 'waitlist' | null,
        counts: {
          yes: Number(row.yes_count ?? 0),
          maybe: Number(row.maybe_count ?? 0),
          no: Number(row.no_count ?? 0),
          waitlist: Number(row.waitlist_count ?? 0),
        },
        attendees: (row.attendees ?? []).map((attendee) => ({
          membershipId: attendee.membershipId,
          memberId: attendee.memberId,
          publicName: attendee.publicName,
          handle: attendee.handle,
          response: attendee.response,
          note: attendee.note,
          createdAt: attendee.createdAt,
        })),
      },
    createdAt: row.entity_created_at,
  };
}

function withContentMentions(entity: ContentEntity, mentions?: ContentMentionsByField): ContentEntity {
  return {
    ...entity,
    version: {
      ...entity.version,
      mentions: entity.version.state === 'removed'
        ? emptyContentMentions()
        : (mentions ?? emptyContentMentions()),
    },
  };
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES.entity;
  await client.query(
    `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('entity_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

async function getViewerMembershipIds(client: DbClient, memberId: string, clubId?: string): Promise<string[]> {
  const result = await client.query<{ membership_id: string }>(
    `select id as membership_id
     from accessible_club_memberships
     where member_id = $1
       and ($2::text is null or club_id = $2)`,
    [memberId, clubId ?? null],
  );
  return result.rows.map(row => row.membership_id);
}

async function assertAuthorCanPostInClub(client: DbClient, memberId: string, clubId: string): Promise<void> {
  const result = await client.query<{ ok: boolean }>(
    `select exists(
       select 1
       from accessible_club_memberships
       where member_id = $1 and club_id = $2
     ) as ok`,
    [memberId, clubId],
  );
  if (!result.rows[0]?.ok) {
    throw new AppError(404, 'not_found', 'Club not found inside the actor scope');
  }
}

async function readExistingThreadTarget(client: DbClient, memberId: string, threadId: string): Promise<{ threadId: string; clubId: string }> {
  const result = await client.query<{ thread_id: string; club_id: string }>(
    `select ct.id as thread_id, ct.club_id
     from content_threads ct
     where ct.id = $1
       and ct.archived_at is null
       and exists (
         select 1
         from accessible_club_memberships acm
         where acm.member_id = $2
           and acm.club_id = ct.club_id
       )`,
    [threadId, memberId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, 'not_found', 'Thread not found inside the actor scope');
  }
  return { threadId: row.thread_id, clubId: row.club_id };
}

async function createThreadTarget(client: DbClient, memberId: string, clubId: string): Promise<{ threadId: string; clubId: string }> {
  await assertAuthorCanPostInClub(client, memberId, clubId);
  const threadResult = await client.query<{ id: string; club_id: string }>(
    `insert into content_threads (club_id, created_by_member_id)
     values ($1, $2)
     returning id, club_id`,
    [clubId, memberId],
  );
  const thread = threadResult.rows[0];
  if (!thread) {
    throw new AppError(500, 'missing_row', 'Created content thread row was not returned');
  }
  return { threadId: thread.id, clubId: thread.club_id };
}

async function readContentRowsByIds(
  client: DbClient,
  entityIds: string[],
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<ContentEntityRow[]> {
  if (entityIds.length === 0) return [];

  const result = await client.query<ContentEntityRow>(
    `with requested as (
       select entity_id, ord::int
       from unnest($1::text[]) with ordinality as requested(entity_id, ord)
     ),
     base as (
       select ${CONTENT_ENTITY_SELECT}
       from requested
       join entities e on e.id = requested.entity_id
       join current_entity_versions cev on cev.entity_id = e.id
       join members m on m.id = e.author_member_id
       left join event_version_details evd on evd.entity_version_id = cev.id
       where e.archived_at is null
         and e.deleted_at is null
         and ($2::boolean or cev.expires_at is null or cev.expires_at > now())
     ),
     attendee_rows as (
       select cer.event_entity_id,
              cer.membership_id,
              cer.created_by_member_id as member_id,
              am.public_name,
              am.handle,
              cer.response::text as response,
              cer.note,
              cer.created_at::text as created_at
       from current_event_rsvps cer
       join requested on requested.entity_id = cer.event_entity_id
       join members am on am.id = cer.created_by_member_id
       where cer.response::text <> 'cancelled'
     ),
     attendee_agg as (
       select event_entity_id,
              jsonb_agg(jsonb_build_object(
                'membershipId', membership_id,
                'memberId', member_id,
                'publicName', public_name,
                'handle', handle,
                'response', response,
                'note', note,
                'createdAt', created_at
              ) order by created_at asc) as attendees,
              count(*) filter (where response = 'yes')::int as yes_count,
              count(*) filter (where response = 'maybe')::int as maybe_count,
              count(*) filter (where response = 'no')::int as no_count,
              count(*) filter (where response = 'waitlist')::int as waitlist_count
       from attendee_rows
       group by event_entity_id
     ),
     viewer_rsvp as (
       select distinct on (cer.event_entity_id)
              cer.event_entity_id,
              case
                when cer.response::text = 'cancelled' then null
                else cer.response::text
              end as viewer_response
       from current_event_rsvps cer
       where cer.event_entity_id = any($1::text[])
         and cer.membership_id = any($3::text[])
       order by cer.event_entity_id, cer.version_no desc, cer.created_at desc
     )
     select base.*,
            viewer_rsvp.viewer_response,
            coalesce(attendee_agg.yes_count, 0) as yes_count,
            coalesce(attendee_agg.maybe_count, 0) as maybe_count,
            coalesce(attendee_agg.no_count, 0) as no_count,
            coalesce(attendee_agg.waitlist_count, 0) as waitlist_count,
            attendee_agg.attendees
     from base
     left join attendee_agg on attendee_agg.event_entity_id = base.entity_id
     left join viewer_rsvp on viewer_rsvp.event_entity_id = base.entity_id
     order by base.ord asc`,
    [entityIds, options.includeExpired ?? false, viewerMembershipIds],
  );

  return result.rows;
}

export async function readContentEntitiesByIds(
  client: DbClient,
  entityIds: string[],
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<ContentEntity[]> {
  const result = await readContentEntitiesBundleByIds(client, entityIds, viewerMembershipIds, options);
  return result.entities;
}

export async function readContentEntitiesBundleByIds(
  client: DbClient,
  entityIds: string[],
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<{ entities: ContentEntity[]; included: IncludedBundle }> {
  const rows = await readContentRowsByIds(client, entityIds, viewerMembershipIds, options);
  if (rows.length === 0) {
    return { entities: [], included: emptyIncludedBundle() };
  }

  const mapped = rows.map(mapContentEntityRow);
  const { mentionsByVersionId, included } = await loadEntityVersionMentions(
    client,
    rows.map((row) => row.entity_version_id),
  );

  const entities = mapped.map((entity, index) =>
    withContentMentions(entity, mentionsByVersionId.get(rows[index]!.entity_version_id)));

  return { entities, included };
}

export async function readContentEntity(
  client: DbClient,
  entityId: string,
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<ContentEntity | null> {
  const result = await readContentEntityBundle(client, entityId, viewerMembershipIds, options);
  return result.entity;
}

export async function readContentEntityBundle(
  client: DbClient,
  entityId: string,
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<WithIncluded<{ entity: ContentEntity | null }>> {
  const { entities, included } = await readContentEntitiesBundleByIds(client, [entityId], viewerMembershipIds, options);
  return {
    entity: entities[0] ?? null,
    included,
  };
}

async function insertEventVersionDetails(client: DbClient, entityVersionId: string, event: EventFields | null): Promise<void> {
  if (!event) return;
  await client.query(
    `insert into event_version_details (
       entity_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entityVersionId,
      event.location,
      event.startsAt,
      event.endsAt,
      event.timezone,
      event.recurrenceRule,
      event.capacity,
    ],
  );
}

async function readExistingClientKeyRow(client: DbClient, memberId: string, clientKey: string): Promise<ExistingClientKeyRow | null> {
  const result = await client.query<ExistingClientKeyRow>(
    `select
       e.id,
       e.club_id,
       e.content_thread_id,
       e.kind::text as kind,
       cev.title,
       cev.summary,
       cev.body,
       cev.expires_at::text as expires_at,
       cev.content,
       evd.location,
       evd.starts_at::text as starts_at,
       evd.ends_at::text as ends_at,
       evd.timezone,
       evd.recurrence_rule,
       evd.capacity,
       not exists (
         select 1
         from entities earlier
         where earlier.content_thread_id = e.content_thread_id
           and earlier.archived_at is null
           and earlier.deleted_at is null
           and (
             earlier.created_at < e.created_at
             or (earlier.created_at = e.created_at and earlier.id < e.id)
           )
       ) as is_thread_subject
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     left join event_version_details evd on evd.entity_version_id = cev.id
     where e.author_member_id = $1
       and e.client_key = $2
       and e.archived_at is null
       and e.deleted_at is null`,
    [memberId, clientKey],
  );
  return result.rows[0] ?? null;
}

export async function createEntity(pool: Pool, input: CreateEntityInput): Promise<WithIncluded<{ entity: ContentEntity }>> {
  return withTransaction(pool, async (client) => {
    if (!input.threadId && !input.clubId) {
      throw new AppError(400, 'invalid_input', 'clubId is required when starting a new thread');
    }

    const existingThreadTarget = input.threadId
      ? await readExistingThreadTarget(client, input.authorMemberId, input.threadId)
      : null;

    if (!input.threadId && input.clubId) {
      await assertAuthorCanPostInClub(client, input.authorMemberId, input.clubId);
    }

    if (input.clientKey) {
      const existing = await readExistingClientKeyRow(client, input.authorMemberId, input.clientKey);
      if (existing) {
        const sameThread = input.threadId
          ? existing.content_thread_id === existingThreadTarget?.threadId
          : existing.is_thread_subject;
        const samePayload =
          existing.club_id === (existingThreadTarget?.clubId ?? input.clubId) &&
          existing.kind === input.kind &&
          existing.title === (input.title ?? null) &&
          existing.summary === (input.summary ?? null) &&
          existing.body === (input.body ?? null) &&
          timestampsEqual(existing.expires_at, input.expiresAt) &&
          jsonEqual(existing.content ?? {}, input.content ?? {}) &&
          eventFieldsEqual(existing, canonicalizeEventFields(input.event ?? null));

        if (!sameThread || !samePayload) {
          throw new AppError(409, 'client_key_conflict',
            'This clientKey was already used with a different payload. Use a unique key per entity.');
        }

        const viewerMembershipIds = await getViewerMembershipIds(
          client,
          input.authorMemberId,
          existingThreadTarget?.clubId ?? input.clubId,
        );
        const replay = await readContentEntityBundle(client, existing.id, viewerMembershipIds, { includeExpired: true });
        if (replay.entity) return { entity: replay.entity, included: replay.included };
      }
    }

    const targetClubId = existingThreadTarget?.clubId ?? input.clubId!;
    const resolvedMentions = hasPotentialMentionChar(input.title, input.summary, input.body)
      ? await resolvePublicContentMentions(client, extractContentMentionCandidates(input), targetClubId)
      : emptyContentMentions();

    const target = existingThreadTarget
      ?? await createThreadTarget(client, input.authorMemberId, targetClubId);

    const entityResult = await client.query<{ id: string; created_at: string }>(
      `insert into entities (club_id, kind, author_member_id, open_loop, content_thread_id, client_key)
       values ($1, $2, $3, $4, $5, $6)
       returning id, created_at::text as created_at`,
      [
        target.clubId,
        input.kind,
        input.authorMemberId,
        initialOpenLoopForKind(input.kind),
        target.threadId,
        input.clientKey ?? null,
      ],
    );
    const entity = entityResult.rows[0];
    if (!entity) {
      throw new AppError(500, 'missing_row', 'Created entity row was not returned');
    }

    const versionResult = await client.query<{ id: string }>(
      `insert into entity_versions (
         entity_id, version_no, state, title, summary, body, expires_at, content, created_by_member_id
       ) values ($1, 1, 'published', $2, $3, $4, $5, $6::jsonb, $7)
       returning id`,
      [
        entity.id,
        input.title,
        input.summary,
        input.body,
        input.expiresAt,
        JSON.stringify(input.content ?? {}),
        input.authorMemberId,
      ],
    );
    const version = versionResult.rows[0];
    if (!version) {
      throw new AppError(500, 'missing_row', 'Created entity version row was not returned');
    }

    if (input.kind === 'event') {
      await insertEventVersionDetails(client, version.id, validateResolvedEventFields(canonicalizeEventFields(input.event ?? null)));
    }

    await insertEntityVersionMentions(client, version.id, resolvedMentions);

    if (input.threadId) {
      await client.query(
        `update content_threads
         set last_activity_at = greatest(last_activity_at, $2::timestamptz)
         where id = $1`,
        [target.threadId, entity.created_at],
      );
    }

    await appendClubActivity(client, {
      clubId: target.clubId,
      entityId: entity.id,
      entityVersionId: version.id,
      topic: 'entity.version.published',
      createdByMemberId: input.authorMemberId,
    });

    await enqueueEmbeddingJob(client, version.id);

    const viewerMembershipIds = await getViewerMembershipIds(client, input.authorMemberId, target.clubId);
    const summary = await readContentEntityBundle(client, entity.id, viewerMembershipIds, { includeExpired: true });
    if (!summary.entity) {
      throw new AppError(500, 'missing_row', 'Created entity could not be reloaded');
    }
    return { entity: summary.entity, included: summary.included };
  });
}

export async function updateEntity(pool: Pool, input: UpdateEntityInput): Promise<WithIncluded<{ entity: ContentEntity }> | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<CurrentEntityForUpdateRow>(
      `select
         e.id as entity_id,
         e.club_id,
         e.content_thread_id,
         e.kind::text as kind,
         e.author_member_id,
         cev.id as version_id,
         cev.version_no,
         cev.title,
         cev.summary,
         cev.body,
         cev.expires_at::text as expires_at,
         cev.content,
         evd.location,
         evd.starts_at::text as starts_at,
         evd.ends_at::text as ends_at,
         evd.timezone,
         evd.recurrence_rule,
         evd.capacity
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       left join event_version_details evd on evd.entity_version_id = cev.id
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.author_member_id = $3
         and e.archived_at is null
         and e.deleted_at is null
         and cev.state = 'published'`,
      [input.entityId, input.accessibleClubIds, input.actorMemberId],
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    if (input.patch.event !== undefined && current.kind !== 'event') {
      throw new AppError(400, 'invalid_input', 'event fields may only be updated on event entities');
    }

    const nextCommon = {
      title: input.patch.title !== undefined ? input.patch.title : current.title,
      summary: input.patch.summary !== undefined ? input.patch.summary : current.summary,
      body: input.patch.body !== undefined ? input.patch.body : current.body,
      expiresAt: input.patch.expiresAt !== undefined ? input.patch.expiresAt : current.expires_at,
      content: input.patch.content !== undefined ? input.patch.content : (current.content ?? {}),
    };

    const changedMentionFields: ContentMentionField[] = [];
    const unchangedMentionFields: ContentMentionField[] = [];
    const fieldPairs: Array<[ContentMentionField, string | null, string | null]> = [
      ['title', current.title, nextCommon.title],
      ['summary', current.summary, nextCommon.summary],
      ['body', current.body, nextCommon.body],
    ];
    for (const [field, previousValue, nextValue] of fieldPairs) {
      if (previousValue === nextValue) {
        unchangedMentionFields.push(field);
      } else {
        changedMentionFields.push(field);
      }
    }

    const carriedMentions = await loadEntityVersionMentionsForVersion(client, current.version_id);
    const changedMentions = changedMentionFields.length > 0
      ? await resolvePublicContentMentions(
        client,
        extractContentMentionCandidates({
          title: changedMentionFields.includes('title') ? nextCommon.title : null,
          summary: changedMentionFields.includes('summary') ? nextCommon.summary : null,
          body: changedMentionFields.includes('body') ? nextCommon.body : null,
        }),
        current.club_id,
      )
      : emptyContentMentions();

    const mergedMentions: ContentMentionsByField = {
      title: changedMentionFields.includes('title') ? changedMentions.title : carriedMentions.title,
      summary: changedMentionFields.includes('summary') ? changedMentions.summary : carriedMentions.summary,
      body: changedMentionFields.includes('body') ? changedMentions.body : carriedMentions.body,
    };
    const changedFieldSpanCount = changedMentionFields.reduce((total, field) => total + changedMentions[field].length, 0);
    applyContentMentionLimitsForUpdate(mergedMentions, changedFieldSpanCount);

    const versionResult = await client.query<{ id: string }>(
      `insert into entity_versions (
         entity_id, version_no, state, title, summary, body, expires_at, content, supersedes_version_id, created_by_member_id
       ) values ($1, $2, 'published', $3, $4, $5, $6, $7::jsonb, $8, $9)
       returning id`,
      [
        current.entity_id,
        current.version_no + 1,
        nextCommon.title,
        nextCommon.summary,
        nextCommon.body,
        nextCommon.expiresAt,
        JSON.stringify(nextCommon.content ?? {}),
        current.version_id,
        input.actorMemberId,
      ],
    );
    const version = versionResult.rows[0];
    if (!version) {
      throw new AppError(500, 'missing_row', 'Updated entity version row was not returned');
    }

    await copyEntityVersionMentions(client, current.version_id, version.id, unchangedMentionFields);
    await insertEntityVersionMentions(client, version.id, changedMentions);

    if (current.kind === 'event') {
      const mergedEvent = validateResolvedEventFields({
        location: input.patch.event?.location !== undefined ? input.patch.event.location ?? null : current.location,
        startsAt: input.patch.event?.startsAt !== undefined ? input.patch.event.startsAt ?? null : current.starts_at,
        endsAt: input.patch.event?.endsAt !== undefined ? input.patch.event.endsAt ?? null : current.ends_at,
        timezone: input.patch.event?.timezone !== undefined ? input.patch.event.timezone ?? null : current.timezone,
        recurrenceRule: input.patch.event?.recurrenceRule !== undefined ? input.patch.event.recurrenceRule ?? null : current.recurrence_rule,
        capacity: input.patch.event?.capacity !== undefined ? input.patch.event.capacity ?? null : current.capacity,
      });
      await insertEventVersionDetails(client, version.id, mergedEvent);
    }

    await appendClubActivity(client, {
      clubId: current.club_id,
      entityId: current.entity_id,
      entityVersionId: version.id,
      topic: 'entity.version.published',
      createdByMemberId: input.actorMemberId,
    });

    await enqueueEmbeddingJob(client, version.id);

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, current.club_id);
    const summary = await readContentEntityBundle(client, current.entity_id, viewerMembershipIds, { includeExpired: true });
    return summary.entity ? { entity: summary.entity, included: summary.included } : null;
  });
}

export async function removeEntity(pool: Pool, input: {
  entityId: string;
  clubIds: string[];
  actorMemberId: string;
  reason?: string | null;
  skipAuthCheck?: boolean;
}): Promise<WithIncluded<{ entity: ContentEntity }> | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      entity_id: string;
      club_id: string;
      author_member_id: string;
      version_id: string;
      version_no: number;
      state: string;
    }>(
      `select
         e.id as entity_id,
         e.club_id,
         e.author_member_id,
         cev.id as version_id,
         cev.version_no,
         cev.state::text as state
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.archived_at is null
         and e.deleted_at is null`,
      [input.entityId, input.clubIds],
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
      return null;
    }

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, current.club_id);

    if (current.state === 'removed') {
      const existing = await readContentEntityBundle(client, current.entity_id, viewerMembershipIds, { includeExpired: true });
      return existing.entity ? { entity: existing.entity, included: existing.included } : null;
    }

    const removeResult = await client.query<{ id: string }>(
      `insert into entity_versions (
         entity_id, version_no, state, reason, supersedes_version_id, created_by_member_id
       ) values ($1, $2, 'removed', $3, $4, $5)
       returning id`,
      [current.entity_id, current.version_no + 1, input.reason ?? null, current.version_id, input.actorMemberId],
    );
    const removeVersion = removeResult.rows[0];
    if (removeVersion) {
      await appendClubActivity(client, {
        clubId: current.club_id,
        entityId: current.entity_id,
        entityVersionId: removeVersion.id,
        topic: 'entity.removed',
        createdByMemberId: input.actorMemberId,
      });
    }

    const summary = await readContentEntityBundle(client, current.entity_id, viewerMembershipIds, { includeExpired: true });
    return summary.entity ? { entity: summary.entity, included: summary.included } : null;
  });
}

async function setEntityLoopState(
  pool: Pool,
  input: SetEntityLoopInput,
  nextOpenLoop: boolean,
): Promise<WithIncluded<{ entity: ContentEntity }> | null> {
  return withTransaction(pool, async (client) => {
    const updateResult = await client.query<{ entity_id: string; club_id: string }>(
      `update entities e
       set open_loop = $4
       from current_entity_versions cev
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.author_member_id = $3
         and e.archived_at is null
         and e.deleted_at is null
         and e.open_loop is not null
         and cev.entity_id = e.id
         and cev.state = 'published'
       returning e.id as entity_id, e.club_id`,
      [input.entityId, input.accessibleClubIds, input.actorMemberId, nextOpenLoop],
    );

    const row = updateResult.rows[0];
    if (!row) return null;

    if (nextOpenLoop) {
      await client.query(
        `delete from signal_background_matches
         where source_id = $1
           and match_kind in ('ask_to_member', 'offer_to_ask')`,
        [row.entity_id],
      );
    } else {
      await client.query(
        `update signal_background_matches
         set state = 'expired'
         where source_id = $1
           and state = 'pending'
           and match_kind in ('ask_to_member', 'offer_to_ask')`,
        [row.entity_id],
      );
    }

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, row.club_id);
    const summary = await readContentEntityBundle(client, row.entity_id, viewerMembershipIds, { includeExpired: true });
    return summary.entity ? { entity: summary.entity, included: summary.included } : null;
  });
}

export async function closeEntityLoop(pool: Pool, input: SetEntityLoopInput): Promise<WithIncluded<{ entity: ContentEntity }> | null> {
  return setEntityLoopState(pool, input, false);
}

export async function reopenEntityLoop(pool: Pool, input: SetEntityLoopInput): Promise<WithIncluded<{ entity: ContentEntity }> | null> {
  return setEntityLoopState(pool, input, true);
}

export type PaginatedThreads = WithIncluded<{ results: ContentThreadSummary[]; hasMore: boolean; nextCursor: string | null }>;

async function loadThreadSummaryRows(
  client: DbClient,
  input: {
    actorMemberId: string;
    clubIds: string[];
    kinds: string[];
    limit: number;
    query?: string;
    includeClosed: boolean;
    cursor?: { lastActivityAt: string; threadId: string } | null;
  },
): Promise<ThreadSummaryRow[]> {
  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;

  const result = await client.query<ThreadSummaryRow>(
    `with thread_scope as (
       select ct.id, ct.club_id, ct.last_activity_at
       from content_threads ct
       where ct.club_id = any($1::text[])
         and ct.archived_at is null
         and ($6::timestamptz is null
           or ct.last_activity_at < $6
           or (ct.last_activity_at = $6 and ct.id < $7))
     ),
     thread_counts as (
       select e.content_thread_id, count(*)::int as entity_count
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       join thread_scope ts on ts.id = e.content_thread_id
       where e.archived_at is null
         and e.deleted_at is null
         and (
           cev.state = 'removed'
           or (
             cev.state = 'published'
             and (cev.expires_at is null or cev.expires_at > now())
             and (
               e.open_loop is null
               or e.open_loop = true
               or $5::boolean
               or e.author_member_id = $4
             )
           )
         )
       group by e.content_thread_id
     ),
     first_entities as (
       select distinct on (e.content_thread_id)
              e.content_thread_id as thread_id,
              e.id as entity_id,
              e.kind::text as kind,
              e.open_loop,
              e.author_member_id,
              cev.state::text as state,
              cev.title,
              cev.summary,
              cev.body
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       join thread_scope ts on ts.id = e.content_thread_id
       where e.archived_at is null
         and e.deleted_at is null
       order by e.content_thread_id, e.created_at asc, e.id asc
     ),
     visible_threads as (
       select distinct e.content_thread_id
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       join thread_scope ts on ts.id = e.content_thread_id
       where e.archived_at is null
         and e.deleted_at is null
         and cev.state = 'published'
         and (cev.expires_at is null or cev.expires_at > now())
         and (
           e.open_loop is null
           or e.open_loop = true
           or ($5::boolean and e.author_member_id = $4)
         )
     )
     select
       ts.id as thread_id,
       ts.club_id,
       fe.entity_id as first_entity_id,
       tc.entity_count,
       ts.last_activity_at::text as last_activity_at
     from thread_scope ts
     join thread_counts tc on tc.content_thread_id = ts.id
     join first_entities fe on fe.thread_id = ts.id
     where fe.kind = any($2::text[])
       and exists (
         select 1
         from visible_threads vt
         where vt.content_thread_id = ts.id
       )
       and not (
         fe.state <> 'removed'
         and fe.kind in ('ask', 'gift', 'service', 'opportunity')
         and fe.open_loop = false
         and fe.author_member_id <> $4
         and not $5::boolean
       )
       and ($3::text is null
         or coalesce(fe.title, '') ilike $8 escape '\\'
         or coalesce(fe.summary, '') ilike $8 escape '\\'
         or coalesce(fe.body, '') ilike $8 escape '\\')
     order by ts.last_activity_at desc, ts.id desc
     limit $9`,
    [
      input.clubIds,
      input.kinds,
      trimmedQuery,
      input.actorMemberId,
      input.includeClosed,
      input.cursor?.lastActivityAt ?? null,
      input.cursor?.threadId ?? null,
      likePattern,
      input.limit + 1,
    ],
  );

  return result.rows;
}

export async function listEntities(pool: Pool, input: ListEntitiesInput): Promise<PaginatedThreads> {
  if (input.clubIds.length === 0) {
    return { results: [], hasMore: false, nextCursor: null, included: emptyIncludedBundle() };
  }

  const rows = await withTransaction(pool, async (client) => {
    return loadThreadSummaryRows(client, {
      actorMemberId: input.actorMemberId,
      clubIds: input.clubIds,
      kinds: input.kinds,
      limit: input.limit,
      query: input.query,
      includeClosed: input.includeClosed,
      cursor: input.cursor,
    });
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  return withTransaction(pool, async (client) => {
    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId);
    const firstEntityBundle = await readContentEntitiesBundleByIds(
      client,
      pageRows.map(row => row.first_entity_id),
      viewerMembershipIds,
      { includeExpired: true },
    );
    const firstEntityById = new Map(firstEntityBundle.entities.map(entity => [entity.entityId, entity]));

    const results = pageRows
      .map((row) => {
        const firstEntity = firstEntityById.get(row.first_entity_id);
        if (!firstEntity) return null;
        return {
          threadId: row.thread_id,
          clubId: row.club_id,
          firstEntity,
          thread: {
            entityCount: Number(row.entity_count),
            lastActivityAt: row.last_activity_at,
          },
        } satisfies ContentThreadSummary;
      })
      .filter((row): row is ContentThreadSummary => row !== null);

    const lastRow = results.length > 0 ? pageRows[results.length - 1] : null;
    const nextCursor = hasMore && lastRow
      ? encodeCursor([lastRow.last_activity_at, lastRow.thread_id])
      : null;

    return { results, hasMore, nextCursor, included: firstEntityBundle.included };
  });
}

async function loadThreadHeader(
  client: DbClient,
  actorMemberId: string,
  threadId: string,
  includeClosed: boolean,
): Promise<ThreadSummaryRow | null> {
  const result = await client.query<ThreadSummaryRow>(
    `with first_entity as (
       select distinct on (e.content_thread_id)
              e.content_thread_id as thread_id,
              e.id as entity_id,
              e.kind::text as kind,
              e.open_loop,
              e.author_member_id,
              cev.state::text as state
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.content_thread_id = $1
         and e.archived_at is null
         and e.deleted_at is null
       order by e.content_thread_id, e.created_at asc, e.id asc
     ),
     thread_counts as (
       select e.content_thread_id, count(*)::int as entity_count
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.content_thread_id = $1
         and e.archived_at is null
         and e.deleted_at is null
         and (
           cev.state = 'removed'
           or (
             cev.state = 'published'
             and (cev.expires_at is null or cev.expires_at > now())
             and (
               e.open_loop is null
               or e.open_loop = true
               or $3::boolean
               or e.author_member_id = $2
             )
           )
         )
       group by e.content_thread_id
     ),
     visible_thread as (
       select 1
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.content_thread_id = $1
         and e.archived_at is null
         and e.deleted_at is null
         and cev.state = 'published'
         and (cev.expires_at is null or cev.expires_at > now())
         and (
           e.open_loop is null
           or e.open_loop = true
           or $3::boolean
           or e.author_member_id = $2
         )
       limit 1
     )
     select
       ct.id as thread_id,
       ct.club_id,
       first_entity.entity_id as first_entity_id,
       thread_counts.entity_count,
       ct.last_activity_at::text as last_activity_at
     from content_threads ct
     join first_entity on first_entity.thread_id = ct.id
     join thread_counts on thread_counts.content_thread_id = ct.id
     where ct.id = $1
       and ct.archived_at is null
       and exists (select 1 from visible_thread)
       and not (
         first_entity.state <> 'removed'
         and first_entity.kind in ('ask', 'gift', 'service', 'opportunity')
         and first_entity.open_loop = false
         and first_entity.author_member_id <> $2
         and not $3::boolean
       )`,
    [threadId, actorMemberId, includeClosed],
  );
  return result.rows[0] ?? null;
}

export async function readContentThread(
  pool: Pool,
  input: ReadContentThreadInput,
): Promise<WithIncluded<{ thread: ContentThreadSummary; entities: ContentEntity[]; hasMore: boolean; nextCursor: string | null }> | null> {
  return withTransaction(pool, async (client) => {
    const resolvedThreadId = input.threadId
      ? (await client.query<{ id: string }>(
        `select id
         from content_threads
         where id = $1
           and archived_at is null
           and club_id = any($2::text[])`,
        [input.threadId, input.accessibleClubIds],
      )).rows[0]?.id
      : (await client.query<{ content_thread_id: string }>(
        `select e.content_thread_id
         from entities e
         where e.id = $1
           and e.archived_at is null
           and e.deleted_at is null
           and e.club_id = any($2::text[])`,
        [input.entityId ?? null, input.accessibleClubIds],
      )).rows[0]?.content_thread_id;

    if (!resolvedThreadId) return null;

    const threadRow = await loadThreadHeader(client, input.actorMemberId, resolvedThreadId, input.includeClosed);
    if (!threadRow) return null;

    const viewerMembershipIds = input.accessibleMemberships
      .filter(membership => membership.clubId === threadRow.club_id)
      .map(membership => membership.membershipId);

    const firstEntityBundle = await readContentEntityBundle(client, threadRow.first_entity_id, viewerMembershipIds, { includeExpired: true });
    if (!firstEntityBundle.entity) return null;

    const pageResult = await client.query<{ entity_id: string; created_at: string }>(
      `select e.id as entity_id, e.created_at::text as created_at
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.content_thread_id = $1
         and e.archived_at is null
         and e.deleted_at is null
         and (
           cev.state = 'removed'
           or (
             cev.state = 'published'
             and (cev.expires_at is null or cev.expires_at > now())
             and (
               e.open_loop is null
               or e.open_loop = true
               or $5::boolean
               or e.author_member_id = $2
             )
           )
         )
         and ($3::timestamptz is null
           or e.created_at < $3
           or (e.created_at = $3 and e.id < $4))
       order by e.created_at desc, e.id desc
       limit $6`,
      [
        resolvedThreadId,
        input.actorMemberId,
        input.cursor?.createdAt ?? null,
        input.cursor?.entityId ?? null,
        input.includeClosed,
        input.limit + 1,
      ],
    );

    const hasMore = pageResult.rows.length > input.limit;
    const entityPage = hasMore ? pageResult.rows.slice(0, input.limit) : pageResult.rows;
    const pageEntityIds = [...entityPage].reverse().map(row => row.entity_id);
    const entityBundle = await readContentEntitiesBundleByIds(client, pageEntityIds, viewerMembershipIds, { includeExpired: false });

    const oldest = entityPage[entityPage.length - 1];
    const nextCursor = hasMore && oldest
      ? encodeCursor([oldest.created_at, oldest.entity_id])
      : null;

    return {
      thread: {
        threadId: threadRow.thread_id,
        clubId: threadRow.club_id,
        firstEntity: firstEntityBundle.entity,
        thread: {
          entityCount: Number(threadRow.entity_count),
          lastActivityAt: threadRow.last_activity_at,
        },
      },
      entities: entityBundle.entities,
      hasMore,
      nextCursor,
      included: mergeIncludedBundles(firstEntityBundle.included, entityBundle.included),
    };
  });
}

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
