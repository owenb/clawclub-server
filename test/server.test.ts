import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, DEFAULT_SERVER_LIMITS } from '../src/server.ts';
import type { PendingUpdate, Repository } from '../src/app.ts';

function makeAuthResult() {
  return {
    actor: {
      member: {
        id: 'member-1',
        handle: 'member-one',
        publicName: 'Member One',
      },
      memberships: [{
        membershipId: 'membership-1',
        networkId: 'network-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First network',
        manifestoMarkdown: null,
        role: 'member' as const,
        status: 'active' as const,
        sponsorMemberId: null,
        joinedAt: '2026-03-14T10:00:00Z',
      }],
      globalRoles: [],
    },
    requestScope: {
      requestedNetworkId: null,
      activeNetworkIds: ['network-1'],
    },
    sharedContext: {
      pendingUpdates: [],
    },
  };
}

function makePendingUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    updateId: 'update-1',
    streamSeq: 1,
    recipientMemberId: 'member-1',
    networkId: 'network-1',
    entityId: null,
    entityVersionId: null,
    transcriptMessageId: 'message-1',
    topic: 'transcript.message.created',
    payload: { kind: 'dm', threadId: 'thread-1' },
    createdAt: '2026-03-14T11:00:00Z',
    createdByMemberId: 'member-2',
    ...overrides,
  };
}

function makeRepository(): Repository {
  return {
    async authenticateBearerToken() {
      return null;
    },
    async listMemberships() { return []; },
    async createMembership() { throw new Error('not used'); },
    async transitionMembershipState() { throw new Error('not used'); },
    async listMembershipReviews() { return []; },
    async searchMembers() { return []; },
    async listMembers() { return []; },
    async getMemberProfile() { return null; },
    async updateOwnProfile() { throw new Error('not used'); },
    async createEntity() { throw new Error('not used'); },
    async updateEntity() { throw new Error('not used'); },
    async listEntities() { return []; },
    async createEvent() { throw new Error('not used'); },
    async listEvents() { return []; },
    async rsvpEvent() { throw new Error('not used'); },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('not used'); },
    async revokeBearerToken() { throw new Error('not used'); },
    async sendDirectMessage() { throw new Error('not used'); },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return []; },
    async readDirectMessageThread() { return null; },
  };
}

test('createServer applies hardened HTTP server limits', async () => {
  const { server, shutdown } = createServer({
    repository: makeRepository(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));

    assert.equal(server.requestTimeout, DEFAULT_SERVER_LIMITS.requestTimeoutMs);
    assert.equal(server.headersTimeout, DEFAULT_SERVER_LIMITS.headersTimeoutMs);
    assert.equal(server.keepAliveTimeout, DEFAULT_SERVER_LIMITS.keepAliveTimeoutMs);
    assert.equal(server.maxRequestsPerSocket, DEFAULT_SERVER_LIMITS.maxRequestsPerSocket);
    assert.equal(server.maxHeadersCount, DEFAULT_SERVER_LIMITS.maxHeadersCount);
  } finally {
    await shutdown();
  }
});

test('createServer serves GET /updates through repository-backed update listing', async () => {
  const requestFetch = globalThis.fetch;
  let capturedInput: { actorMemberId: string; limit: number; after?: number | null } | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listMemberUpdates(input) {
      capturedInput = input;
      return {
        items: [makePendingUpdate()],
        nextAfter: 1,
        polledAt: '2026-03-14T11:05:00Z',
      };
    },
  };

  const { server, shutdown } = createServer({ repository });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/updates?limit=3&after=0`, {
      headers: {
        authorization: 'Bearer cc_live_test',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(capturedInput, {
      actorMemberId: 'member-1',
      limit: 3,
      after: 0,
    });

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.member.id, 'member-1');
    assert.equal(body.updates.items[0]?.updateId, 'update-1');
    assert.equal(body.updates.nextAfter, 1);
    assert.equal(body.updates.polledAt, '2026-03-14T11:05:00Z');
  } finally {
    await shutdown();
  }
});

test('createServer rejects GET /updates without a valid bearer token', async () => {
  const requestFetch = globalThis.fetch;
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return null;
    },
  };

  const { server, shutdown } = createServer({ repository });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/updates`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'unauthorized');
  } finally {
    await shutdown();
  }
});

test('createServer streams updates over SSE and emits heartbeats', async () => {
  const requestFetch = globalThis.fetch;
  let listCallCount = 0;
  const requestAbort = new AbortController();

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listMemberUpdates(input) {
      listCallCount += 1;

      if ((input.after ?? null) !== null) {
        return {
          items: [],
          nextAfter: input.after ?? null,
          polledAt: '2026-03-14T11:05:02Z',
        };
      }

      if (listCallCount === 1) {
        return {
          items: [],
          nextAfter: null,
          polledAt: '2026-03-14T11:05:00Z',
        };
      }

      return {
        items: [makePendingUpdate({ updateId: 'update-2', streamSeq: 2 })],
        nextAfter: 2,
        polledAt: '2026-03-14T11:05:01Z',
      };
    },
  };

  let waitCallCount = 0;
  const updatesNotifier = {
    async waitForUpdate({ signal }: { signal?: AbortSignal }) {
      waitCallCount += 1;

      if (waitCallCount === 1) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 5);
          const onAbort = () => {
            clearTimeout(timeout);
            reject(new Error('Update wait aborted'));
          };

          if (signal?.aborted) {
            onAbort();
            return;
          }

          signal?.addEventListener('abort', onAbort, { once: true });
        });

        return 'timed_out' as const;
      }

      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('Update wait aborted'));
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener('abort', onAbort, { once: true });
      });

      return 'timed_out' as const;
    },
    async close() {},
  };

  const { server, shutdown } = createServer({ repository, updatesNotifier });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/updates/stream`, {
      headers: {
        authorization: 'Bearer cc_live_test',
      },
      signal: requestAbort.signal,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = response.body?.getReader();
    assert.ok(reader, 'SSE response should expose a readable body');

    const decoder = new TextDecoder();
    let transcript = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      transcript += decoder.decode(chunk.value, { stream: true });
      if (/event: ready/.test(transcript) && /: keepalive/.test(transcript) && /"updateId":"update-2"/.test(transcript)) {
        break;
      }
    }

    assert.match(transcript, /event: ready/);
    assert.match(transcript, /: keepalive/);
    assert.match(transcript, /event: update/);
    assert.match(transcript, /"updateId":"update-2"/);

    requestAbort.abort();
    await reader.cancel().catch(() => {});
  } finally {
    requestAbort.abort();
    await shutdown();
  }
});
