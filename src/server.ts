import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type net from 'node:net';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { z } from 'zod';
import { membershipScopes } from './actors.ts';
import { DEFAULT_SERVER_LIMITS } from './config/defaults.ts';
import { AppError, type Repository } from './repository.ts';
import { buildDispatcher, type LlmGateFn } from './dispatch.ts';
import { getConfig, hasInitializedConfig, initializeConfigFromFile } from './config/index.ts';
import { boundedArray } from './schemas/fields.ts';
import { getAction, generateRequestTemplate, GENERIC_REQUEST_TEMPLATE } from './schemas/registry.ts';
import { createPostgresMemberUpdateNotifier, type MemberUpdateNotifier } from './member-updates-notifier.ts';
import { NOTIFICATIONS_PAGE_SIZE } from './notifications-core.ts';
import { createRepository } from './postgres.ts';
import { NOTIFICATION_REF_KINDS } from './notification-substrate.ts';
import { ensurePowChallengeConfig } from './pow-challenge.ts';
import { getSchemaPayload } from './schema-endpoint.ts';
import { assertStartupConfig } from './startup-check.ts';
import { PACKAGE_VERSION } from './version.ts';
import { fireAndForgetRequestLog, logger, STALE_CLIENT_LOG_ACTION } from './logger.ts';
import { canonicalizeTimestampFields } from './timestamps.ts';
import { createDirectoryCache, type DirectoryCache, type DirectoryCacheEntry } from './directory.ts';
import {
  getBearerToken,
  readJsonBody,
  writeCachedText,
  writeJson as writeBoundaryJson,
} from './http-boundary.ts';
import {
  composeStreamResumeId,
  encodeLegacyActivityCursor,
  parseRequiredStreamResumeId,
  parseStreamResumeId,
} from './sse-resume.ts';

export { DEFAULT_SERVER_LIMITS } from './config/defaults.ts';

const EXPOSED_RESPONSE_HEADERS = 'ClawClub-Version, ClawClub-Schema-Hash';
const REGISTRATION_DISCOVER_RATE_LIMIT = 20;
const REGISTRATION_DISCOVER_RATE_LIMIT_WINDOW_MS = 60_000;
const BOOTSTRAP_ROUTE_RATE_LIMIT = 120;
const BOOTSTRAP_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;
const STALE_CLIENT_MESSAGE = [
  'The ClawClub API schema has changed since your agent last fetched it. Your cached schema is out of date, which can cause invalid_input errors and missing capabilities. To recover, do the following and then retry this request:',
  '',
  '1. GET /skill and replace your cached skill document.',
  '2. GET /api/schema and replace your cached schema.',
  '3. Retry the original request.',
  '',
  'Auto-retry is only safe for read-only actions or mutations that include a clientKey. For other mutations, confirm with the human before retrying so you do not duplicate a side effect.',
].join('\n');
const SKILL_MD_RAW: string = readFileSync(
  new URL('../SKILL.md', import.meta.url), 'utf-8',
);

type ServerProcessLogger = (event: string, error: unknown) => void;
type ServerProcessHandlerOptions = {
  logger?: ServerProcessLogger;
  terminate?: () => void;
};

let serverProcessHandlersInstalled = false;
let installedApiUnhandledRejectionHandler: ((reason: unknown) => void) | null = null;
let installedApiUncaughtExceptionHandler: ((error: unknown) => void) | null = null;

export function createApiUnhandledRejectionHandler(
  options: ServerProcessHandlerOptions = {},
): (reason: unknown) => void {
  const log = options.logger ?? ((event: string, error: unknown) => logger.error(event, error));
  return (reason: unknown) => {
    log('api_unhandled_rejection', reason);
  };
}

export function createApiUncaughtExceptionHandler(
  options: ServerProcessHandlerOptions = {},
): (error: unknown) => void {
  const log = options.logger ?? ((event: string, error: unknown) => logger.error(event, error));
  const terminate = options.terminate ?? (() => process.exit(1));
  return (error: unknown) => {
    log('api_uncaught_exception', error);
    terminate();
  };
}

export function installApiProcessHandlers(options: ServerProcessHandlerOptions = {}): void {
  if (serverProcessHandlersInstalled) return;
  installedApiUnhandledRejectionHandler = createApiUnhandledRejectionHandler(options);
  installedApiUncaughtExceptionHandler = createApiUncaughtExceptionHandler(options);
  process.on('unhandledRejection', installedApiUnhandledRejectionHandler);
  process.on('uncaughtException', installedApiUncaughtExceptionHandler);
  serverProcessHandlersInstalled = true;
}

export function resetInstalledApiProcessHandlersForTests(): void {
  if (installedApiUnhandledRejectionHandler) {
    process.off('unhandledRejection', installedApiUnhandledRejectionHandler);
    installedApiUnhandledRejectionHandler = null;
  }
  if (installedApiUncaughtExceptionHandler) {
    process.off('uncaughtException', installedApiUncaughtExceptionHandler);
    installedApiUncaughtExceptionHandler = null;
  }
  serverProcessHandlersInstalled = false;
}

// Strip the static frontmatter and prepend a dynamic one with version metadata.
// The body still contains {baseUrl} placeholders; those are substituted per
// request in resolveBaseUrl() so the served document shows the concrete URL.
const SKILL_MD_BODY: string = SKILL_MD_RAW.replace(/^---\n[\s\S]*?\n---\n/, '');
const SKILL_MD_TEMPLATE: string = [
  '---',
  'name: clawclub',
  'description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; invite someone to a club; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.',
  'license: MIT',
  'metadata:',
  '  author: clawclub.social',
  `  version: "${PACKAGE_VERSION}"`,
  '---',
  '',
].join('\n') + SKILL_MD_BODY;

function resolveBaseUrl(request: http.IncomingMessage): string {
  const envBaseUrl = process.env.BASE_URL?.trim();
  if (envBaseUrl) {
    return envBaseUrl.replace(/\/+$/, '');
  }

  const localPort = request.socket.localPort ?? Number(process.env.PORT ?? 8787);
  const localAddress = request.socket.localAddress;
  const host = normalizeLocalBaseHost(localAddress);

  return `http://${host}:${localPort}`;
}

function normalizeLocalBaseHost(address: string | undefined): string {
  if (!address || address === '::' || address === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }
  if (address.includes(':')) {
    return `[${address}]`;
  }
  return address;
}

function renderSkill(baseUrl: string): string {
  return SKILL_MD_TEMPLATE.replace(/\{baseUrl\}/g, baseUrl);
}

export function buildSkillCacheKey(baseUrl: string, schemaHash: string): string {
  return `skill:${baseUrl}:${schemaHash}`;
}

export function buildRootCacheKey(schemaHash: string): string {
  return `root:${PACKAGE_VERSION}:${schemaHash}`;
}

const NOTIFICATION_WAKEUP_KINDS = new Set(['notification']);
const producerNotificationRefKindSchema = z.enum(NOTIFICATION_REF_KINDS);
const producerDeliverRequestSchema = z.object({
  notifications: boundedArray(z.object({
    topic: z.string().min(1),
    recipientMemberId: z.string().min(1),
    clubId: z.string().min(1).nullable().optional(),
    payloadVersion: z.number().int().min(1),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    refs: boundedArray(z.object({
      role: z.string().min(1),
      kind: producerNotificationRefKindSchema,
      id: z.string().min(1),
    }), { maxItems: 20 }).optional(),
  }), { maxItems: 100 }).default([]),
});
const producerAcknowledgeRequestSchema = z.object({
  notificationIds: boundedArray(z.string().min(1), { maxItems: 500 }).default([]),
});
const producerRequestTemplates = {
  '/internal/notifications/deliver': {
    notifications: '(array, max 100)',
  },
  '/internal/notifications/acknowledge': {
    notificationIds: '(array of string, max 500)',
  },
} as const;

function readProducerIdHeader(request: http.IncomingMessage): string | null {
  const header = request.headers['x-clawclub-producer-id'];
  if (typeof header !== 'string') {
    return null;
  }
  const producerId = header.trim();
  return producerId.length > 0 ? producerId : null;
}

function normalizeStreamLimit(value: string | null): number {
  if (value === null || value.trim().length === 0) {
    return 10;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new AppError('invalid_input', 'limit must be an integer');
  }

  return Math.min(Math.max(parsed, 1), 20);
}

function normalizeStreamAfter(value: string | null): string | 'latest' | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'latest') {
    return 'latest';
  }

  if (!/^[A-Za-z0-9_:-]+={0,2}$/.test(trimmed) && !/^[0-9]+$/.test(trimmed)) {
    throw new AppError('invalid_input', 'after must be a valid cursor string or "latest"');
  }

  return trimmed;
}

function getDefaultResponseHeaders(): Record<string, string> {
  const schemaHash = (getSchemaPayload() as { schemaHash: string }).schemaHash;
  return {
    'ClawClub-Version': PACKAGE_VERSION,
    'ClawClub-Schema-Hash': schemaHash,
  };
}

function getSupersededStreamMessage(): string {
  const cap = getConfig().policy.transport.maxStreamsPerMember;
  return `This /stream was closed because a newer connection from the same member reached the ${cap}-concurrent-stream cap for this account. The newest connection always wins - close unused /stream connections to keep older ones alive.`;
}

function allowedMethodsForPath(pathname: string): string[] | null {
  const normalizedPath = pathname.toLowerCase().replace(/\/+/g, '/');
  const skillCanonicalPath = normalizedPath.replace(/\/+$/, '');
  if (pathname === '/') return ['GET', 'OPTIONS'];
  if (pathname === '/api') return ['POST', 'OPTIONS'];
  if (pathname === '/api/schema') return ['GET', 'OPTIONS'];
  if (pathname === '/stream') return ['GET', 'OPTIONS'];
  if (pathname === '/directory') return ['GET', 'OPTIONS'];
  if (pathname === '/internal/notifications/deliver') return ['POST', 'OPTIONS'];
  if (pathname === '/internal/notifications/acknowledge') return ['POST', 'OPTIONS'];
  if (skillCanonicalPath === '/skill' || skillCanonicalPath === '/skill.md') return ['GET', 'OPTIONS'];
  return null;
}

function writeJson(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  options: {
    extraHeaders?: Record<string, string>;
    destroySocketAfterResponse?: boolean;
  } = {},
) {
  writeBoundaryJson(request, response, statusCode, payload, {
    ...options,
    onNon2xx: (code, body, bytes) => logNon2xx(request, code, body, bytes),
  });
}

function writeDirectoryResponse(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  entry: DirectoryCacheEntry,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=60',
    etag: entry.etag,
    vary: 'Accept-Encoding',
  };
  const ifNoneMatch = request.headers['if-none-match'];
  const requestedEtags = typeof ifNoneMatch === 'string'
    ? ifNoneMatch.split(',').map((value) => value.trim())
    : [];
  if (requestedEtags.includes(entry.etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
  if (acceptsGzip) {
    response.writeHead(200, {
      ...headers,
      'content-encoding': 'gzip',
    });
    response.end(entry.envelopeGzipped);
    return;
  }

  response.writeHead(200, headers);
  response.end(entry.envelopePlain);
}

function logNon2xx(
  request: http.IncomingMessage,
  statusCode: number,
  payload: unknown,
  bytes: number,
) {
  let path = '/';
  try {
    path = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {}
  let errCode: string | undefined;
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const err = (payload as { error?: unknown }).error;
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') errCode = code;
    }
  }
  const ua = typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent'].slice(0, 160)
    : undefined;
  const action = (request as RequestMetadataCarrier).clawclubAction;
  logger.record({
    kind: 'access',
    method: request.method,
    path,
    status: statusCode,
    code: errCode,
    action,
    ip: getClientIp(request),
    ua,
    bytes,
  });
}

function writeSseEvent(response: http.ServerResponse, event: string, data: unknown, id?: string | number) {
  if (id !== undefined) {
    response.write(`id: ${id}\n`);
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(canonicalizeTimestampFields(data))}\n\n`);
}

function writeSseComment(response: http.ServerResponse, comment: string) {
  response.write(`: ${comment}\n\n`);
}

function tryWriteAndEnd(response: http.ServerResponse, event: string, data: unknown): void {
  try {
    writeSseEvent(response, event, data);
  } catch {}
  try {
    response.end();
  } catch {}
}

type RequestMetadataCarrier = http.IncomingMessage & {
  clawclubAction?: string;
  clawclubMemberId?: string;
};

type RegistrationDiscoverRateLimitEntry = {
  count: number;
  windowStart: number;
};

function isRegistrationDiscoverRequest(body: Record<string, unknown>): boolean {
  const input = body.input;
  return body.action === 'accounts.register'
    && input !== null
    && typeof input === 'object'
    && !Array.isArray(input)
    && (input as Record<string, unknown>).mode === 'discover';
}

function configuredTrustedProxyCidrs(): string[] {
  const configured = (process.env.CLAWCLUB_TRUSTED_PROXY_CIDRS ?? process.env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ['127.0.0.1/32', '::1/128', ...configured];
}

function normalizeIpAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) {
    const mapped = trimmed.slice('::ffff:'.length);
    return isIP(mapped) ? mapped : null;
  }
  return isIP(trimmed) ? trimmed : null;
}

function ipv4ToNumber(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function ipv4CidrContains(ip: string, cidr: string): boolean {
  const [rawBase, rawPrefix] = cidr.split('/');
  const base = normalizeIpAddress(rawBase);
  const prefix = Number.parseInt(rawPrefix ?? '', 10);
  if (!base || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNumber = ipv4ToNumber(ip);
  const baseNumber = ipv4ToNumber(base);
  if (ipNumber === null || baseNumber === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (baseNumber & mask);
}

function proxyCidrMatches(ip: string, cidr: string): boolean {
  const trimmed = cidr.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('/')) {
    if (isIP(ip) === 4) {
      return ipv4CidrContains(ip, trimmed);
    }
    const [base, prefix] = trimmed.split('/');
    return normalizeIpAddress(base) === ip && prefix === '128';
  }
  return normalizeIpAddress(trimmed) === ip;
}

export function resolveTrustedClientIp(input: {
  remoteAddress?: string | null;
  forwardedFor?: string | string[] | undefined;
  trustedProxyCidrs?: string[];
}): string {
  const remoteAddress = normalizeIpAddress(input.remoteAddress) ?? 'unknown';
  const trustedProxyCidrs = input.trustedProxyCidrs ?? configuredTrustedProxyCidrs();
  const remoteIsTrusted = remoteAddress !== 'unknown'
    && trustedProxyCidrs.some((cidr) => proxyCidrMatches(remoteAddress, cidr));
  if (!remoteIsTrusted) {
    return remoteAddress;
  }

  const forwarded = Array.isArray(input.forwardedFor) ? input.forwardedFor[0] : input.forwardedFor;
  if (typeof forwarded !== 'string') {
    return remoteAddress;
  }
  const firstForwarded = normalizeIpAddress(forwarded.split(',')[0]?.trim() ?? '');
  return firstForwarded ?? remoteAddress;
}

function getClientIp(request: http.IncomingMessage): string {
  return resolveTrustedClientIp({
    remoteAddress: request.socket.remoteAddress,
    forwardedFor: request.headers['x-forwarded-for'],
  });
}

function consumeRateLimit(
  limits: Map<string, RegistrationDiscoverRateLimitEntry>,
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const current = limits.get(key);
  const entry = !current || current.windowStart <= now - windowMs
    ? { count: 0, windowStart: now }
    : current;
  entry.count += 1;
  limits.set(key, entry);
  return entry.count <= max;
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

      return { outcome: 'timed_out' } as const;
    },
    async close() {},
  };
}

export function createServer(options: {
  repository?: Repository;
  directoryCache?: DirectoryCache;
  directoryCacheTtlMs?: number;
  updatesNotifier?: MemberUpdateNotifier;
  llmGate?: LlmGateFn;
  streamScopeRefreshMs?: number;
} = {}) {
  assertStartupConfig({
    entrypoint: 'server',
    required: ['OPENAI_API_KEY', 'CLAWCLUB_POW_HMAC_KEY', 'BASE_URL'],
  });
  if (!hasInitializedConfig()) {
    initializeConfigFromFile();
  }
  type StreamHandle = {
    id: string;
    response: http.ServerResponse;
    abort: () => void;
    openedAt: number;
  };
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
    application_name: 'clawclub_server_main',
  });
  if (pool) {
    pool.on('error', (err) => {
      logger.error('server_pool_error', err);
    });
  }
  const repository = options.repository ?? createRepository(pool!);
  const maybeRequestLogRepository = repository as Partial<Repository>;
  if (typeof maybeRequestLogRepository.logApiRequest !== 'function') {
    throw new Error('Repository must implement logApiRequest');
  }
  const maybeClosableRepository = repository as Repository & { close?: () => Promise<void> };
  const repositoryClose = typeof maybeClosableRepository.close === 'function'
    ? maybeClosableRepository.close.bind(maybeClosableRepository)
    : null;
  const dbUrl = process.env.DATABASE_URL;
  const updatesNotifier = options.updatesNotifier
    ?? (dbUrl ? createPostgresMemberUpdateNotifier(dbUrl) : createTimeoutOnlyNotifier());
  const directoryCache = options.directoryCache ?? createDirectoryCache(repository, { ttlMs: options.directoryCacheTtlMs });
  const activeStreams = new Map<string, StreamHandle[]>();
  // TODO(#scale): replace this process-local guard before running multiple API instances.
  const registrationDiscoverRateLimits = new Map<string, RegistrationDiscoverRateLimitEntry>();
  const bootstrapRouteRateLimits = new Map<string, RegistrationDiscoverRateLimitEntry>();
  const streamScopeRefreshMs = options.streamScopeRefreshMs ?? 60_000;
  const dispatcher = buildDispatcher({ repository, llmGate: options.llmGate, directoryCache });
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-expose-headers', EXPOSED_RESPONSE_HEADERS);
    for (const [name, value] of Object.entries(getDefaultResponseHeaders())) {
      response.setHeader(name, value);
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': '*',
      });
      response.end();
      return;
    }

    if (request.method === 'POST' && (
      url.pathname === '/internal/notifications/deliver'
      || url.pathname === '/internal/notifications/acknowledge'
    )) {
      try {
        if (!repository.authenticateProducer || !repository.deliverProducerNotifications || !repository.acknowledgeProducerNotifications) {
          throw new AppError('not_implemented', 'Producer transport is not available.');
        }

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

        const producerId = readProducerIdHeader(request);
        const secret = getBearerToken(request);
        if (!producerId || !secret) {
          throw new AppError('unauthenticated', 'Producer credentials are required.');
        }

        const auth = await repository.authenticateProducer({
          producerId,
          secret,
        });
        if (!auth) {
          throw new AppError('unauthenticated', 'Unknown producer credentials.');
        }
        if (auth.status !== 'active') {
          throw new AppError('forbidden_role', 'Producer is disabled.');
        }

        const body = await readJsonBody(request);
        if (url.pathname === '/internal/notifications/deliver') {
          const parsed = producerDeliverRequestSchema.safeParse(body);
          if (!parsed.success) {
            throw new AppError('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid deliver request.');
          }
          const results = await repository.deliverProducerNotifications({
            producerId: auth.producerId,
            notifications: parsed.data.notifications,
          });
          writeJson(request, response, 200, { ok: true, data: { results } });
          return;
        }

        const parsed = producerAcknowledgeRequestSchema.safeParse(body);
        if (!parsed.success) {
          throw new AppError('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid acknowledge request.');
        }
        const results = await repository.acknowledgeProducerNotifications({
          producerId: auth.producerId,
          notificationIds: parsed.data.notificationIds,
        });
        writeJson(request, response, 200, { ok: true, data: { results } });
      } catch (error) {
        if (error instanceof AppError) {
          const requestTemplate = producerRequestTemplates[
            url.pathname as keyof typeof producerRequestTemplates
          ];
          writeJson(request, response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.details !== undefined ? { details: error.details } : {}),
              ...(requestTemplate ? { requestTemplate } : {}),
            },
          }, {
            extraHeaders: error.closeConnection ? { connection: 'close' } : undefined,
            destroySocketAfterResponse: error.closeConnection === true,
          });
          return;
        }

        logger.error('server_internal_notifications_error', error);
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

    if (request.method === 'GET' && url.pathname === '/stream') {
      // The schema-hash handshake is scoped to POST /api. The SSE stream is
      // long-lived and must not participate: strip the response header so
      // clients cannot treat a schema change mid-stream as a staleness signal,
      // and never read ClawClub-Schema-Seen on this path.
      response.removeHeader('ClawClub-Schema-Hash');

      const abortController = new AbortController();
      const abortStream = () => abortController.abort();
      request.on('close', abortStream);
      request.on('aborted', abortStream);
      response.on('close', abortStream);
      response.on('error', abortStream);

      try {
        const bearerToken = getBearerToken(request);
        if (!bearerToken) {
          throw new AppError('unauthenticated', 'Unknown bearer token');
        }

        const auth = await repository.authenticateBearerToken(bearerToken);
        if (!auth) {
          throw new AppError('unauthenticated', 'Unknown bearer token');
        }

        const memberId = auth.actor.member.id;
        const sortClubIds = (clubIds: string[]) => [...clubIds].sort();
        const computeScopedClubIds = (memberships: typeof auth.actor.memberships) => {
          const { clubIds, adminClubIds, ownerClubIds } = membershipScopes(memberships);
          return {
            clubIds: sortClubIds(clubIds),
            adminClubIds: sortClubIds(adminClubIds),
            ownerClubIds: sortClubIds(ownerClubIds),
          };
        };
        const sameScope = (a: string[], b: string[]) => (
          a.length === b.length && a.every((value, index) => value === b[index])
        );

        let { clubIds, adminClubIds, ownerClubIds } = computeScopedClubIds(auth.actor.memberships);
        const limit = Math.min(
          normalizeStreamLimit(url.searchParams.get('limit')),
          DEFAULT_SERVER_LIMITS.updatesStreamLimit,
        );
        const lastEventId = request.headers['last-event-id'];
        const explicitAfter = normalizeStreamAfter(url.searchParams.get('after'));
        const headerAfter = typeof lastEventId === 'string' ? lastEventId.trim() : null;
        const resume = explicitAfter !== null
          ? parseRequiredStreamResumeId(explicitAfter, 'after must be a valid stream cursor or "latest"')
          : headerAfter
            ? parseRequiredStreamResumeId(headerAfter, 'Last-Event-ID must be a valid stream cursor')
            : parseStreamResumeId(null);
        if (!resume) {
          throw new AppError('invalid_input', 'Stream cursor is invalid');
        }

        const activitySeed = await repository.listClubActivity({
          actorMemberId: memberId,
          clubIds,
          adminClubIds,
          ownerClubIds,
          limit,
          afterSeq: resume.activitySeq,
        });
        let activitySeq = activitySeed.highWaterMark;
        const inboxSeed = await repository.listInboxSince({
          actorMemberId: memberId,
          afterSeq: resume.inboxSeq,
          limit,
        });
        let inboxSeq = inboxSeed.highWaterMark;

        const notificationSeed = await repository.listNotifications({
          actorMemberId: memberId,
          accessibleClubIds: clubIds,
          adminClubIds,
          limit: NOTIFICATIONS_PAGE_SIZE,
          after: null,
        });

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

        for (const item of activitySeed.items) {
          activitySeq = item.seq;
          writeSseEvent(response, 'activity', item, composeStreamResumeId(activitySeq, inboxSeq));
        }

        for (const frame of inboxSeed.frames) {
          inboxSeq = frame.inboxSeq;
          writeSseEvent(response, 'message', frame.payload, composeStreamResumeId(activitySeq, inboxSeq));
        }

        writeSseEvent(response, 'ready', {
          member: {
            id: auth.actor.member.id,
            publicName: auth.actor.member.publicName,
          },
          requestScope: auth.requestScope,
          notifications: notificationSeed.items,
          notificationsTruncated: notificationSeed.nextCursor !== null,
          activityCursor: encodeLegacyActivityCursor(activitySeq),
          streamCursor: composeStreamResumeId(activitySeq, inboxSeq),
        }, composeStreamResumeId(activitySeq, inboxSeq));

        const handle: StreamHandle = {
          id: randomUUID(),
          response,
          abort: abortStream,
          openedAt: Date.now(),
        };
        const handles = activeStreams.get(memberId) ?? [];
        handles.push(handle);
        activeStreams.set(memberId, handles);
        while (handles.length > getConfig().policy.transport.maxStreamsPerMember) {
          const evicted = handles.shift();
          if (!evicted) {
            break;
          }
          tryWriteAndEnd(evicted.response, 'closed', {
            reason: 'superseded',
            message: getSupersededStreamMessage(),
          });
          evicted.abort();
          logger.record({
            kind: 'stream_evicted',
            memberId,
            evictedId: evicted.id,
            openedAt: new Date(evicted.openedAt).toISOString(),
          });
        }

        const cleanup = () => {
          const list = activeStreams.get(memberId);
          if (!list) {
            return;
          }
          const index = list.indexOf(handle);
          if (index >= 0) {
            list.splice(index, 1);
          }
          if (list.length === 0) {
            activeStreams.delete(memberId);
          }
        };
        request.on('close', cleanup);

        let lastScopeRefresh = Date.now();

        const refreshScopeIfDue = async (): Promise<{ ok: boolean; scopeChanged: boolean }> => {
          if (!repository.validateBearerTokenPassive) {
            return { ok: true, scopeChanged: false };
          }
          if (Date.now() - lastScopeRefresh < streamScopeRefreshMs) {
            return { ok: true, scopeChanged: false };
          }

          const refreshed = await repository.validateBearerTokenPassive(bearerToken);
          lastScopeRefresh = Date.now();
          if (!refreshed) {
            response.end();
            return { ok: false, scopeChanged: false };
          }

          const nextScope = computeScopedClubIds(refreshed.actor.memberships);
          const scopeChanged = !sameScope(clubIds, nextScope.clubIds)
            || !sameScope(adminClubIds, nextScope.adminClubIds)
            || !sameScope(ownerClubIds, nextScope.ownerClubIds);

          ({ clubIds, adminClubIds, ownerClubIds } = nextScope);
          return { ok: true, scopeChanged };
        };

        while (!abortController.signal.aborted) {
          const refreshResult = await refreshScopeIfDue();
          if (!refreshResult.ok || abortController.signal.aborted || response.writableEnded) {
            return;
          }
          if (refreshResult.scopeChanged) {
            writeSseEvent(response, 'notifications_dirty', {});
          }

          const activity = await repository.listClubActivity({
            actorMemberId: auth.actor.member.id,
            clubIds,
            adminClubIds,
            ownerClubIds,
            limit,
            afterSeq: activitySeq,
          });
          activitySeq = activity.highWaterMark;

          let deliveredFrames = false;

          if (activity.items.length > 0) {
            for (const item of activity.items) {
              activitySeq = item.seq;
              writeSseEvent(response, 'activity', item, composeStreamResumeId(activitySeq, inboxSeq));
            }
            deliveredFrames = true;
          }

          const messageFrames = await repository.listInboxSince({
            actorMemberId: auth.actor.member.id,
            afterSeq: inboxSeq,
            limit,
          });
          inboxSeq = messageFrames.highWaterMark;

          if (messageFrames.frames.length > 0) {
            for (const frame of messageFrames.frames) {
              inboxSeq = frame.inboxSeq;
              writeSseEvent(response, 'message', frame.payload, composeStreamResumeId(activitySeq, inboxSeq));
            }
            deliveredFrames = true;
          }

          if (deliveredFrames) {
            continue;
          }

          const result = await updatesNotifier.waitForUpdate({
            recipientMemberId: auth.actor.member.id,
            clubIds,
            afterStreamSeq: activitySeq ?? null,
            timeoutMs: DEFAULT_SERVER_LIMITS.updatesStreamHeartbeatMs,
            signal: abortController.signal,
          });

          if (result.outcome === 'timed_out' && !abortController.signal.aborted) {
            writeSseComment(response, 'keepalive');
            continue;
          }

          const causeKind = result.outcome === 'notified'
            ? (result.cause?.kind ?? null)
            : null;
          if (causeKind && NOTIFICATION_WAKEUP_KINDS.has(causeKind)) {
            writeSseEvent(response, 'notifications_dirty', {});
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
              ...(error.details !== undefined ? { details: error.details } : {}),
            },
          });
          return;
        }

        logger.error('server_stream_error', error);
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
      if (!consumeRateLimit(
        bootstrapRouteRateLimits,
        `${getClientIp(request)}:/api/schema`,
        BOOTSTRAP_ROUTE_RATE_LIMIT,
        BOOTSTRAP_ROUTE_RATE_LIMIT_WINDOW_MS,
      )) {
        writeJson(request, response, 429, {
          ok: false,
          error: {
            code: 'rate_limited',
            message: 'Too many schema requests from this IP. Retry after 60 seconds.',
          },
        }, { extraHeaders: { 'retry-after': '60' } });
        return;
      }
      try {
        const schema = getSchemaPayload();
        writeJson(request, response, 200, { ok: true, data: schema });
      } catch (error) {
        logger.error('server_schema_error', error);
        writeJson(request, response, 500, {
          ok: false,
          error: { code: 'internal_error', message: 'Unexpected server error' },
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/directory') {
      try {
        const entry = await directoryCache.get();
        writeDirectoryResponse(request, response, entry);
      } catch (error) {
        logger.error('server_directory_error', error);
        writeJson(request, response, 500, {
          ok: false,
          error: { code: 'internal_error', message: 'Unexpected server error' },
        });
      }
      return;
    }

    const normalizedPath = url.pathname.toLowerCase().replace(/\/+/g, '/');

    const skillCanonicalPath = normalizedPath.replace(/\/+$/, '');
    if (request.method === 'GET' && (skillCanonicalPath === '/skill' || skillCanonicalPath === '/skill.md')) {
      if (!consumeRateLimit(
        bootstrapRouteRateLimits,
        `${getClientIp(request)}:${skillCanonicalPath}`,
        BOOTSTRAP_ROUTE_RATE_LIMIT,
        BOOTSTRAP_ROUTE_RATE_LIMIT_WINDOW_MS,
      )) {
        writeJson(request, response, 429, {
          ok: false,
          error: {
            code: 'rate_limited',
            message: 'Too many skill requests from this IP. Retry after 60 seconds.',
          },
        }, { extraHeaders: { 'retry-after': '60' } });
        return;
      }
      const baseUrl = resolveBaseUrl(request);
      const schemaHash = (getSchemaPayload() as { schemaHash: string }).schemaHash;
      writeCachedText(
        request,
        response,
        200,
        'text/markdown; charset=utf-8',
        buildSkillCacheKey(baseUrl, schemaHash),
        () => renderSkill(baseUrl),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const schemaHash = (getSchemaPayload() as { schemaHash: string }).schemaHash;
      writeCachedText(
        request,
        response,
        200,
        'text/html; charset=utf-8',
        buildRootCacheKey(schemaHash),
        () => [
          '<!DOCTYPE html>',
          '<html><head><title>ClawClub</title></head>',
          '<body>',
          `<h1>ClawClub Version ${PACKAGE_VERSION}</h1>`,
          '<p>Bootstrap order: 1. fetch <a href="/skill">/skill</a>, 2. fetch <a href="/api/schema">/api/schema</a>, 3. call actions.</p>',
          '<p><a href="https://clawclub.social">clawclub.social</a></p>',
          '</body></html>',
        ].join('\n'),
      );
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/api') {
      const allowedMethods = allowedMethodsForPath(url.pathname);
      if (allowedMethods && !allowedMethods.includes(request.method ?? '')) {
        writeJson(request, response, 405, {
          ok: false,
          error: {
            code: 'method_not_allowed',
            message: 'Method not allowed for this route.',
          },
        }, {
          extraHeaders: { allow: allowedMethods.join(', ') },
        });
        return;
      }

      writeJson(request, response, 404, {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Only GET /, GET /directory, GET /skill (or /skill.md), GET /stream, GET /api/schema, and POST /api are supported',
        },
      });
      return;
    }

    const metadataRequest = request as RequestMetadataCarrier;
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

      const bearerToken = getBearerToken(request);
      const clientIp = getClientIp(request);
      const schemaSeen = typeof request.headers['clawclub-schema-seen'] === 'string'
        ? request.headers['clawclub-schema-seen'].trim()
        : '';
      const currentSchemaHash = (getSchemaPayload() as { schemaHash: string }).schemaHash;
      if (schemaSeen.length > 0 && schemaSeen !== currentSchemaHash) {
        if (bearerToken && repository.validateBearerTokenPassive) {
          const quickAuth = await repository.validateBearerTokenPassive(bearerToken);
          if (quickAuth) {
            metadataRequest.clawclubMemberId = quickAuth.actor.member.id;
            fireAndForgetRequestLog(repository, {
              memberId: quickAuth.actor.member.id,
              actionName: STALE_CLIENT_LOG_ACTION,
              ipAddress: clientIp,
            });
          }
        }
        throw new AppError('stale_client', STALE_CLIENT_MESSAGE);
      }

      const body = await readJsonBody(request);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        const err = new AppError('invalid_input', 'Request body must be a JSON object');
        err.requestTemplate = GENERIC_REQUEST_TEMPLATE;
        throw err;
      }

      if (typeof body.action === 'string') {
        metadataRequest.clawclubAction = body.action;
      }

      // Enforce canonical POST shape: {"action":"...","input":{...}}
      // Reject any unexpected top-level keys to prevent silent parameter widening.
      if (typeof body.action !== 'string' || !body.action) {
        const err = new AppError('invalid_input', 'Request body must include "action" as a string');
        err.requestTemplate = GENERIC_REQUEST_TEMPLATE;
        throw err;
      }
      const allowedTopLevelKeys = new Set(['action', 'input']);
      const unexpectedKeys = Object.keys(body).filter((k) => !allowedTopLevelKeys.has(k));
      if (unexpectedKeys.length > 0) {
        const err = new AppError('invalid_input',
          `Unexpected top-level keys: ${unexpectedKeys.join(', ')}. Action parameters must be nested inside "input".`,
        );
        const def = getAction(body.action);
        err.requestTemplate = def ? generateRequestTemplate(def) : GENERIC_REQUEST_TEMPLATE;
        throw err;
      }
      if (
        !Object.prototype.hasOwnProperty.call(body, 'input')
        || typeof body.input !== 'object'
        || body.input === null
        || Array.isArray(body.input)
      ) {
        const err = new AppError('invalid_input', 'Request body must include "input" as a JSON object');
        const def = getAction(body.action);
        err.requestTemplate = def ? generateRequestTemplate(def) : GENERIC_REQUEST_TEMPLATE;
        throw err;
      }

      if (isRegistrationDiscoverRequest(body)) {
        const key = getClientIp(request);
        if (!consumeRateLimit(
          registrationDiscoverRateLimits,
          key,
          REGISTRATION_DISCOVER_RATE_LIMIT,
          REGISTRATION_DISCOVER_RATE_LIMIT_WINDOW_MS,
        )) {
          writeJson(request, response, 429, {
            ok: false,
            error: {
              code: 'rate_limited',
              message: 'Too many registration discover requests from this IP. Retry after 60 seconds.',
            },
          }, {
            extraHeaders: { 'retry-after': '60' },
          });
          return;
        }
      }

      // Unified dispatch: auth, parse, legality gate, execute, envelope assembly
      // are all handled inside the dispatcher based on the action contract.
      const result = await dispatcher.dispatch({
        bearerToken,
        action: body.action,
        payload: body.input,
        clientIp,
        stampAuthenticatedMemberId: (memberId) => {
          metadataRequest.clawclubMemberId = memberId;
        },
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
            ...(error.details !== undefined ? { details: error.details } : {}),
            ...(error.requestTemplate ? { requestTemplate: error.requestTemplate } : {}),
          },
        }, {
          extraHeaders: error.closeConnection ? { connection: 'close' } : undefined,
          destroySocketAfterResponse: error.closeConnection === true,
        });
        return;
      }

      logger.error('server_request_error', error, {
        actionName: metadataRequest.clawclubAction,
        memberId: metadataRequest.clawclubMemberId,
      });
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

    const body = JSON.stringify({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Malformed HTTP request',
      },
    });
    const headers = {
      ...getDefaultResponseHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      Connection: 'close',
      'Cache-Control': 'no-store, no-cache, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    const head = [
      'HTTP/1.1 400 Bad Request',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      body,
    ].join('\r\n');
    socket.end(head);
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

    if (repositoryClose) {
      await repositoryClose();
    }

    await updatesNotifier.close();
  };

  // Startup config checks — callers should await `ready` before listening
  const ready: Promise<void> = (async () => {
    ensurePowChallengeConfig();
  })();

  return {
    server,
    shutdown,
    ready,
    __resetRateLimitForTests: () => {
      registrationDiscoverRateLimits.clear();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, shutdown, ready } = createServer();
  installApiProcessHandlers();

  // Await startup config checks before listening
  await ready.catch((err) => {
    logger.error('server_startup_failure', err);
    process.exit(1);
  });

  const port = Number(process.env.PORT ?? 8787);

  server.listen(port, () => {
    logger.info('server_listening', {
      url: `http://127.0.0.1:${port}/api`,
      authMode: 'hashed API-style bearer tokens in member_bearer_tokens',
    });
  });

  const stop = async () => {
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('server_shutdown_failure', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
