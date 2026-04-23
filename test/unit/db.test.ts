import test from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction } from '../../src/db.ts';

test('withTransaction retries serialization failures when configured', async () => {
  const events: string[] = [];
  let attempts = 0;

  const pool = {
    async connect() {
      attempts += 1;
      const attempt = attempts;
      return {
        async query(sql: string) {
          events.push(`attempt${attempt}:${sql}`);
          if (sql === 'COMMIT' && attempt === 1) {
            throw Object.assign(new Error('serialization failure'), { code: '40001' });
          }
          return { rows: [] };
        },
        release() {
          events.push(`attempt${attempt}:release`);
        },
      };
    },
  };

  const result = await withTransaction(
    pool as any,
    async (client) => {
      await client.query('select 1');
      return 'ok';
    },
    {
      isolationLevel: 'serializable',
      retrySerializationFailures: 1,
    },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(events, [
    'attempt1:BEGIN ISOLATION LEVEL SERIALIZABLE',
    'attempt1:select 1',
    'attempt1:COMMIT',
    'attempt1:release',
    'attempt2:BEGIN ISOLATION LEVEL SERIALIZABLE',
    'attempt2:select 1',
    'attempt2:COMMIT',
    'attempt2:release',
  ]);
});

test('withTransaction retries serialization failures raised during the transaction body', async () => {
  let attempts = 0;
  const phases: string[] = [];

  const pool = {
    async connect() {
      attempts += 1;
      const attempt = attempts;
      return {
        async query(sql: string) {
          phases.push(`attempt${attempt}:${sql}`);
          return { rows: [] };
        },
        release() {
          phases.push(`attempt${attempt}:release`);
        },
      };
    },
  };

  const result = await withTransaction(
    pool as any,
    async () => {
      if (attempts === 1) {
        throw Object.assign(new Error('serialization failure'), { code: '40001' });
      }
      return 'ok';
    },
    { retrySerializationFailures: 1 },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(phases, [
    'attempt1:BEGIN',
    'attempt1:ROLLBACK',
    'attempt1:release',
    'attempt2:BEGIN',
    'attempt2:COMMIT',
    'attempt2:release',
  ]);
});

test('withTransaction does not retry non-serialization failures', async () => {
  let attempts = 0;

  const pool = {
    async connect() {
      attempts += 1;
      return {
        async query(sql: string) {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };

  await assert.rejects(
    () => withTransaction(
      pool as any,
      async () => {
        throw new Error('boom');
      },
      { retrySerializationFailures: 5 },
    ),
    /boom/,
  );
  assert.equal(attempts, 1);
});

test('withTransaction surfaces the final serialization failure after retries are exhausted', async () => {
  let attempts = 0;

  const pool = {
    async connect() {
      attempts += 1;
      return {
        async query(sql: string) {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            throw Object.assign(new Error('serialization failure'), { code: '40001' });
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  await assert.rejects(
    () => withTransaction(
      pool as any,
      async (client) => {
        await client.query('select 1');
        return 'ok';
      },
      { retrySerializationFailures: 1 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, '40001');
      return true;
    },
  );
  assert.equal(attempts, 2);
});
