/**
 * Embedding backfill: enqueues embedding jobs for current searchable subjects
 * that don't already have artifacts.
 *
 * All DB access goes through SECURITY DEFINER functions so the backfill
 * does not need actor context and cannot bypass RLS on user-facing tables.
 *
 * Usage:
 *   node --experimental-strip-types src/embedding-backfill.ts
 *
 * Run this after migration 0069, then run the embedding worker to process the queue.
 */
import { Pool } from 'pg';
import { EMBEDDING_PROFILES } from './ai.ts';

async function backfill(pool: Pool): Promise<void> {
  const profileConfig = EMBEDDING_PROFILES.member_profile;
  const entityConfig = EMBEDDING_PROFILES.entity;

  // Enqueue current profile versions that lack artifacts
  const profileResult = await pool.query<{ version_id: string }>(
    `SELECT version_id FROM app.embeddings_list_profiles_needing_artifacts($1, $2, $3)`,
    [profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
  );

  for (const row of profileResult.rows) {
    await pool.query(
      `SELECT app.embeddings_enqueue_job($1, $2, $3, $4, $5)`,
      ['member_profile_version', row.version_id, profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${profileResult.rows.length} profile embedding jobs`);

  // Enqueue current published entity versions that lack artifacts
  const entityResult = await pool.query<{ version_id: string }>(
    `SELECT version_id FROM app.embeddings_list_entities_needing_artifacts($1, $2, $3)`,
    [entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
  );

  for (const row of entityResult.rows) {
    await pool.query(
      `SELECT app.embeddings_enqueue_job($1, $2, $3, $4, $5)`,
      ['entity_version', row.version_id, entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${entityResult.rows.length} entity/event embedding jobs`);
}

// ── Main ────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await backfill(pool);
  } finally {
    await pool.end();
  }
}

export { backfill };
