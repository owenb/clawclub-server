/**
 * Clubs domain — event-specific read and RSVP actions on top of unified content contents.
 */

import type { Pool } from 'pg';
import type { Content, ContentThread, EventRsvpState, WithIncluded } from '../repository.ts';
import { translate23505, translatePgCode, withTransaction, type DbClient } from '../db.ts';
import { AppError } from '../repository.ts';
import { deliverCoreNotifications } from '../notification-substrate.ts';
import { encodeCursor } from '../schemas/fields.ts';
import { readContentsBundleByIds, readContentBundle } from './content.ts';
import { emptyIncludedBundle } from '../mentions.ts';

async function viewerMembershipIdsForClubs(pool: Pool, actorMemberId: string, clubIds: string[]): Promise<string[]> {
  if (clubIds.length === 0) return [];
  const result = await pool.query<{ membership_id: string }>(
    `select id as membership_id
     from accessible_club_memberships
     where member_id = $1
       and club_id = any($2::text[])`,
    [actorMemberId, clubIds],
  );
  return result.rows.map(row => row.membership_id);
}

type EventIdentity = {
  contentId: string;
  clubId: string;
  kind: Content['kind'];
  authorMemberId: string;
  clubSlug: string;
  clubName: string;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  capacity: number | null;
  hasStarted: boolean;
};

async function resolveEventIdentity(
  db: DbClient,
  eventId: string,
  clubIds: string[],
): Promise<EventIdentity | null> {
  const result = await db.query<EventIdentity>(
    `select e.id as "contentId",
            e.club_id as "clubId",
            e.kind::text as "kind",
            e.author_member_id as "authorMemberId",
            c.slug as "clubSlug",
            c.name as "clubName",
            cev.title,
            evd.starts_at::text as "startsAt",
            evd.ends_at::text as "endsAt",
            evd.location,
            evd.capacity,
            coalesce(evd.starts_at <= now(), false) as "hasStarted"
     from contents e
     join current_content_versions cev on cev.content_id = e.id
     join clubs c on c.id = e.club_id
     left join event_version_details evd on evd.content_version_id = cev.id
     where e.id = $1
       and e.club_id = any($2::text[])
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'
       and (cev.expires_at is null or cev.expires_at > now())`,
    [eventId, clubIds],
  );
  return result.rows[0] ?? null;
}

async function throwInvalidEventTarget(
  client: DbClient,
  input: {
    event: EventIdentity;
    actorMemberId: string;
    membershipId: string;
  },
): Promise<never> {
  const content = await readContentBundle(
    client,
    input.event.contentId,
    [input.membershipId],
    { memberId: input.actorMemberId },
    { includeExpired: true },
  );
  throw new AppError('invalid_state', 'Content is not an event.', {
    details: content.content ? { content: content.content, included: content.included } : undefined,
  });
}

type EventRsvpNotificationResponse = EventRsvpState | 'cancelled';
type CurrentEventRsvp = {
  version_no: number;
  id: string;
  response: EventRsvpNotificationResponse;
};

async function readCurrentEventRsvp(
  client: DbClient,
  eventId: string,
  membershipId: string,
): Promise<CurrentEventRsvp | null> {
  const currentRsvp = await client.query<CurrentEventRsvp>(
    `select version_no, id, response::text as response
     from current_event_rsvps
     where event_content_id = $1
       and membership_id = $2
     limit 1`,
    [eventId, membershipId],
  );
  return currentRsvp.rows[0] ?? null;
}

async function countLiveYesRsvps(client: DbClient, eventId: string): Promise<number> {
  const result = await client.query<{ yes_count: number }>(
    `select count(*) filter (where response::text = 'yes')::int as yes_count
     from current_event_rsvps
     where event_content_id = $1`,
    [eventId],
  );
  return result.rows[0]?.yes_count ?? 0;
}

async function lockEventRsvpCapacityIfNeeded(
  client: DbClient,
  eventId: string,
  input: {
    requestedResponse: EventRsvpState;
    capacity: number | null;
  },
): Promise<void> {
  if (input.requestedResponse !== 'yes' || input.capacity === null) return;
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`event-rsvp-capacity:${eventId}`]);
}

function resolveStoredRsvpResponse(input: {
  requestedResponse: EventRsvpState;
  currentResponse: EventRsvpNotificationResponse | null;
  liveYesCount: number;
  capacity: number | null;
}): EventRsvpState {
  // waitlist is an explicit opt-in state; only "yes" consumes capacity and
  // auto-demotes once the event is full.
  if (input.requestedResponse !== 'yes' || input.capacity === null) {
    return input.requestedResponse;
  }

  const occupiedSeatsByOthers = input.liveYesCount - (input.currentResponse === 'yes' ? 1 : 0);
  return occupiedSeatsByOthers >= input.capacity ? 'waitlist' : 'yes';
}

function assertEventRsvpsOpen(event: EventIdentity): void {
  if (event.hasStarted) {
    throw new AppError('event_rsvp_closed', 'This event has already started, so RSVPs are closed.');
  }
}

async function assertEventRsvpWriteAvailable(
  client: DbClient,
  eventId: string,
  membershipId: string,
): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    `select pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) as acquired`,
    [eventId, membershipId],
  );
  if (!result.rows[0]?.acquired) {
    throw new AppError('version_conflict', 'This resource was modified concurrently. Retry.');
  }
}

async function readMemberPublicName(client: DbClient, memberId: string): Promise<string | null> {
  const result = await client.query<{ public_name: string }>(
    `select public_name
     from members
     where id = $1
     limit 1`,
    [memberId],
  );
  return result.rows[0]?.public_name ?? null;
}

async function insertEventRsvpNotification(
  client: DbClient,
  input: {
    event: EventIdentity;
    attendeeMembershipId: string;
    attendeeMemberId: string;
    response: EventRsvpNotificationResponse;
    previousResponse: EventRsvpNotificationResponse | null;
    note: string | null;
    createdAt: string;
  },
): Promise<void> {
  if (input.event.authorMemberId === input.attendeeMemberId) {
    return;
  }

  const attendeePublicName = await readMemberPublicName(client, input.attendeeMemberId);
  if (!attendeePublicName) {
    return;
  }

  await deliverCoreNotifications(client, [{
    clubId: input.event.clubId,
    recipientMemberId: input.event.authorMemberId,
    topic: 'event.rsvp.updated',
    payloadVersion: 1,
    payload: {
      event: {
        contentId: input.event.contentId,
        title: input.event.title,
        startsAt: input.event.startsAt,
        endsAt: input.event.endsAt,
        location: input.event.location,
      },
      club: {
        clubId: input.event.clubId,
        slug: input.event.clubSlug,
        name: input.event.clubName,
      },
      attendee: {
        membershipId: input.attendeeMembershipId,
        memberId: input.attendeeMemberId,
        publicName: attendeePublicName,
      },
      response: input.response,
      previousResponse: input.previousResponse,
      note: input.note,
      createdAt: input.createdAt,
    },
    refs: [
      { role: 'subject', kind: 'content', id: input.event.contentId },
      { role: 'club_context', kind: 'club', id: input.event.clubId },
      { role: 'actor', kind: 'member', id: input.attendeeMemberId },
      { role: 'target', kind: 'membership', id: input.attendeeMembershipId },
    ],
  }]);
}

export async function listEvents(pool: Pool, input: {
  actorMemberId: string;
  clubIds: string[];
  limit: number;
  query?: string;
  cursor?: { startsAt: string; contentId: string } | null;
}): Promise<WithIncluded<{ results: ContentThread[]; hasMore: boolean; nextCursor: string | null }>> {
  if (input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null, included: emptyIncludedBundle() };

  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
  const fetchLimit = input.limit + 1;

  const identityRows = await pool.query<{ content_id: string; thread_id: string; club_id: string; content_count: number; latest_activity_at: string; starts_at: string }>(
    `select e.id as content_id,
            e.thread_id,
            e.club_id,
            (select count(*)::int
             from contents sibling
             where sibling.thread_id = e.thread_id
               and sibling.archived_at is null
               and sibling.deleted_at is null) as content_count,
            ct.last_activity_at::text as latest_activity_at,
            evd.starts_at::text as starts_at
     from contents e
     join content_threads ct on ct.id = e.thread_id
     join current_content_versions cev on cev.content_id = e.id
     join event_version_details evd on evd.content_version_id = cev.id
     where e.kind = 'event'
       and e.club_id = any($1::text[])
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'
       and (cev.expires_at is null or cev.expires_at > now())
       and evd.starts_at is not null
       and ($2::text is null
         or coalesce(cev.title, '') ilike $3 escape '\\'
         or coalesce(cev.summary, '') ilike $3 escape '\\'
         or coalesce(cev.body, '') ilike $3 escape '\\')
       and ($4::timestamptz is null
         or evd.starts_at > $4
         or (evd.starts_at = $4 and e.id > $5))
     order by evd.starts_at asc, e.id asc
     limit $6`,
    [
      input.clubIds,
      trimmedQuery,
      likePattern,
      input.cursor?.startsAt ?? null,
      input.cursor?.contentId ?? null,
      fetchLimit,
    ],
  );

  if (identityRows.rows.length === 0) {
    return { results: [], hasMore: false, nextCursor: null, included: emptyIncludedBundle() };
  }

  const hasMore = identityRows.rows.length > input.limit;
  const pageRows = hasMore ? identityRows.rows.slice(0, input.limit) : identityRows.rows;
  const viewerMembershipIds = await viewerMembershipIdsForClubs(pool, input.actorMemberId, input.clubIds);

  return withTransaction(pool, async (client) => {
    const bundle = await readContentsBundleByIds(
      client,
      pageRows.map(row => row.content_id),
      viewerMembershipIds,
      { memberId: input.actorMemberId },
      { includeExpired: false },
    );

    const last = pageRows[pageRows.length - 1];
    const contentById = new Map(bundle.contents.map((content) => [content.id, content]));
    return {
      results: pageRows
        .map((row) => {
          const content = contentById.get(row.content_id);
          if (!content) return null;
          return {
            id: row.thread_id,
            clubId: row.club_id,
            content,
            contentCount: Number(row.content_count),
            latestActivityAt: row.latest_activity_at,
          } satisfies ContentThread;
        })
        .filter((row): row is ContentThread => row !== null),
      hasMore,
      nextCursor: hasMore && last ? encodeCursor([last.starts_at, last.content_id]) : null,
      included: bundle.included,
    };
  });
}

export async function rsvpEvent(pool: Pool, input: {
  actorMemberId: string;
  eventId: string;
  response: EventRsvpState;
  note?: string | null;
  accessibleMemberships: Array<{ membershipId: string; clubId: string }>;
}): Promise<WithIncluded<{ content: Content }> | null> {
  const clubIds = input.accessibleMemberships.map(membership => membership.clubId);
  try {
    return await withTransaction(pool, async (client) => {
      const event = await resolveEventIdentity(client, input.eventId, clubIds);
      if (!event) return null;

      const membership = input.accessibleMemberships.find(item => item.clubId === event.clubId);
      if (!membership) return null;
      if (event.kind !== 'event') {
        await throwInvalidEventTarget(client, {
          event,
          actorMemberId: input.actorMemberId,
          membershipId: membership.membershipId,
        });
      }

      await assertEventRsvpWriteAvailable(client, input.eventId, membership.membershipId);
      assertEventRsvpsOpen(event);
      await lockEventRsvpCapacityIfNeeded(client, input.eventId, {
        requestedResponse: input.response,
        capacity: event.capacity,
      });

      const currentRsvp = await readCurrentEventRsvp(client, input.eventId, membership.membershipId);
      const storedResponse = resolveStoredRsvpResponse({
        requestedResponse: input.response,
        currentResponse: currentRsvp?.response ?? null,
        liveYesCount: await countLiveYesRsvps(client, input.eventId),
        capacity: event.capacity,
      });
      const versionNo = currentRsvp ? currentRsvp.version_no + 1 : 1;
      const supersedesId = currentRsvp?.id ?? null;

      let insertResult;
      try {
        insertResult = await client.query<{ created_at: string }>(
          `insert into event_rsvps (
             event_content_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
           ) values ($1, $2, $3, $4, $5, $6, $7)
           returning created_at::text as created_at`,
          [
            input.eventId,
            membership.membershipId,
            storedResponse,
            input.note ?? null,
            versionNo,
            supersedesId,
            input.actorMemberId,
          ],
        );
      } catch (error) {
        translate23505(error, 'event_rsvps_event_content_membership_version_unique', 'version_conflict');
        throw error;
      }

      await insertEventRsvpNotification(client, {
        event,
        attendeeMembershipId: membership.membershipId,
        attendeeMemberId: input.actorMemberId,
        response: storedResponse,
        previousResponse: currentRsvp?.response ?? null,
        note: input.note ?? null,
        createdAt: insertResult.rows[0]?.created_at ?? new Date().toISOString(),
      });

      const result = await readContentBundle(
        client,
        input.eventId,
        [membership.membershipId],
        { memberId: input.actorMemberId },
        { includeExpired: false },
      );
      return result.content ? { content: result.content, included: result.included } : null;
    }, {
      isolationLevel: 'serializable',
      retrySerializationFailures: 2,
    });
  } catch (error) {
    translatePgCode(error, '40001', 'version_conflict', 'This resource was modified concurrently. Retry.');
    throw error;
  }
}

export async function cancelEventRsvp(pool: Pool, input: {
  actorMemberId: string;
  eventId: string;
  accessibleMemberships: Array<{ membershipId: string; clubId: string }>;
}): Promise<WithIncluded<{ content: Content }> | null> {
  const clubIds = input.accessibleMemberships.map(membership => membership.clubId);
  return withTransaction(pool, async (client) => {
    const event = await resolveEventIdentity(client, input.eventId, clubIds);
    if (!event) return null;

    const membership = input.accessibleMemberships.find(item => item.clubId === event.clubId);
    if (!membership) return null;
    if (event.kind !== 'event') {
      await throwInvalidEventTarget(client, {
        event,
        actorMemberId: input.actorMemberId,
        membershipId: membership.membershipId,
      });
    }

    await assertEventRsvpWriteAvailable(client, input.eventId, membership.membershipId);
    assertEventRsvpsOpen(event);

    const currentRsvp = await client.query<{ version_no: number; id: string; response: string }>(
      `select version_no, id, response::text as response
       from current_event_rsvps
       where event_content_id = $1
         and membership_id = $2
       limit 1`,
      [input.eventId, membership.membershipId],
    );

    if (!currentRsvp.rows[0] || currentRsvp.rows[0].response === 'cancelled') {
      const result = await readContentBundle(
        client,
        input.eventId,
        [membership.membershipId],
        { memberId: input.actorMemberId },
        { includeExpired: false },
      );
      return result.content ? { content: result.content, included: result.included } : null;
    }

    let insertResult;
    try {
      insertResult = await client.query<{ created_at: string }>(
        `insert into event_rsvps (
           event_content_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
         ) values ($1, $2, 'cancelled', null, $3, $4, $5)
         returning created_at::text as created_at`,
        [
          input.eventId,
          membership.membershipId,
          currentRsvp.rows[0].version_no + 1,
          currentRsvp.rows[0].id,
          input.actorMemberId,
        ],
      );
    } catch (error) {
      translate23505(error, 'event_rsvps_event_content_membership_version_unique', 'version_conflict');
      throw error;
    }

    await insertEventRsvpNotification(client, {
      event,
      attendeeMembershipId: membership.membershipId,
      attendeeMemberId: input.actorMemberId,
      response: 'cancelled',
      previousResponse: currentRsvp.rows[0].response as EventRsvpNotificationResponse,
      note: null,
      createdAt: insertResult.rows[0]?.created_at ?? new Date().toISOString(),
    });

    const result = await readContentBundle(
      client,
      input.eventId,
      [membership.membershipId],
      { memberId: input.actorMemberId },
      { includeExpired: false },
    );
    return result.content ? { content: result.content, included: result.included } : null;
  });
}
