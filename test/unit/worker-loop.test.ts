import test from 'node:test';
import assert from 'node:assert/strict';
import { resetInstalledWorkerProcessHandlersForTests, runWorkerLoop, runWorkerOnce, type WorkerPools } from '../../src/workers/runner.ts';

function makeFakePools() {
  let endCalls = 0;
  const pools = {
    db: {
      end: async () => { endCalls += 1; },
    },
  } as unknown as WorkerPools;

  return {
    pools,
    getEndCalls: () => endCalls,
  };
}

test('runWorkerLoop does not exit after a single transient error followed by idle', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let calls = 0;
  let exitCode: number | null = null;
  let sleepCalls = 0;

  await runWorkerLoop(
    'embedding',
    pools,
    async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary network blip');
      }
      return 0;
    },
    {
      pollIntervalMs: 0,
      logger: () => {},
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 2) {
          process.emit('SIGTERM');
        }
      },
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(calls, 2);
  assert.equal(exitCode, null);
  assert.equal(getEndCalls(), 1);
});

test('runWorkerLoop exits after three consecutive failures', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let calls = 0;
  let exitCode: number | null = null;

  await runWorkerLoop(
    'example-worker',
    pools,
    async () => {
      calls += 1;
      throw new Error('persistent failure');
    },
    {
      pollIntervalMs: 0,
      logger: () => {},
      sleep: async () => {},
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(calls, 3);
  assert.equal(exitCode, 1);
  assert.equal(getEndCalls(), 1);
});

test('runWorkerLoop resets the failure counter after a successful iteration', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let calls = 0;
  let exitCode: number | null = null;
  let sleepCalls = 0;

  await runWorkerLoop(
    'example-worker',
    pools,
    async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error(`failure ${calls}`);
      }
      if (calls === 3) {
        return 1;
      }
      if (calls === 4) {
        throw new Error('failure after reset');
      }
      return 0;
    },
    {
      pollIntervalMs: 0,
      logger: () => {},
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 3) {
          process.emit('SIGTERM');
        }
      },
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(calls, 4);
  assert.equal(exitCode, null);
  assert.equal(getEndCalls(), 1);
});

test('runWorkerLoop backs off consecutive transient failures', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let calls = 0;
  const sleepDelays: number[] = [];

  await runWorkerLoop(
    'example-worker',
    pools,
    async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error(`failure ${calls}`);
      }
      return 0;
    },
    {
      pollIntervalMs: 10,
      retryBackoffBaseMs: 5,
      retryBackoffMaxMs: 12,
      consecutiveFailureLimit: 4,
      logger: () => {},
      sleep: async (ms) => {
        sleepDelays.push(ms);
        if (sleepDelays.length === 3) {
          process.emit('SIGTERM');
        }
      },
      terminate: () => {},
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(sleepDelays, [5, 10, 10]);
  assert.equal(getEndCalls(), 1);
});

test('runWorkerLoop exits immediately for fatal Postgres errors', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let calls = 0;
  let exitCode: number | null = null;
  const error = Object.assign(new Error('relation does not exist'), { code: '42P01' });

  await runWorkerLoop(
    'example-worker',
    pools,
    async () => {
      calls += 1;
      throw error;
    },
    {
      pollIntervalMs: 0,
      logger: () => {},
      sleep: async () => {},
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(calls, 1);
  assert.equal(exitCode, 1);
  assert.equal(getEndCalls(), 1);
});

test('runWorkerOnce exits 1 when processing throws', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const { pools, getEndCalls } = makeFakePools();
  let exitCode: number | null = null;

  await runWorkerOnce(
    'embedding',
    pools,
    async () => {
      throw new Error('one-shot failure');
    },
    {
      logger: () => {},
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(getEndCalls(), 1);
});
