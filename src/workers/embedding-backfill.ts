/**
 * Embedding backfill: enqueues embedding jobs for current searchable subjects
 * that don't already have artifacts.
 *
 * Uses a single database pool.
 *
 * Usage:
 *   node --experimental-strip-types src/workers/embedding-backfill.ts
 *
 * Run this after migrations, then run the embedding worker to process the queue.
 */
import { EMBEDDING_PROFILES } from '../ai.ts';
import { createPools, closePools, installWorkerProcessHandlers, type WorkerPools } from './runner.ts';

async function backfill(pools: WorkerPools): Promise<void> {
  const profileConfig = EMBEDDING_PROFILES.member_profile;
  const entityConfig = EMBEDDING_PROFILES.entity;

  // Enqueue current profile versions that lack artifacts
  const profileResult = await pools.db.query<{ id: string }>(
    `select cmcp.id from current_member_club_profiles cmcp
     where not exists (
       select 1 from member_profile_embeddings empa
       where empa.member_id = cmcp.member_id
         and empa.club_id = cmcp.club_id
         and empa.model = $1 and empa.dimensions = $2 and empa.source_version = $3
     )`,
    [profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
  );

  for (const row of profileResult.rows) {
    await pools.db.query(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('member_club_profile_version', $1, $2, $3, $4)
       on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
      [row.id, profileConfig.model, profileConfig.dimensions, profileConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${profileResult.rows.length} profile embedding jobs`);

  // Enqueue current published entity versions that lack artifacts
  const entityResult = await pools.db.query<{ id: string }>(
    `select cev.id from current_entity_versions cev
     join entities e on e.id = cev.entity_id
     where cev.state = 'published' and e.deleted_at is null
       and not exists (
         select 1 from entity_embeddings eea
         where eea.entity_id = e.id
           and eea.model = $1 and eea.dimensions = $2 and eea.source_version = $3
       )`,
    [entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
  );

  for (const row of entityResult.rows) {
    await pools.db.query(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('entity_version', $1, $2, $3, $4)
       on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
      [row.id, entityConfig.model, entityConfig.dimensions, entityConfig.sourceVersion],
    );
  }
  console.log(`Enqueued ${entityResult.rows.length} entity/event embedding jobs`);
}

// ── Main ────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  installWorkerProcessHandlers('embedding-backfill');
  const pools = createPools({ maxConnections: 2, name: 'embedding-backfill' });
  try {
    await backfill(pools);
  } finally {
    await closePools(pools);
  }
}

export { backfill };
