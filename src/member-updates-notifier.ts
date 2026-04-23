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
): MemberUpdateNotifier {
  const client = new Client({ connectionString });
  const waiters = new Set<Waiter>();
  let failed = false;
  let fallbackLogged = false;

  function markFailed(reason: 'listen_startup_failed' | 'listen_runtime_failed', error: unknown): void {
    if (!failed) {
      failed = true;
    }
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

  const ready = (async () => {
    await client.connect();
    await client.query('listen stream');
  })().catch((error) => {
    markFailed('listen_startup_failed', error);
    throw error;
  });

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

  function handleError(error: unknown) {
    markFailed('listen_runtime_failed', error);
    for (const waiter of [...waiters]) {
      finishWaiter(waiter, undefined, error instanceof Error ? error : new Error('updates notifier failed'));
    }
  }

  client.on('notification', handleNotification);
  client.on('error', handleError);

  return {
    async waitForUpdate({ recipientMemberId, clubIds, afterStreamSeq, timeoutMs, signal }) {
      try {
        await ready;
      } catch {
        return sleep(timeoutMs, signal);
      }

      if (failed) {
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
      for (const waiter of [...waiters]) {
        finishWaiter(waiter, undefined, new Error('updates notifier closed'));
      }

      try {
        await ready;
      } catch {
        return;
      }

      await client.end();
    },
  };
}
