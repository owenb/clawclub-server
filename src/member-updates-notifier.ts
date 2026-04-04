import { Client } from 'pg';

export type MemberUpdateNotifier = {
  waitForUpdate(input: {
    recipientMemberId: string;
    clubIds: string[];
    afterStreamSeq: number | null;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<'notified' | 'timed_out'>;
  close(): Promise<void>;
};

type Waiter = {
  recipientMemberId: string;
  clubIds: string[];
  afterStreamSeq: number | null;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

async function sleep(timeoutMs: number, signal?: AbortSignal): Promise<'timed_out'> {
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
  return 'timed_out';
}

export function createPostgresMemberUpdateNotifier(connectionString: string): MemberUpdateNotifier {
  const client = new Client({ connectionString });
  const waiters = new Set<Waiter>();
  let failed = false;

  const ready = (async () => {
    await client.connect();
    await client.query('listen member_updates');
    await client.query('listen club_activity');
  })().catch((error) => {
    failed = true;
    throw error;
  });

  function finishWaiter(waiter: Waiter, error?: Error) {
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

    waiter.resolve();
  }

  client.on('notification', (message) => {
    if (message.channel === 'member_updates') {
      let recipientMemberId: string | null = null;
      let streamSeq: number | null = null;

      try {
        const payload = message.payload ? JSON.parse(message.payload) as Record<string, unknown> : {};
        recipientMemberId = typeof payload.recipientMemberId === 'string' ? payload.recipientMemberId : null;
        streamSeq = Number.isInteger(payload.streamSeq) ? Number(payload.streamSeq) : null;
      } catch {
        recipientMemberId = null;
        streamSeq = null;
      }

      for (const waiter of [...waiters]) {
        if (recipientMemberId !== null && waiter.recipientMemberId !== recipientMemberId) {
          continue;
        }

        if (streamSeq !== null && waiter.afterStreamSeq !== null && streamSeq <= waiter.afterStreamSeq) {
          continue;
        }

        finishWaiter(waiter);
      }
    } else if (message.channel === 'club_activity') {
      let clubId: string | null = null;

      try {
        const payload = message.payload ? JSON.parse(message.payload) as Record<string, unknown> : {};
        clubId = typeof payload.clubId === 'string' ? payload.clubId : null;
      } catch {
        clubId = null;
      }

      for (const waiter of [...waiters]) {
        if (clubId !== null && !waiter.clubIds.includes(clubId)) {
          continue;
        }

        finishWaiter(waiter);
      }
    }
  });

  client.on('error', (error) => {
    failed = true;
    for (const waiter of [...waiters]) {
      finishWaiter(waiter, error instanceof Error ? error : new Error('member_updates notifier failed'));
    }
  });

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

      return new Promise<'notified' | 'timed_out'>((resolve, reject) => {
        const waiter: Waiter = {
          recipientMemberId,
          clubIds,
          afterStreamSeq,
          resolve: () => resolve('notified'),
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
            resolve('timed_out');
          }, timeoutMs),
        };

        if (signal) {
          waiter.onAbort = () => finishWaiter(waiter, new Error('Update wait aborted'));
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
        finishWaiter(waiter, new Error('member_updates notifier closed'));
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
