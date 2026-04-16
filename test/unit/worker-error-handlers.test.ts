import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerPoolErrorHandler,
  createWorkerUnhandledRejectionHandler,
  createWorkerUncaughtExceptionHandler,
  installWorkerProcessHandlers,
  resetInstalledWorkerProcessHandlersForTests,
} from '../../src/workers/runner.ts';

test('pool error handler logs and returns without throwing', () => {
  const calls: unknown[][] = [];
  const logger = (...args: unknown[]) => { calls.push(args); };
  const handler = createWorkerPoolErrorHandler('embedding', { logger });
  const error = new Error('idle client reset');

  assert.doesNotThrow(() => handler(error));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], '[embedding] [pool error]');
  assert.equal(calls[0]?.[1], error);
});

test('unhandledRejection handler logs and returns', () => {
  const calls: unknown[][] = [];
  const logger = (...args: unknown[]) => { calls.push(args); };
  const handler = createWorkerUnhandledRejectionHandler('synchronicity', { logger });
  const rejection = new Error('transient rejection');

  assert.doesNotThrow(() => handler(rejection));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], '[synchronicity] [unhandled rejection]');
  assert.equal(calls[0]?.[1], rejection);
});

test('uncaughtException handler logs and terminates exactly once', () => {
  const calls: unknown[][] = [];
  let terminateCalls = 0;
  const logger = (...args: unknown[]) => { calls.push(args); };
  const terminate = () => { terminateCalls += 1; };
  const handler = createWorkerUncaughtExceptionHandler('embedding-backfill', { logger, terminate });
  const error = new Error('uncaught boom');

  assert.doesNotThrow(() => handler(error));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], '[embedding-backfill] [uncaught exception]');
  assert.equal(calls[0]?.[1], error);
  assert.equal(terminateCalls, 1);
});

test('installWorkerProcessHandlers is idempotent', (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const logger = () => {};
  const terminate = () => {};
  const beforeUnhandled = process.listenerCount('unhandledRejection');
  const beforeUncaught = process.listenerCount('uncaughtException');

  installWorkerProcessHandlers('embedding', { logger, terminate });
  const afterFirstUnhandled = process.listenerCount('unhandledRejection');
  const afterFirstUncaught = process.listenerCount('uncaughtException');

  installWorkerProcessHandlers('embedding', { logger, terminate });
  const afterSecondUnhandled = process.listenerCount('unhandledRejection');
  const afterSecondUncaught = process.listenerCount('uncaughtException');

  assert.equal(afterFirstUnhandled, beforeUnhandled + 1);
  assert.equal(afterFirstUncaught, beforeUncaught + 1);
  assert.equal(afterSecondUnhandled, afterFirstUnhandled);
  assert.equal(afterSecondUncaught, afterFirstUncaught);
});
