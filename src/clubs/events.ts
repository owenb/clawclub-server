/**
 * Clubs domain — event-specific read and RSVP actions on top of unified content entities.
 */

import type { Pool } from 'pg';
import type { ContentEntity, EventRsvpState } from '../contract.ts';
import { withTransaction } from '../db.ts';
import { AppError } from '../contract.ts';
import { encodeCursor } from '../schemas/fields.ts';
import { readContentEntitiesByIds, readContentEntity } from './entities.ts';

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
  entityId: string;
  clubId: string;
};

async function resolveEventIdentity(
  pool: Pool,
  eventEntityId: string,
  clubIds: string[],
): Promise<EventIdentity | null> {
  const result = await pool.query<EventIdentity>(
    `select e.id as "entityId", e.club_id as "clubId"
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     where e.id = $1
       and e.kind = 'event'
       and e.club_id = any($2::text[])
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'
       and (cev.expires_at is null or cev.expires_at > now())`,
    [eventEntityId, clubIds],
  );
  return result.rows[0] ?? null;
}

export async function listEvents(pool: Pool, input: {
  actorMemberId: string;
  clubIds: string[];
  limit: number;
  query?: string;
  cursor?: { startsAt: string; entityId: string } | null;
}): Promise<{ results: ContentEntity[]; hasMore: boolean; nextCursor: string | null }> {
  if (input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null };

  const trimmedQuery = input.query?.trim().slice(0, 120) || null;
  const likePattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
  const fetchLimit = input.limit + 1;

  const identityRows = await pool.query<{ entity_id: string; starts_at: string }>(
    `select e.id as entity_id, evd.starts_at::text as starts_at
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     join event_version_details evd on evd.entity_version_id = cev.id
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
      input.cursor?.entityId ?? null,
      fetchLimit,
    ],
  );

  if (identityRows.rows.length === 0) return { results: [], hasMore: false, nextCursor: null };

  const hasMore = identityRows.rows.length > input.limit;
  const pageRows = hasMore ? identityRows.rows.slice(0, input.limit) : identityRows.rows;
  const viewerMembershipIds = await viewerMembershipIdsForClubs(pool, input.actorMemberId, input.clubIds);

  return withTransaction(pool, async (client) => {
    const entities = await readContentEntitiesByIds(
      client,
      pageRows.map(row => row.entity_id),
      viewerMembershipIds,
      { includeExpired: false },
    );

    const last = pageRows[pageRows.length - 1];
    return {
      results: entities,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor([last.starts_at, last.entity_id]) : null,
    };
  });
}

export async function rsvpEvent(pool: Pool, input: {
  actorMemberId: string;
  eventEntityId: string;
  response: EventRsvpState;
  note?: string | null;
  accessibleMemberships: Array<{ membershipId: string; clubId: string }>;
}): Promise<ContentEntity | null> {
  const clubIds = input.accessibleMemberships.map(membership => membership.clubId);
  const event = await resolveEventIdentity(pool, input.eventEntityId, clubIds);
  if (!event) return null;

  const membership = input.accessibleMemberships.find(item => item.clubId === event.clubId);
  if (!membership) return null;

  return withTransaction(pool, async (client) => {
    const currentRsvp = await client.query<{ version_no: number; id: string }>(
      `select version_no, id
       from current_event_rsvps
       where event_entity_id = $1
         and membership_id = $2
       limit 1`,
      [input.eventEntityId, membership.membershipId],
    );

    const versionNo = currentRsvp.rows[0] ? currentRsvp.rows[0].version_no + 1 : 1;
    const supersedesId = currentRsvp.rows[0]?.id ?? null;

    await client.query(
      `insert into event_rsvps (
         event_entity_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.eventEntityId,
        membership.membershipId,
        input.response,
        input.note ?? null,
        versionNo,
        supersedesId,
        input.actorMemberId,
      ],
    );

    return readContentEntity(client, input.eventEntityId, [membership.membershipId], { includeExpired: false });
  });
}

export async function cancelEventRsvp(pool: Pool, input: {
  actorMemberId: string;
  eventEntityId: string;
  accessibleMemberships: Array<{ membershipId: string; clubId: string }>;
}): Promise<ContentEntity | null> {
  const clubIds = input.accessibleMemberships.map(membership => membership.clubId);
  const event = await resolveEventIdentity(pool, input.eventEntityId, clubIds);
  if (!event) return null;

  const membership = input.accessibleMemberships.find(item => item.clubId === event.clubId);
  if (!membership) return null;

  return withTransaction(pool, async (client) => {
    const currentRsvp = await client.query<{ version_no: number; id: string; response: string }>(
      `select version_no, id, response::text as response
       from current_event_rsvps
       where event_entity_id = $1
         and membership_id = $2
       limit 1`,
      [input.eventEntityId, membership.membershipId],
    );

    if (!currentRsvp.rows[0] || currentRsvp.rows[0].response === 'cancelled') {
      return readContentEntity(client, input.eventEntityId, [membership.membershipId], { includeExpired: false });
    }

    await client.query(
      `insert into event_rsvps (
         event_entity_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
       ) values ($1, $2, 'cancelled', null, $3, $4, $5)`,
      [
        input.eventEntityId,
        membership.membershipId,
        currentRsvp.rows[0].version_no + 1,
        currentRsvp.rows[0].id,
        input.actorMemberId,
      ],
    );

    return readContentEntity(client, input.eventEntityId, [membership.membershipId], { includeExpired: false });
  });
}
