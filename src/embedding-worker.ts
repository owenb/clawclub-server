/**
 * Embedding worker: processes queued embedding jobs asynchronously.
 *
 * All DB access goes through SECURITY DEFINER functions so the worker
 * does not need actor context and cannot bypass RLS on user-facing tables.
 *
 * Usage:
 *   node --experimental-strip-types src/embedding-worker.ts          # loop mode
 *   node --experimental-strip-types src/embedding-worker.ts --once   # one-shot
 */
import { Pool } from 'pg';
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { EMBEDDING_PROFILES } from './ai.ts';
import { buildProfileSourceText, buildEntitySourceText, buildEventSourceText, computeSourceHash } from './embedding-source.ts';

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 5;

type EmbeddingJob = {
  id: string;
  subject_kind: 'member_profile_version' | 'entity_version';
  subject_version_id: string;
  model: string;
  dimensions: number;
  source_version: string;
  attempt_count: number;
};

type ProfileVersionRow = {
  id: string;
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: unknown[] | null;
  is_current: boolean;
};

type EntityVersionRow = {
  id: string;
  entity_id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  content: Record<string, unknown> | null;
  is_current_published: boolean;
};

// ── DB operations via security definer functions ────────

async function claimJobs(pool: Pool, limit: number): Promise<EmbeddingJob[]> {
  const result = await pool.query<EmbeddingJob>(
    `SELECT * FROM app.embeddings_claim_jobs($1, $2)`,
    [MAX_ATTEMPTS, limit],
  );
  return result.rows;
}

async function loadProfileVersion(pool: Pool, versionId: string): Promise<ProfileVersionRow | null> {
  const result = await pool.query<ProfileVersionRow>(
    `SELECT * FROM app.embeddings_load_profile_version($1)`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function loadEntityVersion(pool: Pool, versionId: string): Promise<EntityVersionRow | null> {
  const result = await pool.query<EntityVersionRow>(
    `SELECT * FROM app.embeddings_load_entity_version($1)`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function completeJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(`SELECT app.embeddings_complete_jobs($1::app.short_id[])`, [jobIds]);
}

async function retryJobs(pool: Pool, jobIds: string[], error: string): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(`SELECT app.embeddings_retry_jobs($1::app.short_id[], $2)`, [jobIds, error.slice(0, 1000)]);
}

async function releaseJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(`SELECT app.embeddings_release_jobs($1::app.short_id[])`, [jobIds]);
}

// ── Spend logging ───────────────────────────────────────

function logEmbeddingSpend(
  pool: Pool,
  actionName: string,
  gateStatus: 'passed' | 'skipped',
  skipReason: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
  providerErrorCode: string | null,
): void {
  pool.query(
    `SELECT app.log_llm_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      null,
      null,
      actionName,
      'embedding_index',
      'openai',
      EMBEDDING_PROFILES.member_profile.model,
      gateStatus,
      skipReason,
      promptTokens,
      completionTokens,
      providerErrorCode,
    ],
  ).catch(err => console.error('Failed to log embedding spend:', err));
}

// ── Source text building ────────────────────────────────

function buildSourceText(job: EmbeddingJob, row: ProfileVersionRow | EntityVersionRow): string {
  if (job.subject_kind === 'member_profile_version') {
    const p = row as ProfileVersionRow;
    return buildProfileSourceText({
      publicName: p.public_name,
      handle: p.handle,
      displayName: p.display_name,
      tagline: p.tagline,
      summary: p.summary,
      whatIDo: p.what_i_do,
      knownFor: p.known_for,
      servicesSummary: p.services_summary,
      websiteUrl: p.website_url,
      links: p.links,
    });
  }

  const e = row as EntityVersionRow;
  if (e.kind === 'event') {
    return buildEventSourceText({
      title: e.title,
      summary: e.summary,
      body: e.body,
      location: e.location,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      timezone: e.timezone,
      recurrenceRule: e.recurrence_rule,
      content: e.content,
    });
  }

  return buildEntitySourceText({
    kind: e.kind,
    title: e.title,
    summary: e.summary,
    body: e.body,
    content: e.content,
  });
}

// ── Job processing ──────────────────────────────────────

async function processJobs(pool: Pool): Promise<number> {
  const jobs = await claimJobs(pool, BATCH_SIZE);
  if (jobs.length === 0) return 0;

  // Load subject data and filter to current/published versions
  type PreparedJob = { job: EmbeddingJob; sourceText: string; sourceHash: string };
  const prepared: PreparedJob[] = [];
  const staleJobIds: string[] = [];

  for (const job of jobs) {
    if (job.subject_kind === 'member_profile_version') {
      const row = await loadProfileVersion(pool, job.subject_version_id);
      if (!row || !row.is_current) {
        staleJobIds.push(job.id);
        continue;
      }
      const sourceText = buildSourceText(job, row);
      prepared.push({ job, sourceText, sourceHash: computeSourceHash(sourceText) });
    } else {
      const row = await loadEntityVersion(pool, job.subject_version_id);
      if (!row || !row.is_current_published) {
        staleJobIds.push(job.id);
        continue;
      }
      const sourceText = buildSourceText(job, row);
      prepared.push({ job, sourceText, sourceHash: computeSourceHash(sourceText) });
    }
  }

  // Delete stale jobs
  await completeJobs(pool, staleJobIds);

  if (prepared.length === 0) return staleJobIds.length;

  // Generate embeddings in batch
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const ids = prepared.map(p => p.job.id);
    await releaseJobs(pool, ids);
    logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'no_api_key', null, null, null);
    console.error('OPENAI_API_KEY not set — released', ids.length, 'jobs without penalising');
    return 0;
  }

  const provider = createOpenAI({ apiKey });
  // All jobs in a batch use the same model/dimensions (the code-configured profile).
  const firstJob = prepared[0].job;
  const model = provider.embedding(firstJob.model, { dimensions: firstJob.dimensions });

  let embeddings: number[][];
  let usageTokens = 0;
  try {
    const result = await embedMany({
      model,
      values: prepared.map(p => p.sourceText),
    });
    embeddings = result.embeddings;
    usageTokens = result.usage?.tokens ?? 0;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Distinguish config/quota errors from work errors
    const isConfigError = /api key|unauthorized|quota|rate limit|insufficient|billing/i.test(errorMsg);
    if (isConfigError) {
      await releaseJobs(pool, prepared.map(p => p.job.id));
      logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'provider_error', null, null, errorMsg.slice(0, 200));
      console.error(`Config/quota error, ${prepared.length} jobs released without penalty:`, errorMsg);
    } else {
      await retryJobs(pool, prepared.map(p => p.job.id), errorMsg);
      logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'provider_error', null, null, errorMsg.slice(0, 200));
      console.error(`Work error, ${prepared.length} jobs scheduled for retry:`, errorMsg);
    }
    return 0;
  }

  // Log successful embedding spend
  logEmbeddingSpend(pool, 'embedding_worker', 'passed', null, usageTokens, 0, null);

  // Store artifacts and complete jobs
  const completedJobIds: string[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const { job, sourceText, sourceHash } = prepared[i];
    const embedding = embeddings[i];
    const vectorStr = `[${embedding.join(',')}]`;

    try {
      if (job.subject_kind === 'member_profile_version') {
        await pool.query(
          `SELECT app.embeddings_insert_profile_artifact($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)`,
          [
            job.subject_version_id,
            job.model,
            job.dimensions,
            job.source_version,
            0, // chunk_index
            sourceText,
            sourceHash,
            vectorStr,
            JSON.stringify({}),
          ],
        );
      } else {
        await pool.query(
          `SELECT app.embeddings_insert_entity_artifact($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)`,
          [
            job.subject_version_id,
            job.model,
            job.dimensions,
            job.source_version,
            0, // chunk_index
            sourceText,
            sourceHash,
            vectorStr,
            JSON.stringify({}),
          ],
        );
      }
      completedJobIds.push(job.id);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await retryJobs(pool, [job.id], errorMsg);
      console.error(`Failed to store artifact for job ${job.id}:`, errorMsg);
    }
  }

  await completeJobs(pool, completedJobIds);

  console.log(`Processed ${completedJobIds.length} embeddings, ${staleJobIds.length} stale jobs removed`);
  return completedJobIds.length + staleJobIds.length;
}

async function runLoop(pool: Pool): Promise<void> {
  console.log('Embedding worker started (loop mode)');
  while (true) {
    try {
      const processed = await processJobs(pool);
      if (processed === 0) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error('Worker loop error:', err);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

async function runOnce(pool: Pool): Promise<void> {
  console.log('Embedding worker started (one-shot mode)');
  let total = 0;
  while (true) {
    const processed = await processJobs(pool);
    total += processed;
    if (processed === 0) break;
  }
  console.log(`One-shot complete: ${total} jobs processed`);
}

// ── Main ────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const once = process.argv.includes('--once');

  try {
    if (once) {
      await runOnce(pool);
    } else {
      await runLoop(pool);
    }
  } finally {
    await pool.end();
  }
}

export { processJobs, runOnce, runLoop };
