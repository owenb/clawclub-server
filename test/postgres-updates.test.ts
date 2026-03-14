import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdatesRepository } from '../src/postgres/updates.ts';

test('postgres updates repository acknowledges returned deliveries and records seen posts', async () => {
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

      if (sql.includes('from app.pending_deliveries pd')) {
        return {
          rows: [{
            id: 'delivery-1',
            network_id: 'network-1',
            entity_id: null,
            entity_version_id: null,
            transcript_message_id: 'message-1',
            topic: 'transcript.message.created',
            payload: { kind: 'dm', threadId: 'thread-1' },
            created_at: '2026-03-14T11:00:00Z',
            sent_at: '2026-03-14T11:00:01Z',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('from scope s') && sql.includes("where le.kind = 'post'")) {
        return {
          rows: [{
            entity_id: 'entity-1',
            entity_version_id: 'entity-version-1',
            network_id: 'network-1',
            kind: 'post',
            author_member_id: 'member-2',
            author_public_name: 'Member Two',
            author_handle: 'member-two',
            version_no: 1,
            state: 'published',
            title: 'Weekly update',
            summary: 'Summary',
            body: 'Body',
            effective_at: '2026-03-14T10:55:00Z',
            expires_at: null,
            version_created_at: '2026-03-14T10:55:00Z',
            content: {},
            embedding_id: null,
            embedding_model: null,
            embedding_dimensions: null,
            embedding_source_text: null,
            embedding_metadata: null,
            embedding_created_at: null,
            entity_created_at: '2026-03-14T10:55:00Z',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.delivery_acknowledgements')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('insert into app.member_entity_update_receipts')) {
        return { rows: [], rowCount: 1 };
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

  const updates = await repository.pollUpdates({
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1'],
    limit: 5,
  });

  assert.equal(updates.deliveries[0]?.deliveryId, 'delivery-1');
  assert.equal(updates.posts[0]?.entityId, 'entity-1');
  assert.equal(updates.polledAt, '2026-03-14T11:05:00Z');
  assert.equal(calls.some((call) => call.sql.includes('insert into app.delivery_acknowledgements')), true);
  assert.equal(calls.some((call) => call.sql.includes('insert into app.member_entity_update_receipts')), true);
});
