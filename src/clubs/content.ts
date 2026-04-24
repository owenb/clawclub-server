/**
 * Clubs domain — unified content CRUD and threaded public content reads.
 */

import type { Pool } from 'pg';
import type {
  Content,
  ContentForGate,
  ContentThread,
  CreateContentInput,
  EventFields,
  IncludedBundle,
  ListContentInput,
  ReadContentInput,
  ReadContentThreadInput,
  SetContentLoopInput,
  UpdateContentInput,
  WithIncluded,
} from '../repository.ts';
import { AppError } from '../repository.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { translate23505, withTransaction, type DbClient } from '../db.ts';
import { withIdempotency } from '../idempotency.ts';
import { deliverCoreNotifications } from '../notification-substrate.ts';
import { encodeCursor, decodeCursor } from '../schemas/fields.ts';
import { compareIsoTimestamp } from '../timestamps.ts';
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

type ContentRow = {
  ord?: number;
  content_id: string;
  thread_id: string;
  club_id: string;
  kind: Content['kind'];
  open_loop: boolean | null;
  author_member_id: string;
  author_public_name: string;
  author_display_name: string;
  content_version_id: string;
  version_no: number;
  state: string;
  reason: string | null;
  title: string | null;
  summary: string | null;
  body: string | null;
  effective_at: string;
  expires_at: string | null;
  version_created_at: string;
  version_created_by_member_id: string | null;
  version_created_by_member_public_name: string | null;
  content_created_at: string;
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
    response: 'yes' | 'maybe' | 'no' | 'waitlist';
    note: string | null;
    createdAt: string;
  }> | null;
};

type ThreadSummaryRow = {
  thread_id: string;
  club_id: string;
  first_content_id: string;
  content_count: number;
  last_activity_at: string;
};

type CurrentEntityForUpdateRow = {
  content_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  thread_id: string;
  kind: Content['kind'];
  is_reply?: boolean;
  author_member_id: string;
  version_id: string;
  version_no: number;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
};

type EventNotificationTopic = 'event.updated' | 'event.removed';

type EventNotificationContext = {
  contentId: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
  title: string | null;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
};

type ContentForGateRow = {
  content_kind: ContentForGate['contentKind'];
  is_reply: boolean;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
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
  thread_id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
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
  e.id as content_id,
  e.thread_id,
  e.club_id,
  e.kind::text as kind,
  e.open_loop,
  e.author_member_id,
  m.public_name as author_public_name,
  m.display_name as author_display_name,
  cev.id as content_version_id,
  cev.version_no,
  cev.state::text as state,
  cev.reason,
  cev.title,
  cev.summary,
  cev.body,
  cev.effective_at::text as effective_at,
  cev.expires_at::text as expires_at,
  cev.created_at::text as version_created_at,
  cev.created_by_member_id as version_created_by_member_id,
  creator.public_name as version_created_by_member_public_name,
  e.created_at::text as content_created_at,
  evd.location,
  evd.starts_at::text as starts_at,
  evd.ends_at::text as ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
`;

export function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareIsoTimestamp(a, b) === 0;
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

function initialOpenLoopForKind(kind: CreateContentInput['kind']): boolean | null {
  return LOOPABLE_KINDS.has(kind) ? true : null;
}

function parseIsoDate(value: string | null, fieldName: string): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('invalid_input', `${fieldName} must be a valid ISO 8601 timestamp`);
  }
  return parsed;
}

function validateResolvedEventFields(event: EventFields | null): EventFields | null {
  if (!event) return null;
  if (!event.location || !event.startsAt) {
    throw new AppError('invalid_input', 'Event contents require both event.location and event.startsAt');
  }
  const startsAt = parseIsoDate(event.startsAt, 'event.startsAt');
  const endsAt = parseIsoDate(event.endsAt, 'event.endsAt');
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new AppError('invalid_input', 'event.endsAt must be after or equal to event.startsAt');
  }
  if (event.capacity !== null && event.capacity <= 0) {
    throw new AppError('invalid_input', 'event.capacity must be greater than zero');
  }
  return event;
}

function mapContentRow(row: ContentRow): Content {
  const isRemoved = row.state === 'removed';
  return {
    id: row.content_id,
    threadId: row.thread_id,
    clubId: row.club_id,
    kind: row.kind,
    openLoop: row.open_loop,
    author: {
      memberId: row.author_member_id,
      publicName: row.author_public_name,
      displayName: row.author_display_name,
    },
    version: {
      no: row.version_no,
      status: row.state as Content['version']['status'],
      reason: row.reason,
      title: isRemoved ? '[redacted]' : row.title,
      summary: isRemoved ? '[redacted]' : row.summary,
      body: isRemoved ? '[redacted]' : row.body,
      effectiveAt: row.effective_at,
      expiresAt: isRemoved ? null : row.expires_at,
      createdAt: row.version_created_at,
      createdByMember: row.version_created_by_member_id
        ? {
          memberId: row.version_created_by_member_id,
          publicName: row.version_created_by_member_public_name as string,
        }
        : null,
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
          response: attendee.response,
          note: attendee.note,
          createdAt: attendee.createdAt,
        })),
      },
    createdAt: row.content_created_at,
  };
}

function withContentMentions(content: Content, mentions?: ContentMentionsByField): Content {
  return {
    ...content,
    version: {
      ...content.version,
      mentions: content.version.status === 'removed'
        ? emptyContentMentions()
        : (mentions ?? emptyContentMentions()),
    },
  };
}

async function listEventNotificationRecipientIds(
  client: DbClient,
  eventContentId: string,
  excludeMemberId: string,
): Promise<string[]> {
  const result = await client.query<{ member_id: string }>(
    `select distinct acm.member_id
     from current_event_rsvps cer
     join accessible_club_memberships acm on acm.id = cer.membership_id
     where cer.event_content_id = $1
       and cer.response::text <> 'cancelled'
       and acm.member_id <> $2
     order by acm.member_id asc`,
    [eventContentId, excludeMemberId],
  );
  return result.rows.map((row) => row.member_id);
}

async function insertEventAttendeeNotifications(
  client: DbClient,
  input: {
    topic: EventNotificationTopic;
    event: EventNotificationContext;
    recipientMemberIds: string[];
    changedAt: string;
    changedByMemberId: string;
    reason?: string | null;
    contentId: string | null;
  },
): Promise<void> {
  if (input.recipientMemberIds.length === 0) {
    return;
  }

  const payload = {
    kind: input.topic,
    event: {
      contentId: input.event.contentId,
      title: input.event.title,
      location: input.event.location,
      startsAt: input.event.startsAt,
      endsAt: input.event.endsAt,
      timezone: input.event.timezone,
    },
    club: {
      clubId: input.event.clubId,
      slug: input.event.clubSlug,
      name: input.event.clubName,
    },
    changedAt: input.changedAt,
    changedByMemberId: input.changedByMemberId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };

  await deliverCoreNotifications(client, input.recipientMemberIds.map((recipientMemberId) => ({
    clubId: input.event.clubId,
    recipientMemberId,
    topic: input.topic,
    payloadVersion: 1,
    payload,
    refs: [
      { role: 'subject', kind: 'content', id: input.event.contentId },
      { role: 'club_context', kind: 'club', id: input.event.clubId },
      { role: 'actor', kind: 'member', id: input.changedByMemberId },
    ],
  })));
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES.content;
  await client.query(
    `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('content_version', $1, $2, $3, $4)
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

async function buildContentErrorDetails(
  client: DbClient,
  input: {
    contentId: string;
    actorMemberId: string;
    clubId: string;
  },
): Promise<WithIncluded<{ content: Content }> | undefined> {
  const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, input.clubId);
  const bundle = await readContentBundle(
    client,
    input.contentId,
    viewerMembershipIds,
    { memberId: input.actorMemberId },
    { includeExpired: true },
  );
  return bundle.content ? { content: bundle.content, included: bundle.included } : undefined;
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
    throw new AppError('club_not_found', 'Club not found inside the actor scope');
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
    throw new AppError('thread_not_found', 'Thread not found inside the actor scope');
  }
  return { threadId: row.thread_id, clubId: row.club_id };
}

export async function resolveContentThreadClubIdForGate(pool: Pool, input: {
  actorMemberId: string;
  threadId: string;
  accessibleClubIds: string[];
}): Promise<string | null> {
  if (input.accessibleClubIds.length === 0) return null;
  const result = await pool.query<{ club_id: string }>(
    `select ct.club_id
     from content_threads ct
     where ct.id = $1
       and ct.archived_at is null
       and ct.club_id = any($2::text[])
       and exists (
         select 1
         from accessible_club_memberships acm
         where acm.member_id = $3
           and acm.club_id = ct.club_id
       )
     limit 1`,
    [input.threadId, input.accessibleClubIds, input.actorMemberId],
  );
  return result.rows[0]?.club_id ?? null;
}

export async function resolveContentClubIdForGate(pool: Pool, input: {
  actorMemberId: string;
  contentId: string;
  accessibleClubIds: string[];
}): Promise<string | null> {
  if (input.accessibleClubIds.length === 0) return null;
  const result = await pool.query<{ club_id: string }>(
    `select e.club_id
     from contents e
     where e.id = $1
       and e.author_member_id = $2
       and e.archived_at is null
       and e.deleted_at is null
       and e.club_id = any($3::text[])
     limit 1`,
    [input.contentId, input.actorMemberId, input.accessibleClubIds],
  );
  return result.rows[0]?.club_id ?? null;
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
    throw new AppError('missing_row', 'Created content thread row was not returned');
  }
  return { threadId: thread.id, clubId: thread.club_id };
}

async function readContentRowsByIds(
  client: DbClient,
  contentIds: string[],
  viewerMembershipIds: string[],
  options: { includeExpired?: boolean } = {},
): Promise<ContentRow[]> {
  if (contentIds.length === 0) return [];

  const result = await client.query<ContentRow>(
    `with requested as (
       select content_id, ord::int
       from unnest($1::text[]) with ordinality as requested(content_id, ord)
     ),
     base as (
       select ${CONTENT_ENTITY_SELECT}
       from requested
       join contents e on e.id = requested.content_id
       join current_content_versions cev on cev.content_id = e.id
       join members m on m.id = e.author_member_id
       left join members creator on creator.id = cev.created_by_member_id
       left join event_version_details evd on evd.content_version_id = cev.id
       where e.archived_at is null
         and e.deleted_at is null
         and ($2::boolean or cev.expires_at is null or cev.expires_at > now())
     ),
     attendee_rows as (
       select cer.event_content_id,
              cer.membership_id,
              cer.created_by_member_id as member_id,
              am.public_name,
              cer.response::text as response,
              cer.note,
              cer.created_at::text as created_at
       from current_event_rsvps cer
       join requested on requested.content_id = cer.event_content_id
       join members am on am.id = cer.created_by_member_id
       where cer.response::text <> 'cancelled'
     ),
     attendee_agg as (
       select event_content_id,
              jsonb_agg(jsonb_build_object(
                'membershipId', membership_id,
                'memberId', member_id,
                'publicName', public_name,
                'response', response,
                'note', note,
                'createdAt', created_at
              ) order by created_at asc) as attendees,
              count(*) filter (where response = 'yes')::int as yes_count,
              count(*) filter (where response = 'maybe')::int as maybe_count,
              count(*) filter (where response = 'no')::int as no_count,
              count(*) filter (where response = 'waitlist')::int as waitlist_count
       from attendee_rows
       group by event_content_id
     ),
     viewer_rsvp as (
       select distinct on (cer.event_content_id)
              cer.event_content_id,
              case
                when cer.response::text = 'cancelled' then null
                else cer.response::text
              end as viewer_response
       from current_event_rsvps cer
       where cer.event_content_id = any($1::text[])
         and cer.membership_id = any($3::text[])
       order by cer.event_content_id, cer.version_no desc, cer.created_at desc
     )
     select base.*,
            viewer_rsvp.viewer_response,
            coalesce(attendee_agg.yes_count, 0) as yes_count,
            coalesce(attendee_agg.maybe_count, 0) as maybe_count,
            coalesce(attendee_agg.no_count, 0) as no_count,
            coalesce(attendee_agg.waitlist_count, 0) as waitlist_count,
            attendee_agg.attendees
     from base
     left join attendee_agg on attendee_agg.event_content_id = base.content_id
     left join viewer_rsvp on viewer_rsvp.event_content_id = base.content_id
     order by base.ord asc`,
    [contentIds, options.includeExpired ?? false, viewerMembershipIds],
  );

  return result.rows;
}

export async function readContentsByIds(
  client: DbClient,
  contentIds: string[],
  viewerMembershipIds: string[],
  readerScope: { memberId: string } | 'superadmin',
  options: { includeExpired?: boolean } = {},
): Promise<Content[]> {
  const result = await readContentsBundleByIds(client, contentIds, viewerMembershipIds, readerScope, options);
  return result.contents;
}

export async function readContentsBundleByIds(
  client: DbClient,
  contentIds: string[],
  viewerMembershipIds: string[],
  readerScope: { memberId: string } | 'superadmin',
  options: { includeExpired?: boolean } = {},
): Promise<{ contents: Content[]; included: IncludedBundle }> {
  const rows = await readContentRowsByIds(client, contentIds, viewerMembershipIds, options);
  if (rows.length === 0) {
    return { contents: [], included: emptyIncludedBundle() };
  }

  const mapped = rows.map(mapContentRow);
  const { mentionsByVersionId, included } = await loadEntityVersionMentions(
    client,
    rows.map((row) => row.content_version_id),
    readerScope,
  );

  const contents = mapped.map((content, index) =>
    withContentMentions(content, mentionsByVersionId.get(rows[index]!.content_version_id)));

  return { contents, included };
}

async function readContentById(
  client: DbClient,
  id: string,
  viewerMembershipIds: string[],
  readerScope: { memberId: string } | 'superadmin',
  options: { includeExpired?: boolean } = {},
): Promise<Content | null> {
  const result = await readContentBundle(client, id, viewerMembershipIds, readerScope, options);
  return result.content;
}

export async function readContentBundle(
  client: DbClient,
  id: string,
  viewerMembershipIds: string[],
  readerScope: { memberId: string } | 'superadmin',
  options: { includeExpired?: boolean } = {},
): Promise<WithIncluded<{ content: Content | null }>> {
  const { contents, included } = await readContentsBundleByIds(client, [id], viewerMembershipIds, readerScope, options);
  return {
    content: contents[0] ?? null,
    included,
  };
}

export async function readContent(
  pool: Pool,
  input: ReadContentInput,
): Promise<WithIncluded<{ content: Content }> | null> {
  return withTransaction(pool, async (client) => {
    const accessibleClubIds = [...new Set(input.accessibleMemberships.map((membership) => membership.clubId))];
    const target = await client.query<{ club_id: string }>(
      `select club_id
       from contents
       where id = $1
         and archived_at is null
         and deleted_at is null
         and club_id = any($2::text[])
       limit 1`,
      [input.id, accessibleClubIds],
    );
    const clubId = target.rows[0]?.club_id;
    if (!clubId) return null;
    const viewerMembershipIds = input.accessibleMemberships
      .filter((membership) => membership.clubId === clubId)
      .map((membership) => membership.membershipId);
    const result = await readContentBundle(client, input.id, viewerMembershipIds, { memberId: input.actorMemberId }, { includeExpired: false });
    return result.content ? { content: result.content, included: result.included } : null;
  });
}

async function insertEventVersionDetails(client: DbClient, contentVersionId: string, event: EventFields | null): Promise<void> {
  if (!event) return;
  await client.query(
    `insert into event_version_details (
       content_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      contentVersionId,
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
       e.thread_id,
       e.kind::text as kind,
       cev.title,
       cev.summary,
       cev.body,
       cev.expires_at::text as expires_at,
       evd.location,
       evd.starts_at::text as starts_at,
       evd.ends_at::text as ends_at,
       evd.timezone,
       evd.recurrence_rule,
       evd.capacity,
       not exists (
         select 1
         from contents earlier
         where earlier.thread_id = e.thread_id
           and earlier.archived_at is null
           and earlier.deleted_at is null
           and (
             earlier.created_at < e.created_at
             or (earlier.created_at = e.created_at and earlier.id < e.id)
           )
       ) as is_thread_subject
     from contents e
     join current_content_versions cev on cev.content_id = e.id
     left join event_version_details evd on evd.content_version_id = cev.id
     where e.author_member_id = $1
       and e.client_key = $2
       and e.archived_at is null
       and e.deleted_at is null`,
    [memberId, clientKey],
  );
  return result.rows[0] ?? null;
}

export async function createContent(pool: Pool, input: CreateContentInput): Promise<WithIncluded<{ content: Content }>> {
  const performCreate = async (client: DbClient): Promise<WithIncluded<{ content: Content }>> => {
    if (!input.threadId && !input.clubId) {
      throw new AppError('invalid_input', 'clubId is required when starting a new thread');
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
          ? existing.thread_id === existingThreadTarget?.threadId
          : existing.is_thread_subject;
        const samePayload =
          existing.club_id === (existingThreadTarget?.clubId ?? input.clubId) &&
          existing.kind === input.kind &&
          existing.title === (input.title ?? null) &&
          existing.summary === (input.summary ?? null) &&
          existing.body === (input.body ?? null) &&
          timestampsEqual(existing.expires_at, input.expiresAt) &&
          eventFieldsEqual(existing, canonicalizeEventFields(input.event ?? null));

        if (!sameThread || !samePayload) {
          throw new AppError('client_key_conflict',
            'This clientKey was already used with a different payload. Use a unique key per content.');
        }

        const viewerMembershipIds = await getViewerMembershipIds(
          client,
          input.authorMemberId,
          existingThreadTarget?.clubId ?? input.clubId,
        );
        const replay = await readContentBundle(
          client,
          existing.id,
          viewerMembershipIds,
          { memberId: input.authorMemberId },
          { includeExpired: true },
        );
        if (replay.content) return { content: replay.content, included: replay.included };
      }
    }

    const targetClubId = existingThreadTarget?.clubId ?? input.clubId!;
    const mentionScope = { memberId: input.authorMemberId } as const;
    const resolvedMentions = hasPotentialMentionChar(input.title, input.summary, input.body)
      ? await resolvePublicContentMentions(client, extractContentMentionCandidates(input), mentionScope)
      : emptyContentMentions();

    const target = existingThreadTarget
      ?? await createThreadTarget(client, input.authorMemberId, targetClubId);

    const contentResult = await client.query<{ id: string; created_at: string }>(
      `insert into contents (club_id, kind, author_member_id, open_loop, thread_id, client_key)
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
    const content = contentResult.rows[0];
    if (!content) {
      throw new AppError('missing_row', 'Created content row was not returned');
    }

    const versionResult = await client.query<{ id: string }>(
      `insert into content_versions (
         content_id, version_no, state, title, summary, body, expires_at, created_by_member_id
       ) values ($1, 1, 'published', $2, $3, $4, $5, $6)
       returning id`,
      [
        content.id,
        input.title,
        input.summary,
        input.body,
        input.expiresAt,
        input.authorMemberId,
      ],
    );
    const version = versionResult.rows[0];
    if (!version) {
      throw new AppError('missing_row', 'Created content version row was not returned');
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
        [target.threadId, content.created_at],
      );
    }

    await appendClubActivity(client, {
      clubId: target.clubId,
      contentId: content.id,
      contentVersionId: version.id,
      topic: 'content.version.published',
      creatorMemberId: input.authorMemberId,
    });

    await enqueueEmbeddingJob(client, version.id);

    const viewerMembershipIds = await getViewerMembershipIds(client, input.authorMemberId, target.clubId);
    const summary = await readContentBundle(
      client,
      content.id,
      viewerMembershipIds,
      mentionScope,
      { includeExpired: true },
    );
    if (!summary.content) {
      throw new AppError('missing_row', 'Created content could not be reloaded');
    }
    return { content: summary.content, included: summary.included };
  };

  return withTransaction(pool, async (client) => {
    if (!input.clientKey) {
      return performCreate(client);
    }
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: `member:${input.authorMemberId}:content.create`,
      requestValue: input,
      execute: async () => ({ responseValue: await performCreate(client) }),
    });
  });
}

export async function updateContent(pool: Pool, input: UpdateContentInput): Promise<WithIncluded<{ content: Content }> | null> {
  const performUpdate = async (client: DbClient): Promise<WithIncluded<{ content: Content }> | null> => {
    const currentResult = await client.query<CurrentEntityForUpdateRow>(
      `select
         e.id as content_id,
         e.club_id,
         c.slug as club_slug,
         c.name as club_name,
         e.thread_id,
         e.kind::text as kind,
         e.author_member_id,
         cev.id as version_id,
         cev.version_no,
         cev.title,
         cev.summary,
         cev.body,
         cev.expires_at::text as expires_at,
         evd.location,
         evd.starts_at::text as starts_at,
         evd.ends_at::text as ends_at,
         evd.timezone,
         evd.recurrence_rule,
         evd.capacity
       from contents e
       join clubs c on c.id = e.club_id
       join current_content_versions cev on cev.content_id = e.id
       left join event_version_details evd on evd.content_version_id = cev.id
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.archived_at is null
         and e.deleted_at is null
         and cev.state = 'published'`,
      [input.id, input.accessibleClubIds],
    );
    const current = currentResult.rows[0];
    if (!current) return null;
    if (current.author_member_id !== input.actorMemberId) {
      throw new AppError('forbidden', 'Only the original author may update this content.');
    }

    if (input.patch.event !== undefined && current.kind !== 'event') {
      throw new AppError('invalid_input', 'event fields may only be updated on event contents');
    }

    const nextCommon = {
      title: input.patch.title !== undefined ? input.patch.title : current.title,
      summary: input.patch.summary !== undefined ? input.patch.summary : current.summary,
      body: input.patch.body !== undefined ? input.patch.body : current.body,
      expiresAt: input.patch.expiresAt !== undefined ? input.patch.expiresAt : current.expires_at,
    };
    const nextEvent = current.kind === 'event'
      ? validateResolvedEventFields({
        location: input.patch.event?.location !== undefined ? input.patch.event.location ?? null : current.location,
        startsAt: input.patch.event?.startsAt !== undefined ? input.patch.event.startsAt ?? null : current.starts_at,
        endsAt: input.patch.event?.endsAt !== undefined ? input.patch.event.endsAt ?? null : current.ends_at,
        timezone: input.patch.event?.timezone !== undefined ? input.patch.event.timezone ?? null : current.timezone,
        recurrenceRule: input.patch.event?.recurrenceRule !== undefined ? input.patch.event.recurrenceRule ?? null : current.recurrence_rule,
        capacity: input.patch.event?.capacity !== undefined ? input.patch.event.capacity ?? null : current.capacity,
      })
      : null;

    const hasEffectiveChange = current.title !== nextCommon.title
      || current.summary !== nextCommon.summary
      || current.body !== nextCommon.body
      || !timestampsEqual(current.expires_at, nextCommon.expiresAt)
      || (current.kind === 'event' && !eventFieldsEqual(current, nextEvent));

    if (!hasEffectiveChange) {
      const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, current.club_id);
      const existing = await readContentBundle(
        client,
        current.content_id,
        viewerMembershipIds,
        { memberId: input.actorMemberId },
        { includeExpired: true },
      );
      return existing.content ? { content: existing.content, included: existing.included } : null;
    }

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

    const carriedMentions = await loadEntityVersionMentionsForVersion(client, current.version_id, {
      memberId: input.actorMemberId,
    });
    const changedMentions = changedMentionFields.length > 0
      ? await resolvePublicContentMentions(
        client,
        extractContentMentionCandidates({
          title: changedMentionFields.includes('title') ? nextCommon.title : null,
          summary: changedMentionFields.includes('summary') ? nextCommon.summary : null,
          body: changedMentionFields.includes('body') ? nextCommon.body : null,
        }),
        { memberId: input.actorMemberId },
      )
      : emptyContentMentions();

    const mergedMentions: ContentMentionsByField = {
      title: changedMentionFields.includes('title') ? changedMentions.title : carriedMentions.title,
      summary: changedMentionFields.includes('summary') ? changedMentions.summary : carriedMentions.summary,
      body: changedMentionFields.includes('body') ? changedMentions.body : carriedMentions.body,
    };
    const changedFieldSpanCount = changedMentionFields.reduce((total, field) => total + changedMentions[field].length, 0);
    applyContentMentionLimitsForUpdate(mergedMentions, changedFieldSpanCount);

    let versionResult;
    try {
      versionResult = await client.query<{ id: string; created_at: string }>(
        `insert into content_versions (
           content_id, version_no, state, title, summary, body, expires_at, supersedes_version_id, created_by_member_id
         ) values ($1, $2, 'published', $3, $4, $5, $6, $7, $8)
         returning id, created_at::text as created_at`,
        [
          current.content_id,
          current.version_no + 1,
          nextCommon.title,
          nextCommon.summary,
          nextCommon.body,
          nextCommon.expiresAt,
          current.version_id,
          input.actorMemberId,
        ],
      );
    } catch (error) {
      translate23505(error, 'content_versions_content_version_unique', 'version_conflict');
      throw error;
    }
    const version = versionResult.rows[0];
    if (!version) {
      throw new AppError('missing_row', 'Updated content version row was not returned');
    }

    await copyEntityVersionMentions(client, current.version_id, version.id, unchangedMentionFields);
    await insertEntityVersionMentions(client, version.id, changedMentions);

    if (current.kind === 'event') {
      if (!nextEvent) {
        throw new AppError('invalid_input', 'Event contents require both event.location and event.startsAt');
      }
      await insertEventVersionDetails(client, version.id, nextEvent);

      const recipientMemberIds = await listEventNotificationRecipientIds(
        client,
        current.content_id,
        input.actorMemberId,
      );
      await insertEventAttendeeNotifications(client, {
        topic: 'event.updated',
        event: {
          contentId: current.content_id,
          clubId: current.club_id,
          clubSlug: current.club_slug,
          clubName: current.club_name,
          title: nextCommon.title,
          location: nextEvent.location,
          startsAt: nextEvent.startsAt,
          endsAt: nextEvent.endsAt,
          timezone: nextEvent.timezone,
        },
        recipientMemberIds,
        changedAt: version.created_at,
        changedByMemberId: input.actorMemberId,
        contentId: current.content_id,
      });
    }

    await appendClubActivity(client, {
      clubId: current.club_id,
      contentId: current.content_id,
      contentVersionId: version.id,
      topic: 'content.version.published',
      creatorMemberId: input.actorMemberId,
    });

    await enqueueEmbeddingJob(client, version.id);

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, current.club_id);
    const summary = await readContentBundle(
      client,
      current.content_id,
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: true },
    );
    return summary.content ? { content: summary.content, included: summary.included } : null;
  };

  return withTransaction(pool, async (client) => {
    if (!input.clientKey) {
      return performUpdate(client);
    }
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: `member:${input.actorMemberId}:content.update:${input.id}`,
      requestValue: input,
      execute: async () => ({ responseValue: await performUpdate(client) }),
    });
  });
}

export async function loadContentForGate(pool: Pool, input: {
  actorMemberId: string;
  id: string;
  accessibleClubIds: string[];
}): Promise<ContentForGate | null> {
  const result = await pool.query<ContentForGateRow>(
    `select
       e.kind::text as content_kind,
       exists (
         select 1
                from contents earlier
         where earlier.thread_id = e.thread_id
           and earlier.archived_at is null
           and earlier.deleted_at is null
           and (
             earlier.created_at < e.created_at
             or (earlier.created_at = e.created_at and earlier.id < e.id)
           )
       ) as is_reply,
       cev.title,
       cev.summary,
       cev.body,
       cev.expires_at::text as expires_at,
       evd.location,
       evd.starts_at::text as starts_at,
       evd.ends_at::text as ends_at,
       evd.timezone,
       evd.recurrence_rule,
       evd.capacity
     from contents e
     join current_content_versions cev on cev.content_id = e.id
     left join event_version_details evd on evd.content_version_id = cev.id
     where e.id = $1
       and e.club_id = any($2::text[])
       and e.author_member_id = $3
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'
     limit 1`,
    [input.id, input.accessibleClubIds, input.actorMemberId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    contentKind: row.content_kind,
    isReply: row.is_reply,
    title: row.title,
    summary: row.summary,
    body: row.body,
    expiresAt: row.expires_at,
    event: row.content_kind === 'event' && row.location && row.starts_at
      ? {
        location: row.location,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        timezone: row.timezone,
        recurrenceRule: row.recurrence_rule,
        capacity: row.capacity,
      }
      : null,
  };
}

export async function removeContent(pool: Pool, input: {
  id: string;
  accessibleClubIds: string[];
  actorMemberId: string;
  reason?: string | null;
  moderatorRemoval?: { restrictToClubId: string } | null;
}): Promise<WithIncluded<{ content: Content }> | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      content_id: string;
      club_id: string;
      club_slug: string;
      club_name: string;
      kind: Content['kind'];
      author_member_id: string;
      version_id: string;
      version_no: number;
      state: string;
      title: string | null;
      location: string | null;
      starts_at: string | null;
      ends_at: string | null;
      timezone: string | null;
    }>(
      `select
         e.id as content_id,
         e.club_id,
         c.slug as club_slug,
         c.name as club_name,
         e.kind::text as kind,
         e.author_member_id,
         cev.id as version_id,
         cev.version_no,
         cev.state::text as state,
         cev.title,
         evd.location,
         evd.starts_at::text as starts_at,
         evd.ends_at::text as ends_at,
         evd.timezone
       from contents e
       join clubs c on c.id = e.club_id
       join current_content_versions cev on cev.content_id = e.id
       left join event_version_details evd on evd.content_version_id = cev.id
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.archived_at is null
         and e.deleted_at is null`,
      [input.id, input.accessibleClubIds],
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    if (input.moderatorRemoval && current.club_id !== input.moderatorRemoval.restrictToClubId) {
      throw new AppError('invalid_data', 'Moderator removal must be restricted to exactly one club');
    }

    const isModeratorRemoval = input.moderatorRemoval !== undefined && input.moderatorRemoval !== null;
    if (!isModeratorRemoval && current.author_member_id !== input.actorMemberId) {
      throw new AppError('forbidden', 'Only the original author may remove this content.');
    }

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, current.club_id);

    if (current.state === 'removed') {
      const existing = await readContentBundle(
        client,
        current.content_id,
        viewerMembershipIds,
        { memberId: input.actorMemberId },
        { includeExpired: true },
      );
      throw new AppError('content_already_removed', 'Content is already removed.', {
        details: existing.content ? { content: existing.content, included: existing.included } : undefined,
      });
    }

    let removeResult;
    try {
      removeResult = await client.query<{ id: string; created_at: string }>(
        `insert into content_versions (
           content_id, version_no, state, reason, supersedes_version_id, created_by_member_id
         ) values ($1, $2, 'removed', $3, $4, $5)
         returning id, created_at::text as created_at`,
        [current.content_id, current.version_no + 1, input.reason ?? null, current.version_id, input.actorMemberId],
      );
    } catch (error) {
      translate23505(error, 'content_versions_content_version_unique', 'version_conflict');
      throw error;
    }
    const removeVersion = removeResult.rows[0];
    if (removeVersion) {
      if (current.kind === 'event') {
        const recipientMemberIds = await listEventNotificationRecipientIds(
          client,
          current.content_id,
          input.actorMemberId,
        );
        await insertEventAttendeeNotifications(client, {
          topic: 'event.removed',
          event: {
            contentId: current.content_id,
            clubId: current.club_id,
            clubSlug: current.club_slug,
            clubName: current.club_name,
            title: current.title,
            location: current.location,
            startsAt: current.starts_at,
            endsAt: current.ends_at,
            timezone: current.timezone,
          },
          recipientMemberIds,
          changedAt: removeVersion.created_at,
          changedByMemberId: input.actorMemberId,
          reason: input.reason ?? null,
          contentId: null,
        });
      }

      await appendClubActivity(client, {
        clubId: current.club_id,
        contentId: current.content_id,
        contentVersionId: removeVersion.id,
        topic: 'content.removed',
        creatorMemberId: input.actorMemberId,
      });
    }

    const summary = await readContentBundle(
      client,
      current.content_id,
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: true },
    );
    return summary.content ? { content: summary.content, included: summary.included } : null;
  });
}

async function setContentLoopState(
  pool: Pool,
  input: SetContentLoopInput,
  nextOpenLoop: boolean,
): Promise<WithIncluded<{ content: Content }> | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      content_id: string;
      club_id: string;
      author_member_id: string;
      open_loop: boolean | null;
    }>(
      `select e.id as content_id,
              e.club_id,
              e.author_member_id,
              e.open_loop
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       where e.id = $1
         and e.club_id = any($2::text[])
         and e.archived_at is null
         and e.deleted_at is null
         and cev.state = 'published'`,
      [input.id, input.accessibleClubIds],
    );

    const row = currentResult.rows[0];
    if (!row) return null;
    if (row.author_member_id !== input.actorMemberId) {
      throw new AppError('forbidden', 'Only the original author may change this content loop state.');
    }
    if (row.open_loop === null) {
      throw new AppError('invalid_state', 'Content is not loopable.', {
        details: await buildContentErrorDetails(client, {
          contentId: row.content_id,
          actorMemberId: input.actorMemberId,
          clubId: row.club_id,
        }),
      });
    }

    await client.query(
      `update contents
       set open_loop = $2
       where id = $1`,
      [row.content_id, nextOpenLoop],
    );

    const viewerMembershipIds = await getViewerMembershipIds(client, input.actorMemberId, row.club_id);
    const summary = await readContentBundle(
      client,
      row.content_id,
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: true },
    );
    return summary.content ? { content: summary.content, included: summary.included } : null;
  });
}

export async function closeContentLoop(pool: Pool, input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null> {
  return setContentLoopState(pool, input, false);
}

export async function reopenContentLoop(pool: Pool, input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null> {
  return setContentLoopState(pool, input, true);
}

export type PaginatedThreads = WithIncluded<{ results: ContentThread[]; hasMore: boolean; nextCursor: string | null }>;

async function loadThreadSummaryRows(
  client: DbClient,
  input: {
    actorMemberId: string;
    clubIds: string[];
    kinds: string[];
    limit: number;
    query?: string;
    includeClosed: boolean;
    cursor?: { latestActivityAt: string; threadId: string } | null;
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
       select e.thread_id, count(*)::int as content_count
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       join thread_scope ts on ts.id = e.thread_id
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
       group by e.thread_id
     ),
     first_contents as (
       select distinct on (e.thread_id)
              e.thread_id as thread_id,
              e.id as content_id,
              e.kind::text as kind,
              e.open_loop,
              e.author_member_id,
              cev.state::text as state,
              cev.title,
              cev.summary,
              cev.body
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       join thread_scope ts on ts.id = e.thread_id
       where e.archived_at is null
         and e.deleted_at is null
       order by e.thread_id, e.created_at asc, e.id asc
     ),
     visible_threads as (
       select distinct e.thread_id
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       join thread_scope ts on ts.id = e.thread_id
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
       fe.content_id as first_content_id,
       tc.content_count,
       ts.last_activity_at::text as last_activity_at
     from thread_scope ts
     join thread_counts tc on tc.thread_id = ts.id
     join first_contents fe on fe.thread_id = ts.id
     where fe.kind = any($2::text[])
       and exists (
         select 1
         from visible_threads vt
         where vt.thread_id = ts.id
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
      input.cursor?.latestActivityAt ?? null,
      input.cursor?.threadId ?? null,
      likePattern,
      input.limit + 1,
    ],
  );

  return result.rows;
}

export async function listContent(pool: Pool, input: ListContentInput): Promise<PaginatedThreads> {
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
    const firstContentBundle = await readContentsBundleByIds(
      client,
      pageRows.map(row => row.first_content_id),
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: true },
    );
    const firstContentById = new Map(firstContentBundle.contents.map(content => [content.id, content]));

    const results = pageRows
      .map((row) => {
        const firstContent = firstContentById.get(row.first_content_id);
        if (!firstContent) return null;
        return {
          id: row.thread_id,
          clubId: row.club_id,
          firstContent,
          contentCount: Number(row.content_count),
          latestActivityAt: row.last_activity_at,
        } satisfies ContentThread;
      })
      .filter((row): row is ContentThread => row !== null);

    const lastRow = results.length > 0 ? pageRows[results.length - 1] : null;
    const nextCursor = hasMore && lastRow
      ? encodeCursor([lastRow.last_activity_at, lastRow.thread_id])
      : null;

    return { results, hasMore, nextCursor, included: firstContentBundle.included };
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
       select distinct on (e.thread_id)
              e.thread_id as thread_id,
              e.id as content_id,
              e.kind::text as kind,
              e.open_loop,
              e.author_member_id,
              cev.state::text as state
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       where e.thread_id = $1
         and e.archived_at is null
         and e.deleted_at is null
       order by e.thread_id, e.created_at asc, e.id asc
     ),
     thread_counts as (
       select e.thread_id, count(*)::int as content_count
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       where e.thread_id = $1
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
       group by e.thread_id
     ),
     visible_thread as (
       select 1
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       where e.thread_id = $1
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
       first_entity.content_id as first_content_id,
       thread_counts.content_count,
       ct.last_activity_at::text as last_activity_at
     from content_threads ct
     join first_entity on first_entity.thread_id = ct.id
     join thread_counts on thread_counts.thread_id = ct.id
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
): Promise<WithIncluded<{ thread: ContentThread; contents: Content[]; hasMore: boolean; nextCursor: string | null }> | null> {
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
      : (await client.query<{ thread_id: string }>(
        `select e.thread_id
         from contents e
         where e.id = $1
           and e.archived_at is null
           and e.deleted_at is null
           and e.club_id = any($2::text[])`,
        [input.contentId ?? null, input.accessibleClubIds],
      )).rows[0]?.thread_id;

    if (!resolvedThreadId) return null;

    const threadRow = await loadThreadHeader(client, input.actorMemberId, resolvedThreadId, input.includeClosed);
    if (!threadRow) return null;

    const viewerMembershipIds = input.accessibleMemberships
      .filter(membership => membership.clubId === threadRow.club_id)
      .map(membership => membership.membershipId);

    const firstContentBundle = await readContentBundle(
      client,
      threadRow.first_content_id,
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: true },
    );
    if (!firstContentBundle.content) return null;

    const pageResult = await client.query<{ content_id: string; created_at: string }>(
      `select e.id as content_id, e.created_at::text as created_at
       from contents e
       join current_content_versions cev on cev.content_id = e.id
       where e.thread_id = $1
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
        input.cursor?.contentId ?? null,
        input.includeClosed,
        input.limit + 1,
      ],
    );

    const hasMore = pageResult.rows.length > input.limit;
    const pageRows = hasMore ? pageResult.rows.slice(0, input.limit) : pageResult.rows;
    const pageContentIds = [...pageRows].reverse().map(row => row.content_id);
    const contentBundle = await readContentsBundleByIds(
      client,
      pageContentIds,
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: false },
    );

    const oldest = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && oldest
      ? encodeCursor([oldest.created_at, oldest.content_id])
      : null;

    return {
      thread: {
        id: threadRow.thread_id,
        clubId: threadRow.club_id,
        firstContent: firstContentBundle.content,
        contentCount: Number(threadRow.content_count),
        latestActivityAt: threadRow.last_activity_at,
      },
      contents: contentBundle.contents,
      hasMore,
      nextCursor,
      included: mergeIncludedBundles(firstContentBundle.included, contentBundle.included),
    };
  });
}

export async function appendClubActivity(client: DbClient, input: {
  clubId: string;
  contentId?: string;
  contentVersionId?: string;
  topic: string;
  creatorMemberId: string | null;
  payload?: Record<string, unknown>;
  audience?: 'members' | 'clubadmins' | 'owners';
}): Promise<void> {
  await client.query(
    `insert into club_activity (club_id, content_id, content_version_id, topic, payload, created_by_member_id, audience)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      input.clubId,
      input.contentId ?? null,
      input.contentVersionId ?? null,
      input.topic,
      JSON.stringify(input.payload ?? {}),
      input.creatorMemberId,
      input.audience ?? 'members',
    ],
  );
}
