/**
 * Regenerate test/snapshots/api-schema.json from the live action registry.
 *
 * Run after changing any schema field/action description that flows into
 * GET /api/schema. The integration smoke test asserts an exact match against
 * the snapshot, so it must be updated in the same commit as the schema edit.
 *
 * Usage:
 *   node --experimental-strip-types scripts/regen-schema-snapshot.ts
 */
import { writeFileSync } from 'node:fs';
import '../src/dispatch.ts';
import { DEFAULT_CONFIG_V1, initializeConfigForTests } from '../src/config/index.ts';
import { getSchemaPayload } from '../src/schema-endpoint.ts';

// getSchemaPayload() returns the raw schema object — server.ts wraps it in
// { ok: true, data: schema } at the HTTP boundary, and the smoke test compares
// against body.data, so the snapshot stores the raw payload directly.
initializeConfigForTests(DEFAULT_CONFIG_V1);
const snapshotPath = new URL('../test/snapshots/api-schema.json', import.meta.url).pathname;
writeFileSync(snapshotPath, JSON.stringify(getSchemaPayload(), null, 2));
console.log(`Wrote ${snapshotPath}`);
