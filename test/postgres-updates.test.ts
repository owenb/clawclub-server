import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdatesRepository } from '../src/postgres/updates.ts';

test('postgres updates repository lists pending updates with a cursor', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.pending_member_updates pmu')) {
        return {
          rows: [{
            update_id: 'update-1',
            stream_seq: 7,
            recipient_member_id: 'member-1',
            network_id: 'network-1',
            topic: 'transcript.message.created',
            payload: { kind: 'dm', threadId: 'thread-1' },
            entity_id: null,
            entity_version_id: null,
            transcript_message_id: 'message-1',
            created_by_member_id: 'member-2',
            created_at: '2026-03-14T11:00:00Z',
          }],
          rowCount: 1,
        };
      }

      if (sql === 'select now()::text as polled_at') {
        return { rows: [{ polled_at: '2026-03-14T11:05:00Z' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildUpdatesRepository({
    pool: { connect: async () => client } as any,
    applyActorContext: async (dbClient, actorMemberId) => {
      await dbClient.query(`select set_config('app.actor_member_id', $1, true)`, [actorMemberId]);
    },
  });

  const updates = await repository.listMemberUpdates?.({
    actorMemberId: 'member-1',
    limit: 5,
    after: 4,
  });

  assert.equal(updates?.items[0]?.updateId, 'update-1');
  assert.equal(updates?.items[0]?.streamSeq, 7);
  assert.equal(updates?.nextAfter, 7);
  assert.equal(updates?.polledAt, '2026-03-14T11:05:00Z');
  assert.deepEqual(calls[2]?.params, ['member-1', 4, 5]);
});

test('postgres updates repository acknowledges updates idempotently', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.member_update_receipts')) {
        return {
          rows: [{
            receipt_id: 'receipt-1',
            update_id: 'update-1',
            recipient_member_id: 'member-1',
            network_id: 'network-1',
            state: 'processed',
            suppression_reason: null,
            version_no: 1,
            supersedes_receipt_id: null,
            created_at: '2026-03-14T11:06:00Z',
            created_by_member_id: 'member-1',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildUpdatesRepository({
    pool: { connect: async () => client } as any,
    applyActorContext: async (dbClient, actorMemberId) => {
      await dbClient.query(`select set_config('app.actor_member_id', $1, true)`, [actorMemberId]);
    },
  });

  const receipts = await repository.acknowledgeUpdates?.({
    actorMemberId: 'member-1',
    updateIds: ['update-1'],
    state: 'processed',
  });

  assert.equal(receipts?.[0]?.receiptId, 'receipt-1');
  assert.equal(receipts?.[0]?.updateId, 'update-1');
  assert.equal(receipts?.[0]?.state, 'processed');
  assert.deepEqual(calls[2]?.params, ['member-1', ['update-1'], 'processed', null]);
});
