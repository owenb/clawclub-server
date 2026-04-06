/**
 * Embedding worker: processes queued embedding jobs asynchronously.
 *
 * Uses two database pools:
 *   - Identity pool: member_profile_version jobs (embeddings_jobs + member_profile_versions + embeddings_member_profile_artifacts)
 *   - Clubs pool: entity_version jobs (embeddings_jobs + entity_versions + embeddings_entity_artifacts)
 *
 * Usage:
 *   node --experimental-strip-types src/workers/embedding.ts          # loop mode
 *   node --experimental-strip-types src/workers/embedding.ts --once   # one-shot
 */
import type { Pool } from 'pg';
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { buildProfileSourceText, buildEntitySourceText, buildEventSourceText, computeSourceHash } from '../embedding-source.ts';
import { createPools, runWorkerLoop, runWorkerOnce, type WorkerPools } from './runner.ts';

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

// ── DB operations (inlined — no security definer functions) ──

async function claimJobs(pool: Pool, limit: number): Promise<EmbeddingJob[]> {
  const result = await pool.query<EmbeddingJob>(
    `update app.embeddings_jobs
     set attempt_count = attempt_count + 1,
         next_attempt_at = now() + interval '5 minutes'
     where id in (
       select id from app.embeddings_jobs
       where attempt_count < $1 and next_attempt_at <= now()
       order by next_attempt_at asc
       limit $2
       for update skip locked
     )
     returning id, subject_kind, subject_version_id, model, dimensions, source_version, attempt_count`,
    [MAX_ATTEMPTS, limit],
  );
  return result.rows;
}

async function loadProfileVersion(pool: Pool, versionId: string): Promise<ProfileVersionRow | null> {
  const result = await pool.query<ProfileVersionRow>(
    `select mpv.id, mpv.member_id, m.public_name,
            mpv.display_name, m.handle,
            mpv.tagline, mpv.summary, mpv.what_i_do, mpv.known_for,
            mpv.services_summary, mpv.website_url, mpv.links,
            (mpv.version_no = (select max(version_no) from app.member_profile_versions where member_id = mpv.member_id)) as is_current
     from app.member_profile_versions mpv
     join app.members m on m.id = mpv.member_id
     where mpv.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function loadEntityVersion(pool: Pool, versionId: string): Promise<EntityVersionRow | null> {
  const result = await pool.query<EntityVersionRow>(
    `select ev.id, ev.entity_id, e.kind::text as kind,
            ev.title, ev.summary, ev.body, ev.location,
            ev.starts_at::text as starts_at, ev.ends_at::text as ends_at,
            ev.timezone, ev.recurrence_rule, ev.content,
            (ev.state = 'published' and ev.version_no = (
              select max(version_no) from app.entity_versions where entity_id = ev.entity_id
            )) as is_current_published
     from app.entity_versions ev
     join app.entities e on e.id = ev.entity_id
     where ev.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function completeJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(`delete from app.embeddings_jobs where id = any($1::text[])`, [jobIds]);
}

async function retryJobs(pool: Pool, jobIds: string[], error: string): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update app.embeddings_jobs set failure_kind = 'work_error', last_error = $2,
            next_attempt_at = now() + (attempt_count * interval '1 minute')
     where id = any($1::text[])`,
    [jobIds, error.slice(0, 1000)],
  );
}

async function releaseJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update app.embeddings_jobs set attempt_count = greatest(attempt_count - 1, 0),
            next_attempt_at = now() + interval '30 seconds'
     where id = any($1::text[])`,
    [jobIds],
  );
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
    `insert into app.llm_usage_log (member_id, requested_club_id, action_name, gate_name, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [null, null, actionName, 'embedding_index', 'openai', EMBEDDING_PROFILES.member_profile.model, gateStatus, skipReason, promptTokens, completionTokens, providerErrorCode],
  ).catch(err => console.error('Failed to log embedding spend:', err));
}

// ── Source text building ────────────────────────────────

function buildSourceText(job: EmbeddingJob, row: ProfileVersionRow | EntityVersionRow): string {
  if (job.subject_kind === 'member_profile_version') {
    const p = row as ProfileVersionRow;
    return buildProfileSourceText({
      publicName: p.public_name, handle: p.handle, displayName: p.display_name,
      tagline: p.tagline, summary: p.summary, whatIDo: p.what_i_do,
      knownFor: p.known_for, servicesSummary: p.services_summary,
      websiteUrl: p.website_url, links: p.links,
    });
  }

  const e = row as EntityVersionRow;
  if (e.kind === 'event') {
    return buildEventSourceText({
      title: e.title, summary: e.summary, body: e.body,
      location: e.location, startsAt: e.starts_at, endsAt: e.ends_at,
      timezone: e.timezone, recurrenceRule: e.recurrence_rule, content: e.content,
    });
  }

  return buildEntitySourceText({
    kind: e.kind, title: e.title, summary: e.summary, body: e.body, content: e.content,
  });
}

// ── Job processing (processes one plane at a time) ──────

async function processPlane(pool: Pool, planeName: string, insertArtifact: (pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string) => Promise<void>): Promise<number> {
  const jobs = await claimJobs(pool, BATCH_SIZE);
  if (jobs.length === 0) return 0;

  type PreparedJob = { job: EmbeddingJob; sourceText: string; sourceHash: string };
  const prepared: PreparedJob[] = [];
  const staleJobIds: string[] = [];

  for (const job of jobs) {
    const row = job.subject_kind === 'member_profile_version'
      ? await loadProfileVersion(pool, job.subject_version_id)
      : await loadEntityVersion(pool, job.subject_version_id);

    if (!row || (job.subject_kind === 'member_profile_version' && !(row as ProfileVersionRow).is_current)
        || (job.subject_kind === 'entity_version' && !(row as EntityVersionRow).is_current_published)) {
      staleJobIds.push(job.id);
      continue;
    }

    const sourceText = buildSourceText(job, row);
    prepared.push({ job, sourceText, sourceHash: computeSourceHash(sourceText) });
  }

  await completeJobs(pool, staleJobIds);
  if (prepared.length === 0) return staleJobIds.length;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await releaseJobs(pool, prepared.map(p => p.job.id));
    logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'no_api_key', null, null, null);
    console.error(`OPENAI_API_KEY not set — released ${prepared.length} ${planeName} jobs`);
    return 0;
  }

  const provider = createOpenAI({ apiKey });
  const firstJob = prepared[0].job;
  const model = provider.embedding(firstJob.model, { dimensions: firstJob.dimensions });

  let embeddings: number[][];
  let usageTokens = 0;
  try {
    const result = await embedMany({ model, values: prepared.map(p => p.sourceText) });
    embeddings = result.embeddings;
    usageTokens = result.usage?.tokens ?? 0;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isConfigError = /api key|unauthorized|quota|rate limit|insufficient|billing/i.test(errorMsg);
    if (isConfigError) {
      await releaseJobs(pool, prepared.map(p => p.job.id));
    } else {
      await retryJobs(pool, prepared.map(p => p.job.id), errorMsg);
    }
    logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'provider_error', null, null, errorMsg.slice(0, 200));
    console.error(`${planeName} ${isConfigError ? 'config' : 'work'} error:`, errorMsg);
    return 0;
  }

  logEmbeddingSpend(pool, 'embedding_worker', 'passed', null, usageTokens, 0, null);

  const completedJobIds: string[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const { job, sourceText, sourceHash } = prepared[i];
    const vectorStr = `[${embeddings[i].join(',')}]`;
    try {
      await insertArtifact(pool, job, sourceText, sourceHash, vectorStr);
      completedJobIds.push(job.id);
    } catch (err) {
      await retryJobs(pool, [job.id], err instanceof Error ? err.message : String(err));
      console.error(`Failed to store ${planeName} artifact for job ${job.id}:`, err);
    }
  }

  await completeJobs(pool, completedJobIds);
  console.log(`${planeName}: ${completedJobIds.length} embeddings, ${staleJobIds.length} stale`);
  return completedJobIds.length + staleJobIds.length;
}

async function insertProfileArtifact(pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string): Promise<void> {
  const memberResult = await pool.query<{ member_id: string }>(
    `select member_id from app.member_profile_versions where id = $1`,
    [job.subject_version_id],
  );
  const memberId = memberResult.rows[0]?.member_id;
  if (!memberId) throw new Error(`No member found for profile version ${job.subject_version_id}`);

  await pool.query(
    `insert into app.embeddings_member_profile_artifacts (member_id, profile_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata)
     values ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector, '{}'::jsonb)
     on conflict (member_id, model, dimensions, source_version, chunk_index) do update
       set profile_version_id = excluded.profile_version_id,
           source_text = excluded.source_text,
           source_hash = excluded.source_hash,
           embedding = excluded.embedding,
           updated_at = now()`,
    [memberId, job.subject_version_id, job.model, job.dimensions, job.source_version, sourceText, sourceHash, vectorStr],
  );
}

async function insertEntityArtifact(pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string): Promise<void> {
  const entityResult = await pool.query<{ entity_id: string }>(
    `select entity_id from app.entity_versions where id = $1`,
    [job.subject_version_id],
  );
  const entityId = entityResult.rows[0]?.entity_id;
  if (!entityId) throw new Error(`No entity found for version ${job.subject_version_id}`);

  await pool.query(
    `insert into app.embeddings_entity_artifacts (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata)
     values ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector, '{}'::jsonb)
     on conflict (entity_id, model, dimensions, source_version, chunk_index) do update
       set entity_version_id = excluded.entity_version_id,
           source_text = excluded.source_text,
           source_hash = excluded.source_hash,
           embedding = excluded.embedding,
           updated_at = now()`,
    [entityId, job.subject_version_id, job.model, job.dimensions, job.source_version, sourceText, sourceHash, vectorStr],
  );
}

// ── Worker entry point ─────────────────────────────────

async function processEmbeddings(pools: WorkerPools): Promise<number> {
  const profileCount = await processPlane(pools.identity, 'identity/profiles', insertProfileArtifact);
  const entityCount = await processPlane(pools.clubs, 'clubs/entities', insertEntityArtifact);
  return profileCount + entityCount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pools = createPools({ identity: true, clubs: true });
  const healthPort = process.env.WORKER_HEALTH_PORT ? parseInt(process.env.WORKER_HEALTH_PORT, 10) : undefined;

  if (process.argv.includes('--once')) {
    await runWorkerOnce('embedding', pools, processEmbeddings);
  } else {
    await runWorkerLoop('embedding', pools, processEmbeddings, {
      pollIntervalMs: POLL_INTERVAL_MS,
      healthPort,
    });
  }
}

export { processEmbeddings };
