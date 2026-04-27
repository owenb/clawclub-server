/**
 * Postgres implementation of the Repository interface.
 *
 * Composes domain modules (identity, messaging, clubs) against a single
 * database pool. Operations that span modules (update streams,
 * admin aggregation) are coordinated here.
 */

import { Pool, type PoolConfig } from 'pg';
import {
  AppError,
  type AdminDiagnostics,
  type SuperadminClubDetail,
  type SuperadminMemberSummary,
  type Repository,
  type Content,
  type DirectMessageInboxSummary,
  type DirectMessageThreadSummary,
  type MembershipVouchSummary,
  type PublicMemberSummary,
  type IncludedBundle,
  type IncludedMember,
  type MessageFramePayload,
  type NotificationItem,
  type NotificationReceipt,
} from './repository.ts';
import { membershipScopes } from './actors.ts';
import { withTransaction, type DbClient } from './db.ts';
import { createIdentityRepository, type IdentityRepository } from './identity/index.ts';
import {
  createMessagingRepository,
  type InboxEntry as MessagingInboxEntry,
  type MessagingRepository,
  type ThreadSummary as MessagingThreadSummary,
} from './messages/index.ts';
import {
  createClubsRepository,
  batchListVouches,
  createVouch as createClubVouch,
  logApiRequest as insertApiRequestLog,
  type ClubsRepository,
} from './clubs/index.ts';
import { buildVouchReceivedMessage } from './clubs/welcome.ts';
import * as unifiedClubs from './clubs/unified.ts';
import * as admission from './admission.ts';
import {
  emptyIncludedBundle,
  loadIncludedMembers,
  loadEntityVersionMentions,
  loadDmMentions,
  mergeIncludedBundles,
  preflightContentCreateMentions,
  preflightContentUpdateMentions,
} from './mentions.ts';
import {
  encodeCursor as paginationEncodeCursor,
  decodeCursor as paginationDecodeCursor,
} from './schemas/fields.ts';
import { lookupIdempotency, throwSecretReplayUnavailable, withClientKeyBarrier, withIdempotency } from './idempotency.ts';
import {
  NOTIFICATIONS_PAGE_SIZE,
  encodeNotificationCursor,
  decodeNotificationCursor,
} from './notifications-core.ts';
import {
  acknowledgeNotificationsById,
  acknowledgeProducerNotificationsById,
  deliverNotifications,
  deliverCoreNotifications,
} from './notification-substrate.ts';
import { getClubSpendBudgetPolicy, getClubSpendBudgetStatus } from './club-spend.ts';
import { deriveQuotaWindowMaxes, getConfig } from './config/index.ts';
import { QUOTA_ACTIONS } from './quota-metadata.ts';
import { enforceContentCreateQuota, getClubLlmOutputUsage } from './quotas.ts';
import { logger } from './logger.ts';
import {
  generateProducerSecret,
  hashProducerSecret,
  verifyProducerSecret,
} from './producer-secrets.ts';

type RequestLogPool = Pick<Pool, 'query'> & Partial<Pick<Pool, 'end'>>;

const REQUEST_LOG_POOL_MAX_CONNECTIONS = 2;
const REQUEST_LOG_POOL_STATEMENT_TIMEOUT_MS = 2_000;
const REQUEST_LOG_POOL_APPLICATION_NAME = 'clawclub_request_log';

function buildRequestLogPoolConfig(pool: Pool): PoolConfig {
  const shared = {
    max: REQUEST_LOG_POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: 5_000,
    application_name: REQUEST_LOG_POOL_APPLICATION_NAME,
    options: `-c statement_timeout=${REQUEST_LOG_POOL_STATEMENT_TIMEOUT_MS}`,
  } satisfies PoolConfig;

  if (pool.options.connectionString) {
    return {
      ...shared,
      connectionString: pool.options.connectionString,
    };
  }

  return {
    ...shared,
    host: pool.options.host,
    port: pool.options.port,
    database: pool.options.database,
    user: pool.options.user,
    password: pool.options.password,
    ssl: pool.options.ssl,
  };
}

function createRequestLogPool(pool: Pool): Pool {
  const requestLogPool = new Pool(buildRequestLogPoolConfig(pool));
  requestLogPool.on('error', (error) => {
    logger.error('request_log_pool_error', error);
  });
  return requestLogPool;
}

// ── Enrichment helpers ──────────────────────────────────────

function mapVouchToSummary(v: { edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; metadata: Record<string, unknown>; createdAt: string; creatorMemberId: string | null }): MembershipVouchSummary {
  return {
    edgeId: v.edgeId,
    fromMember: { memberId: v.fromMemberId, publicName: v.fromPublicName },
    reason: v.reason,
    metadata: v.metadata,
    createdAt: v.createdAt,
    createdByMember: v.creatorMemberId
      ? { memberId: v.fromMemberId, publicName: v.fromPublicName }
      : null,
  };
}

function mapInlineVouch(v: { edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; createdAt: string }) {
  return {
    edgeId: v.edgeId,
    voucher: {
      memberId: v.fromMemberId,
      publicName: v.fromPublicName,
    },
    reason: v.reason,
    createdAt: v.createdAt,
  };
}

type InlineVouchSummary = ReturnType<typeof mapInlineVouch>;
type VouchableMemberSummary = { memberId: string; vouches: InlineVouchSummary[] };

async function enrichMembersWithVouches<T extends VouchableMemberSummary>(
  pool: Pool,
  clubId: string,
  members: T[],
): Promise<void> {
  if (members.length === 0) return;

  const vouchMap = await batchListVouches(pool, {
    clubId,
    targetMemberIds: [...new Set(members.map((member) => member.memberId))],
    perTargetLimit: 50,
  });

  for (const member of members) {
    member.vouches = (vouchMap.get(member.memberId) ?? []).map(mapInlineVouch);
  }
}

function mergeIncludedById(...bundles: IncludedBundle[]): IncludedBundle {
  const membersById: Record<string, IncludedMember> = {};
  for (const bundle of bundles) {
    Object.assign(membersById, bundle.membersById);
  }
  return { membersById };
}

async function loadNotificationRefs(
  pool: Pool,
  notificationIds: readonly string[],
): Promise<Map<string, NotificationItem['refs']>> {
  const refsByNotificationId = new Map<string, NotificationItem['refs']>();
  if (notificationIds.length === 0) {
    return refsByNotificationId;
  }

  const result = await pool.query<{
    notification_id: string;
    ref_role: string;
    ref_kind: NotificationItem['refs'][number]['kind'];
    ref_id: string;
  }>(
    `select notification_id, ref_role, ref_kind, ref_id
       from notification_refs
      where notification_id = any($1::text[])
      order by notification_id, ref_role, ref_kind, ref_id`,
    [notificationIds],
  );

  for (const row of result.rows) {
    const refs = refsByNotificationId.get(row.notification_id) ?? [];
    refs.push({
      role: row.ref_role,
      kind: row.ref_kind,
      id: row.ref_id,
    });
    refsByNotificationId.set(row.notification_id, refs);
  }

  return refsByNotificationId;
}

async function listMaterializedNotifications(pool: Pool, input: {
  actorMemberId: string;
  accessibleClubIds: string[];
  limit: number;
  after: string | null;
}): Promise<NotificationItem[]> {
  const limit = Math.max(1, Math.min(input.limit, NOTIFICATIONS_PAGE_SIZE)) + 1;
  const afterSeq = input.after ? decodeNotificationCursor(input.after) : null;

  const result = await pool.query<{
    id: string;
    seq: string;
    club_id: string | null;
    producer_id: string;
    topic: string;
    payload_version: number;
    payload: Record<string, unknown>;
    expires_at: string | null;
    created_at: string;
  }>(
    `select mn.id,
            mn.seq::text as seq,
            mn.club_id,
            mn.producer_id,
            mn.topic,
            mn.payload_version,
            mn.payload,
            mn.expires_at::text as expires_at,
            mn.created_at::text as created_at
     from member_notifications mn
     where mn.recipient_member_id = $1
       and (mn.club_id is null or mn.club_id = any($2::text[]))
       and mn.acknowledged_at is null
       and (mn.expires_at is null or mn.expires_at > now())
       and ($3::bigint is null or mn.seq > $3)
     order by mn.seq asc
     limit $4`,
    [
      input.actorMemberId,
      input.accessibleClubIds,
      afterSeq,
      limit,
    ],
  );

  const refsByNotificationId = await loadNotificationRefs(pool, result.rows.map((row) => row.id));

  return result.rows.map((row) => {
    const seq = Number.parseInt(row.seq, 10);
    return {
      notificationId: row.id,
      seq,
      cursor: encodeNotificationCursor(seq),
      producerId: row.producer_id,
      topic: row.topic,
      clubId: row.club_id,
      payloadVersion: row.payload_version,
      payload: row.payload,
      refs: refsByNotificationId.get(row.id) ?? [],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  });
}

async function listInboxFramesSince(pool: Pool, input: {
  actorMemberId: string;
  after: string | null;
  limit: number;
}): Promise<{ frames: MessageFramePayload[]; nextCursor: string | null }> {
  const limit = Math.max(1, input.limit);
  const afterCursor = input.after
    ? (() => {
      const [createdAt, inboxEntryId] = paginationDecodeCursor(input.after!, 2);
      return { createdAt, inboxEntryId };
    })()
    : null;

  if (afterCursor === null) {
    const seed = await pool.query<{
      inbox_entry_id: string;
      created_at: string;
    }>(
      `select ie.id as inbox_entry_id,
              ie.created_at::text as created_at
       from dm_inbox_entries ie
       where ie.recipient_member_id = $1
         and ie.acknowledged_at is null
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
        nextCursor: paginationEncodeCursor([nowResult.rows[0]?.created_at ?? new Date().toISOString(), '']),
      };
    }

    return {
      frames: [],
      nextCursor: paginationEncodeCursor([head.created_at, head.inbox_entry_id]),
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
       and ie.acknowledged_at is null
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
    return { frames: [], nextCursor: input.after };
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
  }>(
    `select m.id as message_id,
            m.thread_id,
            m.sender_member_id,
            m.role::text as role,
            m.message_text,
            m.payload,
            m.created_at::text as created_at
     from dm_messages m
     where m.id = any($1::text[])`,
    [messageIds],
  );

  const threadResult = await pool.query<{
    thread_id: string;
    counterpart_member_id: string;
    counterpart_public_name: string;
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

  const participantIdsByThreadId = new Map(
    threadResult.rows.map((row) => [row.thread_id, [input.actorMemberId, row.counterpart_member_id]]),
  );
  const messageMentions = await loadDmMentions(pool, messageIds, {
    participantIdsByMessageId: new Map(
      messageResult.rows.map((row) => [row.message_id, participantIdsByThreadId.get(row.thread_id) ?? [input.actorMemberId]]),
    ),
  });
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
    };
    return [row.message_id, message];
  }));

  const latestVisibleMessageIds = threadResult.rows
    .filter((row) => !row.latest_is_removed)
    .map((row) => row.latest_message_id);
  const latestThreadMentions = await loadDmMentions(pool, latestVisibleMessageIds, {
    participantIdsByMessageId: new Map(
      threadResult.rows
        .filter((row) => !row.latest_is_removed)
        .map((row) => [row.latest_message_id, [input.actorMemberId, row.counterpart_member_id]]),
    ),
  });
  const participantIncluded = await loadIncludedMembers(
    pool,
    [input.actorMemberId, ...new Set(threadResult.rows.map((row) => row.counterpart_member_id))],
  );
  const threadSummaries = await directThreadSummariesFor(
    pool,
    input.actorMemberId,
    threadResult.rows.map((row): MessagingThreadSummary => ({
      threadId: row.thread_id,
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
    })),
  );

  const threadsById = new Map(threadSummaries.map((thread) => [thread.threadId, thread]));

  const frames = inboxRows.rows.flatMap((row) => {
    const thread = threadsById.get(row.thread_id);
    const message = messagesById.get(row.message_id);
    if (!thread) {
      throw new Error(`Missing DM thread summary for inbox row ${row.inbox_entry_id}`);
    }
    if (!message) {
      throw new Error(`Missing DM message ${row.message_id} for inbox row ${row.inbox_entry_id}`);
    }

    const participantBundle: IncludedBundle = {
      membersById: [input.actorMemberId, thread.counterpart.memberId].reduce<Record<string, IncludedMember>>((acc, memberId) => {
        const member = participantIncluded.membersById[memberId];
        if (member) {
          acc[memberId] = member;
        }
        return acc;
      }, {}),
    };
    const mentionIncluded: IncludedBundle = {
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
      included: mergeIncludedBundles(participantBundle, mentionIncluded),
    }];
  });

  const lastInboxRow = inboxRows.rows[inboxRows.rows.length - 1];
  return {
    frames,
    nextCursor: lastInboxRow ? paginationEncodeCursor([lastInboxRow.created_at, lastInboxRow.inbox_entry_id]) : input.after,
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

async function directThreadSummariesFor(
  pool: Pool,
  actorMemberId: string,
  threads: readonly MessagingThreadSummary[],
): Promise<DirectMessageThreadSummary[]> {
  const counterpartIds = [...new Set(threads.map((thread) => thread.counterpartMemberId))];
  const sharedClubsMap = await batchResolveSharedClubs(pool, actorMemberId, counterpartIds);

  return threads.map((thread) => ({
    threadId: thread.threadId,
    sharedClubs: sharedClubsMap.get(thread.counterpartMemberId) ?? [],
    counterpart: {
      memberId: thread.counterpartMemberId,
      publicName: thread.counterpartPublicName,
    },
    latestMessage: thread.latestMessage,
    messageCount: thread.messageCount,
  }));
}

async function directInboxSummariesFor(
  pool: Pool,
  actorMemberId: string,
  entries: readonly MessagingInboxEntry[],
): Promise<DirectMessageInboxSummary[]> {
  const threadSummaries = await directThreadSummariesFor(pool, actorMemberId, entries);

  return entries.map((entry, index) => ({
    ...threadSummaries[index]!,
    unread: {
      hasUnread: entry.hasUnread,
      unreadMessageCount: entry.unreadCount,
      unreadUpdateCount: entry.unreadCount,
      latestUnreadMessageCreatedAt: entry.latestUnreadAt,
    },
  }));
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

type NotificationProducerRow = {
  producer_id: string;
  namespace_prefix: string;
  burst_limit: number | null;
  hourly_limit: number | null;
  daily_limit: number | null;
  status: 'active' | 'disabled';
  created_at: string;
  rotated_at: string | null;
};

type NotificationProducerTopicRow = {
  producer_id: string;
  topic: string;
  delivery_class: 'transactional' | 'informational' | 'suggestion';
  status: 'active' | 'disabled';
  created_at: string;
};

function mapNotificationProducer(row: NotificationProducerRow) {
  return {
    producerId: row.producer_id,
    namespacePrefix: row.namespace_prefix,
    burstLimit: row.burst_limit,
    hourlyLimit: row.hourly_limit,
    dailyLimit: row.daily_limit,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  };
}

function mapNotificationProducerTopic(row: NotificationProducerTopicRow) {
  return {
    producerId: row.producer_id,
    topic: row.topic,
    deliveryClass: row.delivery_class,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── Factory ─────────────────────────────────────────────────

export function createRepository(
  pool: Pool,
  options: { requestLogPool?: RequestLogPool } = {},
): Repository & { close?: () => Promise<void> } {
  const identity = createIdentityRepository(pool);
  const messaging = createMessagingRepository(pool);
  const clubs = createClubsRepository(pool);
  const requestLogPool = options.requestLogPool ?? createRequestLogPool(pool);
  const ownsRequestLogPool = !options.requestLogPool;
  const loadSuperadminClubDetail = async (clubId: string): Promise<SuperadminClubDetail | null> => {
    const [clubResult, memberCounts, contentCount, messageCount, spendStatus, llmOutputUsage] = await Promise.all([
      pool.query<{
        club_id: string;
        slug: string;
        name: string;
        summary: string | null;
        admission_policy: string | null;
        uses_free_allowance: boolean;
        member_cap: number | null;
        archived_at: string | null;
        owner_member_id: string;
        owner_public_name: string;
        owner_email: string | null;
        version_no: number;
        version_created_at: string;
        version_created_by_member_id: string | null;
        version_created_by_member_public_name: string | null;
      }>(
        `select
           c.id as club_id,
           c.slug,
           c.name,
           c.summary,
           cv.admission_policy,
           c.uses_free_allowance,
           c.member_cap,
           c.archived_at::text as archived_at,
           cv.owner_member_id,
           owner_member.public_name as owner_public_name,
           owner_member.email as owner_email,
           cv.version_no,
           cv.created_at::text as version_created_at,
           cv.created_by_member_id as version_created_by_member_id,
           creator.public_name as version_created_by_member_public_name
         from clubs c
         join current_club_versions cv on cv.club_id = c.id
         join members owner_member on owner_member.id = cv.owner_member_id
         left join members creator on creator.id = cv.created_by_member_id
         where c.id = $1
         limit 1`,
        [clubId],
      ),
      pool.query<{ status: string; count: string }>(
        `select cm.status::text as status, count(*)::text as count
         from club_memberships cm
         where cm.club_id = $1
         group by cm.status`,
        [clubId],
      ),
      pool.query<{ count: string }>(
        `select count(*)::text as count
         from contents
         where club_id = $1
           and deleted_at is null`,
        [clubId],
      ),
      pool.query<{ count: string }>(
        `select count(*)::text as count
         from dm_messages m
         join dm_threads t on t.id = m.thread_id
         where exists (
           select 1
           from accessible_club_memberships am
           where am.member_id = t.member_a_id
             and am.club_id = $1
         )
         and exists (
           select 1
           from accessible_club_memberships am
           where am.member_id = t.member_b_id
             and am.club_id = $1
         )`,
        [clubId],
      ),
      getClubSpendBudgetStatus(pool, clubId),
      getClubLlmOutputUsage(pool, clubId),
    ]);

    const club = clubResult.rows[0];
    if (!club) return null;

    const spendBudget = getClubSpendBudgetPolicy();
    const llmOutputMaxes = deriveQuotaWindowMaxes(getConfig().policy.quotas.actions[QUOTA_ACTIONS.llmOutputTokens].dailyMax);

    return {
      clubId: club.club_id,
      slug: club.slug,
      name: club.name,
      summary: club.summary,
      admissionPolicy: club.admission_policy,
      usesFreeAllowance: club.uses_free_allowance,
      memberCap: club.uses_free_allowance
        ? getConfig().policy.clubs.freeClubMemberCap
        : club.member_cap,
      archivedAt: club.archived_at,
      owner: {
        memberId: club.owner_member_id,
        publicName: club.owner_public_name,
        email: club.owner_email,
      },
      version: {
        no: Number(club.version_no),
        status: club.archived_at === null ? 'active' : 'archived',
        reason: null,
        createdAt: club.version_created_at,
        createdByMember: club.version_created_by_member_id
          ? {
            memberId: club.version_created_by_member_id,
            publicName: club.version_created_by_member_public_name as string,
          }
          : null,
      },
      memberCounts: Object.fromEntries(memberCounts.rows.map((row) => [row.status, Number(row.count)])),
      contentCount: Number(contentCount.rows[0]?.count ?? 0),
      messageCount: Number(messageCount.rows[0]?.count ?? 0),
      aiSpend: {
        budget: spendBudget,
        usage: spendStatus.windows.map((window) => ({
          window: window.window,
          usedMicroCents: window.usedMicroCents,
          remainingMicroCents: window.remainingMicroCents,
        })),
      },
      llmOutputTokens: {
        scope: 'per_club_member',
        perMemberBudget: {
          dailyMax: llmOutputMaxes.day,
          weeklyMax: llmOutputMaxes.week,
          monthlyMax: llmOutputMaxes.month,
        },
        usage: llmOutputUsage.map((window) => ({
          window: window.window,
          usedTokens: window.used,
        })),
      },
    };
  };

  return {
    // ── Auth ───────────────────────────────────────────────
    authenticateBearerToken: (bearerToken) => identity.authenticateBearerToken(bearerToken),
    validateBearerTokenPassive: (bearerToken) => identity.validateBearerTokenPassive(bearerToken),
    async authenticateProducer(input) {
      const producerId = input.producerId.trim();
      if (producerId.length === 0) {
        return null;
      }

      const result = await pool.query<{
        producer_id: string;
        status: 'active' | 'disabled';
        secret_hash_current: string;
        secret_hash_previous: string | null;
      }>(
        `select producer_id, status, secret_hash_current, secret_hash_previous
           from notification_producers
          where producer_id = $1
          limit 1`,
        [producerId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const secret = input.secret.trim();
      if (
        !verifyProducerSecret(secret, row.secret_hash_current)
        && !verifyProducerSecret(secret, row.secret_hash_previous)
      ) {
        return null;
      }

      return {
        producerId: row.producer_id,
        status: row.status,
      };
    },

    // ── Clubs ──────────────────────────────────────────────
    findClubBySlug: (input) => identity.findClubBySlug(input),
    listClubs: (input) => identity.listClubs(input),
    createClub: (input) => identity.createClub(input),
    archiveClub: (input) => identity.archiveClub(input),
    assignClubOwner: (input) => identity.assignClubOwner(input),
    updateClub: (input) => identity.updateClub(input),
    removeClub: (input) => identity.removeClub(input),
    listRemovedClubs: (input) => identity.listRemovedClubs(input),
    restoreRemovedClub: (input) => identity.restoreRemovedClub(input),
    loadClubForGate: (input) => identity.loadClubForGate(input),

    // ── Memberships ────────────────────────────────────────
    createMembership: (input) => identity.createMembership(input),
    async listMembers(input) {
      const paginated = await identity.listMembers(input);
      await enrichMembersWithVouches(pool, input.clubId, paginated.results);
      return paginated;
    },
    async getMember(input) {
      const summary = await identity.getMember(input);
      if (!summary) return null;

      await enrichMembersWithVouches(pool, input.clubId, [summary]);
      return summary;
    },
    async listAdminMembers(input) {
      const paginated = await identity.listAdminMembers(input);
      await enrichMembersWithVouches(pool, input.clubId, paginated.results);
      return paginated;
    },
    async getAdminMember(input) {
      const summary = await identity.getAdminMember(input);
      if (!summary) return null;

      await enrichMembersWithVouches(pool, input.clubId, [summary]);
      return summary;
    },
    updateMembership: (input) => identity.updateMembership(input),
    promoteMemberToAdmin: (input) => identity.promoteMemberToAdmin!(input),
    demoteMemberFromAdmin: (input) => identity.demoteMemberFromAdmin!(input),
    transitionMembershipState: (input) => admission.transitionMembershipStateWithApplicationEffects(pool, input),

    // ── Profiles ───────────────────────────────────────────
    buildMembershipSeedProfile: (input) => identity.buildMembershipSeedProfile(input),
    updateMemberIdentity: (input) => identity.updateMemberIdentity(input),
    updateClubProfile: (input) => identity.updateClubProfile(input),
    loadProfileForGate: (input) => identity.loadProfileForGate(input),
    preflightCreateContentMentions: (input) => preflightContentCreateMentions(pool, input),
    preflightUpdateContentMentions: (input) => preflightContentUpdateMentions(pool, input),

    // ── Tokens ─────────────────────────────────────────────
    listBearerTokens: (input) => identity.listBearerTokens(input),
    createBearerToken: (input) => identity.createBearerToken(input),
    revokeBearerToken: (input) => identity.revokeBearerToken(input),

    // ── Search ─────────────────────────────────────────────
    fullTextSearchMembers: (input) => identity.fullTextSearchMembers(input),
    findMembersViaEmbedding: (input) => identity.findMembersViaEmbedding(input),

    // ── Entities ──────────────────────────────────────────
    createContent: (input) => clubs.createContent(input),

    readContent: (input) => clubs.readContent(input),

    async updateContent(input) {
      return clubs.updateContent(input);
    },

    loadContentForGate: (input) => clubs.loadContentForGate(input),
    resolveContentThreadClubIdForGate: (input) => clubs.resolveContentThreadClubIdForGate(input),
    resolveContentClubIdForGate: (input) => clubs.resolveContentClubIdForGate(input),

    closeContentLoop: (input) => clubs.closeContentLoop(input),

    reopenContentLoop: (input) => clubs.reopenContentLoop(input),

    removeContent: (input) => clubs.removeContent({
      id: input.id,
      accessibleClubIds: input.accessibleClubIds,
      actorMemberId: input.actorMemberId,
      reason: input.reason,
      moderatorRemoval: input.moderatorRemoval,
    }),

    listContent: (input) => clubs.listContent(input),
    readContentThread: (input) => clubs.readContentThread(input),

    // ── Events ──────────────────────────────────────────
    listEvents: (input) => clubs.listEvents(input),
    rsvpEvent: (input) => clubs.rsvpEvent(input),
    cancelEventRsvp: (input) => clubs.cancelEventRsvp(input),

    // ── Vouches ──────────────────────────────────────────
    checkVouchTargetAccessible: (input) => clubs.checkVouchTargetAccessible(input),

    async createVouch(input) {
      return withTransaction(pool, async (client) => {
        const raw = await createClubVouch(client, input);
        if (!raw) return null;

        const club = await client.query<{ slug: string; name: string }>(
          `select slug, name from clubs where id = $1 limit 1`,
          [input.clubId],
        );
        const clubRow = club.rows[0];
        if (clubRow) {
          const message = buildVouchReceivedMessage({
            voucherPublicName: raw.fromPublicName,
            clubName: clubRow.name,
            clubId: input.clubId,
            vouchedMemberId: input.targetMemberId,
            reason: raw.reason,
          });
          await deliverCoreNotifications(client, [{
            clubId: input.clubId,
            recipientMemberId: input.targetMemberId,
            topic: 'vouch.received',
            payloadVersion: 1,
            idempotencyKey: raw.edgeId,
            payload: {
              voucher: {
                memberId: raw.fromMemberId,
                publicName: raw.fromPublicName,
              },
              club: {
                clubId: input.clubId,
                slug: clubRow.slug,
                name: clubRow.name,
              },
              reason: raw.reason,
              createdAt: raw.createdAt,
              message,
            },
            refs: [
              { role: 'subject', kind: 'member', id: input.targetMemberId },
              { role: 'club_context', kind: 'club', id: input.clubId },
              { role: 'actor', kind: 'member', id: raw.fromMemberId },
            ],
          }]);
        }

        return mapVouchToSummary(raw);
      });
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
    registerAccount: (input) => admission.registerAccount(pool, input),
    updateContactEmail: (input) => admission.updateContactEmail(pool, input),
    applyToClub: (input) => admission.applyToClub(pool, input),
    redeemInvitationApplication: (input) => admission.redeemInvitationApplication(pool, input),
    reviseClubApplication: (input) => admission.reviseClubApplication(pool, input),
    getMemberApplicationById: (input) => admission.getMemberApplicationById(pool, input),
    listMemberApplications: (input) => admission.listMemberApplications(pool, input),
    withdrawClubApplication: (input) => admission.withdrawClubApplication(pool, input),
    listAdminClubApplications: (input) => admission.listAdminClubApplications(pool, input),
    getAdminClubApplicationById: (input) => admission.getAdminClubApplicationById(pool, input),
    decideClubApplication: (input) => admission.decideClubApplication(pool, input),
    resolveInvitationTarget: (input) => unifiedClubs.resolveInvitationTarget(pool, input),
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

      // Platform standing check. Both parties must be members.state = 'active'
      // at write time. The actor side is also enforced by auth's readActor
      // filter, but we re-check here so the DM gate is self-contained and
      // covers the race where a caller authenticates and then gets banned
      // before this write runs.
      const standingResult = await pool.query<{ actor_active: boolean; recipient_active: boolean }>(
        `select
           exists(select 1 from members where id = $1 and state = 'active') as actor_active,
           exists(select 1 from members where id = $2 and state = 'active') as recipient_active`,
        [input.actorMemberId, input.recipientMemberId],
      );
      const standing = standingResult.rows[0];
      if (!standing?.actor_active) {
        throw new AppError('account_not_active', 'Your account is no longer active and cannot send messages.');
      }
      if (!standing?.recipient_active) {
        throw new AppError('recipient_unavailable', 'That recipient is no longer active on ClawClub and cannot receive messages.');
      }

      const msg = await messaging.sendMessage({
        senderMemberId: input.actorMemberId,
        recipientMemberId: input.recipientMemberId,
        messageText: input.messageText,
        clientKey: input.clientKey,
      });

      return {
        message: {
          messageId: msg.message.messageId,
          threadId: msg.message.threadId,
          senderMemberId: msg.message.senderMemberId,
          role: 'member',
          messageText: msg.message.messageText,
          mentions: msg.message.mentions,
          payload: {},
          createdAt: msg.message.createdAt,
        },
        thread: {
          threadId: msg.message.threadId,
          recipientMemberId: msg.message.recipientMemberId,
          sharedClubs,
        },
        included: msg.included,
      };
    },

    async listDirectMessageThreads({ actorMemberId, limit }) {
      const threads = await messaging.listDirectThreads({ memberId: actorMemberId, limit });
      return directThreadSummariesFor(pool, actorMemberId, threads);
    },

    async listDirectMessageInbox(input) {
      const paginated = await messaging.listInbox({
        memberId: input.actorMemberId,
        limit: input.limit,
        unreadOnly: input.unreadOnly,
        cursor: input.cursor,
      });
      const entries = paginated.results;

      return {
        results: await directInboxSummariesFor(pool, input.actorMemberId, entries),
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

      const thread = (await directThreadSummariesFor(pool, input.actorMemberId, [result.thread]))[0];

      return {
        thread: thread!,
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
        highWaterMark: result.highWaterMark,
        hasMore: result.hasMore,
      };
    },

    async listNotifications(input) {
      const limit = Math.max(1, Math.min(input.limit, NOTIFICATIONS_PAGE_SIZE));
      const materialized = await listMaterializedNotifications(pool, {
        actorMemberId: input.actorMemberId,
        accessibleClubIds: input.accessibleClubIds,
        limit,
        after: input.after,
      });

      const page = materialized.slice(0, limit);
      const nextCursor = materialized.length > limit
        ? page[page.length - 1]?.cursor ?? null
        : null;

      return {
        items: page,
        nextCursor,
      };
    },

    async acknowledgeNotifications(input) {
      return withTransaction(pool, async (client) => {
        const notificationIds = [...new Set(input.notificationIds.map((notificationId) => notificationId.trim()).filter(Boolean))];
        if (notificationIds.length === 0) {
          return [];
        }

        const result = await acknowledgeNotificationsById(client, {
          recipientMemberId: input.actorMemberId,
          notificationIds,
        });

        const receiptsById = new Map<string, NotificationReceipt>(
          result.map((row) => [row.id, {
            notificationId: row.id,
            state: 'processed',
            acknowledgedAt: row.acknowledgedAt,
          }]),
        );

        return notificationIds
          .map((notificationId) => receiptsById.get(notificationId) ?? {
            notificationId,
            state: 'suppressed',
            acknowledgedAt: null,
          });
      });
    },

    async deliverProducerNotifications(input) {
      return withTransaction(pool, async (client) => (
        deliverNotifications(client, input.notifications.map((notification) => ({
          producerId: input.producerId,
          topic: notification.topic,
          recipientMemberId: notification.recipientMemberId,
          clubId: notification.clubId,
          payload: notification.payload,
          payloadVersion: notification.payloadVersion,
          idempotencyKey: notification.idempotencyKey,
          expiresAt: notification.expiresAt,
          refs: notification.refs,
        })))
      ));
    },

    async acknowledgeProducerNotifications(input) {
      return withTransaction(pool, async (client) => (
        acknowledgeProducerNotificationsById(client, {
          producerId: input.producerId,
          notificationIds: input.notificationIds,
        })
      ));
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
    enforceClubsCreateQuota: (input) => clubs.enforceClubsCreateQuota(input),
    enforceContentCreateQuota: (input) => enforceContentCreateQuota(pool, input),

    // ── LLM ────────────────────────────────────────────────
    logApiRequest: (input) => insertApiRequestLog(requestLogPool, input),
    logLlmUsage: (input) => clubs.logLlmUsage(input),
    reserveLlmOutputBudget: (input) => clubs.reserveLlmOutputBudget(input),
    finalizeLlmOutputBudget: (input) => clubs.finalizeLlmOutputBudget(input),
    reserveClubSpendBudget: (input) => clubs.reserveClubSpendBudget(input),
    finalizeClubSpendBudget: (input) => clubs.finalizeClubSpendBudget(input),
    releaseClubSpendBudget: (input) => clubs.releaseClubSpendBudget(input),
    async peekIdempotencyReplay(input) {
      const existing = await lookupIdempotency<unknown>(pool, input);
      return existing.status === 'hit';
    },
    withClientKeyBarrier: (input) => withClientKeyBarrier(pool, input),
    enforceEmbeddingQueryQuota: (input) => clubs.enforceEmbeddingQueryQuota(input),
    async close() {
      if (!ownsRequestLogPool || typeof requestLogPool.end !== 'function') {
        return;
      }
      await requestLogPool.end();
    },

    // ── Embeddings ─────────────────────────────────────────
    findContentViaEmbedding: (input) => clubs.findContentViaEmbedding(input),

    // ── Admin: member/membership creation ───────────────
    adminCreateMember: (input) => identity.createMemberDirect(input),
    adminRemoveMember: (input) => identity.removeMember(input),
    adminCreateMembership: (input) => identity.createMembershipAsSuperadmin(input),

    // ── Admin ───────────────────────────────────────────
    async adminGetOverview(_input) {
      const stats = await pool.query<{
        total_members: number;
        active_members: number;
        active_clubs: number;
        live_contents: number;
        total_messages: number;
        pending_applications: number;
      }>(
        `select
            total_members,
            active_members,
            active_clubs,
            live_contents,
            total_messages,
            pending_applications
         from platform_stats
         where singleton = true
         limit 1`,
      );
      const overview = stats.rows[0];
      if (!overview) {
        throw new AppError('invalid_data', 'platform_stats row is missing.');
      }

      const recentMembers = await pool.query<{
        member_id: string; public_name: string; created_at: string;
      }>(
        `select id as member_id, public_name, created_at::text as created_at
         from members
         order by created_at desc limit 5`,
      );

      return {
        totalMembers: overview.total_members,
        activeMembers: overview.active_members,
        totalClubs: overview.active_clubs,
        totalContent: overview.live_contents,
        totalMessages: overview.total_messages,
        pendingApplications: overview.pending_applications,
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

      const rows: SuperadminMemberSummary[] = result.rows.map((r) => ({
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
        version_created_by_member_public_name: string | null;
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
           cmp.created_by_member_id as version_created_by_member_id,
           creator.public_name as version_created_by_member_public_name
         from current_member_club_profiles cmp
         join clubs c on c.id = cmp.club_id
         left join members creator on creator.id = cmp.created_by_member_id
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
            no: Number(row.version_no),
            createdAt: row.version_created_at,
            createdByMember: row.version_created_by_member_id
              ? {
                memberId: row.version_created_by_member_id,
                publicName: row.version_created_by_member_public_name as string,
              }
              : null,
          },
        })),
      };
    },

    async adminGetClub({ clubId }) {
      return loadSuperadminClubDetail(clubId);
    },

    async adminGetClubStats({ clubId }) {
      const detail = await loadSuperadminClubDetail(clubId);
      if (!detail) return null;
      return {
        clubId: detail.clubId,
        slug: detail.slug,
        name: detail.name,
        archivedAt: detail.archivedAt,
        memberCounts: detail.memberCounts,
        contentCount: detail.contentCount,
        messageCount: detail.messageCount,
      };
    },

    async adminListContent({ clubId, kind, limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        content_id: string; thread_id: string; club_id: string; club_name: string; kind: string;
        author_member_id: string; author_public_name: string;
        content_version_id: string; version_no: number; title: string | null; state: string; reason: string | null; created_at: string;
        version_created_by_member_id: string | null; version_created_by_member_public_name: string | null;
      }>(
        `select e.id as content_id, e.thread_id, e.club_id, c.name as club_name,
                e.kind::text as kind, e.author_member_id,
                m.public_name as author_public_name,
                cev.id as content_version_id,
                cev.version_no,
                cev.title,
                cev.state::text as state,
                cev.reason,
                e.created_at::text as created_at,
                cev.created_by_member_id as version_created_by_member_id,
                creator.public_name as version_created_by_member_public_name
         from contents e
         join current_content_versions cev on cev.content_id = e.id
         join members m on m.id = e.author_member_id
         left join members creator on creator.id = cev.created_by_member_id
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
        pageRows.map((row) => row.content_version_id),
        'superadmin',
      );

      const rows = pageRows.map((r) => {
        return {
          id: r.content_id, threadId: r.thread_id, clubId: r.club_id, clubName: r.club_name,
          kind: r.kind as any, author: { memberId: r.author_member_id, publicName: r.author_public_name },
          version: {
            no: Number(r.version_no),
            status: r.state as any,
            reason: r.reason,
            title: r.state === 'removed' ? '[redacted]' : r.title,
            titleMentions: r.state === 'removed'
              ? []
              : (mentionBundle.mentionsByVersionId.get(r.content_version_id)?.title ?? []),
            createdAt: r.created_at,
            createdByMember: r.version_created_by_member_id
              ? {
                memberId: r.version_created_by_member_id,
                publicName: r.version_created_by_member_public_name as string,
              }
              : null,
          },
        };
      });
      const last = rows[rows.length - 1];
      const nextCursor = last ? paginationEncodeCursor([last.version.createdAt, last.id]) : null;
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
        latestActivityAt: r.latest_message_at ?? '',
      }));
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const lastRow = hasMore || rows.length === limit ? result.rows[rows.length - 1] : null;
      const nextCursor = lastRow && rows.length > 0
        ? paginationEncodeCursor([lastRow.created_at, lastRow.thread_id])
        : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminReadThread({ threadId, limit, cursor }) {
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

      const fetchLimit = limit + 1;
      const messages = await pool.query<{
        message_id: string; thread_id: string; sender_member_id: string | null;
        role: string; message_text: string | null; payload: Record<string, unknown> | null;
        created_at: string; is_removed: boolean;
      }>(
        `select m.id as message_id, m.thread_id, m.sender_member_id,
                m.role::text as role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as message_text,
                case when rmv.message_id is not null then null else m.payload end as payload,
                m.created_at::text as created_at,
                (rmv.message_id is not null) as is_removed
         from dm_messages m
         left join dm_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
           and (
             $2::timestamptz is null
             or m.created_at < $2
             or (m.created_at = $2 and m.id < $3)
           )
         order by m.created_at desc, m.id desc limit $4`,
        [threadId, cursor?.createdAt ?? null, cursor?.messageId ?? null, fetchLimit],
      );

      const latestMsg = messages.rows[0];
      const hasMore = messages.rows.length > limit;
      const pageRows = hasMore ? messages.rows.slice(0, limit) : messages.rows;
      const lastRow = pageRows[pageRows.length - 1];

      const participantIds = thread.rows[0].participants.map(p => p.memberId);
      const threadSharedClubs = participantIds.length === 2
        ? await resolveSharedClubsUnscoped(pool, participantIds[0], participantIds[1])
        : [];
      const mentionBundle = await loadDmMentions(
        pool,
        pageRows.filter((row) => !row.is_removed).map((row) => row.message_id),
        { threadParticipantIds: participantIds },
      );

      return {
        thread: {
          threadId: thread.rows[0].thread_id,
          sharedClubs: threadSharedClubs,
          participants: thread.rows[0].participants,
          messageCount: thread.rows[0].message_count,
          latestActivityAt: latestMsg?.created_at ?? '',
        },
        messages: {
          results: pageRows.map((r) => ({
          messageId: r.message_id, threadId: r.thread_id, senderMemberId: r.sender_member_id,
          role: r.role as 'member' | 'agent' | 'system',
          messageText: r.message_text,
          mentions: r.is_removed ? [] : (mentionBundle.mentionsByMessageId.get(r.message_id) ?? []),
          payload: r.payload ?? {},
          createdAt: r.created_at,
          })),
          hasMore,
          nextCursor: hasMore && lastRow ? paginationEncodeCursor([lastRow.created_at, lastRow.message_id]) : null,
        },
        included: mentionBundle.included,
      };
    },

    adminListMemberTokens: ({ memberId, limit, cursor }) => identity.listBearerTokens({ actorMemberId: memberId, limit, cursor }),

    async adminRevokeMemberToken({ memberId, tokenId }) {
      return identity.revokeBearerToken({ actorMemberId: memberId, tokenId });
    },

    adminCreateAccessToken: (input) => identity.createBearerTokenAsSuperadmin(input),

    async adminCreateNotificationProducer(input) {
      const namespacePrefix = input.namespacePrefix.trim();
      const producerId = input.producerId.trim();

      if (producerId.length === 0) {
        throw new AppError('invalid_input', 'producerId must not be empty.');
      }
      if (namespacePrefix.length > 0 && !namespacePrefix.endsWith('.')) {
        throw new AppError('invalid_input', 'namespacePrefix must end with "." when set.');
      }

      for (const topic of input.topics) {
        if (namespacePrefix.length > 0 && !topic.topic.startsWith(namespacePrefix)) {
          throw new AppError('invalid_input', `Topic ${topic.topic} does not match namespacePrefix ${namespacePrefix}.`);
        }
      }

      const performCreate = async (client: DbClient) => {
        const secret = generateProducerSecret();
        const producerResult = await client.query<NotificationProducerRow>(
          `insert into notification_producers (
             producer_id,
             secret_hash_current,
             secret_hash_previous,
             namespace_prefix,
             burst_limit,
             hourly_limit,
             daily_limit,
             status
           )
           values ($1, $2, null, $3, $4, $5, $6, 'active')
           on conflict (producer_id) do nothing
           returning producer_id,
                     namespace_prefix,
                     burst_limit,
                     hourly_limit,
                     daily_limit,
                     status,
                     created_at::text as created_at,
                     rotated_at::text as rotated_at`,
          [
            producerId,
            hashProducerSecret(secret),
            namespacePrefix,
            input.burstLimit ?? null,
            input.hourlyLimit ?? null,
            input.dailyLimit ?? null,
          ],
        );

        const producer = producerResult.rows[0];
        if (!producer) {
          throw new AppError('invalid_state', `Notification producer ${producerId} already exists.`);
        }

        const topicRows: NotificationProducerTopicRow[] = [];
        for (const topic of input.topics) {
          const topicResult = await client.query<NotificationProducerTopicRow>(
            `insert into notification_producer_topics (
               producer_id,
               topic,
               delivery_class,
               status
             )
             values ($1, $2, $3, $4)
             returning producer_id,
                       topic,
                       delivery_class,
                       status,
                       created_at::text as created_at`,
            [
              producerId,
              topic.topic,
              topic.deliveryClass,
              topic.status ?? 'active',
            ],
          );
          topicRows.push(topicResult.rows[0]!);
        }

        return {
          producer: mapNotificationProducer(producer),
          topics: topicRows.map(mapNotificationProducerTopic),
          secret,
        };
      };

      return withTransaction(pool, (client) => withIdempotency(client, {
        actorContext: input.idempotencyActorContext,
        clientKey: input.clientKey,
        requestValue: input.idempotencyRequestValue,
        execute: async () => {
          const created = await performCreate(client);
          const { secret: _secret, ...safeCreated } = created;
          return { responseValue: created, storedValue: safeCreated };
        },
        onReplay: (storedValue) => throwSecretReplayUnavailable(storedValue),
      }));
    },

    async adminRotateNotificationProducerSecret(input) {
      const performRotate = async (client: DbClient) => {
        const secret = generateProducerSecret();
        const result = await client.query<NotificationProducerRow>(
          `update notification_producers
              set secret_hash_previous = secret_hash_current,
                  secret_hash_current = $2,
                  rotated_at = now()
            where producer_id = $1
          returning producer_id,
                    namespace_prefix,
                    burst_limit,
                    hourly_limit,
                    daily_limit,
                    status,
                    created_at::text as created_at,
                    rotated_at::text as rotated_at`,
          [input.producerId, hashProducerSecret(secret)],
        );

        const producer = result.rows[0];
        if (!producer) {
          return null;
        }

        return {
          producer: mapNotificationProducer(producer),
          secret,
        };
      };

      return withTransaction(pool, (client) => withIdempotency(client, {
        actorContext: input.idempotencyActorContext,
        clientKey: input.clientKey,
        requestValue: input.idempotencyRequestValue,
        execute: async () => {
          const rotated = await performRotate(client);
          if (!rotated) return { responseValue: null };
          const { secret: _secret, ...safeRotated } = rotated;
          return { responseValue: rotated, storedValue: safeRotated };
        },
        onReplay: (storedValue) => throwSecretReplayUnavailable(storedValue),
      }));
    },

    async adminUpdateNotificationProducerStatus(input) {
      const result = await pool.query<NotificationProducerRow>(
        `update notification_producers
            set status = $2
          where producer_id = $1
        returning producer_id,
                  namespace_prefix,
                  burst_limit,
                  hourly_limit,
                  daily_limit,
                  status,
                  created_at::text as created_at,
                  rotated_at::text as rotated_at`,
        [input.producerId, input.status],
      );
      const producer = result.rows[0];
      return producer ? mapNotificationProducer(producer) : null;
    },

    async adminUpdateNotificationProducerTopicStatus(input) {
      const result = await pool.query<NotificationProducerTopicRow>(
        `update notification_producer_topics
            set status = $3
          where producer_id = $1
            and topic = $2
        returning producer_id,
                  topic,
                  delivery_class,
                  status,
                  created_at::text as created_at`,
        [input.producerId, input.topic, input.status],
      );
      const topic = result.rows[0];
      return topic ? mapNotificationProducerTopic(topic) : null;
    },

    async adminGetDiagnostics(): Promise<AdminDiagnostics> {
      const [migrationResult, memberCount, clubCount, tableCount, dbSize, queueCounts, byModelRows, oldestClaimable, retryErrorRows] = await Promise.all([
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
        pool.query<{ collected_at: string; claimable: string; scheduled_future: string; at_or_over_max: string }>(
          `select now()::text as collected_at,
                  count(*) filter (where state in ('queued', 'budget_blocked') and next_attempt_at <= now())::text as claimable,
                  count(*) filter (where state in ('queued', 'budget_blocked') and next_attempt_at > now())::text as scheduled_future,
                  count(*) filter (where state = 'failed')::text as at_or_over_max
           from ai_embedding_jobs`,
        ),
        pool.query<{ model: string; dimensions: number; claimable: string; scheduled_future: string; at_or_over_max: string }>(
          `select model,
                  dimensions,
                  count(*) filter (where state in ('queued', 'budget_blocked') and next_attempt_at <= now())::text as claimable,
                  count(*) filter (where state in ('queued', 'budget_blocked') and next_attempt_at > now())::text as scheduled_future,
                  count(*) filter (where state = 'failed')::text as at_or_over_max
           from ai_embedding_jobs
           group by model, dimensions
           order by model, dimensions`,
        ),
        pool.query<{ age_seconds: string | null }>(
          `select extract(epoch from (now() - min(created_at)))::text as age_seconds
           from ai_embedding_jobs
           where state in ('queued', 'budget_blocked')
             and next_attempt_at <= now()`,
        ),
        pool.query<{
          id: string;
          subject_kind: 'member_club_profile_version' | 'content_version';
          model: string;
          attempt_count: number;
          last_error: string | null;
          next_attempt_at: string;
        }>(
          `select id,
                  subject_kind::text as subject_kind,
                  model,
                  attempt_count,
                  substring(last_error from 1 for 500) as last_error,
                  next_attempt_at::text as next_attempt_at
           from ai_embedding_jobs
           where last_error is not null
             and coalesce(failure_kind, '') <> 'budget_blocked'
           order by attempt_count desc, next_attempt_at asc
           limit 10`,
        ),
      ]);

      const queueRow = queueCounts.rows[0];
      if (!queueRow) {
        throw new Error('adminGetDiagnostics queue aggregate returned no rows');
      }

      return {
        migrationCount: Number(migrationResult.rows[0]?.count ?? 0),
        latestMigration: migrationResult.rows[0]?.latest ?? null,
        memberCount: Number(memberCount.rows[0]?.count ?? 0),
        clubCount: Number(clubCount.rows[0]?.count ?? 0),
        totalAppTables: Number(tableCount.rows[0]?.count ?? 0),
        databaseSize: dbSize.rows[0]?.size ?? '0 bytes',
        workers: {
          embedding: {
            queue: {
              claimable: Number(queueRow.claimable),
              scheduledFuture: Number(queueRow.scheduled_future),
              atOrOverMaxAttempts: Number(queueRow.at_or_over_max),
            },
            failedEmbeddingJobs: Number(queueRow.at_or_over_max),
            oldestClaimableAgeSeconds: oldestClaimable.rows[0]?.age_seconds
              ? Math.round(Number(oldestClaimable.rows[0].age_seconds))
              : null,
            byModel: byModelRows.rows.map((row) => ({
              model: row.model,
              dimensions: row.dimensions,
              claimable: Number(row.claimable),
              scheduledFuture: Number(row.scheduled_future),
              atOrOverMaxAttempts: Number(row.at_or_over_max),
            })),
            retryErrorSample: retryErrorRows.rows.map((row) => ({
              jobId: row.id,
              subjectKind: row.subject_kind,
              model: row.model,
              attemptCount: row.attempt_count,
              lastError: row.last_error ?? '',
              nextAttemptAt: row.next_attempt_at,
            })),
          },
        },
        collectedAt: queueRow.collected_at,
      };
    },

  };
}
