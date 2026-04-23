import test from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { acquireExclusiveWorkerLock } from '../../src/workers/runner.ts';

const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for worker exclusive lock tests');
  }
  return databaseUrl;
}

async function closeClient(client: Client): Promise<void> {
  await client.end().catch(() => {});
}

test('exclusive worker lock retries on the same key and allows different keys concurrently', { concurrency: false }, async (t) => {
  const heldClients = new Set<Client>();
  const holdClient = (client: Client) => { heldClients.add(client); };
  t.after(async () => {
    await Promise.allSettled([...heldClients].map(closeClient));
  });

  const key = `worker-exclusive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const first = await acquireExclusiveWorkerLock(key, {
    databaseUrl: requireDatabaseUrl(),
    logger: () => {},
    maxAttempts: 1,
  });
  assert.equal(first.acquired, true);
  if (!first.acquired) return;
  holdClient(first.client);

  const second = await acquireExclusiveWorkerLock(key, {
    databaseUrl: requireDatabaseUrl(),
    logger: () => {},
    maxAttempts: 2,
    retryDelayMs: 10,
  });
  assert.deepEqual(second, { acquired: false, attempts: 2 });

  const differentKey = await acquireExclusiveWorkerLock(`${key}:other`, {
    databaseUrl: requireDatabaseUrl(),
    logger: () => {},
    maxAttempts: 1,
  });
  assert.equal(differentKey.acquired, true);
  if (differentKey.acquired) {
    holdClient(differentKey.client);
  }

  heldClients.delete(first.client);
  await closeClient(first.client);

  const third = await acquireExclusiveWorkerLock(key, {
    databaseUrl: requireDatabaseUrl(),
    logger: () => {},
    maxAttempts: 1,
  });
  assert.equal(third.acquired, true);
  if (third.acquired) {
    holdClient(third.client);
  }
});

test('exclusive worker lock uses a real keyed advisory lock', { concurrency: false }, async (t) => {
  const heldClients = new Set<Client>();
  t.after(async () => {
    await Promise.allSettled([...heldClients].map(closeClient));
  });

  const key = `worker-exclusive-race-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [left, right] = await Promise.all([
    acquireExclusiveWorkerLock(key, {
      databaseUrl: requireDatabaseUrl(),
      logger: () => {},
      maxAttempts: 1,
    }),
    acquireExclusiveWorkerLock(key, {
      databaseUrl: requireDatabaseUrl(),
      logger: () => {},
      maxAttempts: 1,
    }),
  ]);

  const acquiredCount = Number(left.acquired) + Number(right.acquired);
  assert.equal(acquiredCount, 1);

  if (left.acquired) heldClients.add(left.client);
  if (right.acquired) heldClients.add(right.client);

  const failed = left.acquired ? right : left;
  assert.deepEqual(failed, { acquired: false, attempts: 1 });
});
