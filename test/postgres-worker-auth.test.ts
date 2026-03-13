import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository authenticates delivery worker tokens separately from member bearer tokens', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('update app.delivery_worker_tokens dwt')) {
        return {
          rows: [{
            token_id: 'worker-token-1',
            actor_member_id: 'member-1',
            label: 'primary worker',
            allowed_network_ids: ['network-2', 'network-3'],
            metadata: { host: 'worker-a' },
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const auth = await repository.authenticateDeliveryWorkerToken?.('cc_live_23456789abcd_23456789abcdefghjkmnpqrs');

  assert.deepEqual(auth, {
    tokenId: 'worker-token-1',
    actorMemberId: 'member-1',
    label: 'primary worker',
    allowedNetworkIds: ['network-2', 'network-3'],
    metadata: { host: 'worker-a' },
  });
  assert.match(calls[0]?.sql ?? '', /update app\.delivery_worker_tokens dwt/);
});
