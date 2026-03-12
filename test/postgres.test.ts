import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository projects actor scope into the db session before dm reads', async () => {
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

      if (sql.includes('with scope as (')) {
        return {
          rows: [
            {
              thread_id: 'thread-1',
              network_id: 'network-1',
              counterpart_member_id: 'member-2',
              counterpart_public_name: 'Member Two',
              counterpart_handle: 'member-two',
              latest_message_id: 'message-1',
              latest_sender_member_id: 'member-2',
              latest_role: 'member',
              latest_message_text: 'hello',
              latest_created_at: '2026-03-12T00:00:00Z',
              message_count: 1,
            },
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const results = await repository.listDirectMessageThreads({
    actorMemberId: 'member-1',
    networkIds: ['network-1', 'network-2'],
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-1,network-2']);
  assert.match(calls[2]?.sql ?? '', /with scope as \(/);
  assert.equal(calls.at(-1)?.sql, 'commit');
});
