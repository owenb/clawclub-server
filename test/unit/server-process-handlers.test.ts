import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApiUnhandledRejectionHandler,
  createApiUncaughtExceptionHandler,
  installApiProcessHandlers,
  resetInstalledApiProcessHandlersForTests,
} from '../../src/server.ts';

test('api unhandledRejection handler logs and returns', () => {
  const calls: Array<[string, unknown]> = [];
  const handler = createApiUnhandledRejectionHandler({
    logger: (event, error) => {
      calls.push([event, error]);
    },
  });
  const error = new Error('transient rejection');

  assert.doesNotThrow(() => handler(error));
  assert.deepEqual(calls, [['api_unhandled_rejection', error]]);
});

test('api uncaughtException handler logs and terminates exactly once', () => {
  const calls: Array<[string, unknown]> = [];
  let terminateCalls = 0;
  const handler = createApiUncaughtExceptionHandler({
    logger: (event, error) => {
      calls.push([event, error]);
    },
    terminate: () => {
      terminateCalls += 1;
    },
  });
  const error = new Error('uncaught boom');

  assert.doesNotThrow(() => handler(error));
  assert.deepEqual(calls, [['api_uncaught_exception', error]]);
  assert.equal(terminateCalls, 1);
});

test('installApiProcessHandlers is idempotent', (t) => {
  resetInstalledApiProcessHandlersForTests();
  t.after(() => {
    resetInstalledApiProcessHandlersForTests();
  });

  const logger = () => {};
  const terminate = () => {};
  const beforeUnhandled = process.listenerCount('unhandledRejection');
  const beforeUncaught = process.listenerCount('uncaughtException');

  installApiProcessHandlers({ logger, terminate });
  const afterFirstUnhandled = process.listenerCount('unhandledRejection');
  const afterFirstUncaught = process.listenerCount('uncaughtException');

  installApiProcessHandlers({ logger, terminate });
  const afterSecondUnhandled = process.listenerCount('unhandledRejection');
  const afterSecondUncaught = process.listenerCount('uncaughtException');

  assert.equal(afterFirstUnhandled, beforeUnhandled + 1);
  assert.equal(afterFirstUncaught, beforeUncaught + 1);
  assert.equal(afterSecondUnhandled, afterFirstUnhandled);
  assert.equal(afterSecondUncaught, afterFirstUncaught);
});
