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

/**
 * Create a notifier that connects to both the clubs DB (for club_activity)
 * and the messaging DB (for member_updates / inbox notifications).
 * If only one URL is provided, it connects to that one only.
 */
export function createPostgresMemberUpdateNotifier(
  clubsConnectionString: string,
  messagingConnectionString?: string,
): MemberUpdateNotifier {
  const clubsClient = new Client({ connectionString: clubsConnectionString });
  const messagingClient = messagingConnectionString ? new Client({ connectionString: messagingConnectionString }) : null;
  const waiters = new Set<Waiter>();
  let failed = false;

  const ready = (async () => {
    await clubsClient.connect();
    await clubsClient.query('listen club_activity');
    if (messagingClient) {
      await messagingClient.connect();
      await messagingClient.query('listen member_updates');
    }
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

  function handleNotification(message: { channel: string; payload?: string }) {
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
        if (recipientMemberId !== null && waiter.recipientMemberId !== recipientMemberId) continue;
        if (streamSeq !== null && waiter.afterStreamSeq !== null && streamSeq <= waiter.afterStreamSeq) continue;
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
        if (clubId !== null && !waiter.clubIds.includes(clubId)) continue;
        finishWaiter(waiter);
      }
    }
  }

  function handleError(error: unknown) {
    failed = true;
    for (const waiter of [...waiters]) {
      finishWaiter(waiter, error instanceof Error ? error : new Error('member_updates notifier failed'));
    }
  }

  clubsClient.on('notification', handleNotification);
  clubsClient.on('error', handleError);
  if (messagingClient) {
    messagingClient.on('notification', handleNotification);
    messagingClient.on('error', handleError);
  }

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

      await clubsClient.end();
      if (messagingClient) await messagingClient.end();
    },
  };
}
