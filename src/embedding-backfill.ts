/**
 * Embedding backfill: enqueues embedding jobs for current searchable subjects
 * that don't already have artifacts.
 *
 * Uses two pools: identity (profiles) and clubs (entities).
 *
 * Usage:
 *   node --experimental-strip-types src/embedding-backfill.ts
 *
 * Run this after the split migrations, then run the embedding worker to process the queue.
 */
import { Pool } from 'pg';
import { EMBEDDING_PROFILES } from './ai.ts';

async function backfill(identityPool: Pool, clubsPool: Pool): Promise<void> {
  const profileConfig = EMBEDDING_PROFILES.member_profile;
  const entityConfig = EMBEDDING_PROFILES.entity;

  // Enqueue current profile versions that lack artifacts (identity DB)
  const profileResult = await identityPool.query<{ id: string }>(
    `select cmp.id from app.current_member_profiles cmp
     where not exists (
       select 1 from app.embeddings_member_profile_artifacts empa
       where empa.member_id = cmp.member_id
         and empa.model = $1 and empa.dimensions = $2 and empa.source_version = $3
     )`,
    [profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
  );

  for (const row of profileResult.rows) {
    await identityPool.query(
      `insert into app.embeddings_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('member_profile_version', $1, $2, $3, $4)
       on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
      [row.id, profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${profileResult.rows.length} profile embedding jobs`);

  // Enqueue current published entity versions that lack artifacts (clubs DB)
  const entityResult = await clubsPool.query<{ id: string }>(
    `select cev.id from app.current_entity_versions cev
     join app.entities e on e.id = cev.entity_id
     where cev.state = 'published' and e.deleted_at is null
       and not exists (
         select 1 from app.embeddings_entity_artifacts eea
         where eea.entity_id = e.id
           and eea.model = $1 and eea.dimensions = $2 and eea.source_version = $3
       )`,
    [entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
  );

  for (const row of entityResult.rows) {
    await clubsPool.query(
      `insert into app.embeddings_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('entity_version', $1, $2, $3, $4)
       on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
      [row.id, entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${entityResult.rows.length} entity/event embedding jobs`);
}

// ── Main ────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const identityUrl = process.env.IDENTITY_DATABASE_URL;
  const clubsUrl = process.env.CLUBS_DATABASE_URL;
  if (!identityUrl || !clubsUrl) {
    console.error('IDENTITY_DATABASE_URL and CLUBS_DATABASE_URL must be set');
    process.exit(1);
  }

  const identityPool = new Pool({ connectionString: identityUrl, max: 2 });
  const clubsPool = new Pool({ connectionString: clubsUrl, max: 2 });
  try {
    await backfill(identityPool, clubsPool);
  } finally {
    await identityPool.end();
    await clubsPool.end();
  }
}

export { backfill };
