/**
 * Messaging domain — threads, messages, inbox.
 *
 * Tables: threads, messages, inbox_entries, thread_participants, message_removals.
 */

import type { Pool } from 'pg';
import { AppError } from '../contract.ts';
import { withTransaction } from '../db.ts';

// ── Types ───────────────────────────────────────────────────

export type MessageSummary = {
  threadId: string;
  messageId: string;
  senderMemberId: string;
  recipientMemberId: string;
  messageText: string;
  createdAt: string;
};

export type ThreadSummary = {
  threadId: string;
  counterpartMemberId: string;
  counterpartPublicName: string;
  counterpartHandle: string | null;
  latestMessage: {
    messageId: string;
    senderMemberId: string | null;
    role: 'member' | 'agent' | 'system';
    messageText: string | null;
    createdAt: string;
  };
  messageCount: number;
};

export type InboxEntry = ThreadSummary & {
  unreadCount: number;
  hasUnread: boolean;
  latestUnreadAt: string | null;
};

export type MessageEntry = {
  messageId: string;
  threadId: string;
  senderMemberId: string | null;
  role: 'member' | 'agent' | 'system';
  messageText: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  inReplyToMessageId: string | null;
};

export type MessageRemovalResult = {
  messageId: string;
  removedByMemberId: string;
  reason: string | null;
  removedAt: string;
};

// ── Repository ──────────────────────────────────────────────

export type MessagingRepository = {
  sendMessage(input: {
    senderMemberId: string;
    recipientMemberId: string;
    messageText: string;
    clientKey?: string | null;
  }): Promise<MessageSummary>;

  listThreads(input: {
    memberId: string;
    limit: number;
  }): Promise<ThreadSummary[]>;

  listInbox(input: {
    memberId: string;
    limit: number;
    unreadOnly: boolean;
  }): Promise<InboxEntry[]>;

  readThread(input: {
    memberId: string;
    threadId: string;
    limit: number;
  }): Promise<{ thread: ThreadSummary; messages: MessageEntry[] } | null>;

  removeMessage(input: {
    messageId: string;
    removedByMemberId: string;
    reason?: string | null;
    skipAuthCheck?: boolean;
  }): Promise<MessageRemovalResult | null>;

  acknowledgeInbox(input: {
    memberId: string;
    threadId: string;
  }): Promise<void>;

  hasExistingThread(memberA: string, memberB: string): Promise<boolean>;
};

export function createMessagingRepository(pool: Pool): MessagingRepository {
  return {
    async sendMessage({ senderMemberId, recipientMemberId, messageText, clientKey }) {
      return withTransaction(pool, async (client) => {
        // Idempotency: check BEFORE any thread/message creation to avoid phantom threads.
        // If a message exists with this clientKey for this sender:
        //   - same conversation → return the original (true retry)
        //   - different conversation → reject with conflict error
        if (clientKey) {
          const existing = await client.query<{
            id: string; thread_id: string; member_a_id: string; member_b_id: string;
            message_text: string | null; created_at: string;
          }>(
            `select m.id, m.thread_id, t.member_a_id, t.member_b_id,
                    m.message_text, m.created_at::text as created_at
             from dm_messages m
             join dm_threads t on t.id = m.thread_id
             where m.sender_member_id = $1 and m.client_key = $2`,
            [senderMemberId, clientKey],
          );
          if (existing.rows[0]) {
            const orig = existing.rows[0];
            // Verify this is the same conversation (same member pair) AND same message text
            const expectedA = senderMemberId < recipientMemberId ? senderMemberId : recipientMemberId;
            const expectedB = senderMemberId < recipientMemberId ? recipientMemberId : senderMemberId;
            if (orig.member_a_id !== expectedA || orig.member_b_id !== expectedB) {
              throw new AppError(409, 'client_key_conflict',
                'This clientKey was already used for a different conversation. Use a unique key per message.');
            }
            if ((orig.message_text ?? '') !== (messageText ?? '')) {
              throw new AppError(409, 'client_key_conflict',
                'This clientKey was already used with a different message. Use a unique key per message.');
            }
            return {
              threadId: orig.thread_id,
              messageId: orig.id,
              senderMemberId,
              recipientMemberId,
              messageText: orig.message_text ?? messageText,
              createdAt: orig.created_at,
            };
          }
        }

        // Normalize pair ordering for direct thread uniqueness
        const memberA = senderMemberId < recipientMemberId ? senderMemberId : recipientMemberId;
        const memberB = senderMemberId < recipientMemberId ? recipientMemberId : senderMemberId;

        // Find or create thread
        const threadResult = await client.query<{ id: string }>(
          `insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id)
           values ('direct', $1, $2, $3)
           on conflict do nothing
           returning id`,
          [senderMemberId, memberA, memberB],
        );

        let threadId = threadResult.rows[0]?.id;
        if (!threadId) {
          const existing = await client.query<{ id: string }>(
            `select id from dm_threads
             where kind = 'direct' and member_a_id = $1 and member_b_id = $2
               and archived_at is null
             limit 1`,
            [memberA, memberB],
          );
          threadId = existing.rows[0]?.id;
          if (!threadId) throw new AppError(500, 'thread_not_found', 'Failed to find or create direct thread');
        } else {
          await client.query(
            `insert into dm_thread_participants (thread_id, member_id) values ($1, $2), ($1, $3)`,
            [threadId, senderMemberId, recipientMemberId],
          );
        }

        // Insert message
        const msgResult = await client.query<{ id: string; created_at: string }>(
          `insert into dm_messages (thread_id, sender_member_id, role, message_text, client_key)
           values ($1, $2, 'member', $3, $4)
           returning id, created_at::text as created_at`,
          [threadId, senderMemberId, messageText, clientKey ?? null],
        );
        const msg = msgResult.rows[0]!;

        // Create inbox entry for recipient (idempotent via unique constraint)
        await client.query(
          `insert into dm_inbox_entries (recipient_member_id, thread_id, message_id)
           values ($1, $2, $3)
           on conflict (recipient_member_id, message_id) do nothing`,
          [recipientMemberId, threadId, msg.id],
        );

        return {
          threadId,
          messageId: msg.id,
          senderMemberId,
          recipientMemberId,
          messageText,
          createdAt: msg.created_at,
        };
      });
    },

    async listThreads({ memberId, limit }) {
      const result = await pool.query<{
        thread_id: string; counterpart_member_id: string;
        counterpart_public_name: string; counterpart_handle: string | null;
        latest_message_id: string; latest_sender_member_id: string | null;
        latest_role: string; latest_message_text: string | null;
        latest_created_at: string; message_count: number;
      }>(
        `with my_threads as (
           select tp.thread_id
           from dm_thread_participants tp
           where tp.member_id = $1 and tp.left_at is null
         ),
         counterparts as (
           select mt.thread_id,
                  tp.member_id as counterpart_member_id
           from my_threads mt
           join dm_threads t on t.id = mt.thread_id and t.kind = 'direct'
           join dm_thread_participants tp on tp.thread_id = mt.thread_id
             and tp.member_id <> $1
         ),
         ranked as (
           select c.thread_id, c.counterpart_member_id,
                  m.id as latest_message_id,
                  m.sender_member_id as latest_sender_member_id,
                  m.role::text as latest_role,
                  case when rmv.message_id is not null then '[Message removed]' else m.message_text end as latest_message_text,
                  m.created_at::text as latest_created_at,
                  count(*) over (partition by c.thread_id)::int as message_count,
                  row_number() over (partition by c.thread_id order by m.created_at desc, m.id desc) as rn
           from counterparts c
           join dm_messages m on m.thread_id = c.thread_id
           left join dm_message_removals rmv on rmv.message_id = m.id
         )
         select r.thread_id, r.counterpart_member_id,
                mbr.public_name as counterpart_public_name,
                mbr.handle as counterpart_handle,
                r.latest_message_id, r.latest_sender_member_id,
                r.latest_role, r.latest_message_text, r.latest_created_at, r.message_count
         from ranked r
         join members mbr on mbr.id = r.counterpart_member_id
         where r.rn = 1
         order by r.latest_created_at desc, r.thread_id desc
         limit $2`,
        [memberId, limit],
      );

      return result.rows.map((row) => ({
        threadId: row.thread_id,
        counterpartMemberId: row.counterpart_member_id,
        counterpartPublicName: row.counterpart_public_name,
        counterpartHandle: row.counterpart_handle,
        latestMessage: {
          messageId: row.latest_message_id,
          senderMemberId: row.latest_sender_member_id,
          role: row.latest_role as 'member' | 'agent' | 'system',
          messageText: row.latest_message_text,
          createdAt: row.latest_created_at,
        },
        messageCount: Number(row.message_count),
      }));
    },

    async listInbox({ memberId, limit, unreadOnly }) {
      const result = await pool.query<{
        thread_id: string; counterpart_member_id: string;
        counterpart_public_name: string; counterpart_handle: string | null;
        latest_message_id: string; latest_sender_member_id: string | null;
        latest_role: string; latest_message_text: string | null;
        latest_created_at: string; message_count: number;
        unread_count: number; has_unread: boolean; latest_unread_at: string | null;
      }>(
        `with my_threads as (
           select tp.thread_id
           from dm_thread_participants tp
           where tp.member_id = $1 and tp.left_at is null
         ),
         counterparts as (
           select mt.thread_id,
                  tp.member_id as counterpart_member_id
           from my_threads mt
           join dm_threads t on t.id = mt.thread_id and t.kind = 'direct'
           join dm_thread_participants tp on tp.thread_id = mt.thread_id
             and tp.member_id <> $1
         ),
         inbox_stats as (
           select ie.thread_id,
                  count(*) filter (where not ie.acknowledged)::int as unread_count,
                  bool_or(not ie.acknowledged) as has_unread,
                  max(ie.created_at) filter (where not ie.acknowledged)::text as latest_unread_at
           from dm_inbox_entries ie
           where ie.recipient_member_id = $1
           group by ie.thread_id
         ),
         latest_msg as (
           select distinct on (c.thread_id)
                  c.thread_id, c.counterpart_member_id,
                  m.id as latest_message_id,
                  m.sender_member_id as latest_sender_member_id,
                  m.role::text as latest_role,
                  case when rmv.message_id is not null then '[Message removed]' else m.message_text end as latest_message_text,
                  m.created_at::text as latest_created_at,
                  (select count(*)::int from dm_messages mm where mm.thread_id = c.thread_id) as message_count
           from counterparts c
           join dm_messages m on m.thread_id = c.thread_id
           left join dm_message_removals rmv on rmv.message_id = m.id
           order by c.thread_id, m.created_at desc, m.id desc
         )
         select lm.thread_id, lm.counterpart_member_id,
                mbr.public_name as counterpart_public_name,
                mbr.handle as counterpart_handle,
                lm.latest_message_id, lm.latest_sender_member_id,
                lm.latest_role, lm.latest_message_text, lm.latest_created_at,
                lm.message_count,
                coalesce(ist.unread_count, 0) as unread_count,
                coalesce(ist.has_unread, false) as has_unread,
                ist.latest_unread_at
         from latest_msg lm
         join members mbr on mbr.id = lm.counterpart_member_id
         left join inbox_stats ist on ist.thread_id = lm.thread_id
         where ($3::boolean = false or coalesce(ist.has_unread, false))
         order by coalesce(ist.has_unread, false) desc,
                  coalesce(ist.latest_unread_at, lm.latest_created_at) desc,
                  lm.thread_id desc
         limit $2`,
        [memberId, limit, unreadOnly],
      );

      return result.rows.map((row) => ({
        threadId: row.thread_id,
        counterpartMemberId: row.counterpart_member_id,
        counterpartPublicName: row.counterpart_public_name,
        counterpartHandle: row.counterpart_handle,
        latestMessage: {
          messageId: row.latest_message_id,
          senderMemberId: row.latest_sender_member_id,
          role: row.latest_role as 'member' | 'agent' | 'system',
          messageText: row.latest_message_text,
          createdAt: row.latest_created_at,
        },
        messageCount: Number(row.message_count),
        unreadCount: Number(row.unread_count),
        hasUnread: row.has_unread,
        latestUnreadAt: row.latest_unread_at,
      }));
    },

    async readThread({ memberId, threadId, limit }) {
      // Verify participation and get counterpart info
      const participantCheck = await pool.query<{
        counterpart_member_id: string;
        counterpart_public_name: string;
        counterpart_handle: string | null;
      }>(
        `select tp2.member_id as counterpart_member_id,
                mbr.public_name as counterpart_public_name,
                mbr.handle as counterpart_handle
         from dm_thread_participants tp1
         join dm_thread_participants tp2
           on tp2.thread_id = tp1.thread_id and tp2.member_id <> $1
         join members mbr on mbr.id = tp2.member_id
         where tp1.thread_id = $2 and tp1.member_id = $1
         limit 1`,
        [memberId, threadId],
      );
      if (!participantCheck.rows[0]) return null;

      const counterpartMemberId = participantCheck.rows[0].counterpart_member_id;
      const counterpartPublicName = participantCheck.rows[0].counterpart_public_name;
      const counterpartHandle = participantCheck.rows[0].counterpart_handle;

      // Thread summary
      const threadResult = await pool.query<{
        latest_message_id: string; latest_sender_member_id: string | null;
        latest_role: string; latest_message_text: string | null;
        latest_created_at: string; message_count: number;
      }>(
        `select m.id as latest_message_id, m.sender_member_id as latest_sender_member_id,
                m.role::text as latest_role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as latest_message_text,
                m.created_at::text as latest_created_at,
                (select count(*)::int from dm_messages mm where mm.thread_id = $1) as message_count
         from dm_messages m
         left join dm_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
         order by m.created_at desc, m.id desc
         limit 1`,
        [threadId],
      );

      const threadRow = threadResult.rows[0];
      if (!threadRow) return null;

      const thread: ThreadSummary = {
        threadId,
        counterpartMemberId,
        counterpartPublicName,
        counterpartHandle,
        latestMessage: {
          messageId: threadRow.latest_message_id,
          senderMemberId: threadRow.latest_sender_member_id,
          role: threadRow.latest_role as 'member' | 'agent' | 'system',
          messageText: threadRow.latest_message_text,
          createdAt: threadRow.latest_created_at,
        },
        messageCount: Number(threadRow.message_count),
      };

      // Messages
      const messagesResult = await pool.query<{
        message_id: string; thread_id: string; sender_member_id: string | null;
        role: string; message_text: string | null; payload: Record<string, unknown> | null;
        created_at: string; in_reply_to_message_id: string | null;
      }>(
        `select m.id as message_id, m.thread_id, m.sender_member_id,
                m.role::text as role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as message_text,
                case when rmv.message_id is not null then null else m.payload end as payload,
                m.created_at::text as created_at,
                m.in_reply_to_message_id
         from dm_messages m
         left join dm_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
         order by m.created_at desc, m.id desc
         limit $2`,
        [threadId, limit],
      );

      const messages: MessageEntry[] = messagesResult.rows.map((row) => ({
        messageId: row.message_id,
        threadId: row.thread_id,
        senderMemberId: row.sender_member_id,
        role: row.role as 'member' | 'agent' | 'system',
        messageText: row.message_text,
        payload: row.payload ?? {},
        createdAt: row.created_at,
        inReplyToMessageId: row.in_reply_to_message_id,
      })).reverse();

      return { thread, messages };
    },

    async removeMessage({ messageId, removedByMemberId, reason, skipAuthCheck }) {
      // Check if already removed — idempotent return
      const existing = await pool.query<{
        message_id: string; removed_by_member_id: string;
        reason: string | null; removed_at: string;
        sender_member_id: string | null;
      }>(
        `select rmv.message_id, rmv.removed_by_member_id, rmv.reason,
                rmv.removed_at::text as removed_at,
                m.sender_member_id
         from dm_message_removals rmv
         join dm_messages m on m.id = rmv.message_id
         where rmv.message_id = $1`,
        [messageId],
      );
      if (existing.rows[0]) {
        // Auth check even on already-removed messages (existence-hiding)
        if (!skipAuthCheck && existing.rows[0].sender_member_id !== removedByMemberId) {
          return null;
        }
        return {
          messageId: existing.rows[0].message_id,
          removedByMemberId: existing.rows[0].removed_by_member_id,
          reason: existing.rows[0].reason,
          removedAt: existing.rows[0].removed_at,
        };
      }

      // Verify the caller is the message sender (unless skipAuthCheck)
      const msgCheck = await pool.query<{ sender_member_id: string | null }>(
        `select sender_member_id from dm_messages where id = $1`,
        [messageId],
      );
      if (!msgCheck.rows[0]) return null;
      if (!skipAuthCheck && msgCheck.rows[0].sender_member_id !== removedByMemberId) {
        return null; // existence-hiding: matches content.remove / events.remove behavior
      }

      const result = await pool.query<{
        message_id: string; removed_by_member_id: string;
        reason: string | null; removed_at: string;
      }>(
        `insert into dm_message_removals (message_id, removed_by_member_id, reason)
         values ($1, $2, $3)
         returning message_id, removed_by_member_id, reason, removed_at::text as removed_at`,
        [messageId, removedByMemberId, reason ?? null],
      );
      if (!result.rows[0]) return null;
      return {
        messageId: result.rows[0].message_id,
        removedByMemberId: result.rows[0].removed_by_member_id,
        reason: result.rows[0].reason,
        removedAt: result.rows[0].removed_at,
      };
    },

    async acknowledgeInbox({ memberId, threadId }) {
      await pool.query(
        `update dm_inbox_entries
         set acknowledged = true
         where recipient_member_id = $1 and thread_id = $2 and acknowledged = false`,
        [memberId, threadId],
      );
    },

    async hasExistingThread(memberA, memberB) {
      const a = memberA < memberB ? memberA : memberB;
      const b = memberA < memberB ? memberB : memberA;
      const result = await pool.query<{ id: string }>(
        `select id from dm_threads
         where kind = 'direct' and member_a_id = $1 and member_b_id = $2
           and archived_at is null
         limit 1`,
        [a, b],
      );
      return result.rows.length > 0;
    },
  };
}
