import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository authenticates delivery worker tokens separately from member bearer tokens', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('from app.members m') && sql.includes('coalesce(gr.global_roles')) {
        return {
          rows: [{
            member_id: 'member-1',
            handle: 'member-one',
            public_name: 'Member One',
            global_roles: [],
            membership_id: 'membership-1',
            network_id: 'network-2',
            slug: 'alpha',
            network_name: 'Alpha',
            network_summary: 'First network',
            manifesto_markdown: null,
            role: 'owner',
            status: 'active',
            sponsor_member_id: null,
            joined_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected client query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.authenticate_delivery_worker_token(')) {
        return {
          rows: [{
            token_id: 'worker-token-1',
            actor_member_id: 'member-1',
            label: 'primary worker',
            allowed_network_ids: '{network-2,network-3}',
            metadata: { host: 'worker-a' },
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const auth = await repository.authenticateDeliveryWorkerToken?.('cc_live_23456789abcd_23456789abcdefghjkmnpqrs');

  assert.deepEqual(auth, {
    tokenId: 'worker-token-1',
    actorMemberId: 'member-1',
    label: 'primary worker',
    allowedNetworkIds: ['network-2'],
    metadata: { host: 'worker-a' },
  });
  assert.match(calls[0]?.sql ?? '', /from app\.authenticate_delivery_worker_token\(/);
});

test('postgres repository rejects delivery worker tokens when the actor no longer has any allowed network access', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('from app.members m') && sql.includes('coalesce(gr.global_roles')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected client query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async query(sql: string) {
      if (sql.includes('from app.authenticate_delivery_worker_token(')) {
        return {
          rows: [{
            token_id: 'worker-token-2',
            actor_member_id: 'member-9',
            label: 'stale worker',
            allowed_network_ids: '{network-9}',
            metadata: {},
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const auth = await repository.authenticateDeliveryWorkerToken?.('cc_live_23456789abcd_23456789abcdefghjkmnpqrs');

  assert.equal(auth, null);
});

test('postgres repository parses postgres auth array strings for bearer-token actor scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('from app.pending_deliveries pd')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.members m') && sql.includes('coalesce(gr.global_roles')) {
        return {
          rows: [{
            member_id: 'member-1',
            handle: 'member-one',
            public_name: 'Member One',
            global_roles: '{superadmin}',
            membership_id: 'membership-1',
            network_id: 'network-2',
            slug: 'alpha',
            network_name: 'Alpha',
            network_summary: 'First network',
            manifesto_markdown: null,
            role: 'owner',
            status: 'active',
            sponsor_member_id: null,
            joined_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected client query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.authenticate_member_bearer_token(')) {
        return {
          rows: [{ member_id: 'member-1' }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const auth = await repository.authenticateBearerToken?.('cc_live_23456789abcd_23456789abcdefghjkmnpqrs');

  assert.deepEqual(auth?.actor.globalRoles, ['superadmin']);
  assert.deepEqual(auth?.requestScope.activeNetworkIds, ['network-2']);
  assert.match(calls[0]?.sql ?? '', /from app\.authenticate_member_bearer_token\(/);
});
