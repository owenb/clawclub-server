/**
 * GET /api/schema — self-describing API schema endpoint.
 *
 * Serves the full auto-generated contract for every action in the registry,
 * plus transport-level information (endpoints, auth, request/response
 * envelopes, update/stream schemas, error codes) so the schema is
 * self-sufficient — an agent needs no other document to make a correct call.
 *
 * Output is deterministic: actions sorted by name, stable JSON key order.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { getRegistry } from './schemas/registry.ts';
import {
  authenticatedSuccessEnvelope,
  unauthenticatedSuccessEnvelope,
  errorEnvelope,
  pollingResponse,
  sseReadyEvent,
} from './schemas/transport.ts';
import { pendingUpdate } from './schemas/responses.ts';

const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

type SchemaAction = {
  action: string;
  domain: string;
  description: string;
  auth: string;
  safety: string;
  authorizationNote?: string;
  input: unknown;
  output: unknown;
};

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

let schemaCache: unknown = null;

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

/**
 * Convert a Zod schema to JSON Schema using the same pipeline as action schemas.
 */
function toRelaxedJsonSchema(schema: z.ZodType): unknown {
  return relaxInputSchema(z.toJSONSchema(schema, { target: 'openapi-3.0' }));
}

/**
 * Build the transport section: endpoints, auth, envelopes, updates, error codes.
 */
function buildTransport(): unknown {
  return {
    endpoints: {
      action: { method: 'POST', path: '/api', contentType: 'application/json' },
      schema: { method: 'GET', path: '/api/schema' },
      updates: { method: 'GET', path: '/updates', contentType: 'application/json' },
      stream: { method: 'GET', path: '/updates/stream', contentType: 'text/event-stream' },
    },
    auth: {
      type: 'bearer',
      headerFormat: 'Authorization: Bearer cc_live_...',
      unauthenticatedActions: ['admissions.challenge', 'admissions.apply'],
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
      example: { action: 'session.describe', input: {} },
    },
    responseEnvelopes: {
      authenticatedSuccess: toRelaxedJsonSchema(authenticatedSuccessEnvelope),
      unauthenticatedSuccess: toRelaxedJsonSchema(unauthenticatedSuccessEnvelope),
      error: toRelaxedJsonSchema(errorEnvelope),
    },
    updates: {
      polling: {
        queryParameters: {
          limit: { type: 'integer', default: 10 },
          after: { type: 'string', description: 'Opaque cursor or "latest"' },
        },
        responseSchema: toRelaxedJsonSchema(pollingResponse),
      },
      stream: {
        events: {
          ready: toRelaxedJsonSchema(sseReadyEvent),
          update: toRelaxedJsonSchema(pendingUpdate),
        },
        note: 'Browser EventSource cannot set Authorization headers; use fetch with a streaming reader.',
      },
      acknowledgment: 'Acknowledge inbox-sourced updates via updates.acknowledge. Activity updates advance via cursor.',
    },
    transportErrorCodes: [
      { code: 'invalid_input', status: 400 },
      { code: 'invalid_json', status: 400 },
      { code: 'unknown_action', status: 400 },
      { code: 'unsupported_media_type', status: 415 },
      { code: 'unauthorized', status: 401 },
      { code: 'forbidden', status: 403 },
      { code: 'rate_limited', status: 429 },
      { code: 'payload_too_large', status: 413 },
      { code: 'internal_error', status: 500 },
      { code: 'not_implemented', status: 501 },
    ],
  };
}

function buildSchema(): unknown {
  const registry = getRegistry();
  const actions: SchemaAction[] = [];

  for (const [, def] of registry) {
    const inputSchema = relaxInputSchema(z.toJSONSchema(def.wire.input, { target: 'openapi-3.0' }));

    const entry: SchemaAction = {
      action: def.action,
      domain: def.domain,
      description: def.description,
      auth: def.auth,
      safety: def.safety,
      input: inputSchema,
      output: z.toJSONSchema(def.wire.output, { target: 'openapi-3.0' }),
    };

    if (def.authorizationNote) {
      entry.authorizationNote = def.authorizationNote;
    }

    actions.push(entry);
  }

  // Sort by action name for deterministic output
  actions.sort((a, b) => a.action.localeCompare(b.action));

  const transport = buildTransport();

  const payload = sortKeysDeep({
    version: PACKAGE_VERSION,
    transport,
    actions,
  });

  // Hash the full payload (transport + actions) so agents detect any contract change.
  const schemaHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

  return { ...(payload as Record<string, unknown>), schemaHash };
}

/**
 * Get the schema payload.
 * Caches after first build (schemas don't change at runtime).
 */
export function getSchemaPayload(): unknown {
  if (schemaCache) return schemaCache;
  schemaCache = buildSchema();
  return schemaCache;
}
