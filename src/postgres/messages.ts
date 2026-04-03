import type { Pool } from 'pg';
import { enforceQuota } from './quotas.ts';
import type {
  DirectMessageInboxSummary,
  DirectMessageSummary,
  DirectMessageThreadSummary,
  DirectMessageEntry,
  DirectMessageUpdateReceipt,
  Repository,
  SendDirectMessageInput,
} from '../app.ts';
import { requireReturnedRow } from './query-guards.ts';
import { appendDirectMessageUpdate } from './updates.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

type DirectMessageRow = {
  thread_id: string;
  club_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  message_id: string;
  message_text: string;
  created_at: string;
  update_count: number;
};

type DirectMessageThreadRow = {
  thread_id: string;
  club_id: string;
  counterpart_member_id: string;
  counterpart_public_name: string;
  counterpart_handle: string | null;
  latest_message_id: string;
  latest_sender_member_id: string;
  latest_role: DirectMessageThreadSummary['latestMessage']['role'];
  latest_message_text: string | null;
  latest_created_at: string;
  message_count: number;
};

type DirectMessageUpdateReceiptRow = {
  updateId: string;
  recipientMemberId: string;
  topic: string;
  createdAt: string;
  receipt: DirectMessageUpdateReceipt['receipt'];
};

type DirectMessageDetailRow = {
  message_id: string;
  thread_id: string;
  sender_member_id: string | null;
  role: DirectMessageEntry['role'];
  message_text: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  in_reply_to_message_id: string | null;
  update_receipts: DirectMessageUpdateReceiptRow[] | null;
};

type DirectMessageInboxRow = {
  thread_id: string;
  club_id: string;
  counterpart_member_id: string;
  counterpart_public_name: string;
  counterpart_handle: string | null;
  latest_message_id: string;
  latest_sender_member_id: string;
  latest_role: DirectMessageThreadSummary['latestMessage']['role'];
  latest_message_text: string | null;
  latest_created_at: string;
  message_count: number;
  unread_message_count: number;
  unread_update_count: number;
  latest_unread_message_created_at: string | null;
  has_unread: boolean;
};

function mapDirectMessageRow(row: DirectMessageRow): DirectMessageSummary {
  return {
    threadId: row.thread_id,
    clubId: row.club_id,
    senderMemberId: row.sender_member_id,
    recipientMemberId: row.recipient_member_id,
    messageId: row.message_id,
    messageText: row.message_text,
    createdAt: row.created_at,
    updateCount: Number(row.update_count),
  };
}

function mapDirectMessageThreadRow(row: DirectMessageThreadRow): DirectMessageThreadSummary {
  return {
    threadId: row.thread_id,
    clubId: row.club_id,
    counterpartMemberId: row.counterpart_member_id,
    counterpartPublicName: row.counterpart_public_name,
    counterpartHandle: row.counterpart_handle,
    latestMessage: {
      messageId: row.latest_message_id,
      senderMemberId: row.latest_sender_member_id,
      role: row.latest_role,
      messageText: row.latest_message_text,
      createdAt: row.latest_created_at,
    },
    messageCount: Number(row.message_count),
  };
}

function mapDirectMessageDetailRow(row: DirectMessageDetailRow): DirectMessageEntry {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    senderMemberId: row.sender_member_id,
    role: row.role,
    messageText: row.message_text,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    inReplyToMessageId: row.in_reply_to_message_id,
    updateReceipts: row.update_receipts ?? [],
  };
}

function mapDirectMessageInboxRow(row: DirectMessageInboxRow): DirectMessageInboxSummary {
  return {
    threadId: row.thread_id,
    clubId: row.club_id,
    counterpartMemberId: row.counterpart_member_id,
    counterpartPublicName: row.counterpart_public_name,
    counterpartHandle: row.counterpart_handle,
    latestMessage: {
      messageId: row.latest_message_id,
      senderMemberId: row.latest_sender_member_id,
      role: row.latest_role,
      messageText: row.latest_message_text,
      createdAt: row.latest_created_at,
    },
    messageCount: Number(row.message_count),
    unread: {
      hasUnread: row.has_unread,
      unreadMessageCount: Number(row.unread_message_count),
      unreadUpdateCount: Number(row.unread_update_count),
      latestUnreadMessageCreatedAt: row.latest_unread_message_created_at,
    },
  };
}

async function listDirectMessageThreads(client: DbClient, actorMemberId: string, clubIds: string[], limit: number): Promise<DirectMessageThreadSummary[]> {
  const result = await client.query<DirectMessageThreadRow>(
    `
      with scope as (
        select unnest($2::text[])::app.short_id as club_id
      ),
      thread_scope as (
        select
          participant.thread_id,
          participant.club_id,
          participant.counterpart_member_id
        from app.current_dm_thread_participants participant
        join scope s on s.club_id = participant.club_id
        where participant.participant_member_id = $1
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.club_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          case when r.id is not null then '[Message redacted]' else tm.message_text end as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.dm_messages tm on tm.thread_id = ts.thread_id
        left join app.redactions r on r.target_kind = 'dm_message' and r.target_id = tm.id
      )
      select
        mr.thread_id,
        mr.club_id,
        mr.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        mr.latest_message_id,
        mr.latest_sender_member_id,
        mr.latest_role,
        mr.latest_message_text,
        mr.latest_created_at,
        mr.message_count
      from message_ranked mr
      join app.members m on m.id = mr.counterpart_member_id and m.state = 'active'
      where mr.row_no = 1
      order by mr.latest_created_at desc, mr.thread_id desc
      limit $3
    `,
    [actorMemberId, clubIds, limit],
  );

  return result.rows.map(mapDirectMessageThreadRow);
}

async function listDirectMessageInbox(
  client: DbClient,
  actorMemberId: string,
  clubIds: string[],
  limit: number,
  unreadOnly: boolean,
): Promise<DirectMessageInboxSummary[]> {
  const result = await client.query<DirectMessageInboxRow>(
    `
      select
        inbox.thread_id,
        inbox.club_id,
        inbox.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        inbox.latest_message_id,
        inbox.latest_sender_member_id,
        inbox.latest_role,
        inbox.latest_message_text,
        inbox.latest_created_at::text as latest_created_at,
        (select count(*)::int from app.dm_messages tm where tm.thread_id = inbox.thread_id) as message_count,
        inbox.unread_message_count,
        inbox.unread_update_count,
        inbox.latest_unread_message_created_at::text as latest_unread_message_created_at,
        inbox.has_unread
      from app.current_dm_inbox_threads inbox
      join app.members m on m.id = inbox.counterpart_member_id and m.state = 'active'
      where inbox.recipient_member_id = $1
        and inbox.club_id = any($2::app.short_id[])
        and ($3::boolean = false or inbox.has_unread)
      order by
        inbox.has_unread desc,
        coalesce(inbox.latest_unread_message_created_at, inbox.latest_created_at) desc,
        inbox.thread_id desc
      limit $4
    `,
    [actorMemberId, clubIds, unreadOnly, limit],
  );

  return result.rows.map(mapDirectMessageInboxRow);
}

async function readDirectMessageThread(
  client: DbClient,
  actorMemberId: string,
  accessibleClubIds: string[],
  threadId: string,
  limit: number,
): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageEntry[] } | null> {
  const threadResult = await client.query<DirectMessageThreadRow>(
    `
      with thread_scope as (
        select
          participant.thread_id,
          participant.club_id,
          participant.counterpart_member_id
        from app.current_dm_thread_participants participant
        where participant.participant_member_id = $1
          and participant.thread_id = $2
          and participant.club_id = any($3::app.short_id[])
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.club_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          case when r.id is not null then '[Message redacted]' else tm.message_text end as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.dm_messages tm on tm.thread_id = ts.thread_id
        left join app.redactions r on r.target_kind = 'dm_message' and r.target_id = tm.id
      )
      select
        mr.thread_id,
        mr.club_id,
        mr.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        mr.latest_message_id,
        mr.latest_sender_member_id,
        mr.latest_role,
        mr.latest_message_text,
        mr.latest_created_at,
        mr.message_count
      from message_ranked mr
      join app.members m on m.id = mr.counterpart_member_id and m.state = 'active'
      where mr.row_no = 1
    `,
    [actorMemberId, threadId, accessibleClubIds],
  );

  const thread = threadResult.rows[0];
  if (!thread) {
    return null;
  }

  const messagesResult = await client.query<DirectMessageDetailRow>(
    `
      select
        tm.id as message_id,
        tm.thread_id,
        tm.sender_member_id,
        tm.role,
        case when r.id is not null then '[Message redacted]' else tm.message_text end as message_text,
        case when r.id is not null then null else tm.payload end as payload,
        tm.created_at::text as created_at,
        tm.in_reply_to_message_id,
        coalesce(receipts.update_receipts, '[]'::jsonb) as update_receipts
      from app.dm_messages tm
      left join app.redactions r
        on r.target_kind = 'dm_message' and r.target_id = tm.id
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'updateId', mu.id,
            'recipientMemberId', mu.recipient_member_id,
            'topic', mu.topic,
            'createdAt', mu.created_at::text,
            'receipt',
              case
                when cmur.id is null then null
                else jsonb_build_object(
                  'receiptId', cmur.id,
                  'state', cmur.state,
                  'suppressionReason', cmur.suppression_reason,
                  'versionNo', cmur.version_no,
                  'createdAt', cmur.created_at::text,
                  'createdByMemberId', cmur.created_by_member_id
                )
              end
          )
          order by mu.created_at asc, mu.id asc
        ) as update_receipts
        from app.member_updates mu
        left join app.current_member_update_receipts cmur
          on cmur.member_update_id = mu.id
         and cmur.recipient_member_id = mu.recipient_member_id
        where mu.dm_message_id = tm.id
      ) receipts on true
      where tm.thread_id = $1
      order by tm.created_at desc, tm.id desc
      limit $2
    `,
    [threadId, limit],
  );

  return {
    thread: mapDirectMessageThreadRow(thread),
    messages: messagesResult.rows.map(mapDirectMessageDetailRow).reverse(),
  };
}

export function buildMessagesRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  'sendDirectMessage' | 'listDirectMessageThreads' | 'listDirectMessageInbox' | 'readDirectMessageThread'
> {
  return {
    async sendDirectMessage(input: SendDirectMessageInput): Promise<DirectMessageSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        const scopeResult = await client.query<{ club_id: string }>(
          `
            with actor_scope as (
              select distinct club_id
              from app.accessible_club_memberships
              where member_id = $1
                and club_id = any($2::app.short_id[])
            ),
            shared_scope as (
              select actor_scope.club_id
              from actor_scope
              join app.accessible_club_memberships recipient_scope
                on recipient_scope.club_id = actor_scope.club_id
             where recipient_scope.member_id = $3
            )
            select club_id
            from shared_scope
            where ($4::app.short_id is null or club_id = $4)
            order by club_id asc
            limit 1
          `,
          [input.actorMemberId, input.accessibleClubIds, input.recipientMemberId, input.clubId ?? null],
        );

        const clubId = scopeResult.rows[0]?.club_id;
        if (!clubId) {
          await client.query('rollback');
          return null;
        }

        await enforceQuota(client, input.actorMemberId, clubId, 'messages.send');

        const insertedThread = await client.query<{ id: string }>(
          `
            insert into app.dm_threads (club_id, kind, created_by_member_id, counterpart_member_id)
            values ($1, 'conversation', $2, $3)
            on conflict do nothing
            returning id
          `,
          [clubId, input.actorMemberId, input.recipientMemberId],
        );

        let threadId = insertedThread.rows[0]?.id;
        if (!threadId) {
          const existingThread = await client.query<{ id: string }>(
            `
              select participant.thread_id as id
              from app.current_dm_thread_participants participant
              where participant.club_id = $1
                and participant.participant_member_id = $2
                and participant.counterpart_member_id = $3
              order by participant.thread_id asc
              limit 1
            `,
            [clubId, input.actorMemberId, input.recipientMemberId],
          );
          threadId = requireReturnedRow(
            existingThread.rows[0],
            'Direct message thread row was not returned',
          ).id;
        }

        const messageResult = await client.query<{ id: string; created_at: string }>(
          `
            insert into app.dm_messages (thread_id, sender_member_id, role, message_text)
            values ($1, $2, 'member', $3)
            returning id, created_at::text
          `,
          [threadId, input.actorMemberId, input.messageText],
        );
        const message = requireReturnedRow(messageResult.rows[0], 'Direct message row was not returned');

        const senderResult = await client.query<{ public_name: string; handle: string | null }>(
          `
            select public_name, handle
            from app.members
            where id = $1
              and state = 'active'
            limit 1
          `,
          [input.actorMemberId],
        );
        const sender = requireReturnedRow(
          senderResult.rows[0],
          'Sender profile row was not returned for DM update fanout',
        );

        const updateCount = await appendDirectMessageUpdate(client, {
          recipientMemberId: input.recipientMemberId,
          clubId,
          dmMessageId: message.id,
          createdByMemberId: input.actorMemberId,
          payload: {
            kind: 'dm',
            threadId,
            messageId: message.id,
            senderMemberId: input.actorMemberId,
            senderPublicName: sender.public_name,
            senderHandle: sender.handle,
            recipientMemberId: input.recipientMemberId,
            messageText: input.messageText,
          },
        });

        await client.query('commit');
        return mapDirectMessageRow({
          thread_id: threadId,
          club_id: clubId,
          sender_member_id: input.actorMemberId,
          recipient_member_id: input.recipientMemberId,
          message_id: message.id,
          message_text: input.messageText,
          created_at: message.created_at,
          update_count: updateCount,
        });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listDirectMessageThreads({ actorMemberId, clubIds, limit }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) =>
        listDirectMessageThreads(client, actorMemberId, clubIds, limit),
      );
    },

    async listDirectMessageInbox({ actorMemberId, clubIds, limit, unreadOnly }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) =>
        listDirectMessageInbox(client, actorMemberId, clubIds, limit, unreadOnly),
      );
    },

    async readDirectMessageThread({ actorMemberId, accessibleClubIds, threadId, limit }) {
      return withActorContext(pool, actorMemberId, accessibleClubIds, (client) =>
        readDirectMessageThread(client, actorMemberId, accessibleClubIds, threadId, limit),
      );
    },
  };
}
