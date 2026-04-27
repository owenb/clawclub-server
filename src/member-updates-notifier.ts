import { Client } from 'pg';
import { logger } from './logger.ts';

export type StreamWakeupCause = {
  kind: string;
  clubId: string | null;
  recipientMemberId: string | null;
};

export type WaitResult =
  | { outcome: 'notified'; cause?: StreamWakeupCause }
  | { outcome: 'timed_out' };

export type MemberUpdateNotifier = {
  waitForUpdate(input: {
    recipientMemberId: string;
    clubIds: string[];
    afterStreamSeq: number | null;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<WaitResult>;
  close(): Promise<void>;
};

type Waiter = {
  recipientMemberId: string;
  clubIds: string[];
  afterStreamSeq: number | null;
  resolve: (cause?: StreamWakeupCause) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type PostgresMemberUpdateNotifierOptions = {
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

async function sleep(timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
  if (signal?.aborted) {
    throw new Error('Update wait aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('Update wait aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return { outcome: 'timed_out' };
}

/**
 * Create a notifier that listens on the unified `stream` channel.
 */
export function createPostgresMemberUpdateNotifier(
  connectionString: string,
  options: PostgresMemberUpdateNotifierOptions = {},
): MemberUpdateNotifier {
  const reconnectBaseDelayMs = Math.max(1, options.reconnectBaseDelayMs ?? 250);
  const reconnectMaxDelayMs = Math.max(reconnectBaseDelayMs, options.reconnectMaxDelayMs ?? 5_000);
  const waiters = new Set<Waiter>();
  let client: Client | null = null;
  let connectPromise: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let state: 'connecting' | 'listening' | 'fallback' | 'closed' = 'connecting';
  let reconnectAttempt = 0;
  let fallbackLogged = false;

  function logFallback(reason: 'listen_startup_failed' | 'listen_runtime_failed', error: unknown): void {
    if (fallbackLogged) {
      return;
    }
    fallbackLogged = true;
    const errorContext = {
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
    };
    logger.warn('updates_notifier_fallback_installed', {
      reason,
      error: errorContext,
    });
  }

  function finishWaiter(waiter: Waiter, cause?: StreamWakeupCause, error?: Error) {
    if (!waiters.has(waiter)) {
      return;
    }

    waiters.delete(waiter);
    clearTimeout(waiter.timeout);
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
    }

    if (error) {
      waiter.reject(error);
      return;
    }

    waiter.resolve(cause);
  }

  function rejectWaiters(error: Error): void {
    for (const waiter of [...waiters]) {
      finishWaiter(waiter, undefined, error);
    }
  }

  function handleNotification(message: { channel: string; payload?: string }) {
    if (message.channel !== 'stream') return;

    let kind: string | null = null;
    let clubId: string | null = null;
    let recipientMemberId: string | null = null;

    try {
      const payload = message.payload ? JSON.parse(message.payload) as Record<string, unknown> : {};
      kind = typeof payload.kind === 'string' ? payload.kind : null;
      clubId = typeof payload.clubId === 'string' ? payload.clubId : null;
      recipientMemberId = typeof payload.recipientMemberId === 'string' ? payload.recipientMemberId : null;
    } catch {
      kind = null;
      clubId = null;
      recipientMemberId = null;
    }

    const cause = kind === null && clubId === null && recipientMemberId === null
      ? undefined
      : {
        kind: kind ?? '',
        clubId,
        recipientMemberId,
      };

    for (const waiter of [...waiters]) {
      // Match by recipient or by club
      if (recipientMemberId !== null && waiter.recipientMemberId === recipientMemberId) {
        finishWaiter(waiter, cause);
        continue;
      }
      if (clubId !== null && waiter.clubIds.includes(clubId)) {
        finishWaiter(waiter, cause);
        continue;
      }
      // If payload has no identifiers, wake everyone (defensive)
      if (clubId === null && recipientMemberId === null) {
        finishWaiter(waiter, cause);
      }
    }
  }

  function scheduleReconnect(): void {
    if (state === 'closed' || reconnectTimer !== null) {
      return;
    }

    const delayMs = Math.min(
      reconnectMaxDelayMs,
      reconnectBaseDelayMs * (2 ** Math.min(reconnectAttempt, 8)),
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectListener();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function enterFallback(
    reason: 'listen_startup_failed' | 'listen_runtime_failed',
    error: unknown,
  ): void {
    if (state === 'closed') {
      return;
    }

    state = 'fallback';
    logFallback(reason, error);
    scheduleReconnect();
  }

  async function disconnectClient(current: Client): Promise<void> {
    current.removeAllListeners('notification');
    current.removeAllListeners('error');
    try {
      await current.end();
    } catch {
      // The reconnect loop already moved to fallback; a failed close should not
      // permanently disable LISTEN recovery.
    }
  }

  function handleClientError(current: Client, error: unknown): void {
    if (state === 'closed' || client !== current) {
      return;
    }

    client = null;
    enterFallback('listen_runtime_failed', error);
    rejectWaiters(error instanceof Error ? error : new Error('updates notifier failed'));
    void disconnectClient(current);
  }

  function connectListener(): Promise<void> {
    if (state === 'closed') {
      return Promise.resolve();
    }
    if (connectPromise !== null) {
      return connectPromise;
    }

    state = 'connecting';
    const nextClient = new Client({ connectionString });
    client = nextClient;
    nextClient.on('notification', handleNotification);
    nextClient.on('error', (error) => handleClientError(nextClient, error));

    const promise = (async () => {
      await nextClient.connect();
      await nextClient.query('listen stream');
      if (client !== nextClient) {
        await disconnectClient(nextClient);
        return;
      }

      state = 'listening';
      reconnectAttempt = 0;
      if (fallbackLogged) {
        fallbackLogged = false;
        logger.warn('updates_notifier_recovered');
      }
    })();

    const managedPromise = promise
      .catch((error) => {
        if (client === nextClient) {
          client = null;
        }
        void disconnectClient(nextClient);
        enterFallback('listen_startup_failed', error);
        throw error;
      })
      .finally(() => {
        if (connectPromise === managedPromise) {
          connectPromise = null;
        }
      });

    connectPromise = managedPromise;
    return connectPromise;
  }

  void connectListener();

  return {
    async waitForUpdate({ recipientMemberId, clubIds, afterStreamSeq, timeoutMs, signal }) {
      await (connectPromise ?? Promise.resolve()).catch(() => undefined);
      if (state !== 'listening') {
        return sleep(timeoutMs, signal);
      }

      return new Promise<WaitResult>((resolve, reject) => {
        const waiter: Waiter = {
          recipientMemberId,
          clubIds,
          afterStreamSeq,
          resolve: (cause) => resolve({ outcome: 'notified', cause }),
          reject,
          signal,
          timeout: setTimeout(() => {
            if (!waiters.has(waiter)) {
              return;
            }

            waiters.delete(waiter);
            if (waiter.onAbort) {
              waiter.signal?.removeEventListener('abort', waiter.onAbort);
            }
            resolve({ outcome: 'timed_out' });
          }, timeoutMs),
        };

        if (signal) {
          waiter.onAbort = () => finishWaiter(waiter, undefined, new Error('Update wait aborted'));
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }

        waiters.add(waiter);
      }).catch(async (error) => {
        if (signal?.aborted) {
          throw error;
        }

        return sleep(timeoutMs, signal);
      });
    },

    async close() {
      state = 'closed';
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const waiter of [...waiters]) {
        finishWaiter(waiter, undefined, new Error('updates notifier closed'));
      }

      const current = client;
      client = null;
      await (connectPromise ?? Promise.resolve()).catch(() => undefined);
      if (current !== null) {
        await disconnectClient(current);
      }
    },
  };
}
