/**
 * Clubs domain — event operations (create, list, RSVP).
 *
 * Events are entities with kind='event' and extra version fields.
 */

import type { Pool } from 'pg';
import { AppError, type CreateEventInput, type EventSummary, type EventRsvpState, type ListEventsInput } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { appendClubActivity } from './entities.ts';

type EventRow = {
  entity_id: string;
  entity_version_id: string;
  club_id: string;
  author_member_id: string;
  version_no: number;
  state: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
  effective_at: string;
  expires_at: string | null;
  version_created_at: string;
  content: Record<string, unknown> | null;
  entity_created_at: string;
  author_public_name: string;
  author_handle: string | null;
  viewer_response: EventRsvpState | null;
  yes_count: number;
  maybe_count: number;
  no_count: number;
  waitlist_count: number;
  attendees: Array<{
    membershipId: string; memberId: string;
    publicName: string; handle: string | null;
    response: EventRsvpState;
    note: string | null; createdAt: string;
  }> | null;
};

/** Map event row. Author + attendee names come from JOINed member data. */
function mapEventRow(row: EventRow): EventSummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    author: { memberId: row.author_member_id, publicName: row.author_public_name, handle: row.author_handle },
    version: {
      versionNo: row.version_no,
      state: row.state as EventSummary['version']['state'],
      title: row.title, summary: row.summary, body: row.body,
      location: row.location,
      startsAt: row.starts_at, endsAt: row.ends_at,
      timezone: row.timezone, recurrenceRule: row.recurrence_rule,
      capacity: row.capacity,
      effectiveAt: row.effective_at, expiresAt: row.expires_at,
      createdAt: row.version_created_at, content: row.content ?? {},
    },
    rsvps: {
      viewerResponse: row.viewer_response,
      counts: {
        yes: Number(row.yes_count ?? 0), maybe: Number(row.maybe_count ?? 0),
        no: Number(row.no_count ?? 0), waitlist: Number(row.waitlist_count ?? 0),
      },
      attendees: (row.attendees ?? []).map((a) => ({
        membershipId: a.membershipId, memberId: a.memberId,
        publicName: a.publicName, handle: a.handle,
        response: a.response, note: a.note, createdAt: a.createdAt,
      })),
    },
    createdAt: row.entity_created_at,
  };
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES['entity'];
  await client.query(
    `insert into app.ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('entity_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

export async function readEventSummary(client: DbClient, entityId: string, viewerMembershipIds: string[], entityVersionId?: string): Promise<EventSummary | null> {
  const result = await client.query<EventRow>(
    `with event_base as (
       select e.id as entity_id, cev.id as entity_version_id, e.club_id,
              e.author_member_id, cev.version_no, cev.state,
              cev.title, cev.summary, cev.body, cev.location,
              cev.starts_at::text as starts_at, cev.ends_at::text as ends_at,
              cev.timezone, cev.recurrence_rule, cev.capacity,
              cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
              cev.created_at::text as version_created_at, cev.content,
              e.created_at::text as entity_created_at,
              m.public_name as author_public_name, m.handle as author_handle
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       join app.members m on m.id = e.author_member_id
       where e.id = $1 and e.kind = 'event' and e.archived_at is null and e.deleted_at is null
         and ($3::text is null or cev.id = $3)
     ),
     attendee_rows as (
       select cer.event_entity_id, cer.membership_id, cer.created_by_member_id as member_id,
              am.public_name, am.handle,
              cer.response, cer.note, cer.created_at::text as created_at
       from app.current_event_rsvps cer
       join event_base eb on eb.entity_id = cer.event_entity_id
       join app.members am on am.id = cer.created_by_member_id
     ),
     attendee_agg as (
       select event_entity_id,
              jsonb_agg(jsonb_build_object(
                'membershipId', membership_id, 'memberId', member_id,
                'publicName', public_name, 'handle', handle,
                'response', response, 'note', note, 'createdAt', created_at
              ) order by created_at asc) as attendees,
              count(*) filter (where response = 'yes')::int as yes_count,
              count(*) filter (where response = 'maybe')::int as maybe_count,
              count(*) filter (where response = 'no')::int as no_count,
              count(*) filter (where response = 'waitlist')::int as waitlist_count
       from attendee_rows group by event_entity_id
     ),
     viewer_rsvp as (
       select cer.event_entity_id, cer.response
       from app.current_event_rsvps cer
       where cer.membership_id = any($2::text[])
     )
     select eb.*,
            vr.response as viewer_response,
            coalesce(aa.yes_count, 0) as yes_count,
            coalesce(aa.maybe_count, 0) as maybe_count,
            coalesce(aa.no_count, 0) as no_count,
            coalesce(aa.waitlist_count, 0) as waitlist_count,
            aa.attendees
     from event_base eb
     left join attendee_agg aa on aa.event_entity_id = eb.entity_id
     left join viewer_rsvp vr on vr.event_entity_id = eb.entity_id`,
    [entityId, viewerMembershipIds, entityVersionId ?? null],
  );

  return result.rows[0] ? mapEventRow(result.rows[0]) : null;
}

export async function createEvent(pool: Pool, input: CreateEventInput): Promise<EventSummary> {
  return withTransaction(pool, async (client) => {
    // Idempotency: if clientKey provided, return existing event
    if (input.clientKey) {
      const existing = await client.query<{ id: string; club_id: string }>(
        `select id, club_id from app.entities where author_member_id = $1 and client_key = $2`,
        [input.authorMemberId, input.clientKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].club_id !== input.clubId) {
          throw new AppError(409, 'client_key_conflict',
            'This clientKey was already used for a different event. Use a unique key per event.');
        }
        const summary = await readEventSummary(client, existing.rows[0].id, []);
        if (summary) return summary;
      }
    }

    const entityResult = await client.query<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id, client_key) values ($1, 'event', $2, $3) returning id`,
      [input.clubId, input.authorMemberId, input.clientKey ?? null],
    );
    const entityId = entityResult.rows[0]?.id;
    if (!entityId) throw new AppError(500, 'missing_row', 'Created event entity row was not returned');

    const versionResult = await client.query<{ id: string }>(
      `insert into app.entity_versions (
         entity_id, version_no, state, title, summary, body, location, starts_at, ends_at,
         timezone, recurrence_rule, capacity, expires_at, content, created_by_member_id
       ) values ($1, 1, 'published', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       returning id`,
      [entityId, input.title, input.summary, input.body, input.location,
       input.startsAt, input.endsAt, input.timezone, input.recurrenceRule,
       input.capacity, input.expiresAt, JSON.stringify(input.content), input.authorMemberId],
    );
    const versionId = versionResult.rows[0]?.id;
    if (!versionId) throw new AppError(500, 'missing_row', 'Created event version row was not returned');

    const event = await readEventSummary(client, entityId, [], versionId);
    if (!event) throw new AppError(500, 'missing_row', 'Created event could not be reloaded');

    await appendClubActivity(client, {
      clubId: event.clubId,
      entityId: event.entityId,
      entityVersionId: event.entityVersionId,
      topic: 'entity.version.published',
      createdByMemberId: input.authorMemberId,
    });

    await enqueueEmbeddingJob(client, versionId);
    return event;
  });
}

export async function listEvents(pool: Pool, input: {
  clubIds: string[]; limit: number; query?: string; viewerMembershipIds: string[];
}): Promise<EventSummary[]> {
  if (input.clubIds.length === 0) return [];

  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;

  const entityResult = await pool.query<{ entity_id: string }>(
    `select le.entity_id
     from app.live_entities le
     where le.club_id = any($1::text[]) and le.kind = 'event'
       and ($3::text is null
         or coalesce(le.title, '') ilike $3 escape '\\'
         or coalesce(le.summary, '') ilike $3 escape '\\')
     order by le.effective_at desc, le.entity_id desc
     limit $2`,
    [input.clubIds, input.limit, likePattern],
  );

  if (entityResult.rows.length === 0) return [];

  const entityIds = entityResult.rows.map((r) => r.entity_id);

  // Read full event summaries with RSVPs
  const result = await pool.query<EventRow>(
    `with event_base as (
       select e.id as entity_id, cev.id as entity_version_id, e.club_id,
              e.author_member_id, cev.version_no, cev.state,
              cev.title, cev.summary, cev.body, cev.location,
              cev.starts_at::text as starts_at, cev.ends_at::text as ends_at,
              cev.timezone, cev.recurrence_rule, cev.capacity,
              cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
              cev.created_at::text as version_created_at, cev.content,
              e.created_at::text as entity_created_at,
              m.public_name as author_public_name, m.handle as author_handle
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       join app.members m on m.id = e.author_member_id
       where e.id = any($1::text[]) and e.kind = 'event'
     ),
     attendee_rows as (
       select cer.event_entity_id, cer.membership_id, cer.created_by_member_id as member_id,
              am.public_name, am.handle,
              cer.response, cer.note, cer.created_at::text as created_at
       from app.current_event_rsvps cer
       join event_base eb on eb.entity_id = cer.event_entity_id
       join app.members am on am.id = cer.created_by_member_id
     ),
     attendee_agg as (
       select event_entity_id,
              jsonb_agg(jsonb_build_object(
                'membershipId', membership_id, 'memberId', member_id,
                'publicName', public_name, 'handle', handle,
                'response', response, 'note', note, 'createdAt', created_at
              ) order by created_at asc) as attendees,
              count(*) filter (where response = 'yes')::int as yes_count,
              count(*) filter (where response = 'maybe')::int as maybe_count,
              count(*) filter (where response = 'no')::int as no_count,
              count(*) filter (where response = 'waitlist')::int as waitlist_count
       from attendee_rows group by event_entity_id
     ),
     viewer_rsvp as (
       select cer.event_entity_id, cer.response
       from app.current_event_rsvps cer
       where cer.membership_id = any($2::text[])
     )
     select eb.*,
            vr.response as viewer_response,
            coalesce(aa.yes_count, 0) as yes_count,
            coalesce(aa.maybe_count, 0) as maybe_count,
            coalesce(aa.no_count, 0) as no_count,
            coalesce(aa.waitlist_count, 0) as waitlist_count,
            aa.attendees
     from event_base eb
     left join attendee_agg aa on aa.event_entity_id = eb.entity_id
     left join viewer_rsvp vr on vr.event_entity_id = eb.entity_id
     order by eb.effective_at desc, eb.entity_id desc`,
    [entityIds, input.viewerMembershipIds],
  );

  return result.rows.map(mapEventRow);
}

export async function rsvpEvent(pool: Pool, input: {
  eventEntityId: string; membershipId: string; memberId: string;
  response: EventRsvpState; note?: string | null; clubIds: string[];
}): Promise<EventSummary | null> {
  return withTransaction(pool, async (client) => {
    // Verify event exists and is published
    const eventCheck = await client.query<{ entity_id: string; club_id: string }>(
      `select e.id as entity_id, e.club_id
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.kind = 'event' and e.club_id = any($2::text[])
         and e.deleted_at is null and cev.state = 'published'
       limit 1`,
      [input.eventEntityId, input.clubIds],
    );
    if (!eventCheck.rows[0]) return null;

    // Get current RSVP version
    const currentRsvp = await client.query<{ version_no: number; id: string }>(
      `select version_no, id from app.current_event_rsvps
       where event_entity_id = $1 and membership_id = $2 limit 1`,
      [input.eventEntityId, input.membershipId],
    );

    const versionNo = currentRsvp.rows[0] ? currentRsvp.rows[0].version_no + 1 : 1;
    const supersedesId = currentRsvp.rows[0]?.id ?? null;

    await client.query(
      `insert into app.event_rsvps (event_entity_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [input.eventEntityId, input.membershipId, input.response, input.note ?? null, versionNo, supersedesId, input.memberId],
    );

    return readEventSummary(client, input.eventEntityId, [input.membershipId]);
  });
}

export async function removeEvent(pool: Pool, input: {
  entityId: string; clubIds: string[]; actorMemberId: string;
  reason?: string | null; skipAuthCheck?: boolean;
}): Promise<EventSummary | null> {
  return withTransaction(pool, async (client) => {
    // Check if already removed — idempotent
    const alreadyRemoved = await client.query<{ entity_id: string }>(
      `select e.id as entity_id from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[]) and e.kind = 'event'
         and e.deleted_at is null and cev.state = 'removed'`,
      [input.entityId, input.clubIds],
    );
    if (alreadyRemoved.rows[0]) {
      return readEventSummary(client, input.entityId, []);
    }

    const currentResult = await client.query<{
      entity_id: string; author_member_id: string; version_id: string; version_no: number;
    }>(
      `select e.id as entity_id, e.author_member_id, cev.id as version_id, cev.version_no
       from app.entities e
       join app.current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.club_id = any($2::text[]) and e.kind = 'event'
         and e.deleted_at is null and cev.state = 'published'`,
      [input.entityId, input.clubIds],
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
      throw new AppError(403, 'forbidden', 'Only the author can remove this event');
    }

    await client.query(
      `insert into app.entity_versions (entity_id, version_no, state, reason, supersedes_version_id, created_by_member_id)
       values ($1, $2, 'removed', $3, $4, $5)`,
      [current.entity_id, current.version_no + 1, input.reason ?? null, current.version_id, input.actorMemberId],
    );

    return readEventSummary(client, current.entity_id, []);
  });
}
