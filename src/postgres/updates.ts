import type { Pool } from 'pg';
import type {
  AcknowledgeUpdatesInput,
  MemberUpdates,
  PendingUpdate,
  Repository,
  UpdateReceipt,
} from '../app.ts';
import type { ApplyActorContext, DbClient } from './shared.ts';

type PendingUpdateRow = {
  update_id: string;
  stream_seq: string | number;
  recipient_member_id: string;
  club_id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  created_by_member_id: string | null;
  created_at: string;
};

type UpdateReceiptRow = {
  receipt_id: string;
  update_id: string;
  recipient_member_id: string;
  club_id: string;
  state: UpdateReceipt['state'];
  suppression_reason: string | null;
  version_no: number | string;
  supersedes_receipt_id: string | null;
  created_at: string;
  created_by_member_id: string | null;
};

function mapPendingUpdateRow(row: PendingUpdateRow): PendingUpdate {
  return {
    updateId: row.update_id,
    streamSeq: Number(row.stream_seq),
    recipientMemberId: row.recipient_member_id,
    clubId: row.club_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    topic: row.topic,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapUpdateReceiptRow(row: UpdateReceiptRow): UpdateReceipt {
  return {
    receiptId: row.receipt_id,
    updateId: row.update_id,
    recipientMemberId: row.recipient_member_id,
    clubId: row.club_id,
    state: row.state,
    suppressionReason: row.suppression_reason,
    versionNo: Number(row.version_no),
    supersedesReceiptId: row.supersedes_receipt_id,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

export async function listPendingUpdates(
  client: DbClient,
  actorMemberId: string,
  limit: number,
  after: number | null = null,
): Promise<MemberUpdates> {
  const result = await client.query<PendingUpdateRow>(
    `
      select
        pmu.update_id,
        pmu.stream_seq,
        pmu.recipient_member_id,
        pmu.club_id,
        pmu.topic,
        pmu.payload,
        pmu.entity_id,
        pmu.entity_version_id,
        pmu.transcript_message_id,
        pmu.created_by_member_id,
        pmu.created_at::text
      from app.pending_member_updates pmu
      where pmu.recipient_member_id = $1
        and ($2::bigint is null or pmu.stream_seq > $2)
      order by pmu.stream_seq asc
      limit $3
    `,
    [actorMemberId, after, limit],
  );

  const polledAtResult = await client.query<{ polled_at: string }>(`select now()::text as polled_at`);
  const items = result.rows.map(mapPendingUpdateRow);

  return {
    items,
    nextAfter: items.length > 0 ? items[items.length - 1]!.streamSeq : after,
    polledAt: polledAtResult.rows[0]?.polled_at ?? new Date().toISOString(),
  };
}

export async function appendDirectMessageUpdate(
  client: DbClient,
  input: {
    recipientMemberId: string;
    clubId: string;
    transcriptMessageId: string;
    createdByMemberId: string;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const result = await client.query(
    `
      insert into app.member_updates (
        recipient_member_id,
        club_id,
        topic,
        payload,
        transcript_message_id,
        created_by_member_id
      )
      values ($1, $2, 'transcript.message.created', $3::jsonb, $4, $5)
    `,
    [
      input.recipientMemberId,
      input.clubId,
      JSON.stringify(input.payload),
      input.transcriptMessageId,
      input.createdByMemberId,
    ],
  );

  return result.rowCount ?? 0;
}

export async function appendEntityVersionUpdates(
  client: DbClient,
  input: {
    clubId: string;
    entityId: string;
    entityVersionId: string;
    topic: string;
    createdByMemberId: string;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const result = await client.query(
    `
      insert into app.member_updates (
        recipient_member_id,
        club_id,
        topic,
        payload,
        entity_id,
        entity_version_id,
        created_by_member_id
      )
      select
        anm.member_id,
        $1,
        $2,
        $3::jsonb,
        $4,
        $5,
        $6
      from app.accessible_club_memberships anm
      where anm.club_id = $1
        and anm.member_id <> $6
    `,
    [
      input.clubId,
      input.topic,
      JSON.stringify(input.payload),
      input.entityId,
      input.entityVersionId,
      input.createdByMemberId,
    ],
  );

  return result.rowCount ?? 0;
}

async function acknowledgeUpdates(
  client: DbClient,
  input: AcknowledgeUpdatesInput,
): Promise<UpdateReceipt[]> {
  if (input.updateIds.length === 0) {
    return [];
  }

  const result = await client.query<UpdateReceiptRow>(
    `
      with scoped_updates as (
        select
          mu.id as update_id,
          mu.recipient_member_id,
          mu.club_id
        from app.member_updates mu
        where mu.recipient_member_id = $1
          and mu.id = any($2::app.short_id[])
      ),
      current_receipts as (
        select
          su.update_id,
          su.recipient_member_id,
          su.club_id,
          cmur.id as current_receipt_id,
          cmur.state as current_state,
          cmur.suppression_reason as current_suppression_reason,
          cmur.version_no as current_version_no,
          cmur.created_at::text as current_created_at,
          cmur.created_by_member_id as current_created_by_member_id
        from scoped_updates su
        left join app.current_member_update_receipts cmur
          on cmur.member_update_id = su.update_id
         and cmur.recipient_member_id = su.recipient_member_id
      ),
      inserted as (
        insert into app.member_update_receipts (
          member_update_id,
          recipient_member_id,
          club_id,
          state,
          suppression_reason,
          version_no,
          supersedes_receipt_id,
          created_by_member_id
        )
        select
          cr.update_id,
          cr.recipient_member_id,
          cr.club_id,
          $3::app.member_update_receipt_state,
          $4,
          coalesce(cr.current_version_no, 0) + 1,
          cr.current_receipt_id,
          $1
        from current_receipts cr
        where cr.current_receipt_id is null
           or cr.current_state is distinct from $3::app.member_update_receipt_state
           or cr.current_suppression_reason is distinct from $4
        returning
          id as receipt_id,
          member_update_id as update_id,
          recipient_member_id,
          club_id,
          state,
          suppression_reason,
          version_no,
          supersedes_receipt_id,
          created_at::text,
          created_by_member_id
      ),
      unchanged as (
        select
          cr.current_receipt_id as receipt_id,
          cr.update_id,
          cr.recipient_member_id,
          cr.club_id,
          cr.current_state as state,
          cr.current_suppression_reason as suppression_reason,
          cr.current_version_no as version_no,
          null::app.short_id as supersedes_receipt_id,
          cr.current_created_at as created_at,
          cr.current_created_by_member_id as created_by_member_id
        from current_receipts cr
        where cr.current_receipt_id is not null
          and cr.current_state is not distinct from $3::app.member_update_receipt_state
          and cr.current_suppression_reason is not distinct from $4
      )
      select * from inserted
      union all
      select * from unchanged
      order by update_id asc
    `,
    [input.actorMemberId, input.updateIds, input.state, input.suppressionReason ?? null],
  );

  return result.rows.map(mapUpdateReceiptRow);
}

export function buildUpdatesRepository({
  pool,
  applyActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
}): Pick<Repository, 'listMemberUpdates' | 'acknowledgeUpdates'> {
  return {
    async listMemberUpdates({ actorMemberId, limit, after }): Promise<MemberUpdates> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actorMemberId, []);
        const updates = await listPendingUpdates(client, actorMemberId, limit, after ?? null);
        await client.query('commit');
        return updates;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async acknowledgeUpdates(input): Promise<UpdateReceipt[]> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);
        const receipts = await acknowledgeUpdates(client, input);
        await client.query('commit');
        return receipts;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
