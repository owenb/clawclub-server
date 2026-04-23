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
import { logger } from '../logger.ts';
import { createPools, closePools, installWorkerProcessHandlers, type WorkerPools } from './runner.ts';

async function backfill(pools: WorkerPools): Promise<void> {
  const profileConfig = EMBEDDING_PROFILES.member_profile;
  const contentConfig = EMBEDDING_PROFILES.content;

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
  logger.info('embedding_backfill_profiles_enqueued', { count: profileResult.rows.length });

  // Enqueue current published content versions that lack artifacts
  const contentResult = await pools.db.query<{ id: string }>(
    `select cev.id from current_content_versions cev
     join contents e on e.id = cev.content_id
     where cev.state = 'published' and e.deleted_at is null
       and not exists (
         select 1 from content_embeddings eea
         where eea.content_id = e.id
           and eea.model = $1 and eea.dimensions = $2 and eea.source_version = $3
       )`,
    [contentConfig.model, contentConfig.dimensions, contentConfig.sourceVersion],
  );

  for (const row of contentResult.rows) {
    await pools.db.query(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('content_version', $1, $2, $3, $4)
       on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
      [row.id, contentConfig.model, contentConfig.dimensions, contentConfig.sourceVersion],
    );
  }
  logger.info('embedding_backfill_contents_enqueued', { count: contentResult.rows.length });
}

// ── Main ────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  installWorkerProcessHandlers('embedding-backfill');
  const pools = createPools({ maxConnections: 2, name: 'embedding-backfill', requiredEnv: ['OPENAI_API_KEY'] });
  try {
    await backfill(pools);
  } finally {
    await closePools(pools);
  }
}

export { backfill };
