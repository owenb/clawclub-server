/**
 * Postgres implementation of the Repository interface.
 *
 * Composes domain modules (identity, messaging, clubs) against a single
 * database pool. Operations that span modules (update streams,
 * admin aggregation) are coordinated here.
 */

import type { Pool } from 'pg';
import {
  AppError,
  type Repository,
  type EntitySummary,
  type MembershipVouchSummary,
  type IncludedBundle,
  type IncludedMember,
  type MessageFramePayload,
  type NotificationItem,
  type NotificationReceipt,
} from './contract.ts';
import { withTransaction } from './db.ts';
import { createIdentityRepository, type IdentityRepository } from './identity/index.ts';
import { createMessagingRepository, type MessagingRepository } from './messages/index.ts';
import { createClubsRepository, batchListVouches, type ClubsRepository } from './clubs/index.ts';
import * as unifiedClubs from './clubs/unified.ts';
import {
  emptyIncludedBundle,
  loadIncludedMembers,
  loadEntityVersionMentions,
  loadDmMentions,
  preflightContentCreateMentions,
  preflightContentUpdateMentions,
} from './mentions.ts';
import {
  encodeCursor as paginationEncodeCursor,
  decodeCursor as paginationDecodeCursor,
} from './schemas/fields.ts';
import {
  NOTIFICATIONS_PAGE_SIZE,
  encodeNotificationCursor,
  decodeNotificationCursor,
} from './notifications-core.ts';

// ── Enrichment helpers ──────────────────────────────────────

function mapVouchToSummary(v: { edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null }): MembershipVouchSummary {
  return {
    edgeId: v.edgeId,
    fromMember: { memberId: v.fromMemberId, publicName: v.fromPublicName },
    reason: v.reason,
    metadata: v.metadata,
    createdAt: v.createdAt,
    createdByMemberId: v.createdByMemberId,
  };
}

function mergeIncludedById(...bundles: IncludedBundle[]): IncludedBundle {
  const membersById: Record<string, IncludedMember> = {};
  for (const bundle of bundles) {
    Object.assign(membersById, bundle.membersById);
  }
  return { membersById };
}

function buildNotificationId(kind: string, primaryRef: string): string {
  return `${kind}:${primaryRef}`;
}

function splitNotificationId(notificationId: string): { kind: string; primaryRef: string } | null {
  const separator = notificationId.lastIndexOf(':');
  if (separator <= 0 || separator === notificationId.length - 1) {
    return null;
  }
  return {
    kind: notificationId.slice(0, separator),
    primaryRef: notificationId.slice(separator + 1),
  };
}

function encodeInboxCursor(createdAt: string, inboxEntryId: string): string {
  return paginationEncodeCursor([createdAt, inboxEntryId]);
}

function decodeInboxCursor(cursor: string): { createdAt: string; inboxEntryId: string } {
  const [createdAt, inboxEntryId] = paginationDecodeCursor(cursor, 2);
  return { createdAt, inboxEntryId };
}

function sortNotificationItems(a: NotificationItem, b: NotificationItem): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  return a.notificationId.localeCompare(b.notificationId);
}

async function listMaterializedNotifications(pool: Pool, input: {
  actorMemberId: string;
  accessibleClubIds: string[];
  limit: number;
  after: string | null;
}): Promise<NotificationItem[]> {
  const limit = Math.max(1, Math.min(input.limit, NOTIFICATIONS_PAGE_SIZE)) + 1;
  const afterCursor = input.after ? decodeNotificationCursor(input.after) : null;
  const afterNotification = afterCursor ? splitNotificationId(afterCursor.notificationId) : null;

  const result = await pool.query<{
    id: string;
    club_id: string | null;
    topic: string;
    payload: Record<string, unknown>;
    entity_id: string | null;
    match_id: string | null;
    acknowledged_state: 'processed' | 'suppressed' | null;
    created_at: string;
  }>(
    `select mn.id,
            mn.club_id,
            mn.topic,
            mn.payload,
            mn.entity_id,
            mn.match_id,
            mn.acknowledged_state,
            mn.created_at::text as created_at
     from member_notifications mn
     where mn.recipient_member_id = $1
       and (mn.club_id is null or mn.club_id = any($2::text[]))
       and mn.acknowledged_state is null
       and (
         $3::timestamptz is null
         or mn.created_at > $3
         or (
           mn.created_at = $3
           and (
             mn.topic > $4
             or (mn.topic = $4 and mn.id > $5)
           )
         )
       )
       and (
         mn.entity_id is null
         or exists (
           select 1 from current_entity_versions cev
           where cev.entity_id = mn.entity_id and cev.state = 'published'
         )
       )
       and (
         mn.topic <> 'synchronicity.offer_to_ask'
         or mn.payload->>'yourAskEntityId' is null
         or exists (
           select 1 from current_entity_versions cev
           where cev.entity_id = mn.payload->>'yourAskEntityId' and cev.state = 'published'
         )
       )
     order by mn.created_at asc, mn.topic asc, mn.id asc
     limit $6`,
    [
      input.actorMemberId,
      input.accessibleClubIds,
      afterCursor?.createdAt ?? null,
      afterNotification?.kind ?? null,
      afterNotification?.primaryRef ?? null,
      limit,
    ],
  );

  return result.rows.map((row) => {
    const notificationId = buildNotificationId(row.topic, row.id);
    return {
      notificationId,
      cursor: encodeNotificationCursor(row.created_at, notificationId),
      kind: row.topic,
      clubId: row.club_id,
      ref: {
        ...(row.match_id ? { matchId: row.match_id } : {}),
        ...(row.entity_id ? { entityId: row.entity_id } : {}),
      },
      payload: row.payload,
      createdAt: row.created_at,
      acknowledgeable: true,
      acknowledgedState: row.acknowledged_state,
    };
  });
}

async function listDerivedApplicationNotifications(pool: Pool, input: {
  adminClubIds: string[];
  limit: number;
  after: string | null;
}): Promise<NotificationItem[]> {
  if (input.adminClubIds.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(input.limit, NOTIFICATIONS_PAGE_SIZE)) + 1;
  const afterCursor = input.after ? decodeNotificationCursor(input.after) : null;

  const result = await pool.query<{
    membership_id: string;
    club_id: string;
    created_at: string;
  }>(
    `select cm.id as membership_id,
            cm.club_id,
            cm.state_created_at::text as created_at
     from current_club_memberships cm
     where cm.status = 'submitted'
       and cm.club_id = any($1::text[])
       and (
         $2::timestamptz is null
         or cm.state_created_at > $2
         or (cm.state_created_at = $2 and ('application.submitted:' || cm.id) > $3)
       )
     order by cm.state_created_at asc, cm.id asc
     limit $4`,
    [
      input.adminClubIds,
      afterCursor?.createdAt ?? null,
      afterCursor?.notificationId ?? null,
      limit,
    ],
  );

  return result.rows.map((row) => {
    const notificationId = buildNotificationId('application.submitted', row.membership_id);
    return {
      notificationId,
      cursor: encodeNotificationCursor(row.created_at, notificationId),
      kind: 'application.submitted',
      clubId: row.club_id,
      ref: { membershipId: row.membership_id },
      payload: { membershipId: row.membership_id },
      createdAt: row.created_at,
      acknowledgeable: false,
      acknowledgedState: null,
    };
  });
}

async function listInboxFramesSince(pool: Pool, input: {
  actorMemberId: string;
  after: string | null;
  limit: number;
}): Promise<{ frames: MessageFramePayload[]; nextAfter: string | null }> {
  const limit = Math.max(1, input.limit);
  const afterCursor = input.after ? decodeInboxCursor(input.after) : null;

  if (afterCursor === null) {
    const seed = await pool.query<{
      inbox_entry_id: string;
      created_at: string;
    }>(
      `select ie.id as inbox_entry_id,
              ie.created_at::text as created_at
       from dm_inbox_entries ie
       where ie.recipient_member_id = $1
         and ie.acknowledged = false
         and not exists (
           select 1 from dm_message_removals rmv where rmv.message_id = ie.message_id
         )
         and exists (
           select 1
           from dm_thread_participants self
           where self.thread_id = ie.thread_id
             and self.member_id = $1
             and self.left_at is null
         )
         and exists (
           select 1
           from dm_thread_participants other
           where other.thread_id = ie.thread_id
             and other.member_id <> $1
             and other.left_at is null
         )
       order by ie.created_at desc, ie.id desc
       limit 1`,
      [input.actorMemberId],
    );

    const head = seed.rows[0];
    if (!head) {
      const nowResult = await pool.query<{ created_at: string }>(
        `select clock_timestamp()::text as created_at`,
      );
      return {
        frames: [],
        nextAfter: encodeInboxCursor(nowResult.rows[0]?.created_at ?? new Date().toISOString(), ''),
      };
    }

    return {
      frames: [],
      nextAfter: encodeInboxCursor(head.created_at, head.inbox_entry_id),
    };
  }

  const inboxRows = await pool.query<{
    inbox_entry_id: string;
    thread_id: string;
    message_id: string;
    created_at: string;
  }>(
    `select ie.id as inbox_entry_id,
            ie.thread_id,
            ie.message_id,
            ie.created_at::text as created_at
     from dm_inbox_entries ie
     where ie.recipient_member_id = $1
       and ie.acknowledged = false
       and not exists (
         select 1 from dm_message_removals rmv where rmv.message_id = ie.message_id
       )
       and exists (
         select 1
         from dm_thread_participants self
         where self.thread_id = ie.thread_id
           and self.member_id = $1
           and self.left_at is null
       )
       and exists (
         select 1
         from dm_thread_participants other
         where other.thread_id = ie.thread_id
           and other.member_id <> $1
           and other.left_at is null
       )
       and (
         ie.created_at > $2::timestamptz
         or (ie.created_at = $2::timestamptz and ie.id > $3)
       )
     order by ie.created_at asc, ie.id asc
     limit $4`,
    [input.actorMemberId, afterCursor.createdAt, afterCursor.inboxEntryId, limit],
  );

  if (inboxRows.rows.length === 0) {
    return { frames: [], nextAfter: input.after };
  }

  const messageIds = inboxRows.rows.map((row) => row.message_id);
  const threadIds = [...new Set(inboxRows.rows.map((row) => row.thread_id))];

  const messageResult = await pool.query<{
    message_id: string;
    thread_id: string;
    sender_member_id: string | null;
    role: 'member' | 'agent' | 'system';
    message_text: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
    in_reply_to_message_id: string | null;
  }>(
    `select m.id as message_id,
            m.thread_id,
            m.sender_member_id,
            m.role::text as role,
            m.message_text,
            m.payload,
            m.created_at::text as created_at,
            m.in_reply_to_message_id
     from dm_messages m
     where m.id = any($1::text[])`,
    [messageIds],
  );

  const messageMentions = await loadDmMentions(pool, messageIds);
  const messagesById = new Map(messageResult.rows.map((row) => {
    const message = {
      messageId: row.message_id,
      threadId: row.thread_id,
      senderMemberId: row.sender_member_id,
      role: row.role,
      messageText: row.message_text,
      mentions: messageMentions.mentionsByMessageId.get(row.message_id) ?? [],
      payload: row.payload ?? {},
      createdAt: row.created_at,
      inReplyToMessageId: row.in_reply_to_message_id,
    };
    return [row.message_id, message];
  }));

  const threadResult = await pool.query<{
    thread_id: string;
    counterpart_member_id: string;
    counterpart_public_name: string;
    counterpart_handle: string | null;
    latest_message_id: string;
    latest_sender_member_id: string | null;
    latest_role: 'member' | 'agent' | 'system';
    latest_message_text: string | null;
    latest_created_at: string;
    latest_is_removed: boolean;
    message_count: number;
  }>(
    `with counterparts as (
       select tp.thread_id,
              other.member_id as counterpart_member_id
       from dm_thread_participants tp
       join dm_thread_participants other
         on other.thread_id = tp.thread_id
        and other.member_id <> $1
       where tp.member_id = $1
         and tp.left_at is null
         and other.left_at is null
         and tp.thread_id = any($2::text[])
     ),
     latest_msg as (
       select distinct on (c.thread_id)
              c.thread_id,
              c.counterpart_member_id,
              m.id as latest_message_id,
              m.sender_member_id as latest_sender_member_id,
              m.role::text as latest_role,
              case when rmv.message_id is not null then '[Message removed]' else m.message_text end as latest_message_text,
              m.created_at::text as latest_created_at,
              (rmv.message_id is not null) as latest_is_removed,
              (select count(*)::int from dm_messages mm where mm.thread_id = c.thread_id) as message_count
       from counterparts c
       join dm_messages m on m.thread_id = c.thread_id
       left join dm_message_removals rmv on rmv.message_id = m.id
       order by c.thread_id, m.created_at desc, m.id desc
     )
     select lm.thread_id,
            lm.counterpart_member_id,
            mbr.public_name as counterpart_public_name,
            lm.latest_message_id,
            lm.latest_sender_member_id,
            lm.latest_role,
            lm.latest_message_text,
            lm.latest_created_at,
            lm.latest_is_removed,
            lm.message_count
     from latest_msg lm
     join members mbr on mbr.id = lm.counterpart_member_id`,
    [input.actorMemberId, threadIds],
  );

  const latestVisibleMessageIds = threadResult.rows
    .filter((row) => !row.latest_is_removed)
    .map((row) => row.latest_message_id);
  const latestThreadMentions = await loadDmMentions(pool, latestVisibleMessageIds);
  const sharedClubsMap = await batchResolveSharedClubs(
    pool,
    input.actorMemberId,
    [...new Set(threadResult.rows.map((row) => row.counterpart_member_id))],
  );

  const threadsById = new Map(threadResult.rows.map((row) => {
    const thread = {
      threadId: row.thread_id,
      sharedClubs: sharedClubsMap.get(row.counterpart_member_id) ?? [],
      counterpartMemberId: row.counterpart_member_id,
      counterpartPublicName: row.counterpart_public_name,
      latestMessage: {
        messageId: row.latest_message_id,
        senderMemberId: row.latest_sender_member_id,
        role: row.latest_role,
        messageText: row.latest_message_text,
        mentions: row.latest_is_removed ? [] : (latestThreadMentions.mentionsByMessageId.get(row.latest_message_id) ?? []),
        createdAt: row.latest_created_at,
      },
      messageCount: Number(row.message_count),
    };
    return [row.thread_id, thread];
  }));

  const frames = inboxRows.rows.flatMap((row) => {
    const thread = threadsById.get(row.thread_id);
    const message = messagesById.get(row.message_id);
    if (!thread) {
      throw new Error(`Missing DM thread summary for inbox row ${row.inbox_entry_id}`);
    }
    if (!message) {
      throw new Error(`Missing DM message ${row.message_id} for inbox row ${row.inbox_entry_id}`);
    }

    const included: IncludedBundle = {
      membersById: message.mentions.reduce<Record<string, IncludedMember>>((acc, mention) => {
        const member = messageMentions.included.membersById[mention.memberId];
        if (member) {
          acc[mention.memberId] = member;
        }
        return acc;
      }, {}),
    };

    return [{
      thread,
      messages: [message],
      included,
    }];
  });

  const lastInboxRow = inboxRows.rows[inboxRows.rows.length - 1];
  return {
    frames,
    nextAfter: lastInboxRow ? encodeInboxCursor(lastInboxRow.created_at, lastInboxRow.inbox_entry_id) : input.after,
  };
}

// ── Shared-club helpers for DMs ─────────────────────────────
// DMs are not club-scoped. These helpers resolve clubs currently shared
// between two members, used only for eligibility checks and response enrichment.

type SharedClubRow = { club_id: string; slug: string; name: string };

/** Resolve shared clubs between actor and another member, scoped to actor's accessible clubs. */
async function resolveSharedClubs(
  pool: Pool, actorMemberId: string, otherMemberId: string, accessibleClubIds: string[],
): Promise<Array<{ clubId: string; slug: string; name: string }>> {
  const result = await pool.query<SharedClubRow>(
    `select c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = $3
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1 and a.club_id = any($2::text[])
     order by c.name asc`,
    [actorMemberId, accessibleClubIds, otherMemberId],
  );
  return result.rows.map(r => ({ clubId: r.club_id, slug: r.slug, name: r.name }));
}

/** Resolve shared clubs between two members without scoping to accessible clubs. */
async function resolveSharedClubsUnscoped(
  pool: Pool, memberA: string, memberB: string,
): Promise<Array<{ clubId: string; slug: string; name: string }>> {
  const result = await pool.query<SharedClubRow>(
    `select c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = $2
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1
     order by c.name asc`,
    [memberA, memberB],
  );
  return result.rows.map(r => ({ clubId: r.club_id, slug: r.slug, name: r.name }));
}

/** Batch-resolve shared clubs for multiple counterparts in one query. */
async function batchResolveSharedClubs(
  pool: Pool, actorMemberId: string, counterpartMemberIds: string[],
): Promise<Map<string, Array<{ clubId: string; slug: string; name: string }>>> {
  const map = new Map<string, Array<{ clubId: string; slug: string; name: string }>>();
  if (counterpartMemberIds.length === 0) return map;

  const result = await pool.query<SharedClubRow & { counterpart_member_id: string }>(
    `select b.member_id as counterpart_member_id, c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = any($2::text[])
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1
     order by b.member_id, c.name asc`,
    [actorMemberId, counterpartMemberIds],
  );

  for (const r of result.rows) {
    let arr = map.get(r.counterpart_member_id);
    if (!arr) {
      arr = [];
      map.set(r.counterpart_member_id, arr);
    }
    arr.push({ clubId: r.club_id, slug: r.slug, name: r.name });
  }
  return map;
}

/** Batch-resolve shared clubs for multiple member pairs keyed by an opaque ID (e.g. threadId). */
async function batchResolveSharedClubsPairs(
  pool: Pool, pairs: Map<string, [string, string]>,
): Promise<Map<string, Array<{ clubId: string; slug: string; name: string }>>> {
  const result = new Map<string, Array<{ clubId: string; slug: string; name: string }>>();
  if (pairs.size === 0) return result;

  // Build VALUES list for all pairs
  const values: string[] = [];
  const params: string[] = [];
  let idx = 1;
  for (const [key, [a, b]] of pairs) {
    values.push(`($${idx}::text, $${idx + 1}::text, $${idx + 2}::text)`);
    params.push(key, a, b);
    idx += 3;
  }

  const rows = await pool.query<{ pair_key: string; club_id: string; slug: string; name: string }>(
    `with pairs(pair_key, member_a, member_b) as (values ${values.join(', ')})
     select p.pair_key, c.id as club_id, c.slug, c.name
     from pairs p
     join accessible_club_memberships a on a.member_id = p.member_a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = p.member_b
     join clubs c on c.id = a.club_id and c.archived_at is null
     order by p.pair_key, c.name asc`,
    params,
  );

  for (const r of rows.rows) {
    let arr = result.get(r.pair_key);
    if (!arr) {
      arr = [];
      result.set(r.pair_key, arr);
    }
    arr.push({ clubId: r.club_id, slug: r.slug, name: r.name });
  }
  return result;
}

// ── Factory ─────────────────────────────────────────────────

export function createRepository(pool: Pool): Repository {
  const identity = createIdentityRepository(pool);
  const messaging = createMessagingRepository(pool);
  const clubs = createClubsRepository(pool);

  return {
    // ── Auth ───────────────────────────────────────────────
    authenticateBearerToken: (bearerToken) => identity.authenticateBearerToken(bearerToken),
    validateBearerTokenPassive: (bearerToken) => identity.validateBearerTokenPassive(bearerToken),

    // ── Clubs ──────────────────────────────────────────────
    listClubs: (input) => identity.listClubs(input),
    createClub: (input) => identity.createClub(input),
    archiveClub: (input) => identity.archiveClub(input),
    assignClubOwner: (input) => identity.assignClubOwner(input),
    updateClub: (input) => identity.updateClub(input),

    // ── Memberships ────────────────────────────────────────
    listMemberships: (input) => identity.listMemberships(input),
    createMembership: (input) => identity.createMembership(input),
    transitionMembershipState: (input) => identity.transitionMembershipState(input),
    listMembers: (input) => identity.listMembers(input),
    promoteMemberToAdmin: (input) => identity.promoteMemberToAdmin!(input),
    demoteMemberFromAdmin: (input) => identity.demoteMemberFromAdmin!(input),

    async listMembershipReviews(input) {
      const paginated = await identity.listMembershipReviews(input);
      if (paginated.results.length === 0) return paginated;

      // Batch-load vouches for all target members on the page in one query.
      // Reviews are always scoped to a single club (clubIds comes from the action's clubId).
      const clubId = paginated.results[0].clubId;
      const targetMemberIds = [...new Set(paginated.results.map(r => r.member.memberId))];
      const vouchMap = await batchListVouches(pool, {
        clubId,
        targetMemberIds,
        perTargetLimit: 50,
      });

      for (const review of paginated.results) {
        const rawVouches = vouchMap.get(review.member.memberId) ?? [];
        review.vouches = rawVouches.map(mapVouchToSummary);
      }

      return paginated;
    },

    // ── Profiles ───────────────────────────────────────────
    listMemberProfiles: ({ actorMemberId, targetMemberId, actorClubIds, clubId }) => {
      return identity.listMemberProfiles({ actorMemberId, targetMemberId, actorClubIds, clubId });
    },
    buildMembershipSeedProfile: (input) => identity.buildMembershipSeedProfile(input),
    updateMemberIdentity: (input) => identity.updateMemberIdentity(input),
    updateClubProfile: (input) => identity.updateClubProfile(input),
    preflightCreateEntityMentions: (input) => preflightContentCreateMentions(pool, input),
    preflightUpdateEntityMentions: (input) => preflightContentUpdateMentions(pool, input),

    // ── Tokens ─────────────────────────────────────────────
    listBearerTokens: (input) => identity.listBearerTokens(input),
    createBearerToken: (input) => identity.createBearerToken(input),
    revokeBearerToken: (input) => identity.revokeBearerToken(input),

    // ── Search ─────────────────────────────────────────────
    fullTextSearchMembers: (input) => identity.fullTextSearchMembers(input),
    findMembersViaEmbedding: (input) => identity.findMembersViaEmbedding(input),

    // ── Entities ──────────────────────────────────────────
    async createEntity(input) {
      const actor = await identity.readActor(input.authorMemberId);
      const accessibleClubIds = actor?.memberships.map((membership) => membership.clubId) ?? [];
      const quotaClubId = input.clubId
        ?? (input.threadId
          ? (await pool.query<{ club_id: string }>(
            `select club_id
             from content_threads
             where id = $1
               and archived_at is null
               and club_id = any($2::text[])`,
            [input.threadId, accessibleClubIds],
          )).rows[0]?.club_id
          : null);
      if (!quotaClubId) {
        throw new AppError(404, 'not_found', 'Club or thread not found inside the actor scope');
      }
      const membership = actor?.memberships.find((m) => m.clubId === quotaClubId);
      const actorInfo = { role: membership?.role ?? 'member' as const, isOwner: membership?.isOwner ?? false };
      await clubs.enforceQuota(input.authorMemberId, quotaClubId, 'content.create', actorInfo);
      return clubs.createEntity(input);
    },

    async updateEntity(input) {
      return clubs.updateEntity(input);
    },

    closeEntityLoop: (input) => clubs.closeEntityLoop(input),

    reopenEntityLoop: (input) => clubs.reopenEntityLoop(input),

    removeEntity: (input) => clubs.removeEntity({
      entityId: input.entityId,
      clubIds: input.accessibleClubIds,
      actorMemberId: input.actorMemberId,
      reason: input.reason,
      skipAuthCheck: input.skipAuthCheck,
    }),

    listEntities: (input) => clubs.listEntities(input),
    readContentThread: (input) => clubs.readContentThread(input),

    // ── Events ──────────────────────────────────────────
    listEvents: (input) => clubs.listEvents(input),
    rsvpEvent: (input) => clubs.rsvpEvent(input),
    cancelEventRsvp: (input) => clubs.cancelEventRsvp(input),

    // ── Vouches ──────────────────────────────────────────
    async createVouch(input) {
      // Verify the target member has an accessible membership in this club (identity check)
      const targetCheck = await pool.query<{ ok: boolean }>(
        `select exists(
           select 1 from accessible_club_memberships
           where member_id = $1 and club_id = $2
         ) as ok`,
        [input.targetMemberId, input.clubId],
      );
      if (!targetCheck.rows[0]?.ok) return null;

      const raw = await clubs.createVouch(input);
      if (!raw) return null;
      return mapVouchToSummary(raw);
    },

    async listVouches(input) {
      const raw = await clubs.listVouches({
        clubIds: input.clubIds,
        targetMemberId: input.targetMemberId,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        results: raw.results.map(mapVouchToSummary),
        hasMore: raw.hasMore,
        nextCursor: raw.nextCursor,
      };
    },

    // ── Unified club join ─────────────────────────────────
    joinClub: (input) => unifiedClubs.joinClub(pool, input),
    submitClubApplication: (input) => unifiedClubs.submitClubApplication(pool, input),
    getClubApplication: (input) => unifiedClubs.getClubApplication(pool, input.actorMemberId, input.membershipId),
    listClubApplications: (input) => unifiedClubs.listClubApplications(pool, input),
    getMembershipApplication: (input) => unifiedClubs.getMembershipApplication(
      pool,
      input.actorMemberId,
      input.membershipId,
      input.accessibleClubIds,
    ),
    startMembershipCheckout: (input) => unifiedClubs.startMembershipCheckout(pool, input),
    issueInvitation: (input) => unifiedClubs.issueInvitation(pool, input),
    listIssuedInvitations: (input) => unifiedClubs.listIssuedInvitations(pool, input),
    revokeInvitation: (input) => unifiedClubs.revokeInvitation(pool, input),

    // ── Messages ─────────────────────────────────────────
    // DMs are not club-scoped. Clubs are only an eligibility check for starting
    // a conversation. Existing threads continue even if clubs diverge.

    async sendDirectMessage(input) {
      // Clubs are an eligibility check for *starting* a DM. If an existing
      // thread already exists between the two members, sending is always
      // allowed (the thread was started when they did share a club).
      const sharedClubs = await resolveSharedClubs(pool, input.actorMemberId, input.recipientMemberId, input.accessibleClubIds);
      if (sharedClubs.length === 0) {
        const hasThread = await messaging.hasExistingThread(input.actorMemberId, input.recipientMemberId);
        if (!hasThread) return null;
      }

      const msg = await messaging.sendMessage({
        senderMemberId: input.actorMemberId,
        recipientMemberId: input.recipientMemberId,
        messageText: input.messageText,
        clientKey: input.clientKey,
      });

      return {
        message: {
          threadId: msg.message.threadId,
          sharedClubs,
          senderMemberId: msg.message.senderMemberId,
          recipientMemberId: msg.message.recipientMemberId,
          messageId: msg.message.messageId,
          messageText: msg.message.messageText,
          mentions: msg.message.mentions,
          createdAt: msg.message.createdAt,
          updateCount: 1,
        },
        included: msg.included,
      };
    },

    async listDirectMessageThreads({ actorMemberId, limit }) {
      const threads = await messaging.listThreads({ memberId: actorMemberId, limit });
      const counterpartIds = threads.map((t) => t.counterpartMemberId);
      const sharedClubsMap = await batchResolveSharedClubs(pool, actorMemberId, counterpartIds);

      return threads.map((t) => ({
        threadId: t.threadId,
        sharedClubs: sharedClubsMap.get(t.counterpartMemberId) ?? [],
        counterpartMemberId: t.counterpartMemberId,
        counterpartPublicName: t.counterpartPublicName,
        latestMessage: t.latestMessage,
        messageCount: t.messageCount,
      }));
    },

    async listDirectMessageInbox(input) {
      const paginated = await messaging.listInbox({
        memberId: input.actorMemberId,
        limit: input.limit,
        unreadOnly: input.unreadOnly,
        cursor: input.cursor,
      });
      const entries = paginated.results;
      const counterpartIds = entries.map((e) => e.counterpartMemberId);
      const sharedClubsMap = await batchResolveSharedClubs(pool, input.actorMemberId, counterpartIds);

      return {
        results: entries.map((e) => ({
          threadId: e.threadId,
          sharedClubs: sharedClubsMap.get(e.counterpartMemberId) ?? [],
          counterpartMemberId: e.counterpartMemberId,
          counterpartPublicName: e.counterpartPublicName,
          latestMessage: e.latestMessage,
          messageCount: e.messageCount,
          unread: {
            hasUnread: e.hasUnread,
            unreadMessageCount: e.unreadCount,
            unreadUpdateCount: e.unreadCount,
            latestUnreadMessageCreatedAt: e.latestUnreadAt,
          },
        })),
        hasMore: paginated.hasMore,
        nextCursor: paginated.nextCursor,
        included: paginated.included,
      };
    },

    async readDirectMessageThread(input) {
      const result = await messaging.readThread({
        memberId: input.actorMemberId,
        threadId: input.threadId,
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!result) return null;

      const sharedClubs = await resolveSharedClubsUnscoped(pool, input.actorMemberId, result.thread.counterpartMemberId);

      return {
        thread: {
          threadId: result.thread.threadId,
          sharedClubs,
          counterpartMemberId: result.thread.counterpartMemberId,
          counterpartPublicName: result.thread.counterpartPublicName,
          latestMessage: result.thread.latestMessage,
          messageCount: result.thread.messageCount,
        },
        messages: result.messages,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        included: result.included,
      };
    },

    async acknowledgeDirectMessageInbox(input) {
      return messaging.acknowledgeInbox({
        memberId: input.actorMemberId,
        threadId: input.threadId,
      });
    },

    // ── Removals ───────────────────────────────────────────
    async removeMessage(input) {
      const result = await messaging.removeMessage({
        messageId: input.messageId,
        removedByMemberId: input.actorMemberId,
        reason: input.reason,
        skipAuthCheck: input.skipAuthCheck,
      });
      if (!result) return null;
      return {
        messageId: result.messageId,
        removedByMemberId: result.removedByMemberId,
        reason: result.reason,
        removedAt: result.removedAt,
      };
    },

    // ── Activity / Notifications / Stream ──────────────────
    async listClubActivity(input) {
      const result = await clubs.listClubActivity({
        memberId: input.actorMemberId,
        clubIds: input.clubIds,
        adminClubIds: input.adminClubIds,
        ownerClubIds: input.ownerClubIds,
        limit: input.limit,
        afterSeq: input.afterSeq,
      });
      return {
        items: result.items,
        nextAfterSeq: result.nextAfterSeq,
      };
    },

    async listNotifications(input) {
      const limit = Math.max(1, Math.min(input.limit, NOTIFICATIONS_PAGE_SIZE));
      const [materialized, derived] = await Promise.all([
        listMaterializedNotifications(pool, {
          actorMemberId: input.actorMemberId,
          accessibleClubIds: input.accessibleClubIds,
          limit,
          after: input.after,
        }),
        listDerivedApplicationNotifications(pool, {
          adminClubIds: input.adminClubIds,
          limit,
          after: input.after,
        }),
      ]);

      const merged = [...materialized, ...derived].sort(sortNotificationItems);
      const page = merged.slice(0, limit);
      const nextAfter = merged.length > limit
        ? page[page.length - 1]?.cursor ?? null
        : null;

      return {
        items: page,
        nextAfter,
      };
    },

    async acknowledgeNotifications(input) {
      return withTransaction(pool, async (client) => {
        const materializedIds = input.notificationIds
          .map((notificationId) => {
            const parsed = splitNotificationId(notificationId);
            if (!parsed) return null;
            const { kind, primaryRef: rowId } = parsed;
            if (!kind.startsWith('synchronicity.') || rowId.length === 0) return null;
            return rowId;
          })
          .filter((rowId): rowId is string => rowId !== null);

        if (materializedIds.length === 0) {
          return [];
        }

        const result = await client.query<{
          id: string;
          recipient_member_id: string;
          club_id: string | null;
          topic: string;
          entity_id: string | null;
          acknowledged_at: string;
          acknowledged_state: 'processed' | 'suppressed';
          suppression_reason: string | null;
        }>(
          `update member_notifications
           set acknowledged_state = $3,
               acknowledged_at = now(),
               suppression_reason = case when $3 = 'suppressed' then $4 else null end
           where id = any($1::text[])
             and recipient_member_id = $2
             and acknowledged_state is null
           returning id,
                     recipient_member_id,
                     club_id,
                     topic,
                     entity_id,
                     acknowledged_at::text as acknowledged_at,
                     acknowledged_state,
                     suppression_reason`,
          [materializedIds, input.actorMemberId, input.state, input.suppressionReason ?? null],
        );

        const receiptsById = new Map<string, NotificationReceipt>();
        for (const row of result.rows) {
          const notificationId = buildNotificationId(row.topic, row.id);
          receiptsById.set(notificationId, {
            notificationId,
            recipientMemberId: row.recipient_member_id,
            entityId: row.entity_id,
            clubId: row.club_id,
            state: row.acknowledged_state,
            suppressionReason: row.suppression_reason,
            versionNo: 1,
            createdAt: row.acknowledged_at,
            createdByMemberId: input.actorMemberId,
          });
        }

        return input.notificationIds
          .map((notificationId) => receiptsById.get(notificationId))
          .filter((receipt): receipt is NotificationReceipt => receipt !== undefined);
      });
    },

    async listInboxSince(input) {
      return listInboxFramesSince(pool, {
        actorMemberId: input.actorMemberId,
        after: input.after,
        limit: input.limit,
      });
    },

    // ── Quotas ─────────────────────────────────────────────
    getQuotaStatus: (input) => clubs.getQuotaStatus({
      ...input,
      memberships: input.memberships ?? [],
    }),

    // ── LLM ────────────────────────────────────────────────
    logLlmUsage: (input) => clubs.logLlmUsage(input),

    // ── Embeddings ─────────────────────────────────────────
    findEntitiesViaEmbedding: (input) => clubs.findEntitiesViaEmbedding(input),

    // ── Admin: member/membership creation ───────────────
    adminCreateMember: (input) => identity.createMemberDirect(input),
    adminCreateMembership: (input) => identity.createMembershipAsSuperadmin(input),

    // ── Admin ───────────────────────────────────────────
    async adminGetOverview() {
      const [totalMemberCount, activeMemberCount, clubCount, entityCount, messageCount, pendingApplicationCount] = await Promise.all([
        pool.query<{ count: string }>(`select count(*)::text as count from members`),
        pool.query<{ count: string }>(`select count(*)::text as count from members where state = 'active'`),
        pool.query<{ count: string }>(`select count(*)::text as count from clubs where archived_at is null`),
        pool.query<{ count: string }>(`select count(*)::text as count from entities where deleted_at is null`),
        pool.query<{ count: string }>(`select count(*)::text as count from dm_messages`),
        pool.query<{ count: string }>(
          `select count(*)::text as count
           from current_club_memberships
           where status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed')`,
        ),
      ]);

      const recentMembers = await pool.query<{
        member_id: string; public_name: string; created_at: string;
      }>(
        `select id as member_id, public_name, created_at::text as created_at
         from members
         order by created_at desc limit 5`,
      );

      return {
        totalMembers: Number(totalMemberCount.rows[0]?.count ?? 0),
        activeMembers: Number(activeMemberCount.rows[0]?.count ?? 0),
        totalClubs: Number(clubCount.rows[0]?.count ?? 0),
        totalEntities: Number(entityCount.rows[0]?.count ?? 0),
        totalMessages: Number(messageCount.rows[0]?.count ?? 0),
        pendingApplications: Number(pendingApplicationCount.rows[0]?.count ?? 0),
        recentMembers: recentMembers.rows.map((r) => ({
          memberId: r.member_id,
          publicName: r.public_name,
          createdAt: r.created_at,
        })),
      };
    },

    async adminListMembers({ limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        member_id: string; public_name: string;
        state: string; created_at: string; membership_count: number; token_count: number;
      }>(
        `select m.id as member_id, m.public_name, m.state::text as state,
                m.created_at::text as created_at,
                (select count(*)::int from club_memberships cm where cm.member_id = m.id) as membership_count,
                (select count(*)::int from member_bearer_tokens t where t.member_id = m.id and t.revoked_at is null) as token_count
         from members m
         where ($1::timestamptz is null or m.created_at < $1 or (m.created_at = $1 and m.id < $2))
         order by m.created_at desc, m.id desc
         limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      const rows = result.rows.map((r) => ({
        memberId: r.member_id, publicName: r.public_name,
        state: r.state, createdAt: r.created_at,
        membershipCount: r.membership_count, tokenCount: r.token_count,
      }));
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      const nextCursor = last ? paginationEncodeCursor([last.createdAt, last.memberId]) : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminGetMember({ memberId }) {
      const memberResult = await pool.query<{
        member_id: string; public_name: string; display_name: string;
        state: string; created_at: string;
      }>(
        `select id as member_id, public_name, display_name, state::text as state, created_at::text as created_at
         from members where id = $1 limit 1`,
        [memberId],
      );
      if (!memberResult.rows[0]) return null;
      const m = memberResult.rows[0];

      const membershipsResult = await pool.query<{
        membership_id: string; club_id: string; club_name: string; club_slug: string;
        role: string; status: string; joined_at: string;
      }>(
        `select cm.id as membership_id, cm.club_id, c.name as club_name, c.slug as club_slug,
                cm.role::text as role, cm.status::text as status, cm.joined_at::text as joined_at
         from club_memberships cm
         join clubs c on c.id = cm.club_id
         where cm.member_id = $1
         order by cm.joined_at desc`,
        [memberId],
      );

      const tokenCount = await pool.query<{ count: string }>(
        `select count(*)::text as count from member_bearer_tokens where member_id = $1 and revoked_at is null`,
        [memberId],
      );

      const profileRows = await pool.query<{
        club_id: string;
        club_slug: string;
        club_name: string;
        tagline: string | null;
        summary: string | null;
        what_i_do: string | null;
        known_for: string | null;
        services_summary: string | null;
        website_url: string | null;
        links: Array<{ url: string; label: string | null }> | null;
        version_id: string;
        version_no: number;
        version_created_at: string;
        version_created_by_member_id: string | null;
      }>(
        `select
           c.id as club_id,
           c.slug as club_slug,
           c.name as club_name,
           cmp.tagline,
           cmp.summary,
           cmp.what_i_do,
           cmp.known_for,
           cmp.services_summary,
           cmp.website_url,
           cmp.links,
           cmp.id as version_id,
           cmp.version_no,
           cmp.created_at::text as version_created_at,
           cmp.created_by_member_id as version_created_by_member_id
         from current_member_club_profiles cmp
         join clubs c on c.id = cmp.club_id
         where cmp.member_id = $1
         order by c.name asc, c.id asc`,
        [memberId],
      );

      return {
        memberId: m.member_id, publicName: m.public_name,
        displayName: m.display_name,
        state: m.state, createdAt: m.created_at,
        memberships: membershipsResult.rows.map((r) => ({
          membershipId: r.membership_id, clubId: r.club_id, clubName: r.club_name,
          clubSlug: r.club_slug, role: r.role, status: r.status, joinedAt: r.joined_at,
        })),
        tokenCount: Number(tokenCount.rows[0]?.count ?? 0),
        profiles: profileRows.rows.map((row) => ({
          club: { clubId: row.club_id, slug: row.club_slug, name: row.club_name },
          tagline: row.tagline,
          summary: row.summary,
          whatIDo: row.what_i_do,
          knownFor: row.known_for,
          servicesSummary: row.services_summary,
          websiteUrl: row.website_url,
          links: row.links ?? [],
          version: {
            id: row.version_id,
            versionNo: Number(row.version_no),
            createdAt: row.version_created_at,
            createdByMemberId: row.version_created_by_member_id,
          },
        })),
      };
    },

    async adminGetClubStats({ clubId }) {
      const [clubResult, memberCounts, entityCount] = await Promise.all([
        pool.query<{ club_id: string; slug: string; name: string; archived_at: string | null }>(
          `select id as club_id, slug, name, archived_at::text as archived_at from clubs where id = $1 limit 1`,
          [clubId],
        ),
        pool.query<{ status: string; count: string }>(
          `select cm.status::text as status, count(*)::text as count
           from club_memberships cm where cm.club_id = $1 group by cm.status`,
          [clubId],
        ),
        pool.query<{ count: string }>(
          `select count(*)::text as count from entities where club_id = $1 and deleted_at is null`,
          [clubId],
        ),
      ]);

      const club = clubResult.rows[0];
      if (!club) return null;

      const messageCount = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from dm_messages m
         join dm_threads t on t.id = m.thread_id
         where exists (
           select 1 from accessible_club_memberships am
           where am.member_id = t.member_a_id and am.club_id = $1
         )
         and exists (
           select 1 from accessible_club_memberships am
           where am.member_id = t.member_b_id and am.club_id = $1
         )`,
        [clubId],
      );

      return {
        clubId: club.club_id, slug: club.slug, name: club.name, archivedAt: club.archived_at,
        memberCounts: Object.fromEntries(memberCounts.rows.map((r) => [r.status, Number(r.count)])),
        entityCount: Number(entityCount.rows[0]?.count ?? 0),
        messageCount: Number(messageCount.rows[0]?.count ?? 0),
      };
    },

    async adminListContent({ clubId, kind, limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        entity_id: string; content_thread_id: string; club_id: string; club_name: string; kind: string;
        author_member_id: string; author_public_name: string;
        entity_version_id: string; title: string | null; state: string; created_at: string;
      }>(
        `select e.id as entity_id, e.content_thread_id, e.club_id, c.name as club_name,
                e.kind::text as kind, e.author_member_id,
                m.public_name as author_public_name,
                cev.id as entity_version_id,
                cev.title, cev.state::text as state, e.created_at::text as created_at
         from entities e
         join current_entity_versions cev on cev.entity_id = e.id
         join members m on m.id = e.author_member_id
         join clubs c on c.id = e.club_id
         where e.deleted_at is null
           and ($1::text is null or e.club_id = $1)
           and ($2::text is null or e.kind::text = $2)
           and ($3::timestamptz is null or e.created_at < $3 or (e.created_at = $3 and e.id < $4))
         order by e.created_at desc, e.id desc limit $5`,
        [clubId ?? null, kind ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      const hasMore = result.rows.length > limit;
      const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const mentionBundle = await loadEntityVersionMentions(
        pool,
        pageRows.map((row) => row.entity_version_id),
      );

      const rows = pageRows.map((r) => {
        return {
          entityId: r.entity_id, contentThreadId: r.content_thread_id, clubId: r.club_id, clubName: r.club_name,
          kind: r.kind as any, author: { memberId: r.author_member_id, publicName: r.author_public_name },
          title: r.state === 'removed' ? '[redacted]' : r.title,
          titleMentions: r.state === 'removed'
            ? []
            : (mentionBundle.mentionsByVersionId.get(r.entity_version_id)?.title ?? []),
          state: r.state as any,
          createdAt: r.created_at,
        };
      });
      const last = rows[rows.length - 1];
      const nextCursor = last ? paginationEncodeCursor([last.createdAt, last.entityId]) : null;
      return { results: rows, hasMore, nextCursor, included: mentionBundle.included };
    },

    async adminListThreads({ limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        thread_id: string; message_count: number; latest_message_at: string;
        participants: Array<{ memberId: string; publicName: string }>;
        created_at: string;
      }>(
        `select t.id as thread_id,
                (select count(*)::int from dm_messages m where m.thread_id = t.id) as message_count,
                (select max(m.created_at)::text from dm_messages m where m.thread_id = t.id) as latest_message_at,
                t.created_at::text as created_at,
                (select coalesce(json_agg(json_build_object(
                  'memberId', mbr.id, 'publicName', mbr.public_name
                )), '[]'::json)
                from dm_thread_participants tp
                join members mbr on mbr.id = tp.member_id
                where tp.thread_id = t.id) as participants
         from dm_threads t
         where ($1::timestamptz is null or t.created_at < $1 or (t.created_at = $1 and t.id < $2))
         order by t.created_at desc, t.id desc limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      // Batch-resolve shared clubs for all thread participant pairs
      const pairMap = new Map<string, [string, string]>();
      for (const r of result.rows) {
        const ids = r.participants.map(p => p.memberId);
        if (ids.length === 2) pairMap.set(r.thread_id, [ids[0], ids[1]]);
      }
      const sharedClubsByThread = await batchResolveSharedClubsPairs(pool, pairMap);

      const rows = result.rows.map((r) => ({
        threadId: r.thread_id,
        sharedClubs: sharedClubsByThread.get(r.thread_id) ?? [],
        participants: r.participants,
        messageCount: r.message_count,
        latestMessageAt: r.latest_message_at ?? '',
      }));
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const lastRow = hasMore || rows.length === limit ? result.rows[rows.length - 1] : null;
      const nextCursor = lastRow && rows.length > 0
        ? paginationEncodeCursor([lastRow.created_at, lastRow.thread_id])
        : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminReadThread({ threadId, limit }) {
      const thread = await pool.query<{
        thread_id: string;
        participants: Array<{ memberId: string; publicName: string }>;
        message_count: number;
      }>(
        `select t.id as thread_id,
                (select coalesce(json_agg(json_build_object(
                  'memberId', mbr.id, 'publicName', mbr.public_name
                )), '[]'::json)
                from dm_thread_participants tp
                join members mbr on mbr.id = tp.member_id
                where tp.thread_id = t.id) as participants,
                (select count(*)::int from dm_messages mm where mm.thread_id = t.id) as message_count
         from dm_threads t where t.id = $1 limit 1`,
        [threadId],
      );
      if (!thread.rows[0]) return null;

      const messages = await pool.query<{
        message_id: string; thread_id: string; sender_member_id: string | null;
        role: string; message_text: string | null; payload: Record<string, unknown> | null;
        created_at: string; in_reply_to_message_id: string | null; is_removed: boolean;
      }>(
        `select m.id as message_id, m.thread_id, m.sender_member_id,
                m.role::text as role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as message_text,
                case when rmv.message_id is not null then null else m.payload end as payload,
                m.created_at::text as created_at, m.in_reply_to_message_id,
                (rmv.message_id is not null) as is_removed
         from dm_messages m
         left join dm_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
         order by m.created_at desc, m.id desc limit $2`,
        [threadId, limit],
      );

      const latestMsg = messages.rows[0];

      const participantIds = thread.rows[0].participants.map(p => p.memberId);
      const threadSharedClubs = participantIds.length === 2
        ? await resolveSharedClubsUnscoped(pool, participantIds[0], participantIds[1])
        : [];
      const mentionBundle = await loadDmMentions(
        pool,
        messages.rows.filter((row) => !row.is_removed).map((row) => row.message_id),
      );

      return {
        thread: {
          threadId: thread.rows[0].thread_id,
          sharedClubs: threadSharedClubs,
          participants: thread.rows[0].participants,
          messageCount: thread.rows[0].message_count,
          latestMessageAt: latestMsg?.created_at ?? '',
        },
        messages: messages.rows.map((r) => ({
          messageId: r.message_id, threadId: r.thread_id, senderMemberId: r.sender_member_id,
          role: r.role as 'member' | 'agent' | 'system',
          messageText: r.message_text,
          mentions: r.is_removed ? [] : (mentionBundle.mentionsByMessageId.get(r.message_id) ?? []),
          payload: r.payload ?? {},
          createdAt: r.created_at, inReplyToMessageId: r.in_reply_to_message_id,
        })).reverse(),
        included: mentionBundle.included,
      };
    },

    adminListMemberTokens: ({ memberId }) => identity.listBearerTokens({ actorMemberId: memberId }),

    async adminRevokeMemberToken({ memberId, tokenId }) {
      return identity.revokeBearerToken({ actorMemberId: memberId, tokenId });
    },

    adminCreateAccessToken: (input) => identity.createBearerTokenAsSuperadmin(input),

    async adminGetDiagnostics() {
      const [migrationResult, memberCount, clubCount, tableCount, dbSize] = await Promise.all([
        pool.query<{ count: string; latest: string | null }>(
          `select count(*)::text as count, max(filename) as latest from public.schema_migrations
           where exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'schema_migrations')`,
        ).catch(() => ({ rows: [{ count: '0', latest: null }] })),
        pool.query<{ count: string }>(`select count(*)::text as count from members`),
        pool.query<{ count: string }>(`select count(*)::text as count from clubs`),
        pool.query<{ count: string }>(
          `select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name <> 'schema_migrations'`,
        ),
        pool.query<{ size: string }>(`select pg_size_pretty(pg_database_size(current_database())) as size`),
      ]);

      return {
        migrationCount: Number(migrationResult.rows[0]?.count ?? 0),
        latestMigration: migrationResult.rows[0]?.latest ?? null,
        memberCount: Number(memberCount.rows[0]?.count ?? 0),
        clubCount: Number(clubCount.rows[0]?.count ?? 0),
        tablesWithRls: 0,
        totalAppTables: Number(tableCount.rows[0]?.count ?? 0),
        databaseSize: dbSize.rows[0]?.size ?? '0 bytes',
      };
    },

    // ── Billing helpers ────────────────────────────────────────

    async getBillingStatus({ memberId, clubId }) {
      const result = await pool.query<{
        membership_id: string;
        status: string;
        is_comped: boolean;
        current_period_end: string | null;
        approved_price_amount: string | null;
        approved_price_currency: string | null;
      }>(
        `select
           m.id as membership_id,
           m.status,
           m.is_comped,
           s.current_period_end::text as current_period_end,
           m.approved_price_amount::text as approved_price_amount,
           m.approved_price_currency
         from current_club_memberships m
         left join club_subscriptions s on s.membership_id = m.id
           and s.status in ('trialing', 'active', 'past_due')
         where m.club_id = $1
           and m.member_id = $2
           and m.left_at is null
         order by m.state_created_at desc, m.id desc
         limit 1`,
        [clubId, memberId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        membershipId: row.membership_id,
        state: row.status,
        isComped: row.is_comped,
        paidThrough: row.current_period_end,
        approvedPrice: {
          amount: row.approved_price_amount != null ? Number(row.approved_price_amount) : null,
          currency: row.approved_price_currency,
        },
      };
    },

    async isPaidClub(clubId: string): Promise<boolean> {
      const result = await pool.query<{ is_paid: boolean }>(
        `select (membership_price_amount is not null) as is_paid from clubs where id = $1`,
        [clubId],
      );
      return result.rows[0]?.is_paid === true;
    },

    // ── Billing sync ─────────────────────────────────────────

    async billingActivateMembership({ membershipId, paidThrough }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; member_id: string; club_id: string;
          status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.member_id, cnm.club_id,
                  cnm.status::text as status, cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status === 'active') {
          const subRow = await client.query<{ id: string; current_period_end: string | null }>(
            `select id, current_period_end::text as current_period_end from club_subscriptions
             where membership_id = $1 and status in ('active', 'trialing')
             order by started_at desc limit 1`,
            [membershipId],
          );
          const liveSubscription = subRow.rows[0];
          if (liveSubscription?.current_period_end &&
              new Date(liveSubscription.current_period_end) >= new Date(paidThrough)) {
            return;
          }

          const priceRow = await client.query<{ approved_price_amount: string | null }>(
            `select approved_price_amount::text from club_memberships where id = $1`,
            [membershipId],
          );
          const amount = priceRow.rows[0]?.approved_price_amount != null
            ? Number(priceRow.rows[0].approved_price_amount) : 0;

          if (liveSubscription) {
            await client.query(
              `update club_subscriptions
               set current_period_end = $2,
                   status = 'active',
                   ended_at = null
               where id = $1`,
              [liveSubscription.id, paidThrough],
            );
          } else {
            await client.query(
              `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
               values ($1::short_id, $2::short_id, 'active', $3, $4)`,
              [membershipId, m.member_id, amount, paidThrough],
            );
          }
          return;
        }

        // Only payment_pending can transition to active via this action
        if (m.status !== 'payment_pending') {
          throw new AppError(409, 'invalid_state', `Cannot activate membership in state '${m.status}'; expected 'payment_pending'`);
        }

        // Transition membership state: payment_pending → active
        await client.query(
          `insert into club_membership_state_versions
           (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
           values ($1, 'active', 'Billing activation', $2, $3, null)`,
          [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
        );

        // Create subscription row
        const priceRow = await client.query<{ approved_price_amount: string | null }>(
          `select approved_price_amount::text from club_memberships where id = $1`,
          [membershipId],
        );
        const amount = priceRow.rows[0]?.approved_price_amount != null
          ? Number(priceRow.rows[0].approved_price_amount) : 0;
        await client.query(
          `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
           values ($1::short_id, $2::short_id, 'active', $3, $4)`,
          [membershipId, m.member_id, amount, paidThrough],
        );
      });
    },

    async billingRenewMembership({ membershipId, newPaidThrough }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'cancelled' && m.status !== 'renewal_pending') {
          throw new AppError(409, 'invalid_state', `Cannot renew membership in state '${m.status}'; expected 'active', 'cancelled', or 'renewal_pending'`);
        }

        // If cancelled or renewal_pending, transition back to active
        if (m.status === 'cancelled' || m.status === 'renewal_pending') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'active', 'Billing renewal', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        // Update subscription current_period_end forward only, and ensure status is active
        const updated = await client.query<{ id: string }>(
          `update club_subscriptions
           set current_period_end = greatest(current_period_end, $2::timestamptz),
               status = 'active',
               ended_at = null
           where membership_id = $1
             and status in ('active', 'trialing', 'past_due')
           returning id`,
          [membershipId, newPaidThrough],
        );

        // If no live subscription exists (e.g., was ended), create one
        if (updated.rows.length === 0) {
          await client.query(
            `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
             select $1, ms.member_id, 'active',
                    coalesce(ms.approved_price_amount, 0), $2
             from club_memberships ms where ms.id = $1`,
            [membershipId, newPaidThrough],
          );
        }
      });
    },

    async billingMarkRenewalPending({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'renewal_pending') {
          throw new AppError(409, 'invalid_state', `Cannot mark renewal pending for membership in state '${m.status}'; expected 'active'`);
        }

        if (m.status === 'active') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'renewal_pending', 'Payment past due', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        await client.query(
          `update club_subscriptions set status = 'past_due'
           where membership_id = $1 and status in ('active', 'trialing')
           returning id`,
          [membershipId],
        );
      });
    },

    async billingExpireMembership({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        const allowedStates = ['active', 'renewal_pending', 'cancelled', 'payment_pending'];
        if (m.status !== 'expired' && !allowedStates.includes(m.status)) {
          throw new AppError(409, 'invalid_state', `Cannot expire membership in state '${m.status}'`);
        }

        if (m.status !== 'expired') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'expired', 'Billing expiration', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        await client.query(
          `update club_subscriptions set status = 'ended', ended_at = now()
           where membership_id = $1 and status in ('active', 'trialing', 'past_due')
           returning id`,
          [membershipId],
        );
      });
    },

    async billingCancelAtPeriodEnd({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'cancelled') {
          throw new AppError(409, 'invalid_state', `Cannot cancel membership in state '${m.status}'; expected 'active'`);
        }

        if (m.status === 'active') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'cancelled', 'Cancelled at period end', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }
      });
    },

    async billingBanMember({ memberId, reason }) {
      await withTransaction(pool, async (client) => {
        // Check member exists and current state
        const memberRow = await client.query<{ id: string; state: string }>(
          `select id, state::text as state from members where id = $1 limit 1`,
          [memberId],
        );
        const member = memberRow.rows[0];
        if (!member) throw new AppError(404, 'not_found', 'Member not found');

        if (member.state !== 'banned') {
          await client.query(
            `update members set state = 'banned' where id = $1`,
            [memberId],
          );
        }

        // Find all non-terminal memberships
        const terminalStates = ['banned', 'expired', 'revoked', 'rejected', 'left', 'removed'];
        const membershipsResult = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.member_id = $1
             and cnm.status::text <> all($2::text[])`,
          [memberId, terminalStates],
        );
        // Transition each non-terminal membership to banned
        for (const ms of membershipsResult.rows) {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'banned', $2, $3, $4, null)`,
            [ms.membership_id, reason, Number(ms.state_version_no) + 1, ms.state_version_id],
          );
        }

        // End all live subscriptions for this member
        await client.query(
          `update club_subscriptions set status = 'ended', ended_at = now()
           where payer_member_id = $1 and status in ('active', 'trialing', 'past_due')
           returning id`,
          [memberId],
        );
      });
    },

    async billingSetClubPrice({ clubId, amount, currency }) {
      await withTransaction(pool, async (client) => {
        const currentResult = await client.query<{
          club_id: string; current_version_id: string; current_version_no: number;
          owner_member_id: string; name: string; summary: string | null;
          admission_policy: string | null;
          membership_price_amount: string | null; membership_price_currency: string;
        }>(
          `select n.id as club_id, cv.id as current_version_id, cv.version_no as current_version_no,
                  cv.owner_member_id, cv.name, cv.summary, cv.admission_policy,
                  cv.membership_price_amount::text as membership_price_amount,
                  cv.membership_price_currency
           from clubs n
           join current_club_versions cv on cv.club_id = n.id
           where n.id = $1 limit 1`,
          [clubId],
        );

        const current = currentResult.rows[0];
        if (!current) throw new AppError(404, 'not_found', 'Club not found');

        const currentAmount = current.membership_price_amount != null ? Number(current.membership_price_amount) : null;
        if (currentAmount === amount && (amount === null || current.membership_price_currency === currency)) {
          return;
        }

        // Create new club version with updated price
        await client.query(
          `insert into club_versions
           (club_id, owner_member_id, name, summary, admission_policy,
            membership_price_amount, membership_price_currency,
            version_no, supersedes_version_id, created_by_member_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null)`,
          [clubId, current.owner_member_id, current.name, current.summary,
           current.admission_policy, amount, currency,
           Number(current.current_version_no) + 1, current.current_version_id],
        );
      });
    },

    async billingArchiveClub({ clubId }) {
      const result = await pool.query<{ club_id: string }>(
        `update clubs set archived_at = coalesce(archived_at, now())
         where id = $1 returning id as club_id`,
        [clubId],
      );
      if (!result.rows[0]) {
        throw new AppError(404, 'not_found', 'Club not found');
      }
    },
  };
}
