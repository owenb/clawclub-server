import test from 'node:test';
import assert from 'node:assert/strict';
import { logApiRequest } from '../../src/clubs/index.ts';
import { fireAndForgetRequestLog } from '../../src/logger.ts';
import { createRepository } from '../../src/postgres.ts';

test('logApiRequest inserts member, action, and normalized IP value', async () => {
  let seenSql = '';
  let seenParams: unknown[] = [];

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      seenSql = sql;
      seenParams = params ?? [];
      return { rows: [] };
    },
  };

  await logApiRequest(pool as any, {
    memberId: 'member-1',
    actionName: 'session.getContext',
    ipAddress: '203.0.113.10',
  });

  assert.match(seenSql.replace(/\s+/g, ' ').trim(), /^insert into api_request_log \(/i);
  assert.deepEqual(seenParams, ['member-1', 'session.getContext', '203.0.113.10']);
});

test('logApiRequest preserves null ip addresses', async () => {
  let seenParams: unknown[] = [];

  const pool = {
    query: async (_sql: string, params?: unknown[]) => {
      seenParams = params ?? [];
      return { rows: [] };
    },
  };

  await logApiRequest(pool as any, {
    memberId: 'member-2',
    actionName: 'content.list',
    ipAddress: null,
  });

  assert.deepEqual(seenParams, ['member-2', 'content.list', null]);
});

test('createRepository routes request logging through the dedicated request-log pool', async () => {
  let mainQueryCount = 0;
  let requestLogQueryCount = 0;

  const mainPool = {
    options: { connectionString: 'postgresql://clawclub_app:localdev@localhost/clawclub_dev' },
    query: async () => {
      mainQueryCount += 1;
      return { rows: [] };
    },
  };
  const requestLogPool = {
    query: async () => {
      requestLogQueryCount += 1;
      return { rows: [] };
    },
    async end() {},
  };

  const repository = createRepository(mainPool as any, {
    requestLogPool: requestLogPool as any,
  });

  await repository.logApiRequest({
    memberId: 'member-3',
    actionName: 'session.getContext',
    ipAddress: '203.0.113.91',
  });

  assert.equal(requestLogQueryCount, 1);
  assert.equal(mainQueryCount, 0);
});

test('fireAndForgetRequestLog does not surface logger serialization failures', async () => {
  const originalConsoleError = console.error;
  let consoleErrorCalled = false;
  console.error = () => {
    consoleErrorCalled = true;
    throw new Error('console unavailable');
  };

  const cyclicError = new Error('request log write failed') as Error & { cause?: unknown };
  cyclicError.cause = cyclicError;

  try {
    fireAndForgetRequestLog({
      async logApiRequest() {
        throw cyclicError;
      },
    } as any, {
      memberId: 'member-4',
      actionName: 'content.list',
      ipAddress: '203.0.113.44',
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(consoleErrorCalled, true);
  } finally {
    console.error = originalConsoleError;
  }
});
