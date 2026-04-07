/**
 * GET /api/schema — self-describing API schema endpoint.
 *
 * Serves the full auto-generated contract for every action in the registry.
 * Output is deterministic: actions sorted by name, stable JSON key order.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { getRegistry } from './schemas/registry.ts';

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

  // Compute a content hash from the sorted actions so agents can detect
  // schema changes with a single comparison, without diffing the full payload.
  const actionsJson = JSON.stringify(actions);
  const schemaHash = createHash('sha256').update(actionsJson).digest('hex').slice(0, 16);

  return sortKeysDeep({
    version: PACKAGE_VERSION,
    schemaHash,
    actions,
  });
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
