/**
 * GET /api/schema — self-describing API schema endpoint.
 *
 * Serves the full auto-generated contract for every action in the registry,
 * plus transport-level information (endpoints, auth, request/response
 * envelopes, stream schemas, error codes) so the schema is
 * self-sufficient — an agent needs no other document to make a correct call.
 *
 * Output is deterministic: actions sorted by name, stable JSON key order.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfig, getInstancePolicyFingerprint, getPublicInstancePolicy } from './config/index.ts';
import { getRegistry, type SchemaBusinessError } from './schemas/registry.ts';
import { PACKAGE_VERSION } from './version.ts';
import {
  authenticatedSuccessEnvelope,
  unauthenticatedSuccessEnvelope,
  errorEnvelope,
  sseReadyEvent,
  sseActivityEvent,
  sseMessageEvent,
  sseNotificationsDirtyEvent,
  sseClosedEvent,
} from './schemas/transport.ts';

type SchemaAction = {
  action: string;
  domain: string;
  description: string;
  auth: string;
  safety: string;
  authorizationNote?: string;
  businessErrors?: SchemaBusinessError[];
  scopeRules?: string[];
  notes?: string[];
  input: unknown;
  output: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatDurationMs(ms: number): string {
  const units = [
    { label: 'hour', ms: 60 * 60 * 1000 },
    { label: 'minute', ms: 60 * 1000 },
    { label: 'second', ms: 1000 },
  ] as const;

  let remaining = ms;
  const parts: string[] = [];

  for (const unit of units) {
    const count = Math.floor(remaining / unit.ms);
    if (count <= 0) continue;
    parts.push(`${count} ${unit.label}${count === 1 ? '' : 's'}`);
    remaining %= unit.ms;
  }

  if (remaining > 0 || parts.length === 0) {
    parts.push(`${remaining} millisecond${remaining === 1 ? '' : 's'}`);
  }

  return parts.slice(0, 2).join(' ');
}

function formatRegistrationChallengeTtl(ttlMs: number): string {
  return `${ttlMs} ms (${formatDurationMs(ttlMs)})`;
}

function getSchemaProperty(schema: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(schema)) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  const child = properties[key];
  return isRecord(child) ? child : null;
}

function findUnionVariantByEnumValue(schema: unknown, field: string, value: string): Record<string, unknown> | null {
  if (!isRecord(schema)) return null;
  const variants = schema.oneOf;
  if (!Array.isArray(variants)) return null;

  for (const variant of variants) {
    const fieldSchema = getSchemaProperty(variant, field);
    if (!fieldSchema || !Array.isArray(fieldSchema.enum)) continue;
    if (fieldSchema.enum.includes(value)) {
      return variant as Record<string, unknown>;
    }
  }

  return null;
}

function annotateAccountsRegisterSchema(entry: SchemaAction): void {
  const ttlMs = getConfig().policy.pow.challengeTtlMs;
  const ttlText = formatRegistrationChallengeTtl(ttlMs);
  const ttlNote = `Registration challenge TTL: ${ttlText} from issuance. Read challenge.expiresAt and finish both solving and submit before it. There is no extra post-solve grace period.`;

  entry.notes = [...(entry.notes ?? []), ttlNote];

  const discoverVariant = findUnionVariantByEnumValue(entry.input, 'mode', 'discover');
  const discoverMode = getSchemaProperty(discoverVariant, 'mode');
  if (discoverMode) {
    discoverMode.description = `First call: get a registration proof-of-work challenge. Current registration challenge TTL: ${ttlText} from issuance. Read challenge.expiresAt and submit before it.`;
  }

  const proofRequiredVariant = findUnionVariantByEnumValue(entry.output, 'phase', 'proof_required');
  const challengeSchema = getSchemaProperty(proofRequiredVariant, 'challenge');
  const challengeExpiresAt = getSchemaProperty(challengeSchema, 'expiresAt');
  if (challengeExpiresAt) {
    challengeExpiresAt.description = `Authoritative ISO 8601 expiry for this specific registration challenge. Current configured TTL is ${ttlText} from issuance. The same window covers both solving and submit; there is no extra post-solve grace period.`;
  }

  if (entry.businessErrors) {
    entry.businessErrors = entry.businessErrors.map((error) => {
      if (error.code !== 'challenge_expired') return error;
      return {
        ...error,
        meaning: `The supplied registration challenge expired before submit completed. The current configured TTL is ${ttlText} from issuance.`,
      };
    });
  }
}

/**
 * Recursively sort all object keys for deterministic output.
 * Handles nested objects and arrays. Primitives pass through unchanged.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

let schemaCache: { fingerprint: string; payload: unknown } | null = null;

function relaxInputSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(relaxInputSchema);
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (key === 'additionalProperties' && child === false) {
        continue;
      }
      next[key] = relaxInputSchema(child);
    }
    return next;
  }

  return value;
}

function markDefaultedPropertiesOptional(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(markDefaultedPropertiesOptional);
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(obj)) {
      next[key] = markDefaultedPropertiesOptional(child);
    }

    const properties = next.properties;
    const required = next.required;
    if (
      properties
      && typeof properties === 'object'
      && !Array.isArray(properties)
      && Array.isArray(required)
    ) {
      const propertyMap = properties as Record<string, Record<string, unknown>>;
      next.required = required.filter((key) => propertyMap[key]?.default === undefined);
      if ((next.required as unknown[]).length === 0) {
        delete next.required;
      }
    }

    return next;
  }

  return value;
}

/**
 * Convert a Zod schema to JSON Schema using the same pipeline as action schemas.
 */
function toRelaxedJsonSchema(schema: z.ZodType): unknown {
  return relaxInputSchema(z.toJSONSchema(schema, { target: 'openapi-3.0' }));
}

function toActionJsonSchema(schema: z.ZodType): unknown {
  return markDefaultedPropertiesOptional(z.toJSONSchema(schema, { target: 'openapi-3.0' }));
}

/**
 * Build the transport section: endpoints, auth, envelopes, stream, error codes.
 */
function buildTransport(unauthenticatedActions: string[]): unknown {
  return {
    endpoints: {
      action: { method: 'POST', path: '/api', contentType: 'application/json' },
      schema: { method: 'GET', path: '/api/schema' },
      stream: { method: 'GET', path: '/stream', contentType: 'text/event-stream' },
    },
    auth: {
      type: 'bearer',
      headerFormat: 'Authorization: Bearer clawclub_...',
      unauthenticatedActions,
    },
    requestEnvelope: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['action'],
      },
      example: { action: 'session.getContext', input: {} },
    },
    responseEnvelopes: {
      authenticatedSuccess: toRelaxedJsonSchema(authenticatedSuccessEnvelope),
      unauthenticatedSuccess: toRelaxedJsonSchema(unauthenticatedSuccessEnvelope),
      error: toRelaxedJsonSchema(errorEnvelope),
    },
    stream: {
      queryParameters: {
        after: { type: 'string', description: 'Optional activity cursor seed. Omit to rely on Last-Event-ID or the current tip.' },
        limit: { type: 'integer', default: 20, maximum: 20, description: 'Max activity or DM items per poll cycle inside the stream (1-20).' },
      },
      resumeHeaders: {
        'Last-Event-ID': 'Used for activity resumption only. Ready frames attach the current activity seq when one exists, and activity frames always attach seq as the SSE id; message and notifications_dirty frames do not advance any cursor. After reconnect, use updates.list to catch up on missed DM and notification state.',
      },
      sseIdBehavior: 'Ready frames attach the current activity seq when one exists, and activity frames always attach seq as the SSE id. Only activity is replayable; message and notifications_dirty frames are stateless on reconnect, so clients must use updates.list to catch up on missed DM and notification state.',
      heartbeat: { comment: 'keepalive', intervalMs: 15_000 },
      maxConcurrentStreamsPerMember: getConfig().policy.transport.maxStreamsPerMember,
      events: {
        ready: toRelaxedJsonSchema(sseReadyEvent),
        activity: toRelaxedJsonSchema(sseActivityEvent),
        message: toRelaxedJsonSchema(sseMessageEvent),
        notifications_dirty: toRelaxedJsonSchema(sseNotificationsDirtyEvent),
        closed: toRelaxedJsonSchema(sseClosedEvent),
      },
      note: 'Browser EventSource cannot set Authorization headers; use fetch with a streaming reader.',
    },
    acknowledgment: 'Acknowledge queued notifications via updates.acknowledge(notificationIds) and DM inbox entries via updates.acknowledge(threadId). Sending a DM reply also auto-marks that thread read for the sender. Activity advances via the activity cursor.',
    // Transport-surface and dispatch-layer error codes only.
    // Action-level business codes (illegal_content, gate_unavailable, quota_exceeded, etc.)
    // are documented per-action and are NOT included here.
    transportErrorCodes: [
      { code: 'invalid_input', status: 400 },
      { code: 'invalid_json', status: 400 },
      { code: 'unknown_action', status: 400 },
      { code: 'not_found', status: 404 },
      { code: 'unsupported_media_type', status: 415 },
      { code: 'unauthorized', status: 401 },
      { code: 'forbidden', status: 403 },
      { code: 'rate_limited', status: 429 },
      { code: 'payload_too_large', status: 413 },
      { code: 'stale_client', status: 409, meaning: 'The client cached an older schema. Refetch /api/schema and /skill, then retry.' },
      { code: 'internal_error', status: 500 },
      { code: 'not_implemented', status: 501 },
    ],
  };
}

function buildSchema(): unknown {
  const registry = getRegistry();
  const actions: SchemaAction[] = [];

  for (const [, def] of registry) {
    const inputSchema = toActionJsonSchema(def.wire.input);

    const entry: SchemaAction = {
      action: def.action,
      domain: def.domain,
      description: def.description,
      auth: def.auth,
      safety: def.safety,
      input: inputSchema,
      output: toActionJsonSchema(def.wire.output),
    };

    if (def.authorizationNote) {
      entry.authorizationNote = def.authorizationNote;
    }
    if (def.businessErrors) {
      entry.businessErrors = def.businessErrors;
    }
    if (def.scopeRules) {
      entry.scopeRules = def.scopeRules;
    }
    if (def.notes) {
      entry.notes = def.notes;
    }

    if (def.action === 'accounts.register') {
      annotateAccountsRegisterSchema(entry);
    }

    actions.push(entry);
  }

  // Sort by action name for deterministic output
  actions.sort((a, b) => a.action.localeCompare(b.action));

  const unauthenticatedActions = [...registry.values()]
    .filter((def) => def.auth === 'none')
    .map((def) => def.action)
    .sort((a, b) => a.localeCompare(b));

  const transport = buildTransport(unauthenticatedActions);
  const instancePolicy = getPublicInstancePolicy();

  const payload = sortKeysDeep({
    version: PACKAGE_VERSION,
    transport,
    instancePolicy,
    actions,
  });

  const hashInput = sortKeysDeep({ transport, instancePolicy, actions });
  const schemaHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 16);

  return { ...(payload as Record<string, unknown>), schemaHash };
}

/**
 * Get the schema payload.
 * Caches after first build (schemas don't change at runtime).
 */
export function getSchemaPayload(): unknown {
  const fingerprint = getInstancePolicyFingerprint();
  if (schemaCache && schemaCache.fingerprint === fingerprint) {
    return schemaCache.payload;
  }
  const payload = buildSchema();
  schemaCache = { fingerprint, payload };
  return payload;
}
