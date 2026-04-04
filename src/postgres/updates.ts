import type { Pool } from 'pg';
import {
  AppError,
  type AcknowledgeUpdatesInput,
  type MemberUpdates,
  type PendingUpdate,
  type Repository,
  type UpdateReceipt,
} from '../contract.ts';
import type { ApplyActorContext, DbClient } from './helpers.ts';

// ── Compound cursor for merged activity + inbox streams ─────

type UpdatesCursor = { a: number; i: number };

export function encodeUpdatesCursor(c: UpdatesCursor): string {
  return Buffer.from(JSON.stringify([c.a, c.i])).toString('base64url');
}

export function decodeUpdatesCursor(s: string): UpdatesCursor {
  try {
    const [a, i] = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (typeof a !== 'number' || typeof i !== 'number') throw new Error();
    return { a, i };
  } catch {
    throw new AppError(400, 'invalid_input', 'Invalid updates cursor');
  }
}

type PendingUpdateRow = {
  update_id: string;
  stream_seq: string | number;
  recipient_member_id: string;
  club_id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  entity_id: string | null;
  entity_version_id: string | null;
  dm_message_id: string | null;
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
    source: 'inbox',
    recipientMemberId: row.recipient_member_id,
    clubId: row.club_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    dmMessageId: row.dm_message_id,
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

// ── Inbox: targeted per-recipient updates (DMs, admissions) ─

async function listInboxUpdates(
  client: DbClient,
  actorMemberId: string,
  limit: number,
  afterSeq: number,
): Promise<Array<PendingUpdate & { _sourceSeq: number }>> {
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
        pmu.dm_message_id,
        pmu.created_by_member_id,
        pmu.created_at::text
      from app.pending_member_updates pmu
      where pmu.recipient_member_id = $1
        and pmu.stream_seq > $2
      order by pmu.stream_seq asc
      limit $3
    `,
    [actorMemberId, afterSeq, limit],
  );

  return result.rows.map(row => ({
    ...mapPendingUpdateRow(row),
    _sourceSeq: Number(row.stream_seq),
  }));
}

// ── Club activity: club-wide events (entities, events) ──────

type ClubActivityRow = {
  id: string;
  club_id: string;
  seq: string | number;
  topic: string;
  payload: Record<string, unknown> | null;
  entity_id: string | null;
  entity_version_id: string | null;
  created_by_member_id: string | null;
  created_at: string;
};

async function listClubActivityUpdates(
  client: DbClient,
  actorMemberId: string,
  clubIds: string[],
  limit: number,
  afterSeq: number,
): Promise<Array<PendingUpdate & { _sourceSeq: number }>> {
  if (clubIds.length === 0) return [];

  const result = await client.query<ClubActivityRow>(
    `
      select
        ca.id,
        ca.club_id,
        ca.seq,
        ca.topic,
        ca.payload,
        ca.entity_id,
        ca.entity_version_id,
        ca.created_by_member_id,
        ca.created_at::text
      from app.club_activity ca
      where ca.club_id = any($1::app.short_id[])
        and ca.seq > $2::bigint
      order by ca.created_at asc, ca.seq asc
      limit $3
    `,
    [clubIds, afterSeq, limit],
  );

  return result.rows.map(row => ({
    updateId: row.id,
    streamSeq: Number(row.seq),
    source: 'activity' as const,
    recipientMemberId: actorMemberId,
    clubId: row.club_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    dmMessageId: null,
    topic: row.topic,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
    _sourceSeq: Number(row.seq),
  }));
}

// ── Seed activity cursor for first-time readers ─────────────

async function seedActivityCursor(
  client: DbClient,
  actorMemberId: string,
  clubIds: string[],
): Promise<number> {
  if (clubIds.length === 0) return 0;

  // Check for a saved cursor first (use min across clubs so we don't skip any club's activity)
  const saved = await client.query<{ last_seq: string | null }>(
    `select min(last_seq)::text as last_seq from app.club_activity_cursors where member_id = $1 and club_id = any($2::app.short_id[])`,
    [actorMemberId, clubIds],
  );
  const savedSeq = saved.rows[0]?.last_seq;
  if (savedSeq !== null && savedSeq !== undefined) return Number(savedSeq);

  // No saved cursor — start from the current max (don't replay history)
  // Persist immediately so subsequent cursorless polls resume from here
  const latest = await client.query<{ max_seq: string | null }>(
    `select max(seq)::text as max_seq from app.club_activity where club_id = any($1::app.short_id[])`,
    [clubIds],
  );
  const seededSeq = latest.rows[0]?.max_seq ? Number(latest.rows[0].max_seq) : 0;

  // Persist for every club so subsequent polls without a cursor don't reseed
  for (const clubId of clubIds) {
    await client.query(
      `
        insert into app.club_activity_cursors (member_id, club_id, last_seq, updated_at)
        values ($1, $2, $3, now())
        on conflict (member_id, club_id) do nothing
      `,
      [actorMemberId, clubId, seededSeq],
    );
  }

  return seededSeq;
}

// ── Advance activity cursors after reading ──────────────────

async function advanceActivityCursors(
  client: DbClient,
  actorMemberId: string,
  activityItems: Array<{ clubId: string; _sourceSeq: number }>,
): Promise<void> {
  if (activityItems.length === 0) return;

  // Group by club, find max seq per club
  const maxPerClub = new Map<string, number>();
  for (const item of activityItems) {
    const current = maxPerClub.get(item.clubId) ?? 0;
    if (item._sourceSeq > current) maxPerClub.set(item.clubId, item._sourceSeq);
  }

  for (const [clubId, maxSeq] of maxPerClub) {
    await client.query(
      `
        insert into app.club_activity_cursors (member_id, club_id, last_seq, updated_at)
        values ($1, $2, $3, now())
        on conflict (member_id, club_id) do update
          set last_seq = greatest(app.club_activity_cursors.last_seq, excluded.last_seq),
              updated_at = now()
      `,
      [actorMemberId, clubId, maxSeq],
    );
  }
}

// ── Merged read: combines club activity + inbox ─────────────

export async function listMergedUpdates(
  client: DbClient,
  actorMemberId: string,
  clubIds: string[],
  limit: number,
  cursor: UpdatesCursor | null,
): Promise<MemberUpdates> {
  // Seed the activity cursor for first-time readers (no client cursor provided)
  const activityAfter = cursor?.a ?? await seedActivityCursor(client, actorMemberId, clubIds);
  const inboxAfter = cursor?.i ?? 0;

  const [activityItems, inboxItems] = await Promise.all([
    listClubActivityUpdates(client, actorMemberId, clubIds, limit, activityAfter),
    listInboxUpdates(client, actorMemberId, limit, inboxAfter),
  ]);

  // Tag source for cursor tracking
  type Tagged = PendingUpdate & { _source: 'a' | 'i'; _sourceSeq: number };
  const tagged: Tagged[] = [
    ...activityItems.map(item => ({ ...item, _source: 'a' as const })),
    ...inboxItems.map(item => ({ ...item, _source: 'i' as const })),
  ];

  // Merge by created_at ASC, take limit
  tagged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const merged = tagged.slice(0, limit);

  // Advance cursor based on which items were included
  let nextA = activityAfter;
  let nextI = inboxAfter;
  for (const item of merged) {
    if (item._source === 'a') nextA = Math.max(nextA, item._sourceSeq);
    else nextI = Math.max(nextI, item._sourceSeq);
  }

  // Persist activity cursor advancement
  const deliveredActivity = merged.filter(item => item._source === 'a');
  await advanceActivityCursors(client, actorMemberId, deliveredActivity);

  const polledAtResult = await client.query<{ polled_at: string }>(`select now()::text as polled_at`);
  const nextCursor: UpdatesCursor = { a: nextA, i: nextI };

  // Strip internal tags
  const items: PendingUpdate[] = merged.map(({ _source, _sourceSeq, ...item }) => item);

  return {
    items,
    nextAfter: encodeUpdatesCursor(nextCursor),
    polledAt: polledAtResult.rows[0]?.polled_at ?? new Date().toISOString(),
  };
}

export async function appendDirectMessageUpdate(
  client: DbClient,
  input: {
    recipientMemberId: string;
    clubId: string;
    dmMessageId: string;
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
        dm_message_id,
        created_by_member_id
      )
      values ($1, $2, 'dm.message.created', $3::jsonb, $4, $5)
    `,
    [
      input.recipientMemberId,
      input.clubId,
      JSON.stringify(input.payload),
      input.dmMessageId,
      input.createdByMemberId,
    ],
  );

  return result.rowCount ?? 0;
}

export async function appendClubActivity(
  client: DbClient,
  input: {
    clubId: string;
    topic: string;
    payload: Record<string, unknown>;
    entityId?: string;
    entityVersionId?: string;
    createdByMemberId: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into app.club_activity (
        club_id,
        topic,
        payload,
        entity_id,
        entity_version_id,
        created_by_member_id
      )
      values ($1, $2, $3::jsonb, $4, $5, $6)
    `,
    [
      input.clubId,
      input.topic,
      JSON.stringify(input.payload),
      input.entityId ?? null,
      input.entityVersionId ?? null,
      input.createdByMemberId,
    ],
  );
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
}): Pick<Repository, 'listMemberUpdates' | 'getLatestCursor' | 'acknowledgeUpdates'> {
  return {
    async listMemberUpdates({ actorMemberId, clubIds, limit, after }): Promise<MemberUpdates> {
      const cursor = after ? decodeUpdatesCursor(after) : null;
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actorMemberId, clubIds);
        const updates = await listMergedUpdates(client, actorMemberId, clubIds, limit, cursor);
        await client.query('commit');
        return updates;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async getLatestCursor({ actorMemberId, clubIds }): Promise<string | null> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actorMemberId, clubIds);
        const [inboxResult, activityResult] = await Promise.all([
          client.query<{ latest: string | null }>(
            `select max(stream_seq)::text as latest from app.member_updates where recipient_member_id = $1`,
            [actorMemberId],
          ),
          clubIds.length > 0
            ? client.query<{ latest: string | null }>(
                `select max(seq)::text as latest from app.club_activity where club_id = any($1::app.short_id[])`,
                [clubIds],
              )
            : Promise.resolve({ rows: [{ latest: null }] }),
        ]);
        await client.query('commit');

        const inboxSeq = inboxResult.rows[0]?.latest;
        const activitySeq = activityResult.rows[0]?.latest;
        const i = inboxSeq !== null && inboxSeq !== undefined ? Number(inboxSeq) : 0;
        const a = activitySeq !== null && activitySeq !== undefined ? Number(activitySeq) : 0;

        return (i > 0 || a > 0) ? encodeUpdatesCursor({ a, i }) : null;
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
