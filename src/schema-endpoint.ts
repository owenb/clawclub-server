/**
 * GET /api/schema — self-describing API schema endpoint.
 *
 * Serves the public contract for all actions from the registry.
 * Default (unauthenticated): only aiExposed actions.
 * With superadmin auth + ?full=1: all actions.
 *
 * Output is deterministic: actions sorted by name, stable JSON key order.
 */
import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRegistry } from './schemas/registry.ts';
import type { Repository } from './app-contract.ts';

type SchemaAction = {
  action: string;
  domain: string;
  description: string;
  auth: string;
  safety: string;
  aiExposed: boolean;
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

let cachedPublicSchema: unknown = null;
let cachedFullSchema: unknown = null;

function buildSchema(aiExposedOnly: boolean): unknown {
  const registry = getRegistry();
  const actions: SchemaAction[] = [];

  for (const [, def] of registry) {
    if (aiExposedOnly && !def.aiExposed) continue;

    const entry: SchemaAction = {
      action: def.action,
      domain: def.domain,
      description: def.description,
      auth: def.auth,
      safety: def.safety,
      aiExposed: def.aiExposed,
      input: zodToJsonSchema(def.wire.input, { target: 'openApi3' }),
      output: zodToJsonSchema(def.wire.output, { target: 'openApi3' }),
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
    version: '1.0',
    schemaHash,
    actions,
  });
}

/**
 * Get the schema payload for the given access level.
 * Caches after first build (schemas don't change at runtime).
 */
export function getSchemaPayload(full: boolean): unknown {
  if (full) {
    if (!cachedFullSchema) {
      cachedFullSchema = buildSchema(false);
    }
    return cachedFullSchema;
  }

  if (!cachedPublicSchema) {
    cachedPublicSchema = buildSchema(true);
  }
  return cachedPublicSchema;
}

/**
 * Determine if the request should see the full schema.
 * Requires bearer token auth with superadmin role + ?full=1 query param.
 */
export async function resolveSchemaAccess(
  bearerToken: string | null,
  fullParam: string | null,
  repository: Repository,
): Promise<boolean> {
  if (fullParam !== '1') return false;
  if (!bearerToken) return false;

  const auth = await repository.authenticateBearerToken(bearerToken);
  if (!auth) return false;

  return auth.actor.globalRoles.includes('superadmin');
}
