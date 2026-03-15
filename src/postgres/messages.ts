import { Pool, type PoolClient } from 'pg';
import type {
  DirectMessageInboxSummary,
  DirectMessageSummary,
  DirectMessageThreadSummary,
  DirectMessageTranscriptEntry,
  DirectMessageUpdateReceipt,
  Repository,
  SendDirectMessageInput,
} from '../app.ts';
import { appendDirectMessageUpdate } from './updates.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: Record<string, never>,
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

type DirectMessageRow = {
  thread_id: string;
  network_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  message_id: string;
  message_text: string;
  created_at: string;
  update_count: number;
};

type DirectMessageThreadRow = {
  thread_id: string;
  network_id: string;
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

type DirectMessageTranscriptRow = {
  message_id: string;
  thread_id: string;
  sender_member_id: string | null;
  role: DirectMessageTranscriptEntry['role'];
  message_text: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  in_reply_to_message_id: string | null;
  update_receipts: DirectMessageUpdateReceiptRow[] | null;
};

type DirectMessageInboxRow = {
  thread_id: string;
  network_id: string;
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
    networkId: row.network_id,
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
    networkId: row.network_id,
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

function mapDirectMessageTranscriptRow(row: DirectMessageTranscriptRow): DirectMessageTranscriptEntry {
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
    networkId: row.network_id,
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

async function listDirectMessageThreads(client: DbClient, actorMemberId: string, networkIds: string[], limit: number): Promise<DirectMessageThreadSummary[]> {
  const result = await client.query<DirectMessageThreadRow>(
    `
      with scope as (
        select unnest($2::text[])::app.short_id as network_id
      ),
      thread_scope as (
        select
          tt.id as thread_id,
          tt.network_id,
          case
            when tt.created_by_member_id = $1 then tt.counterpart_member_id
            else tt.created_by_member_id
          end as counterpart_member_id
        from app.transcript_threads tt
        join scope s on s.network_id = tt.network_id
        where tt.kind = 'dm'
          and tt.archived_at is null
          and $1 in (tt.created_by_member_id, tt.counterpart_member_id)
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.network_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          tm.message_text as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.transcript_messages tm on tm.thread_id = ts.thread_id
      )
      select
        mr.thread_id,
        mr.network_id,
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
    [actorMemberId, networkIds, limit],
  );

  return result.rows.map(mapDirectMessageThreadRow);
}

async function listDirectMessageInbox(
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  limit: number,
  unreadOnly: boolean,
): Promise<DirectMessageInboxSummary[]> {
  const result = await client.query<DirectMessageInboxRow>(
    `
      with thread_message_counts as (
        select tm.thread_id, count(*)::int as message_count
        from app.transcript_messages tm
        group by tm.thread_id
      )
      select
        inbox.thread_id,
        inbox.network_id,
        inbox.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        inbox.latest_message_id,
        inbox.latest_sender_member_id,
        inbox.latest_role,
        inbox.latest_message_text,
        inbox.latest_created_at::text as latest_created_at,
        coalesce(tmc.message_count, 0) as message_count,
        inbox.unread_message_count,
        inbox.unread_update_count,
        inbox.latest_unread_message_created_at::text as latest_unread_message_created_at,
        inbox.has_unread
      from app.current_dm_inbox_threads inbox
      join app.members m on m.id = inbox.counterpart_member_id and m.state = 'active'
      left join thread_message_counts tmc on tmc.thread_id = inbox.thread_id
      where inbox.recipient_member_id = $1
        and inbox.network_id = any($2::app.short_id[])
        and ($3::boolean = false or inbox.has_unread)
      order by
        inbox.has_unread desc,
        coalesce(inbox.latest_unread_message_created_at, inbox.latest_created_at) desc,
        inbox.thread_id desc
      limit $4
    `,
    [actorMemberId, networkIds, unreadOnly, limit],
  );

  return result.rows.map(mapDirectMessageInboxRow);
}

async function readDirectMessageThread(
  client: DbClient,
  actorMemberId: string,
  accessibleNetworkIds: string[],
  threadId: string,
  limit: number,
): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageTranscriptEntry[] } | null> {
  const threadResult = await client.query<DirectMessageThreadRow>(
    `
      with thread_scope as (
        select
          tt.id as thread_id,
          tt.network_id,
          case
            when tt.created_by_member_id = $1 then tt.counterpart_member_id
            else tt.created_by_member_id
          end as counterpart_member_id
        from app.transcript_threads tt
        where tt.id = $2
          and tt.kind = 'dm'
          and tt.archived_at is null
          and tt.network_id = any($3::app.short_id[])
          and $1 in (tt.created_by_member_id, tt.counterpart_member_id)
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.network_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          tm.message_text as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.transcript_messages tm on tm.thread_id = ts.thread_id
      )
      select
        mr.thread_id,
        mr.network_id,
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
    [actorMemberId, threadId, accessibleNetworkIds],
  );

  const thread = threadResult.rows[0];
  if (!thread) {
    return null;
  }

  const messagesResult = await client.query<DirectMessageTranscriptRow>(
    `
      select
        tm.id as message_id,
        tm.thread_id,
        tm.sender_member_id,
        tm.role,
        tm.message_text,
        tm.payload,
        tm.created_at::text as created_at,
        tm.in_reply_to_message_id,
        coalesce(receipts.update_receipts, '[]'::jsonb) as update_receipts
      from app.transcript_messages tm
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
        where mu.transcript_message_id = tm.id
      ) receipts on true
      where tm.thread_id = $1
      order by tm.created_at desc, tm.id desc
      limit $2
    `,
    [threadId, limit],
  );

  return {
    thread: mapDirectMessageThreadRow(thread),
    messages: messagesResult.rows.map(mapDirectMessageTranscriptRow).reverse(),
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
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const scopeResult = await client.query<{ network_id: string }>(
          `
            with actor_scope as (
              select distinct network_id
              from app.accessible_network_memberships
              where member_id = $1
                and network_id = any($2::app.short_id[])
            ),
            shared_scope as (
              select actor_scope.network_id
              from actor_scope
              join app.accessible_network_memberships recipient_scope
                on recipient_scope.network_id = actor_scope.network_id
             where recipient_scope.member_id = $3
            )
            select network_id
            from shared_scope
            where ($4::app.short_id is null or network_id = $4)
            order by network_id asc
            limit 1
          `,
          [input.actorMemberId, input.accessibleNetworkIds, input.recipientMemberId, input.networkId ?? null],
        );

        const networkId = scopeResult.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        const threadResult = await client.query<{ id: string }>(
          `
            select tt.id
            from app.transcript_threads tt
            where tt.kind = 'dm'
              and tt.archived_at is null
              and tt.network_id = $1
              and (
                (tt.created_by_member_id = $2 and tt.counterpart_member_id = $3)
                or (tt.created_by_member_id = $3 and tt.counterpart_member_id = $2)
              )
            order by tt.created_at asc, tt.id asc
            limit 1
          `,
          [networkId, input.actorMemberId, input.recipientMemberId],
        );

        let threadId = threadResult.rows[0]?.id;
        if (!threadId) {
          const insertedThread = await client.query<{ id: string }>(
            `
              insert into app.transcript_threads (network_id, kind, created_by_member_id, counterpart_member_id)
              values ($1, 'dm', $2, $3)
              returning id
            `,
            [networkId, input.actorMemberId, input.recipientMemberId],
          );
          threadId = insertedThread.rows[0]!.id;
        }

        const messageResult = await client.query<{ id: string; created_at: string }>(
          `
            insert into app.transcript_messages (thread_id, sender_member_id, role, message_text)
            values ($1, $2, 'member', $3)
            returning id, created_at::text
          `,
          [threadId, input.actorMemberId, input.messageText],
        );
        const message = messageResult.rows[0]!;

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
        const sender = senderResult.rows[0];
        if (!sender) {
          throw new Error('Sender profile could not be loaded for DM update fanout');
        }

        const updateCount = await appendDirectMessageUpdate(client, {
          recipientMemberId: input.recipientMemberId,
          networkId,
          transcriptMessageId: message.id,
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
          network_id: networkId,
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

    async listDirectMessageThreads({ actorMemberId, networkIds, limit }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) =>
        listDirectMessageThreads(client, actorMemberId, networkIds, limit),
      );
    },

    async listDirectMessageInbox({ actorMemberId, networkIds, limit, unreadOnly }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) =>
        listDirectMessageInbox(client, actorMemberId, networkIds, limit, unreadOnly),
      );
    },

    async readDirectMessageThread({ actorMemberId, accessibleNetworkIds, threadId, limit }) {
      return withActorContext(pool, actorMemberId, accessibleNetworkIds, (client) =>
        readDirectMessageThread(client, actorMemberId, accessibleNetworkIds, threadId, limit),
      );
    },
  };
}
