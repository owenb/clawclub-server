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


test('postgres repository projects actor scope into the db session before inbox reads', async () => {
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

      if (sql.includes('from app.current_dm_inbox_threads inbox')) {
        return {
          rows: [
            {
              thread_id: 'thread-1',
              network_id: 'network-2',
              counterpart_member_id: 'member-2',
              counterpart_public_name: 'Member Two',
              counterpart_handle: 'member-two',
              latest_message_id: 'message-2',
              latest_sender_member_id: 'member-2',
              latest_role: 'member',
              latest_message_text: 'still waiting on your reply',
              latest_created_at: '2026-03-12T00:05:00Z',
              message_count: 4,
              unread_message_count: 2,
              unread_delivery_count: 3,
              latest_unread_message_created_at: '2026-03-12T00:05:00Z',
              has_unread: true,
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
  const results = await repository.listDirectMessageInbox({
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 5,
    unreadOnly: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(results[0]?.unread.unreadMessageCount, 2);
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_dm_inbox_threads inbox/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['network-2'], true, 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository projects actor scope into the db session before delivery reads', async () => {
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

      if (sql.includes('from app.current_delivery_receipts cdr')) {
        return {
          rows: [
            {
              delivery_id: 'delivery-1',
              network_id: 'network-2',
              recipient_member_id: 'member-1',
              topic: 'transcript.message.created',
              payload: { kind: 'dm' },
              status: 'sent',
              entity_id: null,
              entity_version_id: null,
              transcript_message_id: 'message-1',
              scheduled_at: '2026-03-12T00:02:00Z',
              sent_at: '2026-03-12T00:03:00Z',
              failed_at: null,
              created_at: '2026-03-12T00:02:00Z',
              acknowledgement_id: 'ack-1',
              acknowledgement_state: 'shown',
              acknowledgement_suppression_reason: null,
              acknowledgement_version_no: 1,
              acknowledgement_created_at: '2026-03-12T00:04:00Z',
              acknowledgement_created_by_member_id: 'member-1',
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
  const results = await repository.listDeliveries({
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 5,
    pendingOnly: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.deliveryId, 'delivery-1');
  assert.equal(results[0]?.acknowledgement?.acknowledgementId, 'ack-1');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_delivery_receipts cdr/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['network-2'], true, 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository creates and revokes hashed bearer tokens without returning the hash', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('insert into app.member_bearer_tokens')) {
        return {
          rows: [
            {
              token_id: 'token-1',
              member_id: 'member-1',
              label: 'laptop',
              created_at: '2026-03-12T00:00:00Z',
              last_used_at: null,
              revoked_at: null,
              metadata: { device: 'mbp' },
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('update app.member_bearer_tokens mbt')) {
        return {
          rows: [
            {
              token_id: 'token-1',
              member_id: 'member-1',
              label: 'laptop',
              created_at: '2026-03-12T00:00:00Z',
              last_used_at: null,
              revoked_at: '2026-03-12T00:05:00Z',
              metadata: { device: 'mbp' },
            },
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const created = await repository.createBearerToken({
    actorMemberId: 'member-1',
    label: 'laptop',
    metadata: { device: 'mbp' },
  });

  assert.equal(created.token.tokenId, 'token-1');
  assert.equal(created.token.memberId, 'member-1');
  assert.equal(created.token.label, 'laptop');
  assert.equal(created.bearerToken.startsWith('cc_live_token-1_'), false);
  assert.match(created.bearerToken, /^cc_live_[23456789abcdefghjkmnpqrstuvwxyz]{12}_[23456789abcdefghjkmnpqrstuvwxyz]{24}$/);
  assert.match(calls[0]?.sql ?? '', /insert into app\.member_bearer_tokens/);
  assert.equal((calls[0]?.params?.[0] as string).length, 12);
  assert.equal(calls[0]?.params?.[1], 'member-1');
  assert.equal(calls[0]?.params?.[2], 'laptop');
  assert.equal(typeof calls[0]?.params?.[3], 'string');
  assert.notEqual(calls[0]?.params?.[3], created.bearerToken);

  const revoked = await repository.revokeBearerToken({
    actorMemberId: 'member-1',
    tokenId: 'token-1',
  });

  assert.equal(revoked?.tokenId, 'token-1');
  assert.equal(revoked?.revokedAt, '2026-03-12T00:05:00Z');
  assert.match(calls[1]?.sql ?? '', /update app\.member_bearer_tokens mbt/);
  assert.deepEqual(calls[1]?.params, ['token-1', 'member-1']);
});
