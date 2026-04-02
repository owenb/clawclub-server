import type { Pool } from 'pg';
import { enforceQuota } from './quotas.ts';
import type {
  CreateEventInput,
  EventRsvpState,
  EventSummary,
  ListEventsInput,
  Repository,
  RsvpEventInput,
} from '../app.ts';
import { requireReturnedRow } from './query-guards.ts';
import { buildContainsLikePattern, buildPrefixLikePattern, normalizeSearchQuery } from './search.ts';
import { appendEntityVersionUpdates } from './updates.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';
import { buildEntityUpdatePayload } from './entities.ts';

type EventRsvpAttendeeRow = {
  membershipId: string;
  memberId: string;
  publicName: string;
  handle: string | null;
  response: EventRsvpState;
  note: string | null;
  createdAt: string;
};

type EventRow = {
  entity_id: string;
  entity_version_id: string;
  club_id: string;
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  version_no: number;
  state: 'published';
  title: string | null;
  summary: string | null;
  body: string | null;
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
  viewer_response: EventRsvpState | null;
  yes_count: number;
  maybe_count: number;
  no_count: number;
  waitlist_count: number;
  attendees: EventRsvpAttendeeRow[] | null;
};

function mapEventRow(row: EventRow): EventSummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    author: {
      memberId: row.author_member_id,
      publicName: row.author_public_name,
      handle: row.author_handle,
    },
    version: {
      versionNo: row.version_no,
      state: row.state,
      title: row.title,
      summary: row.summary,
      body: row.body,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      recurrenceRule: row.recurrence_rule,
      capacity: row.capacity,
      effectiveAt: row.effective_at,
      expiresAt: row.expires_at,
      createdAt: row.version_created_at,
      content: row.content ?? {},
    },
    rsvps: {
      viewerResponse: row.viewer_response,
      counts: {
        yes: Number(row.yes_count ?? 0),
        maybe: Number(row.maybe_count ?? 0),
        no: Number(row.no_count ?? 0),
        waitlist: Number(row.waitlist_count ?? 0),
      },
      attendees: row.attendees ?? [],
    },
    createdAt: row.entity_created_at,
  };
}

async function readEventSummaries(client: DbClient, actorMemberId: string, entityIds: string[]): Promise<EventSummary[]> {
  if (entityIds.length === 0) {
    return [];
  }

  const result = await client.query<EventRow>(
    `
      with actor_scope as (
        select distinct club_id
        from app.accessible_club_memberships
        where member_id = $1
      ),
      event_base as (
        select
          e.id as entity_id,
          cev.id as entity_version_id,
          e.club_id,
          e.author_member_id,
          m.public_name as author_public_name,
          m.handle as author_handle,
          cev.version_no,
          cev.state,
          cev.title,
          cev.summary,
          cev.body,
          cev.starts_at::text as starts_at,
          cev.ends_at::text as ends_at,
          cev.timezone,
          cev.recurrence_rule,
          cev.capacity,
          cev.effective_at::text as effective_at,
          cev.expires_at::text as expires_at,
          cev.created_at::text as version_created_at,
          cev.content,
          e.created_at::text as entity_created_at
        from app.entities e
        join actor_scope ac on ac.club_id = e.club_id
        join app.current_entity_versions cev on cev.entity_id = e.id
        join app.members m on m.id = e.author_member_id
        where e.id = any($2::app.short_id[])
          and e.kind = 'event'
          and e.archived_at is null
          and e.deleted_at is null
      ),
      attendee_rows as (
        select
          cer.event_entity_id,
          cer.membership_id,
          nm.member_id,
          mem.public_name,
          mem.handle,
          cer.response,
          cer.note,
          cer.created_at::text as created_at
        from app.current_event_rsvps cer
        join app.club_memberships nm on nm.id = cer.membership_id
        join app.members mem on mem.id = nm.member_id
        join event_base eb on eb.entity_id = cer.event_entity_id
      ),
      attendee_agg as (
        select
          event_entity_id,
          jsonb_agg(
            jsonb_build_object(
              'membershipId', membership_id,
              'memberId', member_id,
              'publicName', public_name,
              'handle', handle,
              'response', response,
              'note', note,
              'createdAt', created_at
            )
            order by created_at asc
          ) as attendees,
          count(*) filter (where response = 'yes')::int as yes_count,
          count(*) filter (where response = 'maybe')::int as maybe_count,
          count(*) filter (where response = 'no')::int as no_count,
          count(*) filter (where response = 'waitlist')::int as waitlist_count
        from attendee_rows
        group by event_entity_id
      ),
      viewer_rsvp as (
        select cer.event_entity_id, cer.response
        from app.current_event_rsvps cer
        join app.club_memberships nm on nm.id = cer.membership_id
        where nm.member_id = $1
      )
      select
        eb.*,
        vr.response as viewer_response,
        coalesce(aa.yes_count, 0) as yes_count,
        coalesce(aa.maybe_count, 0) as maybe_count,
        coalesce(aa.no_count, 0) as no_count,
        coalesce(aa.waitlist_count, 0) as waitlist_count,
        aa.attendees
      from event_base eb
      left join attendee_agg aa on aa.event_entity_id = eb.entity_id
      left join viewer_rsvp vr on vr.event_entity_id = eb.entity_id
    `,
    [actorMemberId, entityIds],
  );

  return result.rows.map(mapEventRow);
}

async function readEventSummary(client: DbClient, actorMemberId: string, entityId: string, entityVersionId?: string): Promise<EventSummary | null> {
  const result = await client.query<EventRow>(
    `
      with actor_scope as (
        select distinct club_id
        from app.accessible_club_memberships
        where member_id = $1
      ),
      event_base as (
        select
          e.id as entity_id,
          cev.id as entity_version_id,
          e.club_id,
          e.author_member_id,
          m.public_name as author_public_name,
          m.handle as author_handle,
          cev.version_no,
          cev.state,
          cev.title,
          cev.summary,
          cev.body,
          cev.starts_at::text as starts_at,
          cev.ends_at::text as ends_at,
          cev.timezone,
          cev.recurrence_rule,
          cev.capacity,
          cev.effective_at::text as effective_at,
          cev.expires_at::text as expires_at,
          cev.created_at::text as version_created_at,
          cev.content,
          e.created_at::text as entity_created_at
        from app.entities e
        join actor_scope ac on ac.club_id = e.club_id
        join app.current_entity_versions cev on cev.entity_id = e.id
        join app.members m on m.id = e.author_member_id
        where e.id = $2
          and e.kind = 'event'
          and e.archived_at is null
          and e.deleted_at is null
          and ($3::app.short_id is null or cev.id = $3)
      ),
      attendee_rows as (
        select
          cer.event_entity_id,
          cer.membership_id,
          nm.member_id,
          mem.public_name,
          mem.handle,
          cer.response,
          cer.note,
          cer.created_at::text as created_at
        from app.current_event_rsvps cer
        join app.club_memberships nm on nm.id = cer.membership_id
        join app.members mem on mem.id = nm.member_id
        join event_base eb on eb.entity_id = cer.event_entity_id
      ),
      attendee_agg as (
        select
          event_entity_id,
          jsonb_agg(
            jsonb_build_object(
              'membershipId', membership_id,
              'memberId', member_id,
              'publicName', public_name,
              'handle', handle,
              'response', response,
              'note', note,
              'createdAt', created_at
            )
            order by created_at asc
          ) as attendees,
          count(*) filter (where response = 'yes')::int as yes_count,
          count(*) filter (where response = 'maybe')::int as maybe_count,
          count(*) filter (where response = 'no')::int as no_count,
          count(*) filter (where response = 'waitlist')::int as waitlist_count
        from attendee_rows
        group by event_entity_id
      ),
      viewer_rsvp as (
        select cer.event_entity_id, cer.response
        from app.current_event_rsvps cer
        join app.club_memberships nm on nm.id = cer.membership_id
        where nm.member_id = $1
      )
      select
        eb.*,
        vr.response as viewer_response,
        coalesce(aa.yes_count, 0) as yes_count,
        coalesce(aa.maybe_count, 0) as maybe_count,
        coalesce(aa.no_count, 0) as no_count,
        coalesce(aa.waitlist_count, 0) as waitlist_count,
        aa.attendees
      from event_base eb
      left join attendee_agg aa on aa.event_entity_id = eb.entity_id
      left join viewer_rsvp vr on vr.event_entity_id = eb.entity_id
    `,
    [actorMemberId, entityId, entityVersionId ?? null],
  );

  return result.rows[0] ? mapEventRow(result.rows[0]) : null;
}

export function buildEventsRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  'createEvent' | 'listEvents' | 'rsvpEvent'
> {
  return {
    async createEvent(input: CreateEventInput): Promise<EventSummary> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.authorMemberId, [input.clubId]);
        await enforceQuota(client, input.authorMemberId, input.clubId, 'events.create');
        const entityResult = await client.query<{ id: string }>(
          `insert into app.entities (club_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
          [input.clubId, input.authorMemberId],
        );
        const entity = requireReturnedRow(entityResult.rows[0], 'Created event entity row was not returned');
        const entityId = entity.id;
        const versionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id, version_no, state, title, summary, body, starts_at, ends_at, timezone,
              recurrence_rule, capacity, expires_at, content, created_by_member_id
            )
            values ($1, 1, 'published', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
            returning id
          `,
          [
            entityId,
            input.title,
            input.summary,
            input.body,
            input.startsAt,
            input.endsAt,
            input.timezone,
            input.recurrenceRule,
            input.capacity,
            input.expiresAt,
            JSON.stringify(input.content),
            input.authorMemberId,
          ],
        );
        const createdVersion = requireReturnedRow(versionResult.rows[0], 'Created event version row was not returned');
        const event = requireReturnedRow(
          await readEventSummary(client, input.authorMemberId, entityId, createdVersion.id),
          'Created event could not be reloaded',
        );
        await appendEntityVersionUpdates(client, {
          clubId: event.clubId,
          entityId: event.entityId,
          entityVersionId: event.entityVersionId,
          topic: 'entity.version.published',
          createdByMemberId: input.authorMemberId,
          payload: buildEntityUpdatePayload({
            entityId: event.entityId,
            entityVersionId: event.entityVersionId,
            clubId: event.clubId,
            kind: 'event',
            state: event.version.state,
            author: event.author,
            title: event.version.title,
            summary: event.version.summary,
            body: event.version.body,
            effectiveAt: event.version.effectiveAt,
            expiresAt: event.version.expiresAt,
            content: event.version.content,
            startsAt: event.version.startsAt,
            endsAt: event.version.endsAt,
            timezone: event.version.timezone,
            recurrenceRule: event.version.recurrenceRule,
            capacity: event.version.capacity,
          }),
        });
        await client.query('commit');
        return event;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEvents({ actorMemberId, clubIds, limit, query }: ListEventsInput): Promise<EventSummary[]> {
      return withActorContext(pool, actorMemberId, clubIds, async (client) => {
        const trimmedQuery = normalizeSearchQuery(query);
        const likePattern = buildContainsLikePattern(trimmedQuery);
        const prefixPattern = buildPrefixLikePattern(trimmedQuery);

        const result = await client.query<{ entity_id: string }>(
          `
            with scope as (
              select unnest($1::text[])::app.short_id as club_id
            )
            select le.entity_id
            from scope s
            join app.live_entities le on le.club_id = s.club_id
            where le.kind = 'event'
              and (
                $3::text is null
                or coalesce(le.title, '') ilike $3 escape '\\'
                or coalesce(le.summary, '') ilike $3 escape '\\'
                or coalesce(le.body, '') ilike $3 escape '\\'
              )
            order by
              case
                when $2::text is null then 0
                when lower(coalesce(le.title, '')) = lower($2::text) then 400
                when lower(coalesce(le.title, '')) like lower($4::text) escape '\\' then 250
                when lower(coalesce(le.summary, '')) like lower($4::text) escape '\\' then 175
                when lower(coalesce(le.body, '')) like lower($4::text) escape '\\' then 120
                when coalesce(le.title, '') ilike $3 escape '\\' then 90
                when coalesce(le.summary, '') ilike $3 escape '\\' then 60
                when coalesce(le.body, '') ilike $3 escape '\\' then 30
                else 0
              end desc,
              coalesce(le.starts_at, le.effective_at) asc,
              le.entity_id asc
            limit $5
          `,
          [clubIds, trimmedQuery ?? null, likePattern, prefixPattern, limit],
        );

        return readEventSummaries(client, actorMemberId, result.rows.map((row) => row.entity_id));
      });
    },

    async rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleMemberships.map((membership) => membership.clubId));
        const eventResult = await client.query<{ entity_id: string; club_id: string }>(
          `
            select e.id as entity_id, e.club_id
            from app.entities e
            where e.id = $1
              and e.kind = 'event'
              and e.archived_at is null
              and e.deleted_at is null
          `,
          [input.eventEntityId],
        );
        const eventRow = eventResult.rows[0];
        if (!eventRow) {
          await client.query('rollback');
          return null;
        }

        const membership = input.accessibleMemberships.find((item) => item.clubId === eventRow.club_id);
        if (!membership) {
          await client.query('rollback');
          return null;
        }

        const currentResult = await client.query<{ id: string; version_no: number }>(
          `
            select id, version_no
            from app.current_event_rsvps
            where event_entity_id = $1
              and membership_id = $2
          `,
          [input.eventEntityId, membership.membershipId],
        );

        const current = currentResult.rows[0];
        await client.query(
          `
            insert into app.event_rsvps (
              event_entity_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            input.eventEntityId,
            membership.membershipId,
            input.response,
            input.note ?? null,
            (current?.version_no ?? 0) + 1,
            current?.id ?? null,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return await withActorContext(
          pool,
          input.actorMemberId,
          input.accessibleMemberships.map((membership) => membership.clubId),
          (scopedClient) => readEventSummary(scopedClient, input.actorMemberId, input.eventEntityId),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
