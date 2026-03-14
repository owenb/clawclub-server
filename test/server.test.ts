import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, DEFAULT_SERVER_LIMITS } from '../src/server.ts';
import type { Repository } from '../src/app.ts';

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
      pendingDeliveries: [],
    },
  };
}

function makeRepository(): Repository {
  return {
    async authenticateBearerToken() {
      return null;
    },
    async authenticateDeliveryWorkerToken() {
      return {
        tokenId: 'worker-token-1',
        label: 'delivery worker',
        actorMemberId: 'member-1',
        allowedNetworkIds: ['network-1'],
        metadata: {},
      };
    },
    async searchMembers() { return []; },
    async listMembers() { return []; },
    async getMemberProfile() { return null; },
    async updateOwnProfile() { throw new Error('not used'); },
    async createEntity() { throw new Error('not used'); },
    async updateEntity() { throw new Error('not used'); },
    async createEvent() { throw new Error('not used'); },
    async listEvents() { return []; },
    async rsvpEvent() { throw new Error('not used'); },
    async acknowledgeDelivery() { throw new Error('not used'); },
    async listDeliveries() { return []; },
    async retryDelivery() { throw new Error('not used'); },
    async claimNextDelivery() {
      return {
        delivery: {
          deliveryId: 'delivery-1',
          networkId: 'network-1',
          recipientMemberId: 'member-1',
          endpointId: 'endpoint-1',
          topic: 'transcript.message.created',
          payload: { hello: 'world' },
          status: 'processing',
          attemptCount: 1,
          entityId: null,
          entityVersionId: null,
          transcriptMessageId: 'message-1',
          scheduledAt: '2026-03-13T09:30:00Z',
          sentAt: null,
          failedAt: null,
          lastError: null,
          createdAt: '2026-03-13T09:29:00Z',
          acknowledgement: null,
        },
        attempt: {
          attemptId: 'attempt-1',
          deliveryId: 'delivery-1',
          networkId: 'network-1',
          endpointId: 'endpoint-1',
          workerKey: null,
          status: 'processing',
          attemptNo: 1,
          responseStatusCode: null,
          responseBody: null,
          errorMessage: null,
          startedAt: '2026-03-13T09:30:00Z',
          finishedAt: null,
          createdByMemberId: 'member-1',
        },
        endpoint: {
          endpointId: 'endpoint-1',
          memberId: 'member-1',
          channel: 'openclaw_webhook',
          label: 'Primary',
          endpointUrl: 'https://example.test/webhook',
          sharedSecretRef: 'env:CLAWCLUB_WEBHOOK_SECRET',
          state: 'active',
          lastSuccessAt: null,
          lastFailureAt: null,
          metadata: {},
          createdAt: '2026-03-13T09:29:00Z',
          disabledAt: null,
        },
      };
    },
    async completeDeliveryAttempt() {
      return {
        delivery: {
          deliveryId: 'delivery-1',
          networkId: 'network-1',
          recipientMemberId: 'member-1',
          endpointId: 'endpoint-1',
          topic: 'transcript.message.created',
          payload: { hello: 'world' },
          status: 'sent',
          attemptCount: 1,
          entityId: null,
          entityVersionId: null,
          transcriptMessageId: 'message-1',
          scheduledAt: '2026-03-13T09:30:00Z',
          sentAt: '2026-03-13T09:30:05Z',
          failedAt: null,
          lastError: null,
          createdAt: '2026-03-13T09:29:00Z',
          acknowledgement: null,
        },
        attempt: {
          attemptId: 'attempt-1', deliveryId: 'delivery-1', networkId: 'network-1', endpointId: 'endpoint-1', workerKey: null,
          status: 'sent', attemptNo: 1, responseStatusCode: 202, responseBody: 'accepted', errorMessage: null,
          startedAt: '2026-03-13T09:30:00Z', finishedAt: '2026-03-13T09:30:05Z', createdByMemberId: 'member-1',
        },
        endpoint: {
          endpointId: 'endpoint-1', memberId: 'member-1', channel: 'openclaw_webhook', label: 'Primary', endpointUrl: 'https://example.test/webhook',
          sharedSecretRef: 'env:CLAWCLUB_WEBHOOK_SECRET', state: 'active', lastSuccessAt: '2026-03-13T09:30:05Z', lastFailureAt: null, metadata: {}, createdAt: '2026-03-13T09:29:00Z', disabledAt: null,
        },
      };
    },
    async failDeliveryAttempt() { throw new Error('not used'); },
    async sendDirectMessage() { throw new Error('not used'); },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return []; },
    async readDirectMessageThread() { throw new Error('not used'); },
    async listEntities() { return []; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('not used'); },
    async revokeBearerToken() { throw new Error('not used'); },
  };
}

test('createServer wires the delivery secret resolver into deliveries.execute signing', async () => {
  const originalFetch = globalThis.fetch;
  const requestFetch = originalFetch;
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response('accepted', { status: 202 });
  }) as typeof fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    resolveDeliverySecret: async ({ sharedSecretRef }) => {
      assert.equal(sharedSecretRef, 'env:CLAWCLUB_WEBHOOK_SECRET');
      return 'super-secret';
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'deliveries.execute', input: {} }),
    });

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, 'https://example.test/webhook');
    assert.match(fetchCalls[0]?.headers['x-clawclub-signature-v1'] ?? '', /^sha256=/);
    assert.match(fetchCalls[0]?.headers['x-clawclub-signature-timestamp'] ?? '', /^202/);
  } finally {
    globalThis.fetch = originalFetch;
    await shutdown();
  }
});

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

test('createServer serves GET /updates through repository-backed polling', async () => {
  const requestFetch = globalThis.fetch;
  let capturedInput: { actorMemberId: string; accessibleNetworkIds: string[]; limit: number } | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async pollUpdates(input) {
      capturedInput = input;
      return {
        deliveries: [{
          deliveryId: 'delivery-1',
          networkId: 'network-1',
          entityId: null,
          entityVersionId: null,
          transcriptMessageId: 'message-1',
          topic: 'transcript.message.created',
          payload: { kind: 'dm', threadId: 'thread-1' },
          createdAt: '2026-03-14T11:00:00Z',
          sentAt: '2026-03-14T11:00:01Z',
        }],
        posts: [],
        polledAt: '2026-03-14T11:05:00Z',
      };
    },
  };

  const { server, shutdown } = createServer({ repository });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/updates?limit=3`, {
      headers: {
        authorization: 'Bearer cc_live_test',
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedInput, {
      actorMemberId: 'member-1',
      accessibleNetworkIds: ['network-1'],
      limit: 3,
    });

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.member.id, 'member-1');
    assert.equal(body.updates.deliveries[0]?.deliveryId, 'delivery-1');
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
