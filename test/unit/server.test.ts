import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildRootCacheKey,
  buildSkillCacheKey,
  createServer,
  DEFAULT_SERVER_LIMITS,
  resolveTrustedClientIp,
} from '../../src/server.ts';
import { DEFAULT_CONFIG_V1 } from '../../src/config/index.ts';
import type { Repository } from '../../src/repository.ts';
import { makeActivityEvent, makeAuthResult, makeNotificationItem, makeRepository, makeUpdatesNotifier } from './fixtures.ts';

async function listenOnRandomPort(server: ReturnType<typeof createServer>['server']): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

const STREAM_CAP = DEFAULT_CONFIG_V1.policy.transport.maxStreamsPerMember;

function assertContractHeaders(response: Response, expectedSchemaHash?: string): string {
  const version = response.headers.get('clawclub-version');
  const schemaHash = response.headers.get('clawclub-schema-hash');
  const exposed = response.headers.get('access-control-expose-headers') ?? '';

  assert.ok(version, 'responses should expose ClawClub-Version');
  assert.ok(schemaHash, 'responses should expose ClawClub-Schema-Hash');
  assert.match(exposed, /ClawClub-Version/);
  assert.match(exposed, /ClawClub-Schema-Hash/);

  if (expectedSchemaHash) {
    assert.equal(schemaHash, expectedSchemaHash, 'schema hash should stay stable within one process');
  }

  return schemaHash;
}

function assertStreamHasNoSchemaHandshake(response: Response): void {
  assert.equal(
    response.headers.get('clawclub-schema-hash'),
    null,
    'SSE stream responses must not expose ClawClub-Schema-Hash — the handshake is RPC-only',
  );
}

type ParsedSseEvent = {
  event: string;
  data: unknown;
  id?: string;
  rawFrame: string;
};

type TestStream = {
  abortController: AbortController;
  close: () => Promise<void>;
  closed: Promise<void>;
  events: ParsedSseEvent[];
  rawFrames: string[];
  response: Response;
  waitForClose: (timeoutMs?: number) => Promise<void>;
  waitForEvent: (event: string, occurrence?: number, timeoutMs?: number) => Promise<ParsedSseEvent>;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(`${error.name} ${error.message}`);
}

async function waitForValue<T>(fn: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) {
      return value;
    }
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function parseSseFrame(rawFrame: string): ParsedSseEvent | null {
  const lines = rawFrame.split('\n');
  let event: string | null = null;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) {
      return null;
    }
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length);
      continue;
    }
    if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length));
      continue;
    }
    if (line.startsWith('id: ')) {
      id = line.slice('id: '.length);
    }
  }

  if (!event) {
    return null;
  }

  return {
    event,
    data: dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : null,
    id,
    rawFrame: `${rawFrame}\n\n`,
  };
}

function makeBlockingUpdatesNotifier() {
  return {
    async waitForUpdate({ signal }: { signal?: AbortSignal }) {
      return new Promise<{ outcome: 'timed_out' }>((_resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    async close() {},
  };
}

async function openTestStream(port: number, token: string): Promise<TestStream> {
  const requestFetch = globalThis.fetch;
  const abortController = new AbortController();
  const response = await requestFetch(`http://127.0.0.1:${port}/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abortController.signal,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assertStreamHasNoSchemaHandshake(response);

  const reader = response.body?.getReader();
  assert.ok(reader, 'SSE response should expose a readable body');

  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  const rawFrames: string[] = [];
  let buffer = '';

  const closed = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          const tail = decoder.decode();
          if (tail.length > 0) {
            buffer += tail.replace(/\r\n/g, '\n');
          }
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let frameBreak = buffer.indexOf('\n\n');
        while (frameBreak >= 0) {
          const rawFrame = buffer.slice(0, frameBreak);
          buffer = buffer.slice(frameBreak + 2);
          if (rawFrame.length > 0) {
            const parsed = parseSseFrame(rawFrame);
            if (parsed) {
              events.push(parsed);
              rawFrames.push(parsed.rawFrame);
            }
          }
          frameBreak = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        throw error;
      }
    }
  })();

  return {
    abortController,
    response,
    events,
    rawFrames,
    closed,
    async waitForEvent(eventName, occurrence = 1, timeoutMs = 2_000) {
      return waitForValue(() => {
        const matches = events.filter((event) => event.event === eventName);
        return matches.length >= occurrence ? matches[occurrence - 1] : undefined;
      }, timeoutMs);
    },
    async waitForClose(timeoutMs = 2_000) {
      await Promise.race([
        closed,
        delay(timeoutMs).then(() => {
          throw new Error(`Timed out waiting for stream close after ${timeoutMs}ms`);
        }),
      ]);
    },
    async close() {
      abortController.abort();
      await reader.cancel().catch(() => {});
      await closed.catch(() => {});
    },
  };
}

async function assertNoStreamEvent(stream: TestStream, eventName: string, timeoutMs = 150): Promise<void> {
  const beforeCount = stream.events.filter((event) => event.event === eventName).length;
  await delay(timeoutMs);
  const afterCount = stream.events.filter((event) => event.event === eventName).length;
  assert.equal(afterCount, beforeCount, `unexpected ${eventName} event`);
}

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

test('resolveTrustedClientIp ignores spoofed X-Forwarded-For from untrusted remotes', () => {
  assert.equal(resolveTrustedClientIp({
    remoteAddress: '203.0.113.10',
    forwardedFor: '198.51.100.99',
    trustedProxyCidrs: ['10.0.0.0/8'],
  }), '203.0.113.10');
});

test('resolveTrustedClientIp honors X-Forwarded-For only from trusted proxies', () => {
  assert.equal(resolveTrustedClientIp({
    remoteAddress: '10.42.0.5',
    forwardedFor: '198.51.100.99, 10.42.0.5',
    trustedProxyCidrs: ['10.0.0.0/8'],
  }), '198.51.100.99');
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

test('createServer serves SKILL.md from slash-normalized path variants', async () => {
  const requestFetch = globalThis.fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/SKILL///`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/markdown\b/i);
    assert.match(body, /^# /m);
  } finally {
    await shutdown();
  }
});

test('createServer substitutes BASE_URL into the served skill document', async () => {
  const requestFetch = globalThis.fetch;
  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = 'https://clubs.example.test/';

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/skill`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /\{baseUrl\}/, 'served skill must not leak raw placeholders');
    assert.match(body, /POST https:\/\/clubs\.example\.test\/api\b/);
    assert.match(body, /GET https:\/\/clubs\.example\.test\/api\/schema\b/);
    assert.match(body, /GET https:\/\/clubs\.example\.test\/stream\?after=latest/);
    assert.doesNotMatch(body, /https:\/\/clubs\.example\.test\/\//, 'trailing slash on BASE_URL must be stripped so URLs do not get doubled');
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.BASE_URL;
    } else {
      process.env.BASE_URL = previousBaseUrl;
    }
    await shutdown();
  }
});

test('static response cache keys include schema-sensitive inputs', () => {
  assert.notEqual(
    buildSkillCacheKey('https://clubs.example.test', 'schema-a'),
    buildSkillCacheKey('https://clubs.example.test', 'schema-b'),
  );
  assert.notEqual(
    buildSkillCacheKey('https://clubs-a.example.test', 'schema-a'),
    buildSkillCacheKey('https://clubs-b.example.test', 'schema-a'),
  );
  assert.notEqual(
    buildRootCacheKey('schema-a'),
    buildRootCacheKey('schema-b'),
  );
});

test('createServer falls back to the socket address when BASE_URL is unset', async () => {
  const previousBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write([
          'GET /skill HTTP/1.1',
          'Host: attacker.example',
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
      });
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        raw += chunk;
      });
      socket.on('end', () => resolve(raw));
      socket.on('close', () => resolve(raw));
      socket.on('error', reject);
    });
    const body = response.split('\r\n\r\n').slice(1).join('\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.doesNotMatch(body, /\{baseUrl\}/);
    assert.doesNotMatch(body, /attacker\.example/);
    assert.match(body, new RegExp(`POST http://127\\.0\\.0\\.1:${port}/api\\b`));
    assert.match(body, new RegExp(`GET http://127\\.0\\.0\\.1:${port}/api/schema\\b`));
  } finally {
    if (previousBaseUrl !== undefined) {
      process.env.BASE_URL = previousBaseUrl;
    }
    await shutdown();
  }
});

test('createServer exposes contract headers on core routes and JSON responses', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async registerAccount() {
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-03-15T13:00:00.000Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the challenge and submit registration.',
        },
        messages: {
          summary: 'Challenge ready.',
          details: 'Solve the challenge and submit.',
        },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);

    const root = await requestFetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    const schemaHash = assertContractHeaders(root);

    const skill = await requestFetch(`http://127.0.0.1:${port}/skill`);
    assert.equal(skill.status, 200);
    assertContractHeaders(skill, schemaHash);

    const schema = await requestFetch(`http://127.0.0.1:${port}/api/schema`);
    assert.equal(schema.status, 200);
    assert.equal(assertContractHeaders(schema, schemaHash), schemaHash);
    const schemaBody = await schema.json();
    assert.equal(schemaBody.data.schemaHash, schemaHash);

    const options = await requestFetch(`http://127.0.0.1:${port}/api`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assertContractHeaders(options, schemaHash);

    const postOk = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'accounts.register',
        input: { mode: 'discover' },
      }),
    });
    assert.equal(postOk.status, 200);
    assertContractHeaders(postOk, schemaHash);

    const postErr = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'accounts.register',
        input: { mode: 'discover' },
      }),
    });
    assert.equal(postErr.status, 200);
    assertContractHeaders(postErr, schemaHash);
  } finally {
    await shutdown();
  }
});

test('createServer returns 405 for recognized routes with the wrong method', async () => {
  const requestFetch = globalThis.fetch;
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);

    const api = await requestFetch(`http://127.0.0.1:${port}/api`, { method: 'PATCH' });
    const apiBody = await api.json();
    assert.equal(api.status, 405);
    assert.equal(api.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(apiBody.error.code, 'method_not_allowed');

    const schema = await requestFetch(`http://127.0.0.1:${port}/api/schema`, { method: 'POST' });
    const schemaBody = await schema.json();
    assert.equal(schema.status, 405);
    assert.equal(schema.headers.get('allow'), 'GET, OPTIONS');
    assert.equal(schemaBody.error.code, 'method_not_allowed');

    const unknown = await requestFetch(`http://127.0.0.1:${port}/unknown`, { method: 'PATCH' });
    const unknownBody = await unknown.json();
    assert.equal(unknown.status, 404);
    assert.equal(unknownBody.error.code, 'not_found');
  } finally {
    await shutdown();
  }
});

test('createServer rate-limits bootstrap schema and skill routes with JSON errors', async () => {
  const requestFetch = globalThis.fetch;
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    let schemaResponse: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      schemaResponse = await requestFetch(`http://127.0.0.1:${port}/api/schema`);
    }
    assert.equal(schemaResponse?.status, 429);
    assert.equal(schemaResponse?.headers.get('retry-after'), '60');
    const schemaBody = await schemaResponse!.json();
    assert.equal(schemaBody.error.code, 'rate_limited');

    let skillResponse: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      skillResponse = await requestFetch(`http://127.0.0.1:${port}/skill`);
    }
    assert.equal(skillResponse?.status, 429);
    assert.equal(skillResponse?.headers.get('retry-after'), '60');
    const skillBody = await skillResponse!.json();
    assert.equal(skillBody.error.code, 'rate_limited');
  } finally {
    await shutdown();
  }
});

test('createServer accepts unauthenticated accounts.register discover over POST /api', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async registerAccount() {
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-03-15T13:00:00.000Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the challenge and submit registration.',
        },
        messages: {
          summary: 'Challenge ready.',
          details: 'Solve the challenge and submit.',
        },
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
        action: 'accounts.register',
        input: { mode: 'discover' },
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'accounts.register');
    assert.equal(body.data.phase, 'proof_required');
    assert.equal(body.data.challenge.challengeId, 'challenge-1');
    assert.equal('actor' in body, false);
  } finally {
    await shutdown();
  }
});

test('createServer returns authenticated envelope for clubs.apply', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async applyToClub() {
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'test',
          clubName: 'Test',
          clubSummary: null,
          admissionPolicy: 'Tell us why you fit.',
          submissionPath: 'cold' as const,
          sponsorName: null,
          phase: 'awaiting_review' as const,
          submittedAt: '2026-03-15T13:00:00.000Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@j',
          application: 'test',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
          applicationId: 'application-1',
        },
        roadmap: [],
        feedback: null,
        applicationLimits: {
          inFlightCount: 1,
          maxInFlight: 3,
        },
        messages: {
          summary: 'Queued.',
          details: 'Awaiting review.',
        },
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
        authorization: 'Bearer cc_live_test',
      },
      body: JSON.stringify({
        action: 'clubs.apply',
        input: {
          clubSlug: 'test',
          draft: {
            name: 'Jane Doe',
            socials: '@j',
            application: 'test',
          },
          clientKey: 'apply-1',
        },
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'clubs.apply');
    assert.equal(body.data.application.phase, 'awaiting_review');
    assert.equal(body.actor.member.id, 'member-1');
  } finally {
    await shutdown();
  }
});

test('createServer lets a zero-membership bearer poll updates.list without club scope', async () => {
  const requestFetch = globalThis.fetch;
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    memberships: [],
  };
  auth.requestScope = { requestedClubId: null, activeClubIds: [] };

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? auth : null;
    },
    async listNotifications() {
      return {
        items: [],
        nextCursor: null,
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
        authorization: 'Bearer cc_live_test',
      },
      body: JSON.stringify({
        action: 'updates.list',
        input: {},
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'updates.list');
    assert.deepEqual(body.actor.activeMemberships, []);
    assert.deepEqual(body.data.activity.results, []);
    assert.equal(body.actor.member.id, 'member-1');
  } finally {
    await shutdown();
  }
});

test('createServer rejects club-scoped polling for a bearer holder who is not a member of that club', async () => {
  const requestFetch = globalThis.fetch;
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    memberships: [],
  };
  auth.requestScope = { requestedClubId: null, activeClubIds: [] };
  let activityCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? auth : null;
    },
    async listClubActivity() {
      activityCalls += 1;
      return { items: [], highWaterMark: 0, hasMore: false };
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
        authorization: 'Bearer cc_live_test',
      },
      body: JSON.stringify({
        action: 'updates.list',
        input: {
          clubId: 'club-1',
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'forbidden_scope');
    assert.equal(activityCalls, 0);
  } finally {
    await shutdown();
  }
});

test('createServer enforces request body limits by byte size, not decoded string length', async () => {
  const requestFetch = globalThis.fetch;
  let registerCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async registerAccount() {
      registerCalls += 1;
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-03-15T13:00:00.000Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the challenge and submit registration.',
        },
        messages: {
          summary: 'Challenge ready.',
          details: 'Solve the challenge and submit.',
        },
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
      action: 'accounts.register',
      input: { mode: 'discover', clientKey: 'register-1', padding: oversizedPayload },
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
    assert.equal(registerCalls, 0);
  } finally {
    await shutdown();
  }
});

test('createServer closes the socket after a payload_too_large response', async () => {
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const oversizedPayload = '😀'.repeat(300_000);
    const body = JSON.stringify({
      action: 'accounts.register',
      input: { mode: 'discover', clientKey: 'register-close-1', padding: oversizedPayload },
    });

    const rawResponse = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const maybeFinishAfterSocketError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
          fail(error);
          return;
        }
        setTimeout(() => {
          if (response.length > 0) {
            finish(response);
            return;
          }
          fail(error);
        }, 10);
      };
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write([
          'POST /api HTTP/1.1',
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
          '',
          body,
        ].join('\r\n'), (error) => {
          if (error) maybeFinishAfterSocketError(error as NodeJS.ErrnoException);
        });
      });
      let response = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        response += chunk;
      });
      socket.on('end', () => finish(response));
      socket.on('close', () => {
        if (response.length > 0) finish(response);
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        maybeFinishAfterSocketError(error);
      });
    });

    assert.match(rawResponse, /^HTTP\/1\.1 413 Payload Too Large/m);
    assert.match(rawResponse, /\r\nconnection: close\r\n/i);
    assert.match(rawResponse, /"code":"payload_too_large"/);
  } finally {
    await shutdown();
  }
});

test('createServer clientError writes JSON with ClawClub headers', async () => {
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  const writes: string[] = [];
  const socket = {
    writable: true,
    end(chunk?: string) {
      writes.push(chunk ?? '');
    },
    destroy() {},
  };

  try {
    await listenOnRandomPort(server);
    server.emit('clientError', new Error('malformed'), socket as never);
    const response = writes.join('');
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/m);
    assert.match(response, /\r\nContent-Type: application\/json; charset=utf-8\r\n/);
    assert.match(response, /\r\nClawClub-Version: /);
    assert.match(response, /\r\nClawClub-Schema-Hash: /);
    assert.match(response, /\r\nConnection: close\r\n/);
    assert.match(response, /"code":"invalid_input"/);
  } finally {
    await shutdown();
  }
});

test('createServer streams ready, activity, and keepalive frames over SSE', async () => {
  const requestFetch = globalThis.fetch;
  let activityListCallCount = 0;
  const requestAbort = new AbortController();

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listClubActivity(input) {
      activityListCallCount += 1;

      if ((input.afterSeq ?? null) === null) {
        return {
          items: [],
          highWaterMark: 1,
          hasMore: false,
        };
      }

      if (activityListCallCount === 2) {
        return {
          items: [makeActivityEvent({ activityId: 'activity-2', seq: 2 })],
          highWaterMark: 2,
          hasMore: false,
        };
      }

      return {
        items: [],
        highWaterMark: input.afterSeq ?? 2,
        hasMore: false,
      };
    },
    async listNotifications() {
      return {
        items: [makeNotificationItem({ notificationId: 'notification-2', seq: 2 })],
        nextCursor: 'cursor-next',
      };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
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

        return { outcome: 'timed_out' } as const;
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

      return { outcome: 'timed_out' } as const;
    },
    async close() {},
  };

  const { server, shutdown } = createServer({ repository, updatesNotifier });

  try {
    const port = await listenOnRandomPort(server);

    const response = await requestFetch(`http://127.0.0.1:${port}/stream`, {
      headers: {
        authorization: 'Bearer cc_live_test',
      },
      signal: requestAbort.signal,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assertStreamHasNoSchemaHandshake(response);

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
      if (/event: ready/.test(transcript) && /: keepalive/.test(transcript) && /event: activity/.test(transcript)) {
        break;
      }
    }

    assert.match(transcript, /event: ready/);
    assert.match(transcript, /"notificationsTruncated":true/);
    assert.match(transcript, /"activityCursor":"[A-Za-z0-9_-]+={0,2}"/);
    assert.match(transcript, /event: activity/);
    assert.match(transcript, /"activityId":"activity-2"/);
    assert.match(transcript, /: keepalive/);

    requestAbort.abort();
    await reader.cancel().catch(() => {});
  } finally {
    requestAbort.abort();
    await shutdown();
  }
});

test('createServer accepts missing, empty, and matching ClawClub-Schema-Seen headers', async () => {
  const requestFetch = globalThis.fetch;

  const repository: Repository = {
    ...makeRepository(),
    async registerAccount() {
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-03-15T13:00:00.000Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the challenge and submit registration.',
        },
        messages: {
          summary: 'Challenge ready.',
          details: 'Solve the challenge and submit.',
        },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const schemaResponse = await requestFetch(`http://127.0.0.1:${port}/api/schema`);
    assert.equal(schemaResponse.status, 200);
    const schemaHash = assertContractHeaders(schemaResponse);

    for (const headerValue of [undefined, '', schemaHash]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (headerValue !== undefined) {
        headers['clawclub-schema-seen'] = headerValue;
      }

      const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'accounts.register',
          input: { mode: 'discover' },
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assertContractHeaders(response, schemaHash);
      assert.equal(body.ok, true);
    }
  } finally {
    await shutdown();
  }
});

test('createServer returns stale_client when ClawClub-Schema-Seen mismatches', async () => {
  const requestFetch = globalThis.fetch;
  let registerCalls = 0;

  const repository: Repository = {
    ...makeRepository(),
    async registerAccount() {
      registerCalls += 1;
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-03-15T13:00:00.000Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the challenge and submit registration.',
        },
        messages: {
          summary: 'Challenge ready.',
          details: 'Solve the challenge and submit.',
        },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'clawclub-schema-seen': 'stale-schema-hash',
      },
      body: JSON.stringify({
        action: 'accounts.register',
        input: { mode: 'discover', clientKey: 'register-1' },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assertContractHeaders(response);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'stale_client');
    assert.match(body.error.message, /GET \/api\/schema/);
    assert.match(body.error.message, /GET \/skill/);
    assert.equal(registerCalls, 0, 'stale_client should short-circuit before dispatch');
  } finally {
    await shutdown();
  }
});

test('createServer checks stale_client before parsing JSON bodies', async () => {
  const requestFetch = globalThis.fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'clawclub-schema-seen': 'stale-schema-hash',
      },
      body: '{"action":"accounts.register","input":',
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'stale_client');
    assert.match(body.error.message, /GET \/api\/schema/);
    assert.match(body.error.message, /GET \/skill/);
  } finally {
    await shutdown();
  }
});

test('createServer does not gate recovery endpoints on ClawClub-Schema-Seen', async () => {
  const requestFetch = globalThis.fetch;
  const requestAbort = new AbortController();

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const updatesNotifier = {
    async waitForUpdate({ signal }: { signal?: AbortSignal }) {
      return new Promise<{ outcome: 'timed_out' }>((_, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('aborted'));
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

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
    const port = await listenOnRandomPort(server);

    const schemaResponse = await requestFetch(`http://127.0.0.1:${port}/api/schema`, {
      headers: { 'clawclub-schema-seen': 'stale-schema-hash' },
    });
    assert.equal(schemaResponse.status, 200);
    assertContractHeaders(schemaResponse);

    const skillResponse = await requestFetch(`http://127.0.0.1:${port}/skill`, {
      headers: { 'clawclub-schema-seen': 'stale-schema-hash' },
    });
    assert.equal(skillResponse.status, 200);
    assertContractHeaders(skillResponse);

    const streamResponse = await requestFetch(`http://127.0.0.1:${port}/stream`, {
      headers: {
        authorization: 'Bearer cc_live_test',
        'clawclub-schema-seen': 'stale-schema-hash',
      },
      signal: requestAbort.signal,
    });
    assert.equal(streamResponse.status, 200);
    assertStreamHasNoSchemaHandshake(streamResponse);
    const reader = streamResponse.body?.getReader();
    await reader?.read();
    requestAbort.abort();
    await reader?.cancel().catch(() => {});
  } finally {
    requestAbort.abort();
    await shutdown();
  }
});

test('createServer evicts the oldest stream when a member opens cap+1 connections', async () => {
  const requestFetch = globalThis.fetch;
  const cap = STREAM_CAP;
  const streams: TestStream[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap; i += 1) {
      const stream = await openTestStream(port, 'cc_live_test');
      await stream.waitForEvent('ready');
      streams.push(stream);
    }

    const newest = await openTestStream(port, 'cc_live_test');
    await newest.waitForEvent('ready');

    const closed = await streams[0].waitForEvent('closed');
    assert.deepEqual(closed.data, {
      reason: 'superseded',
      message: `This /stream was closed because a newer connection from the same member reached the ${STREAM_CAP}-concurrent-stream cap for this account. The newest connection always wins - close unused /stream connections to keep older ones alive.`,
    });
    await streams[0].waitForClose();
    assert.equal(streams[0].events.filter((event) => event.event === 'closed').length, 1);

    for (const stream of streams.slice(1)) {
      await assertNoStreamEvent(stream, 'closed');
    }
    await assertNoStreamEvent(newest, 'closed');

    streams.push(newest);
  } finally {
    for (const stream of streams) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer natural stream closure frees a slot without evicting another stream', async () => {
  const cap = STREAM_CAP;
  const streams: TestStream[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap; i += 1) {
      const stream = await openTestStream(port, 'cc_live_test');
      await stream.waitForEvent('ready');
      streams.push(stream);
    }

    await streams[0].close();
    await delay(50);

    const replacement = await openTestStream(port, 'cc_live_test');
    await replacement.waitForEvent('ready');

    for (const stream of streams.slice(1)) {
      await assertNoStreamEvent(stream, 'closed');
    }
    await assertNoStreamEvent(replacement, 'closed');

    streams.push(replacement);
  } finally {
    for (const stream of streams.slice(1)) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer isolates oldest-first eviction per member', async () => {
  const cap = STREAM_CAP;
  const memberAStreams: TestStream[] = [];
  const memberBStreams: TestStream[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      if (token === 'cc_live_a') {
        return makeAuthResult({ memberId: 'member-a', publicName: 'Member A' });
      }
      if (token === 'cc_live_b') {
        return makeAuthResult({ memberId: 'member-b', publicName: 'Member B' });
      }
      return null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap; i += 1) {
      const streamA = await openTestStream(port, 'cc_live_a');
      await streamA.waitForEvent('ready');
      memberAStreams.push(streamA);

      const streamB = await openTestStream(port, 'cc_live_b');
      await streamB.waitForEvent('ready');
      memberBStreams.push(streamB);
    }

    const newestA = await openTestStream(port, 'cc_live_a');
    await newestA.waitForEvent('ready');

    const closed = await memberAStreams[0].waitForEvent('closed');
    assert.equal((closed.data as { reason: string }).reason, 'superseded');
    await memberAStreams[0].waitForClose();

    for (const stream of memberAStreams.slice(1)) {
      await assertNoStreamEvent(stream, 'closed');
    }
    for (const stream of memberBStreams) {
      await assertNoStreamEvent(stream, 'closed');
    }
    await assertNoStreamEvent(newestA, 'closed');

    memberAStreams.push(newestA);
  } finally {
    for (const stream of memberAStreams) {
      await stream.close();
    }
    for (const stream of memberBStreams) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer does not track a failed stream open as an active slot', async () => {
  const requestFetch = globalThis.fetch;
  const cap = STREAM_CAP;
  const streams: TestStream[] = [];
  const originalConsoleError = console.error;
  let failNextNotificationSeed = false;

  console.error = () => {};

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      if (token === 'cc_live_test') {
        return makeAuthResult({ memberId: 'member-1' });
      }
      if (token === 'cc_live_broken') {
        failNextNotificationSeed = true;
        return makeAuthResult({ memberId: 'member-1' });
      }
      return null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      if (failNextNotificationSeed) {
        failNextNotificationSeed = false;
        throw new Error('seed failure');
      }
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap - 1; i += 1) {
      const stream = await openTestStream(port, 'cc_live_test');
      await stream.waitForEvent('ready');
      streams.push(stream);
    }

    const failed = await requestFetch(`http://127.0.0.1:${port}/stream`, {
      headers: { authorization: 'Bearer cc_live_broken' },
    });
    const failedBody = await failed.json();
    assert.equal(failed.status, 500);
    assert.equal(failedBody.error.code, 'internal_error');

    const replacement = await openTestStream(port, 'cc_live_test');
    await replacement.waitForEvent('ready');

    for (const stream of streams) {
      await assertNoStreamEvent(stream, 'closed');
    }
    await assertNoStreamEvent(replacement, 'closed');

    streams.push(replacement);
  } finally {
    console.error = originalConsoleError;
    for (const stream of streams) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer logs server_request_error with action and authenticated member context', async () => {
  const requestFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const errorLines: string[] = [];

  console.error = (line?: unknown) => {
    errorLines.push(String(line));
  };

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult({ memberId: 'member-500' }) : null;
    },
    async listMembers() {
      throw new Error('boom');
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer cc_live_test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'members.list',
        input: {
          clubId: 'club-1',
          limit: 1,
        },
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'internal_error');

    const serverErrorLine = errorLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === 'server_request_error');
    assert.ok(serverErrorLine, 'expected server_request_error log line');
    assert.equal(serverErrorLine.actionName, 'members.list');
    assert.equal(serverErrorLine.memberId, 'member-500');
  } finally {
    console.error = originalConsoleError;
    await shutdown();
  }
});

test('createServer rejects repositories without request-log support', () => {
  assert.throws(
    () => createServer({
      repository: {
        ...makeRepository(),
        logApiRequest: undefined,
      } as unknown as Repository,
    }),
    /Repository must implement logApiRequest/,
  );
});

test('createServer emits a well-formed closed SSE frame when it evicts a healthy stream', async () => {
  const cap = STREAM_CAP;
  const streams: TestStream[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap; i += 1) {
      const stream = await openTestStream(port, 'cc_live_test');
      await stream.waitForEvent('ready');
      streams.push(stream);
    }

    const newest = await openTestStream(port, 'cc_live_test');
    await newest.waitForEvent('ready');

    const closed = await streams[0].waitForEvent('closed');
    assert.match(closed.rawFrame, /^event: closed\n/m);
    assert.match(closed.rawFrame, /\ndata: \{"reason":"superseded","message":".+"\}\n\n$/);
    const dataLine = closed.rawFrame.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'closed frame should include a data line');
    assert.deepEqual(JSON.parse(dataLine.slice('data: '.length)), closed.data);

    streams.push(newest);
  } finally {
    for (const stream of streams) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer logs a stream_evicted line when it supersedes an older stream', async () => {
  const cap = STREAM_CAP;
  const streams: TestStream[] = [];
  const originalConsoleLog = console.log;
  const logLines: string[] = [];

  console.log = (...args: unknown[]) => {
    logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult({ memberId: 'member-1' }) : null;
    },
    async listClubActivity() {
      return { items: [], highWaterMark: 0, hasMore: false };
    },
    async listNotifications() {
      return { items: [], nextCursor: null };
    },
    async listInboxSince() {
      return { frames: [], highWaterMark: 0 };
    },
  };
  const { server, shutdown } = createServer({ repository, updatesNotifier: makeBlockingUpdatesNotifier() });

  try {
    const port = await listenOnRandomPort(server);

    for (let i = 0; i < cap; i += 1) {
      const stream = await openTestStream(port, 'cc_live_test');
      await stream.waitForEvent('ready');
      streams.push(stream);
    }

    const newest = await openTestStream(port, 'cc_live_test');
    await newest.waitForEvent('ready');
    await streams[0].waitForEvent('closed');
    await waitForValue(() => logLines.find((line) => line.includes('"kind":"stream_evicted"')), 2_000);

    const evictionLog = logLines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.kind === 'stream_evicted');

    assert.ok(evictionLog, 'should log a stream_evicted line');
    assert.equal(evictionLog.memberId, 'member-1');
    assert.equal(typeof evictionLog.evictedId, 'string');
    assert.match(String(evictionLog.openedAt), /^\d{4}-\d{2}-\d{2}T/);

    streams.push(newest);
  } finally {
    console.log = originalConsoleLog;
    for (const stream of streams) {
      await stream.close();
    }
    await shutdown();
  }
});

test('createServer schema advertises the shared stream cap and closed event', async () => {
  const requestFetch = globalThis.fetch;

  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/api/schema`);
    const body = await response.json();

    assert.equal(response.status, 200);
    const transport = body.data.transport as Record<string, unknown>;
    const stream = transport.stream as Record<string, unknown>;
    const events = stream.events as Record<string, unknown>;
    const closed = events.closed as Record<string, unknown>;
    const errorCodes = transport.transportErrorCodes as Array<Record<string, unknown>>;
    const codes = errorCodes.map((entry) => entry.code);

    assert.equal(stream.maxConcurrentStreamsPerMember, STREAM_CAP);
    assert.equal(closed.type, 'object');
    const closedProperties = closed.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(closed.required, ['reason', 'message']);
    assert.deepEqual(closedProperties.reason.enum, ['superseded']);
    assert.equal(closedProperties.message.type, 'string');
    assert.equal(closedProperties.message.minLength, 1);
    assert.equal(codes.includes('too_many_streams'), false);
  } finally {
    await shutdown();
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

test('createServer rejects malformed Authorization headers distinctly', async () => {
  const requestFetch = globalThis.fetch;
  const { server, shutdown } = createServer({
    repository: makeRepository(),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const response = await requestFetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Token cc_live_test',
      },
      body: JSON.stringify({ action: 'session.getContext', input: {} }),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'invalid_auth_header');
  } finally {
    await shutdown();
  }
});

test('producer notification endpoints use the canonical response envelope', async () => {
  const requestFetch = globalThis.fetch;
  const { server, shutdown } = createServer({
    repository: makeRepository({
      async authenticateProducer(input) {
        assert.equal(input.producerId, 'producer-1');
        assert.equal(input.secret, 'producer-secret');
        return { producerId: 'producer-1', status: 'active' };
      },
      async deliverProducerNotifications() {
        return [{ notificationId: 'notification-1', outcome: 'delivered' }];
      },
      async acknowledgeProducerNotifications() {
        return [{ notificationId: 'notification-1', outcome: 'acknowledged' }];
      },
    }),
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    const port = await listenOnRandomPort(server);
    const headers = {
      'content-type': 'application/json',
      'x-clawclub-producer-id': 'producer-1',
      authorization: 'Bearer producer-secret',
    };
    const deliver = await requestFetch(`http://127.0.0.1:${port}/internal/notifications/deliver`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        notifications: [{
          topic: 'test.topic',
          recipientMemberId: 'member-1',
          payloadVersion: 1,
          payload: {},
        }],
      }),
    });
    const deliverBody = await deliver.json();
    assert.equal(deliver.status, 200);
    assert.equal(deliverBody.ok, true);
    assert.deepEqual(deliverBody.data.results, [{ notificationId: 'notification-1', outcome: 'delivered' }]);
    assert.equal('results' in deliverBody, false);

    const acknowledge = await requestFetch(`http://127.0.0.1:${port}/internal/notifications/acknowledge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ notificationIds: ['notification-1'] }),
    });
    const acknowledgeBody = await acknowledge.json();
    assert.equal(acknowledge.status, 200);
    assert.equal(acknowledgeBody.ok, true);
    assert.deepEqual(acknowledgeBody.data.results, [{ notificationId: 'notification-1', outcome: 'acknowledged' }]);
    assert.equal('results' in acknowledgeBody, false);

    const invalid = await requestFetch(`http://127.0.0.1:${port}/internal/notifications/deliver`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ notifications: [{ topic: 'missing-fields' }] }),
    });
    const invalidBody = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.error.code, 'invalid_input');
    assert.deepEqual(invalidBody.error.requestTemplate, { notifications: '(array, max 100)' });
  } finally {
    await shutdown();
  }
});
