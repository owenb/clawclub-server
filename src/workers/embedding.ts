/**
 * Embedding worker: processes queued embedding jobs asynchronously.
 *
 * Uses a single database pool for all embedding jobs (profiles + contents).
 *
 * Usage:
 *   node --experimental-strip-types src/workers/embedding.ts          # loop mode
 *   node --experimental-strip-types src/workers/embedding.ts --once   # one-shot
 */
import type { Pool } from 'pg';
import { EMBEDDING_PROFILES, embedManyDocuments, isEmbeddingStubEnabled } from '../ai.ts';
import { buildProfileSourceText, buildContentSourceText, buildEventSourceText, computeSourceHash } from '../embedding-source.ts';
import { createPools, runWorkerLoop, runWorkerOnce, type WorkerPools } from './runner.ts';

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 5;

type EmbeddingJob = {
  id: string;
  subject_kind: 'member_club_profile_version' | 'content_version';
  subject_version_id: string;
  model: string;
  dimensions: number;
  source_version: string;
  attempt_count: number;
};

type ProfileVersionRow = {
  id: string;
  member_id: string;
  club_id: string;
  public_name: string;
  display_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: Array<{ url: string; label: string | null }> | null;
  is_current: boolean;
};

type EntityVersionRow = {
  id: string;
  content_id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  // Event-specific (null for non-events)
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  is_current_published: boolean;
};

// ── DB operations (inlined — no security definer functions) ──

async function claimJobs(
  pool: Pool,
  subjectKind: EmbeddingJob['subject_kind'],
  limit: number,
): Promise<EmbeddingJob[]> {
  const result = await pool.query<EmbeddingJob>(
    `update ai_embedding_jobs
     set attempt_count = attempt_count + 1,
         next_attempt_at = now() + interval '5 minutes'
     where id in (
       select id from ai_embedding_jobs
       where attempt_count < $1 and next_attempt_at <= now()
         and subject_kind = $2
       order by next_attempt_at asc
       limit $3
       for update skip locked
     )
     returning id, subject_kind, subject_version_id, model, dimensions, source_version, attempt_count`,
    [MAX_ATTEMPTS, subjectKind, limit],
  );
  return result.rows;
}

async function loadProfileVersion(pool: Pool, versionId: string): Promise<ProfileVersionRow | null> {
  const result = await pool.query<ProfileVersionRow>(
    `select mcpv.id, mcpv.member_id, mcpv.club_id, m.public_name,
            m.display_name,
            mcpv.tagline, mcpv.summary, mcpv.what_i_do, mcpv.known_for,
            mcpv.services_summary, mcpv.website_url, mcpv.links,
            exists (
              select 1 from current_member_club_profiles cmcp where cmcp.id = mcpv.id
            ) as is_current
     from member_club_profile_versions mcpv
     join members m on m.id = mcpv.member_id
     where mcpv.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function loadEntityVersion(pool: Pool, versionId: string): Promise<EntityVersionRow | null> {
  const result = await pool.query<EntityVersionRow>(
    `select ev.id, ev.content_id, e.kind::text as kind,
            ev.title, ev.summary, ev.body,
            evd.location,
            evd.starts_at::text as starts_at, evd.ends_at::text as ends_at,
            evd.timezone, evd.recurrence_rule,
            (ev.state = 'published' and ev.version_no = (
              select max(version_no) from content_versions where content_id = ev.content_id
            )) as is_current_published
     from content_versions ev
     join contents e on e.id = ev.content_id
     left join event_version_details evd on evd.content_version_id = ev.id
     where ev.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function completeJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(`delete from ai_embedding_jobs where id = any($1::text[])`, [jobIds]);
}

async function retryJobs(pool: Pool, jobIds: string[], error: string): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update ai_embedding_jobs set failure_kind = 'work_error', last_error = $2,
            next_attempt_at = now() + (attempt_count * interval '1 minute')
     where id = any($1::text[])`,
    [jobIds, error.slice(0, 1000)],
  );
}

async function releaseJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update ai_embedding_jobs set attempt_count = greatest(attempt_count - 1, 0),
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
    `insert into ai_llm_usage_log (member_id, requested_club_id, action_name, artifact_kind, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code, feedback)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [null, null, actionName, 'embedding_index', 'openai', EMBEDDING_PROFILES.member_profile.model, gateStatus, skipReason, promptTokens, completionTokens, providerErrorCode, null],
  ).catch(err => console.error('Failed to log embedding spend:', err));
}

// ── Source text building ────────────────────────────────

function buildSourceText(job: EmbeddingJob, row: ProfileVersionRow | EntityVersionRow): string {
  if (job.subject_kind === 'member_club_profile_version') {
    const p = row as ProfileVersionRow;
    return buildProfileSourceText({
      publicName: p.public_name, displayName: p.display_name,
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
      timezone: e.timezone, recurrenceRule: e.recurrence_rule,
    });
  }

  return buildContentSourceText({
    kind: e.kind, title: e.title, summary: e.summary, body: e.body,
  });
}

// ── Job processing ──────────────────────────────────────

async function processPlane(
  pool: Pool,
  planeName: string,
  subjectKind: EmbeddingJob['subject_kind'],
  insertArtifact: (pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string) => Promise<void>,
): Promise<number> {
  const jobs = await claimJobs(pool, subjectKind, BATCH_SIZE);
  if (jobs.length === 0) return 0;

  type PreparedJob = { job: EmbeddingJob; sourceText: string; sourceHash: string };
  const prepared: PreparedJob[] = [];
  const staleJobIds: string[] = [];

  for (const job of jobs) {
    const row = job.subject_kind === 'member_club_profile_version'
      ? await loadProfileVersion(pool, job.subject_version_id)
      : await loadEntityVersion(pool, job.subject_version_id);

    if (!row || (job.subject_kind === 'member_club_profile_version' && !(row as ProfileVersionRow).is_current)
        || (job.subject_kind === 'content_version' && !(row as EntityVersionRow).is_current_published)) {
      staleJobIds.push(job.id);
      continue;
    }

    const sourceText = buildSourceText(job, row);
    prepared.push({ job, sourceText, sourceHash: computeSourceHash(sourceText) });
  }

  await completeJobs(pool, staleJobIds);
  if (prepared.length === 0) return staleJobIds.length;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !isEmbeddingStubEnabled()) {
    await releaseJobs(pool, prepared.map(p => p.job.id));
    logEmbeddingSpend(pool, 'embedding_worker', 'skipped', 'no_api_key', null, null, null);
    console.error(`OPENAI_API_KEY not set — released ${prepared.length} ${planeName} jobs`);
    return 0;
  }

  let embeddings: number[][];
  let usageTokens = 0;
  try {
    const result = await embedManyDocuments({
      values: prepared.map(p => p.sourceText),
      profile: subjectKind === 'member_club_profile_version' ? 'member_profile' : 'content',
    });
    embeddings = result.embeddings;
    usageTokens = result.usageTokens;
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
  const memberResult = await pool.query<{ member_id: string; club_id: string }>(
    `select member_id, club_id from member_club_profile_versions where id = $1`,
    [job.subject_version_id],
  );
  const memberId = memberResult.rows[0]?.member_id;
  const clubId = memberResult.rows[0]?.club_id;
  if (!memberId || !clubId) throw new Error(`No member+club found for profile version ${job.subject_version_id}`);

  await pool.query(
    `insert into member_profile_embeddings (member_id, club_id, profile_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata)
     values ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9::vector, '{}'::jsonb)
     on conflict (member_id, club_id, model, dimensions, source_version, chunk_index) do update
       set profile_version_id = excluded.profile_version_id,
           source_text = excluded.source_text,
           source_hash = excluded.source_hash,
           embedding = excluded.embedding,
           updated_at = now()`,
    [memberId, clubId, job.subject_version_id, job.model, job.dimensions, job.source_version, sourceText, sourceHash, vectorStr],
  );
}

async function insertEntityArtifact(pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string): Promise<void> {
  const contentResult = await pool.query<{ content_id: string }>(
    `select content_id from content_versions where id = $1`,
    [job.subject_version_id],
  );
  const contentId = contentResult.rows[0]?.content_id;
  if (!contentId) throw new Error(`No content found for version ${job.subject_version_id}`);

  await pool.query(
    `insert into content_embeddings (content_id, content_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata)
     values ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector, '{}'::jsonb)
     on conflict (content_id, model, dimensions, source_version, chunk_index) do update
       set content_version_id = excluded.content_version_id,
           source_text = excluded.source_text,
           source_hash = excluded.source_hash,
           embedding = excluded.embedding,
           updated_at = now()`,
    [contentId, job.subject_version_id, job.model, job.dimensions, job.source_version, sourceText, sourceHash, vectorStr],
  );
}

// ── Worker entry point ─────────────────────────────────

async function processEmbeddings(pools: WorkerPools): Promise<number> {
  const profileCount = await processPlane(
    pools.db,
    'profiles',
    'member_club_profile_version',
    insertProfileArtifact,
  );
  const contentCount = await processPlane(
    pools.db,
    'contents',
    'content_version',
    insertEntityArtifact,
  );
  return profileCount + contentCount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pools = createPools();
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
