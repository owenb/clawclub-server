import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeliveryWorker } from '../src/delivery-worker.ts';

test('runDeliveryWorker drains successful executions until idle', async () => {
  const calls: string[] = [];
  const logs: string[] = [];

  const summary = await runDeliveryWorker(
    {
      executeOnce: async ({ workerKey }) => {
        calls.push(String(workerKey));

        if (calls.length === 1) {
          return {
            outcome: 'sent',
            claimed: {
              delivery: { deliveryId: 'delivery-1' },
            },
          } as any;
        }

        return {
          outcome: 'idle',
          claimed: null,
        } as any;
      },
      log: (message) => logs.push(message),
    },
    { workerKey: 'worker-a', maxRuns: 5 },
  );

  assert.deepEqual(calls, ['worker-a', 'worker-a']);
  assert.equal(summary.reason, 'idle');
  assert.deepEqual(summary.runs, [
    { iteration: 1, outcome: 'sent', deliveryId: 'delivery-1' },
    { iteration: 2, outcome: 'idle', deliveryId: null },
  ]);
  assert.deepEqual(logs, [
    'delivery worker iteration 1: sent delivery-1',
    'delivery worker idle after 2 iterations',
  ]);
});

test('runDeliveryWorker exits immediately when the first execution is idle', async () => {
  const summary = await runDeliveryWorker({
    executeOnce: async () => ({
      outcome: 'idle',
      claimed: null,
    }) as any,
  });

  assert.equal(summary.reason, 'idle');
  assert.deepEqual(summary.runs, [
    { iteration: 1, outcome: 'idle', deliveryId: null },
  ]);
});

test('runDeliveryWorker stops at the safety limit when work keeps appearing', async () => {
  let callCount = 0;
  const logs: string[] = [];

  const summary = await runDeliveryWorker(
    {
      executeOnce: async () => {
        callCount += 1;
        return {
          outcome: callCount % 2 === 0 ? 'failed' : 'sent',
          claimed: {
            delivery: { deliveryId: `delivery-${callCount}` },
          },
        } as any;
      },
      log: (message) => logs.push(message),
    },
    { maxRuns: 3 },
  );

  assert.equal(callCount, 3);
  assert.equal(summary.reason, 'safety_limit');
  assert.deepEqual(summary.runs, [
    { iteration: 1, outcome: 'sent', deliveryId: 'delivery-1' },
    { iteration: 2, outcome: 'failed', deliveryId: 'delivery-2' },
    { iteration: 3, outcome: 'sent', deliveryId: 'delivery-3' },
  ]);
  assert.deepEqual(logs, [
    'delivery worker iteration 1: sent delivery-1',
    'delivery worker iteration 2: failed delivery-2',
    'delivery worker iteration 3: sent delivery-3',
    'delivery worker stopped at safety limit (3)',
  ]);
});
