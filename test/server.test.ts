import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import type { Repository } from '../src/app.ts';

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
