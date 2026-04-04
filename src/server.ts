import http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';
import { Pool } from 'pg';
import { AppError, type Repository } from './contract.ts';
import { buildDispatcher } from './dispatch.ts';
import { getAction } from './schemas/registry.ts';
import { createPostgresMemberUpdateNotifier, type MemberUpdateNotifier } from './member-updates-notifier.ts';
import { createPostgresRepository } from './postgres.ts';
import { getSchemaPayload, resolveSchemaAccess } from './schema-endpoint.ts';

type ColdAdmissionAction = 'admissions.challenge' | 'admissions.apply';
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
  'admissions.challenge': {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  },
  'admissions.apply': {
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

function normalizeUpdatesAfter(value: string | null): number | 'latest' | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  if (value.trim().toLowerCase() === 'latest') {
    return 'latest';
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(400, 'invalid_input', 'after must be a non-negative integer or "latest"');
  }

  return parsed;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeSseEvent(response: http.ServerResponse, event: string, data: unknown, id?: number) {
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
  return def?.auth === 'none' && (value === 'admissions.challenge' || value === 'admissions.apply');
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
    async waitForUpdate({ timeoutMs, signal }) {
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
  trustProxy?: boolean;
} = {}) {
  const trustProxy = options.trustProxy ?? (process.env.TRUST_PROXY === '1');
  const databaseUrl = process.env.DATABASE_URL;
  const pool = options.repository ? null : new Pool({
    connectionString: databaseUrl ?? (() => { throw new Error('DATABASE_URL must be set'); })(),
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000),
  });
  if (pool) {
    pool.on('error', (err) => { console.error('Unexpected database pool error:', err); });
  }
  const repository = options.repository ?? createPostgresRepository({ pool: pool! });
  const updatesNotifier = options.updatesNotifier
    ?? (databaseUrl ? createPostgresMemberUpdateNotifier(databaseUrl) : createTimeoutOnlyNotifier());
  const coldAdmissionRateLimits: Record<ColdAdmissionAction, FixedWindowRateLimit> = {
    'admissions.challenge': options.coldAdmissionRateLimits?.['admissions.challenge'] ?? DEFAULT_COLD_APPLICATION_RATE_LIMITS['admissions.challenge'],
    'admissions.apply': options.coldAdmissionRateLimits?.['admissions.apply'] ?? DEFAULT_COLD_APPLICATION_RATE_LIMITS['admissions.apply'],
  };
  const coldAdmissionRateLimitBuckets = new Map<string, FixedWindowRateLimitState>();
  const activeStreams = new Map<string, number>();
  const dispatcher = buildDispatcher({ repository });
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/updates') {
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

        const afterRaw = normalizeUpdatesAfter(url.searchParams.get('after'));
        const after = afterRaw === 'latest' && repository.getLatestStreamSeq
          ? await repository.getLatestStreamSeq({ actorMemberId: auth.actor.member.id })
          : afterRaw === 'latest' ? null : afterRaw;

        const updates = await repository.listMemberUpdates({
          actorMemberId: auth.actor.member.id,
          limit: normalizeUpdatesLimit(url.searchParams.get('limit')),
          after,
        });

        writeJson(response, 200, {
          ok: true,
          member: auth.actor.member,
          requestScope: auth.requestScope,
          updates,
        });
      } catch (error) {
        if (error instanceof AppError) {
          writeJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          });
          return;
        }

        console.error(error);
        writeJson(response, 500, {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'Unexpected server error',
          },
        });
      }
      return;
    }

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

        const limit = Math.min(
          normalizeUpdatesLimit(url.searchParams.get('limit')),
          DEFAULT_SERVER_LIMITS.updatesStreamLimit,
        );
        const lastEventId = request.headers['last-event-id'];
        const afterRaw = normalizeUpdatesAfter(
          url.searchParams.get('after')
          ?? (typeof lastEventId === 'string' ? lastEventId : null),
        );

        const latestStreamSeq = repository.getLatestStreamSeq
          ? await repository.getLatestStreamSeq({ actorMemberId: memberId })
          : null;

        const after = afterRaw === 'latest' ? latestStreamSeq : afterRaw;

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
          latestStreamSeq,
        });

        let cursor = after;

        while (!abortController.signal.aborted) {
          const updates = await repository.listMemberUpdates({
            actorMemberId: auth.actor.member.id,
            limit,
            after: cursor,
          });

          if (updates.items.length > 0) {
            for (const item of updates.items) {
              writeSseEvent(response, 'update', item, item.streamSeq);
              cursor = item.streamSeq;
            }
            continue;
          }

          const outcome = await updatesNotifier.waitForUpdate({
            recipientMemberId: auth.actor.member.id,
            afterStreamSeq: cursor,
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

          writeJson(response, error.statusCode, {
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

        writeJson(response, 500, {
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
        const full = await resolveSchemaAccess(
          getBearerToken(request),
          url.searchParams.get('full'),
          repository,
        );
        const schema = getSchemaPayload(full);
        writeJson(response, 200, { ok: true, data: schema });
      } catch (error) {
        console.error(error);
        writeJson(response, 500, {
          ok: false,
          error: { code: 'internal_error', message: 'Unexpected server error' },
        });
      }
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/api') {
      writeJson(response, 404, {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Only GET /updates, GET /updates/stream, GET /api/schema, and POST /api are supported',
        },
      });
      return;
    }

    try {
      const body = await readJsonBody(request);

      // Rate-limit cold admission actions by IP (before dispatch)
      if (isColdAdmissionAction(body.action)) {
        const clientIp = getClientIp(request, trustProxy);
        const key = `${body.action}:${clientIp}`;

        if (!consumeFixedWindowRateLimit(coldAdmissionRateLimitBuckets, key, coldAdmissionRateLimits[body.action])) {
          throw new AppError(429, 'rate_limited', `Too many ${body.action} requests from this IP`);
        }
      }

      // Unified dispatch: auth, parse, quality gate, execute, envelope assembly
      // are all handled inside the dispatcher based on the action contract.
      const result = await dispatcher.dispatch({
        bearerToken: getBearerToken(request),
        action: body.action,
        payload: body.input,
      });

      writeJson(response, 200, {
        ok: true,
        ...(result as Record<string, unknown>),
      });
    } catch (error) {
      if (error instanceof AppError) {
        writeJson(response, error.statusCode, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      console.error(error);
      writeJson(response, 500, {
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

  return { server, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, shutdown } = createServer();
  const port = Number(process.env.PORT ?? 8787);

  server.listen(port, () => {
    console.log(`clawclub api listening on http://127.0.0.1:${port}/api`);
    console.log('auth mode: hashed API-style bearer tokens in app.member_bearer_tokens');
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
