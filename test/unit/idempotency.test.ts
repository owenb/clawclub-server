import test from 'node:test';
import assert from 'node:assert/strict';
import { getBarrierClientConfig } from '../../src/idempotency.ts';

test('getBarrierClientConfig inherits timeout and statement_timeout options from the pool', () => {
  const config = getBarrierClientConfig({
    options: {
      connectionString: 'postgresql://example.test/clawclub',
      connectionTimeoutMillis: 4321,
      options: '-c statement_timeout=9876',
    },
  } as never);

  assert.deepEqual(config, {
    connectionString: 'postgresql://example.test/clawclub',
    connectionTimeoutMillis: 4321,
    options: '-c statement_timeout=9876',
  });
});

