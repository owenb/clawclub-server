import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, DEFAULT_SERVER_LIMITS } from '../../src/server.ts';
import type { Repository } from '../../src/contract.ts';
import { makeAuthResult, makePendingUpdate, makeRepository, makeUpdatesNotifier } from './fixtures.ts';

test('createServer applies hardened HTTP server limits', async () => {
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
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

test('createServer serves SKILL.md from uppercase path variants', async () => {
  const requestFetch = globalThis.fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/SKILL.md`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/markdown\b/i);
    assert.match(body, /^# /m);
  } finally {
    await shutdown();
  }
});

test('createServer accepts unauthenticated cold application actions over POST /api', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async createAdmissionChallenge() {
      return {
        challengeId: 'challenge-1',
        difficulty: 7,
        expiresAt: '2026-03-15T13:00:00.000Z',
        maxAttempts: 5,
        club: { slug: 'test', name: 'Test', summary: null, ownerName: 'Owner', admissionPolicy: 'Tell us about yourself.' },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'admissions.public.requestChallenge',
        input: { clubSlug: 'test' },
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'admissions.public.requestChallenge');
    assert.equal(body.data.challengeId, 'challenge-1');
    assert.equal(body.data.difficulty, 7);
    assert.equal(body.data.maxAttempts, 5);
    assert.equal(body.data.club.slug, 'test');
    assert.equal('actor' in body, false);
  } finally {
    await shutdown();
  }
});

test('createServer returns accepted for admissions.public.submitApplication', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() {
      return { status: 'accepted', message: 'Submitted.' };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'admissions.public.submitApplication',
        input: {
          challengeId: 'challenge-1', nonce: '12345',
          name: 'Jane Doe', email: 'j@x.com',
          socials: '@j', application: 'test',
        },
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.status, 'accepted');
  } finally {
    await shutdown();
  }
});

test('createServer rate limits cold application actions per IP and per action', async () => {
  const requestFetch = globalThis.fetch;
  let challengeCalls = 0;
  let solveCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async createAdmissionChallenge() {
      challengeCalls += 1;
      return {
        challengeId: `challenge-${challengeCalls}`,
        difficulty: 7,
        expiresAt: '2026-03-15T13:00:00.000Z',
        maxAttempts: 5,
        club: { slug: 'test', name: 'Test', summary: null, ownerName: 'Owner', admissionPolicy: 'Policy.' },
      };
    },
    async solveAdmissionChallenge() {
      solveCalls += 1;
      return { status: 'accepted' as const, message: 'Submitted.' };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
    coldAdmissionRateLimits: {
      'admissions.public.requestChallenge': { limit: 1, windowMs: 60_000 },
      'admissions.public.submitApplication': { limit: 1, windowMs: 60_000 },
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const challengeInput = {
      action: 'admissions.public.requestChallenge',
      input: { clubSlug: 'test' },
    };

    const firstChallenge = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(challengeInput),
    });
    assert.equal(firstChallenge.status, 200);

    const secondChallenge = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(challengeInput),
    });
    const secondChallengeBody = await secondChallenge.json();
    assert.equal(secondChallenge.status, 429);
    assert.equal(secondChallengeBody.ok, false);
    assert.equal(secondChallengeBody.error.code, 'rate_limited');

    const solveResponse = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'admissions.public.submitApplication',
        input: {
          challengeId: 'challenge-1',
          nonce: '123456',
          name: 'Jane Doe',
          email: 'jane@example.com',
          socials: '@jane',
          application: 'I want to join',
        },
      }),
    });
    const solveBody = await solveResponse.json();
    assert.equal(solveResponse.status, 200);
    assert.equal(solveBody.ok, true);
    assert.equal(challengeCalls, 1);
    assert.equal(solveCalls, 1);
  } finally {
    await shutdown();
  }
});

test('createServer enforces request body limits by byte size, not decoded string length', async () => {
  const requestFetch = globalThis.fetch;
  let challengeCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async createAdmissionChallenge() {
      challengeCalls += 1;
      return {
        challengeId: 'challenge-1',
        difficulty: 7,
        expiresAt: '2026-03-15T13:00:00.000Z',
        maxAttempts: 5,
        club: { slug: 'test', name: 'Test', summary: null, ownerName: 'Owner', admissionPolicy: 'Policy.' },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const oversizedPayload = '😀'.repeat(300_000);
    const body = JSON.stringify({
      action: 'admissions.public.requestChallenge',
      input: { clubSlug: 'test', padding: oversizedPayload },
    });

    assert.ok(body.length < DEFAULT_SERVER_LIMITS.maxBodyBytes);
    assert.ok(Buffer.byteLength(body, 'utf8') > DEFAULT_SERVER_LIMITS.maxBodyBytes);

    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const responseBody = await response.json();

    assert.equal(response.status, 413);
    assert.equal(responseBody.ok, false);
    assert.equal(responseBody.error.code, 'payload_too_large');
    assert.equal(challengeCalls, 0);
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
        nextAfter: 'cursor-2',
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

test('createServer rejects SSE stream when per-member connection cap is reached', async () => {
  const requestFetch = globalThis.fetch;
  const abortControllers: AbortController[] = [];
  let waitBlocked = false;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listMemberUpdates() {
      return { items: [], nextAfter: null, polledAt: '2026-03-14T11:05:00Z' };
    },
  };

  const updatesNotifier = {
    async waitForUpdate({ signal }: { signal?: AbortSignal }) {
      waitBlocked = true;
      return new Promise<'timed_out' | 'notified'>((resolve, reject) => {
        const onAbort = () => { reject(new Error('aborted')); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    async close() {},
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier,
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    for (let i = 0; i < 3; i++) {
      const abort = new AbortController();
      abortControllers.push(abort);
      const res = await requestFetch(`http://127.0.0.1:${port}/updates/stream`, {
        headers: { authorization: 'Bearer cc_live_test' },
        signal: abort.signal,
      });
      assert.equal(res.status, 200);
    }

    const extraAbort = new AbortController();
    const extraResponse = await requestFetch(`http://127.0.0.1:${port}/updates/stream`, {
      headers: { authorization: 'Bearer cc_live_test' },
      signal: extraAbort.signal,
    });
    const body = await extraResponse.json();
    assert.equal(extraResponse.status, 429);
    assert.equal(body.error.code, 'too_many_streams');
    extraAbort.abort();
  } finally {
    for (const abort of abortControllers) {
      abort.abort();
    }
    await shutdown();
  }
});

test('createServer uses x-forwarded-for only when trustProxy is enabled', async () => {
  const requestFetch = globalThis.fetch;
  let challengeCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async createAdmissionChallenge() {
      challengeCalls += 1;
      return {
        challengeId: `challenge-${challengeCalls}`, difficulty: 7, expiresAt: '2026-03-15T13:00:00.000Z',
        maxAttempts: 5, club: { slug: 'test', name: 'Test', summary: null, ownerName: 'Owner', admissionPolicy: 'Policy.' },
      };
    },
  };

  const { server: serverNoProxy, shutdown: shutdownNoProxy } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
    coldAdmissionRateLimits: { 'admissions.public.requestChallenge': { limit: 1, windowMs: 60_000 }, 'admissions.public.submitApplication': { limit: 1, windowMs: 60_000 } },
    trustProxy: false,
  });

  try {
    await new Promise<void>((resolve) => serverNoProxy.listen(0, resolve));
    const address = serverNoProxy.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const body = JSON.stringify({ action: 'admissions.public.requestChallenge', input: { clubSlug: 'test' } });

    await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body,
    });

    const secondRes = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.6.7.8' },
      body,
    });
    const secondBody = await secondRes.json();

    assert.equal(secondRes.status, 429, 'Without trustProxy, different X-Forwarded-For should still be rate limited by socket IP');
    assert.equal(secondBody.error.code, 'rate_limited');
  } finally {
    await shutdownNoProxy();
  }
});

test('createServer rejects POST /api with wrong content-type and accepts charset variants', async () => {
  const requestFetch = globalThis.fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const wrongContentType = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'session.getContext', input: {} }),
    });
    const wrongCtBody = await wrongContentType.json();
    assert.equal(wrongContentType.status, 415);
    assert.equal(wrongCtBody.ok, false);
    assert.equal(wrongCtBody.error.code, 'unsupported_media_type');

    const jsonpType = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify({ action: 'session.getContext', input: {} }),
    });
    assert.equal(jsonpType.status, 415, 'application/jsonp must not be accepted');

    const withCharset = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ action: 'session.getContext', input: {} }),
    });
    assert.notEqual(withCharset.status, 415, 'application/json with charset should not be rejected as unsupported media type');
  } finally {
    await shutdown();
  }
});
