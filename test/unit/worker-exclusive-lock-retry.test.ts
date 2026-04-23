import test from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { acquireExclusiveWorkerLock } from '../../src/workers/runner.ts';

test('acquireExclusiveWorkerLock retries boundedly and logs only once when the lock stays held', async () => {
  const sleepCalls: number[] = [];
  const logCalls: unknown[][] = [];
  let createdClients = 0;
  let endedClients = 0;

  const clientFactory = () => {
    createdClients += 1;
    return {
      connect: async () => {},
      query: async () => ({ rows: [{ acquired: false }] }),
      end: async () => { endedClients += 1; },
    } as unknown as Client;
  };

  const result = await acquireExclusiveWorkerLock('test-exclusive-lock', {
    databaseUrl: 'postgresql://stub/test',
    clientFactory,
    logger: (...args: unknown[]) => { logCalls.push(args); },
    maxAttempts: 5,
    retryDelayMs: 1000,
    sleep: async (ms: number) => { sleepCalls.push(ms); },
  });

  assert.deepEqual(result, { acquired: false, attempts: 5 });
  assert.deepEqual(sleepCalls, [1000, 1000, 1000, 1000]);
  assert.equal(logCalls.length, 1);
  assert.match(String(logCalls[0]?.[0]), /\[test-exclusive-lock\] lock held by another instance/);
  assert.equal(createdClients, 5);
  assert.equal(endedClients, 5);
});
