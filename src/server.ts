import http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { AppError, type Repository } from './contract.ts';
import { buildDispatcher, type QualityGateFn } from './dispatch.ts';
import { getAction, generateRequestTemplate, GENERIC_REQUEST_TEMPLATE } from './schemas/registry.ts';
import { createPostgresMemberUpdateNotifier, type MemberUpdateNotifier } from './member-updates-notifier.ts';
import { createRepository } from './postgres.ts';
import { getSchemaPayload } from './schema-endpoint.ts';

const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

const SKILL_MD_RAW: string = readFileSync(
  new URL('../SKILL.md', import.meta.url), 'utf-8',
);

// Strip the static frontmatter and prepend a dynamic one with version metadata.
const SKILL_MD_BODY: string = SKILL_MD_RAW.replace(/^---\n[\s\S]*?\n---\n/, '');
const SKILL_MD: string = [
  '---',
  'name: clawclub',
  'description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; sponsor someone for admission; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.',
  'license: MIT',
  'metadata:',
  '  author: clawclub.social',
  `  version: "${PACKAGE_VERSION}"`,
  '---',
  '',
].join('\n') + SKILL_MD_BODY;

type ColdAdmissionAction = 'admissions.public.requestChallenge' | 'admissions.public.submitApplication';
type FixedWindowRateLimit = { limit: number; windowMs: number };
type FixedWindowRateLimitState = { count: number; resetAt: number };

export const DEFAULT_SERVER_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  requestTimeoutMs: 20_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  maxHeadersCount: 100,
  updatesStreamHeartbeatMs: 15_000,
  updatesStreamLimit: 20,
  maxStreamsPerMember: 3,
} as const;

export const DEFAULT_COLD_APPLICATION_RATE_LIMITS: Record<ColdAdmissionAction, FixedWindowRateLimit> = {
  'admissions.public.requestChallenge': {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  },
  'admissions.public.submitApplication': {
    limit: 30,
    windowMs: 60 * 60 * 1000,
  },
} as const;

function readJsonBody(
  request: http.IncomingMessage,
  maxBodyBytes = DEFAULT_SERVER_LIMITS.maxBodyBytes,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };

    const resolveOnce = (value: Record<string, unknown>) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;

      if (totalBytes > maxBodyBytes) {
        request.pause();
        rejectOnce(new AppError(413, 'payload_too_large', 'Request body exceeded 1MB'));
        request.resume();
        return;
      }

      chunks.push(buffer);
    };

    const onEnd = () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (body.trim().length === 0) {
        resolveOnce({});
        return;
      }

      try {
        const parsed = JSON.parse(body);

        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          rejectOnce(new AppError(400, 'invalid_json', 'Request body must be a JSON object'));
          return;
        }

        resolveOnce(parsed as Record<string, unknown>);
      } catch {
        rejectOnce(new AppError(400, 'invalid_json', 'Request body must be valid JSON'));
      }
    };

    const onError = (error: Error) => {
      rejectOnce(error);
    };

    const onAborted = () => {
      rejectOnce(new Error('Request body was aborted'));
    };

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

function getBearerToken(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization;

  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizeUpdatesLimit(value: string | null): number {
  if (value === null || value.trim().length === 0) {
    return 10;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new AppError(400, 'invalid_input', 'limit must be an integer');
  }

  return Math.min(Math.max(parsed, 1), 20);
}

function normalizeUpdatesAfter(value: string | null): string | 'latest' | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'latest') {
    return 'latest';
  }

  // Validate that it looks like a base64url-encoded cursor
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) {
    throw new AppError(400, 'invalid_input', 'after must be a valid cursor string or "latest"');
  }

  return trimmed;
}

function writeCompressed(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders?: Record<string, string>,
) {
  const accept = String(request.headers['accept-encoding'] ?? '');
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };

  if (/\bgzip\b/.test(accept)) {
    const compressed = gzipSync(Buffer.from(body, 'utf-8'));
    headers['content-encoding'] = 'gzip';
    headers['vary'] = 'Accept-Encoding';
    response.writeHead(statusCode, headers);
    response.end(compressed);
  } else {
    response.writeHead(statusCode, headers);
    response.end(body);
  }
}

function writeJson(request: http.IncomingMessage, response: http.ServerResponse, statusCode: number, payload: unknown) {
  writeCompressed(request, response, statusCode, 'application/json; charset=utf-8', JSON.stringify(payload), {
    'cache-control': 'no-store, no-cache, max-age=0',
    pragma: 'no-cache',
  });
}

function writeSseEvent(response: http.ServerResponse, event: string, data: unknown, id?: string | number) {
  if (id !== undefined) {
    response.write(`id: ${id}\n`);
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseComment(response: http.ServerResponse, comment: string) {
  response.write(`: ${comment}\n\n`);
}

function isColdAdmissionAction(value: unknown): value is ColdAdmissionAction {
  if (typeof value !== 'string') return false;
  const def = getAction(value);
  return def?.auth === 'none' && (value === 'admissions.public.requestChallenge' || value === 'admissions.public.submitApplication');
}

function getClientIp(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0].trim();
      if (first.length > 0) {
        return first;
      }
    }
  }

  return request.socket.remoteAddress ?? 'unknown';
}

function consumeFixedWindowRateLimit(
  buckets: Map<string, FixedWindowRateLimitState>,
  key: string,
  rule: FixedWindowRateLimit,
  now = Date.now(),
): boolean {
  for (const [bucketKey, state] of buckets) {
    if (state.resetAt <= now) {
      buckets.delete(bucketKey);
    }
  }

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + rule.windowMs,
    });
    return true;
  }

  if (bucket.count >= rule.limit) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function createTimeoutOnlyNotifier(): MemberUpdateNotifier {
  return {
    async waitForUpdate({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }) {
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
    },
    async close() {},
  };
}

export function createServer(options: {
  repository?: Repository;
  updatesNotifier?: MemberUpdateNotifier;
  coldAdmissionRateLimits?: Partial<Record<ColdAdmissionAction, FixedWindowRateLimit>>;
  qualityGate?: QualityGateFn;
  trustProxy?: boolean;
} = {}) {
  const trustProxy = options.trustProxy ?? (process.env.TRUST_PROXY === '1');

  const poolConfig = {
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000),
    options: `-c statement_timeout=${Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000)}`,
  };

  function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be set`);
    return value;
  }

  const pool = options.repository ? null : new Pool({
    ...poolConfig,
    connectionString: requireEnv('DATABASE_URL'),
  });
  if (pool) {
    pool.on('error', (err) => { console.error('Unexpected pool error:', err); });
  }
  const repository = options.repository ?? createRepository(pool!);
  const dbUrl = process.env.DATABASE_URL;
  const updatesNotifier = options.updatesNotifier
    ?? (dbUrl ? createPostgresMemberUpdateNotifier(dbUrl) : createTimeoutOnlyNotifier());
  const coldAdmissionRateLimits: Record<ColdAdmissionAction, FixedWindowRateLimit> = {
    'admissions.public.requestChallenge': options.coldAdmissionRateLimits?.['admissions.public.requestChallenge'] ?? DEFAULT_COLD_APPLICATION_RATE_LIMITS['admissions.public.requestChallenge'],
    'admissions.public.submitApplication': options.coldAdmissionRateLimits?.['admissions.public.submitApplication'] ?? DEFAULT_COLD_APPLICATION_RATE_LIMITS['admissions.public.submitApplication'],
  };
  const coldAdmissionRateLimitBuckets = new Map<string, FixedWindowRateLimitState>();
  const activeStreams = new Map<string, number>();
  const dispatcher = buildDispatcher({ repository, qualityGate: options.qualityGate });
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/updates/stream') {
      const abortController = new AbortController();
      const abortStream = () => abortController.abort();
      request.on('close', abortStream);
      request.on('aborted', abortStream);
      response.on('close', abortStream);
      response.on('error', abortStream);

      try {
        const bearerToken = getBearerToken(request);
        if (!bearerToken) {
          throw new AppError(401, 'unauthorized', 'Unknown bearer token');
        }

        const auth = await repository.authenticateBearerToken(bearerToken);
        if (!auth) {
          throw new AppError(401, 'unauthorized', 'Unknown bearer token');
        }

        if (!repository.listMemberUpdates) {
          throw new Error('Repository does not implement listMemberUpdates');
        }

        const memberId = auth.actor.member.id;
        const currentStreams = activeStreams.get(memberId) ?? 0;
        if (currentStreams >= DEFAULT_SERVER_LIMITS.maxStreamsPerMember) {
          throw new AppError(429, 'too_many_streams', `Maximum ${DEFAULT_SERVER_LIMITS.maxStreamsPerMember} concurrent streams per member`);
        }
        activeStreams.set(memberId, currentStreams + 1);
        const decrementStreams = () => {
          const count = activeStreams.get(memberId);
          if (count !== undefined) {
            if (count <= 1) {
              activeStreams.delete(memberId);
            } else {
              activeStreams.set(memberId, count - 1);
            }
          }
        };
        request.on('close', decrementStreams);

        const clubIds = auth.actor.memberships.map(m => m.clubId);
        const limit = Math.min(
          normalizeUpdatesLimit(url.searchParams.get('limit')),
          DEFAULT_SERVER_LIMITS.updatesStreamLimit,
        );
        const lastEventId = request.headers['last-event-id'];
        const afterRaw = normalizeUpdatesAfter(
          url.searchParams.get('after')
          ?? (typeof lastEventId === 'string' ? lastEventId : null),
        );

        const latestCursor = repository.getLatestCursor
          ? await repository.getLatestCursor({ actorMemberId: memberId, clubIds })
          : null;

        const after = afterRaw === 'latest' ? latestCursor : afterRaw;

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-cache, max-age=0',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders();

        request.socket?.setTimeout(0);
        response.socket?.setTimeout(0);

        writeSseEvent(response, 'ready', {
          member: auth.actor.member,
          requestScope: auth.requestScope,
          nextAfter: after,
          latestCursor,
        });

        let cursor: string | null = after ?? null;

        while (!abortController.signal.aborted) {
          const updates = await repository.listMemberUpdates({
            actorMemberId: auth.actor.member.id,
            clubIds,
            limit,
            after: cursor,
          });

          if (updates.items.length > 0) {
            for (let idx = 0; idx < updates.items.length; idx++) {
              const item = updates.items[idx]!;
              const isLast = idx === updates.items.length - 1;
              // Attach the compound cursor as id on the last event so Last-Event-ID works on reconnect
              writeSseEvent(response, 'update', item, isLast ? updates.nextAfter ?? undefined : undefined);
            }
            cursor = updates.nextAfter;
            continue;
          }

          const outcome = await updatesNotifier.waitForUpdate({
            recipientMemberId: auth.actor.member.id,
            clubIds,
            afterStreamSeq: null,
            timeoutMs: DEFAULT_SERVER_LIMITS.updatesStreamHeartbeatMs,
            signal: abortController.signal,
          });

          if (outcome === 'timed_out' && !abortController.signal.aborted) {
            writeSseComment(response, 'keepalive');
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          response.end();
          return;
        }

        if (error instanceof AppError) {
          if (response.headersSent) {
            response.end();
            return;
          }

          writeJson(request, response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          });
          return;
        }

        console.error(error);
        if (response.headersSent) {
          response.end();
          return;
        }

        writeJson(request, response, 500, {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'Unexpected server error',
          },
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/schema') {
      try {
        const schema = getSchemaPayload();
        writeJson(request, response, 200, { ok: true, data: schema });
      } catch (error) {
        console.error(error);
        writeJson(request, response, 500, {
          ok: false,
          error: { code: 'internal_error', message: 'Unexpected server error' },
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/skill') {
      writeCompressed(request, response, 200, 'text/markdown; charset=utf-8', SKILL_MD);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const html = [
        '<!DOCTYPE html>',
        '<html><head><title>ClawClub</title></head>',
        '<body>',
        `<h1>ClawClub Version ${PACKAGE_VERSION}</h1>`,
        '<p>Tell your agent to look at <a href="/skill">SKILL.md</a></p>',
        '<p>See the full API Schema at <a href="/api/schema">/api/schema</a></p>',
        '<p><a href="https://clawclub.social">clawclub.social</a></p>',
        '</body></html>',
      ].join('\n');
      writeCompressed(request, response, 200, 'text/html; charset=utf-8', html);
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/api') {
      writeJson(request, response, 404, {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Only GET /, GET /skill, GET /updates/stream, GET /api/schema, and POST /api are supported',
        },
      });
      return;
    }

    try {
      const contentType = (request.headers['content-type'] ?? '').toLowerCase();
      if (contentType !== 'application/json' && !contentType.startsWith('application/json;')) {
        writeJson(request, response, 415, {
          ok: false,
          error: {
            code: 'unsupported_media_type',
            message: 'Content-Type must be application/json',
          },
        });
        return;
      }

      const body = await readJsonBody(request);

      // Enforce canonical POST shape: {"action":"...","input":{...}}
      // Reject any unexpected top-level keys to prevent silent parameter widening.
      if (typeof body.action !== 'string' || !body.action) {
        const err = new AppError(400, 'invalid_input', 'Request body must include "action" as a string');
        err.requestTemplate = GENERIC_REQUEST_TEMPLATE;
        throw err;
      }
      const allowedTopLevelKeys = new Set(['action', 'input']);
      const unexpectedKeys = Object.keys(body).filter((k) => !allowedTopLevelKeys.has(k));
      if (unexpectedKeys.length > 0) {
        const err = new AppError(
          400,
          'invalid_input',
          `Unexpected top-level keys: ${unexpectedKeys.join(', ')}. Action parameters must be nested inside "input".`,
        );
        const def = getAction(body.action);
        err.requestTemplate = def ? generateRequestTemplate(def) : GENERIC_REQUEST_TEMPLATE;
        throw err;
      }
      if (body.input !== undefined && (typeof body.input !== 'object' || body.input === null || Array.isArray(body.input))) {
        const err = new AppError(400, 'invalid_input', '"input" must be a JSON object');
        const def = getAction(body.action);
        err.requestTemplate = def ? generateRequestTemplate(def) : GENERIC_REQUEST_TEMPLATE;
        throw err;
      }

      // Rate-limit cold admission actions by IP (before dispatch)
      if (isColdAdmissionAction(body.action)) {
        const clientIp = getClientIp(request, trustProxy);
        const key = `${body.action}:${clientIp}`;

        if (!consumeFixedWindowRateLimit(coldAdmissionRateLimitBuckets, key, coldAdmissionRateLimits[body.action])) {
          throw new AppError(429, 'rate_limited', `Too many ${body.action} requests from this IP`);
        }
      }

      // Unified dispatch: auth, parse, legality gate, execute, envelope assembly
      // are all handled inside the dispatcher based on the action contract.
      const result = await dispatcher.dispatch({
        bearerToken: getBearerToken(request),
        action: body.action,
        payload: body.input,
      });

      writeJson(request, response, 200, {
        ok: true,
        ...(result as Record<string, unknown>),
      });
    } catch (error) {
      if (error instanceof AppError) {
        writeJson(request, response, error.statusCode, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.requestTemplate ? { requestTemplate: error.requestTemplate } : {}),
          },
        });
        return;
      }

      console.error(error);
      writeJson(request, response, 500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Unexpected server error',
        },
      });
    }
  });
  server.requestTimeout = DEFAULT_SERVER_LIMITS.requestTimeoutMs;
  server.headersTimeout = DEFAULT_SERVER_LIMITS.headersTimeoutMs;
  server.keepAliveTimeout = DEFAULT_SERVER_LIMITS.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = DEFAULT_SERVER_LIMITS.maxRequestsPerSocket;
  server.maxHeadersCount = DEFAULT_SERVER_LIMITS.maxHeadersCount;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }

    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const shutdown = async () => {
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await closePromise;

    if (pool) {
      await pool.end();
    }

    await updatesNotifier.close();
  };

  // Billing config check — runs async, callers should await `ready` before listening
  const ready: Promise<void> = (async () => {
    const billingEnabled = process.env.BILLING_ENABLED === 'true' || process.env.BILLING_ENABLED === '1';
    if (!billingEnabled && pool) {
      const paidCheck = await pool.query<{ count: string }>(
        `select count(*)::text as count from clubs where membership_price_amount is not null and archived_at is null`,
      );
      const pendingCheck = await pool.query<{ count: string }>(
        `select count(*)::text as count from club_memberships where status = 'payment_pending'`,
      );
      const paidCount = Number(paidCheck.rows[0]?.count ?? 0);
      const pendingCount = Number(pendingCheck.rows[0]?.count ?? 0);
      if (paidCount > 0 || pendingCount > 0) {
        const msg = `${paidCount} paid club(s) and ${pendingCount} payment_pending membership(s) exist but BILLING_ENABLED is not set.`;
        if (process.env.NODE_ENV === 'production') {
          throw new Error(msg);
        }
        console.warn(`WARNING: ${msg} Paid billing flows will not function.`);
      }
    }
  })();

  return { server, shutdown, ready };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, shutdown, ready } = createServer();

  // Await billing config check — throws in prod if misconfigured
  await ready.catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });

  const port = Number(process.env.PORT ?? 8787);

  server.listen(port, () => {
    console.log(`clawclub api listening on http://127.0.0.1:${port}/api`);
    console.log('auth mode: hashed API-style bearer tokens in member_bearer_tokens');
  });

  const stop = async () => {
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
