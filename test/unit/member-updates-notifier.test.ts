import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createPostgresMemberUpdateNotifier } from '../../src/member-updates-notifier.ts';

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

function patchClientMethods(methods: Partial<Record<'connect' | 'query' | 'end', AsyncMethod>>): () => void {
  const originals = {
    connect: Client.prototype.connect,
    query: Client.prototype.query,
    end: Client.prototype.end,
  };

  if (methods.connect) {
    Client.prototype.connect = methods.connect as typeof Client.prototype.connect;
  }
  if (methods.query) {
    Client.prototype.query = methods.query as typeof Client.prototype.query;
  }
  if (methods.end) {
    Client.prototype.end = methods.end as typeof Client.prototype.end;
  }

  return () => {
    Client.prototype.connect = originals.connect;
    Client.prototype.query = originals.query;
    Client.prototype.end = originals.end;
  };
}

function captureWarnLogs(): {
  logs: Array<Record<string, unknown>>;
  restore: () => void;
} {
  const originalWarn = console.warn;
  const logs: Array<Record<string, unknown>> = [];
  console.warn = (...args: unknown[]) => {
    const payload = args[0];
    if (typeof payload === 'string') {
      logs.push(JSON.parse(payload) as Record<string, unknown>);
      return;
    }
    logs.push({ raw: payload as unknown });
  };
  return {
    logs,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

test('logs once and falls back to polling when LISTEN setup fails', async () => {
  const restoreClient = patchClientMethods({
    connect: async () => {
      throw new Error('connect failed');
    },
    end: async () => undefined,
  });
  const { logs, restore } = captureWarnLogs();

  try {
    const notifier = createPostgresMemberUpdateNotifier('postgresql://localhost/fallback-startup');

    const first = await notifier.waitForUpdate({
      recipientMemberId: 'member-1',
      clubIds: [],
      afterStreamSeq: null,
      timeoutMs: 1,
    });
    const second = await notifier.waitForUpdate({
      recipientMemberId: 'member-1',
      clubIds: [],
      afterStreamSeq: null,
      timeoutMs: 1,
    });

    assert.deepEqual(first, { outcome: 'timed_out' });
    assert.deepEqual(second, { outcome: 'timed_out' });
    assert.equal(logs.length, 1, 'startup fallback should log only once');
    assert.equal(logs[0]?.message, 'updates_notifier_fallback_installed');
    assert.equal(logs[0]?.reason, 'listen_startup_failed');
    assert.equal((logs[0]?.error as Record<string, unknown>)?.message, 'connect failed');

    await notifier.close();
  } finally {
    restore();
    restoreClient();
  }
});

test('logs once and falls back to polling when listener fails after startup', async () => {
  let capturedClient: Client | null = null;
  const restoreClient = patchClientMethods({
    connect: async function (this: Client) {
      capturedClient = this;
    },
    query: async () => ({ rows: [] }),
    end: async () => undefined,
  });
  const { logs, restore } = captureWarnLogs();

  try {
    const notifier = createPostgresMemberUpdateNotifier('postgresql://localhost/fallback-runtime');

    const beforeFailure = await notifier.waitForUpdate({
      recipientMemberId: 'member-1',
      clubIds: [],
      afterStreamSeq: null,
      timeoutMs: 1,
    });
    assert.deepEqual(beforeFailure, { outcome: 'timed_out' });
    assert.equal(logs.length, 0, 'healthy listener should not log fallback');

    capturedClient?.emit('error', new Error('listener dropped'));

    const afterFailure = await notifier.waitForUpdate({
      recipientMemberId: 'member-1',
      clubIds: [],
      afterStreamSeq: null,
      timeoutMs: 1,
    });
    const secondFallback = await notifier.waitForUpdate({
      recipientMemberId: 'member-1',
      clubIds: [],
      afterStreamSeq: null,
      timeoutMs: 1,
    });

    assert.deepEqual(afterFailure, { outcome: 'timed_out' });
    assert.deepEqual(secondFallback, { outcome: 'timed_out' });
    assert.equal(logs.length, 1, 'runtime fallback should log only once');
    assert.equal(logs[0]?.message, 'updates_notifier_fallback_installed');
    assert.equal(logs[0]?.reason, 'listen_runtime_failed');
    assert.equal((logs[0]?.error as Record<string, unknown>)?.message, 'listener dropped');

    await notifier.close();
  } finally {
    restore();
    restoreClient();
  }
});
