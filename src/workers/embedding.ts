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
import { embedWithTuple, isEmbeddingStubEnabled } from '../ai.ts';
import {
  CLUB_SPEND_BLOCKED_RECHECK_MS,
  CLUB_SPEND_USAGE_KINDS,
  estimateEmbeddingSpend,
  finalizeClubSpendBudget,
  releaseClubSpendBudget,
  reserveClubSpendBudget,
  type EmbeddingSpendEstimate,
} from '../club-spend.ts';
import { buildProfileSourceText, buildContentSourceText, buildEventSourceText, computeSourceHash } from '../embedding-source.ts';
import { AppError } from '../errors.ts';
import { normalizeErrorCode } from '../llm-errors.ts';
import { logger, safeLogError } from '../logger.ts';
import { PACKAGE_VERSION } from '../version.ts';
import {
  createPools,
  runWorkerLoop,
  runWorkerOnce,
  workerFatalError,
  type WorkerPools,
} from './runner.ts';
import { outboundLlmSignal } from './environment.ts';

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 5_000;
const EMBEDDING_BUDGET_EXCEEDED_ERROR_CODE = 'budget_exceeded';
// Keep this in sync with the failed-state transition and diagnostics reporting.
const MAX_ATTEMPTS = 5;

type EmbeddingJob = {
  id: string;
  subject_kind: 'member_club_profile_version' | 'content_version';
  subject_version_id: string;
  model: string;
  dimensions: number;
  source_version: string;
  attempt_count: number;
  previous_state: 'queued' | 'budget_blocked';
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
  club_id: string;
  author_member_id: string;
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

type PreparedProfileJob = {
  kind: 'member_club_profile_version';
  job: EmbeddingJob;
  sourceText: string;
  sourceHash: string;
  clubId: string;
  memberId: string;
  profileVersionId: string;
};

type PreparedContentJob = {
  kind: 'content_version';
  job: EmbeddingJob;
  sourceText: string;
  sourceHash: string;
  clubId: string;
  contentId: string;
  contentVersionId: string;
};

type PreparedJob = PreparedProfileJob | PreparedContentJob;

// ── DB operations (inlined — no security definer functions) ──

async function claimJobs(
  pool: Pool,
  subjectKind: EmbeddingJob['subject_kind'],
  limit: number,
): Promise<EmbeddingJob[]> {
  const result = await pool.query<EmbeddingJob>(
    `with claimable as (
       select id, state
       from ai_embedding_jobs
       where next_attempt_at <= now()
         and subject_kind = $1
         and state in ('queued', 'budget_blocked')
       order by next_attempt_at asc
       limit $2
       for update skip locked
     )
     update ai_embedding_jobs j
     set attempt_count = case
           when claimable.state = 'queued' then j.attempt_count + 1
           else j.attempt_count
         end,
         next_attempt_at = now() + interval '5 minutes',
         state = 'queued'
     from claimable
     where j.id = claimable.id
     returning j.id, j.subject_kind, j.subject_version_id, j.model, j.dimensions, j.source_version, j.attempt_count,
       claimable.state::text as previous_state`,
    [subjectKind, limit],
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
    `select ev.id, ev.content_id, e.club_id, e.author_member_id, e.kind::text as kind,
            ev.title, ev.summary, ev.body,
            evd.location,
            evd.starts_at::text as starts_at, evd.ends_at::text as ends_at,
            evd.timezone, evd.recurrence_rule,
            exists (
              select 1
              from current_content_versions cev
              where cev.id = ev.id
                and cev.state = 'published'
            ) as is_current_published
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

function artifactLookupKey(job: PreparedJob): string {
  if (job.kind === 'member_club_profile_version') {
    return [
      'profile',
      job.memberId,
      job.clubId,
      job.job.model,
      String(job.job.dimensions),
      job.job.source_version,
    ].join('|');
  }

  return [
    'content',
    job.contentId,
    job.job.model,
    String(job.job.dimensions),
    job.job.source_version,
  ].join('|');
}

async function loadExistingSourceHashesByArtifactIdentity(
  pool: Pool,
  jobs: PreparedJob[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const profileJobs = jobs.filter((job): job is PreparedProfileJob => job.kind === 'member_club_profile_version');
  const contentJobs = jobs.filter((job): job is PreparedContentJob => job.kind === 'content_version');

  if (profileJobs.length > 0) {
    const values: string[] = [];
    const params: Array<string | number> = [];
    let index = 1;
    for (const job of profileJobs) {
      values.push(`($${index++}::text, $${index++}::text, $${index++}::text, $${index++}::integer, $${index++}::text)`);
      params.push(job.memberId, job.clubId, job.job.model, job.job.dimensions, job.job.source_version);
    }

    const result = await pool.query<{
      member_id: string;
      club_id: string;
      model: string;
      dimensions: number;
      source_version: string;
      source_hash: string;
    }>(
      `with requested(member_id, club_id, model, dimensions, source_version) as (
         values ${values.join(', ')}
       )
       select requested.member_id,
              requested.club_id,
              requested.model,
              requested.dimensions,
              requested.source_version,
              artifacts.source_hash
       from requested
       join member_profile_embeddings artifacts
         on artifacts.member_id = requested.member_id
        and artifacts.club_id = requested.club_id
        and artifacts.model = requested.model
        and artifacts.dimensions = requested.dimensions
        and artifacts.source_version = requested.source_version
        and artifacts.chunk_index = 0`,
      params,
    );

    for (const row of result.rows) {
      hashes.set(
        ['profile', row.member_id, row.club_id, row.model, String(row.dimensions), row.source_version].join('|'),
        row.source_hash,
      );
    }
  }

  if (contentJobs.length > 0) {
    const values: string[] = [];
    const params: Array<string | number> = [];
    let index = 1;
    for (const job of contentJobs) {
      values.push(`($${index++}::text, $${index++}::text, $${index++}::integer, $${index++}::text)`);
      params.push(job.contentId, job.job.model, job.job.dimensions, job.job.source_version);
    }

    const result = await pool.query<{
      content_id: string;
      model: string;
      dimensions: number;
      source_version: string;
      source_hash: string;
    }>(
      `with requested(content_id, model, dimensions, source_version) as (
         values ${values.join(', ')}
       )
       select requested.content_id,
              requested.model,
              requested.dimensions,
              requested.source_version,
              artifacts.source_hash
       from requested
       join content_embeddings artifacts
         on artifacts.content_id = requested.content_id
        and artifacts.model = requested.model
        and artifacts.dimensions = requested.dimensions
        and artifacts.source_version = requested.source_version
        and artifacts.chunk_index = 0`,
      params,
    );

    for (const row of result.rows) {
      hashes.set(
        ['content', row.content_id, row.model, String(row.dimensions), row.source_version].join('|'),
        row.source_hash,
      );
    }
  }

  return hashes;
}

async function advanceArtifactVersionWithoutReembedding(pool: Pool, jobs: PreparedJob[]): Promise<void> {
  for (const job of jobs) {
    if (job.kind === 'member_club_profile_version') {
      await pool.query(
        `update member_profile_embeddings
         set profile_version_id = $1,
             source_text = $2,
             source_hash = $3,
             updated_at = now()
         where member_id = $4
           and club_id = $5
           and model = $6
           and dimensions = $7
           and source_version = $8
           and chunk_index = 0`,
        [
          job.profileVersionId,
          job.sourceText,
          job.sourceHash,
          job.memberId,
          job.clubId,
          job.job.model,
          job.job.dimensions,
          job.job.source_version,
        ],
      );
      continue;
    }

    await pool.query(
      `update content_embeddings
       set content_version_id = $1,
           source_text = $2,
           source_hash = $3,
           updated_at = now()
       where content_id = $4
         and model = $5
         and dimensions = $6
         and source_version = $7
         and chunk_index = 0`,
      [
        job.contentVersionId,
        job.sourceText,
        job.sourceHash,
        job.contentId,
        job.job.model,
        job.job.dimensions,
        job.job.source_version,
      ],
    );
  }
}

async function retryJobs(pool: Pool, jobIds: string[], error: string): Promise<void> {
  if (jobIds.length === 0) return;
  const result = await pool.query<{
    id: string;
    subject_kind: EmbeddingJob['subject_kind'];
    model: string;
    dimensions: number;
    attempt_count: number;
    state: 'queued' | 'budget_blocked' | 'failed';
  }>(
    `update ai_embedding_jobs
     set state = case
           when attempt_count >= $3 then 'failed'
           else 'queued'
         end,
         failure_kind = 'work_error',
         last_error = $2,
         next_attempt_at = case
           when attempt_count >= $3 then next_attempt_at
           else now() + (attempt_count * interval '1 minute')
         end
     where id = any($1::text[])
     returning id, subject_kind, model, dimensions, attempt_count, state`,
    [jobIds, error.slice(0, 1000), MAX_ATTEMPTS],
  );
  for (const row of result.rows) {
    if (row.state !== 'failed') continue;
    logger.error('embedding_job_failed', undefined, {
      jobId: row.id,
      subjectKind: row.subject_kind,
      model: row.model,
      dimensions: row.dimensions,
      attemptCount: row.attempt_count,
    });
  }
}

async function releaseJobs(pool: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update ai_embedding_jobs set state = 'queued',
            attempt_count = greatest(attempt_count - 1, 0),
            next_attempt_at = now() + interval '30 seconds'
     where id = any($1::text[])`,
    [jobIds],
  );
}

async function blockJobsByBudget(pool: Pool, input: {
  queuedJobIds: string[];
  reclaimedJobIds: string[];
  reason: string;
}): Promise<void> {
  const jobIds = [...input.queuedJobIds, ...input.reclaimedJobIds];
  if (jobIds.length === 0) return;
  await pool.query(
    `update ai_embedding_jobs
     set state = 'budget_blocked',
         attempt_count = case
           when id = any($2::text[]) then greatest(attempt_count - 1, 0)
           else attempt_count
         end,
         failure_kind = 'budget_blocked',
         last_error = $3,
         next_attempt_at = $4
     where id = any($1::text[])`,
    [
      jobIds,
      input.queuedJobIds,
      input.reason.slice(0, 1000),
      new Date(Date.now() + CLUB_SPEND_BLOCKED_RECHECK_MS).toISOString(),
    ],
  );
}

// ── Spend logging ───────────────────────────────────────

function logEmbeddingSpend(
  pool: Pool,
  actionName: string,
  clubId: string,
  model: string,
  gateStatus: 'passed' | 'skipped',
  skipReason: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
  providerErrorCode: string | null,
): void {
  pool.query(
    `insert into ai_llm_usage_log (member_id, requested_club_id, action_name, artifact_kind, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code, feedback)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [null, clubId, actionName, 'embedding_index', 'openai', model, gateStatus, skipReason, promptTokens, completionTokens, providerErrorCode, null],
  ).catch(err => safeLogError('embedding_spend_log_failure', err, { actionName }));
}

function isFatalEmbeddingProviderError(errorMsg: string): boolean {
  return /api key|unauthorized|insufficient quota|quota exceeded|billing/i.test(errorMsg);
}

function isTransientEmbeddingProviderError(errorMsg: string): boolean {
  return /rate limit|429|503|timed out|timeout|temporar/i.test(errorMsg);
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

function embeddingActionName(subjectKind: EmbeddingJob['subject_kind']): string {
  return subjectKind === 'member_club_profile_version' ? 'member_profile.embedding' : 'content.embedding';
}

function mergeEmbeddingEstimates(estimates: EmbeddingSpendEstimate[]): EmbeddingSpendEstimate {
  return estimates.reduce<EmbeddingSpendEstimate>((sum, estimate) => ({
    usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
    reservedMicroCents: sum.reservedMicroCents + estimate.reservedMicroCents,
    reservedInputTokensEstimate: sum.reservedInputTokensEstimate + estimate.reservedInputTokensEstimate,
    reservedOutputTokens: 0,
  }), {
    usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
    reservedMicroCents: 0,
    reservedInputTokensEstimate: 0,
    reservedOutputTokens: 0,
  });
}

async function processPlane(
  pool: Pool,
  planeName: string,
  subjectKind: EmbeddingJob['subject_kind'],
  insertArtifact: (pool: Pool, job: EmbeddingJob, sourceText: string, sourceHash: string, vectorStr: string) => Promise<void>,
): Promise<number> {
  const jobs = await claimJobs(pool, subjectKind, BATCH_SIZE);
  if (jobs.length === 0) return 0;

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
    const sourceHash = computeSourceHash(sourceText);
    if (job.subject_kind === 'member_club_profile_version') {
      const profileRow = row as ProfileVersionRow;
      prepared.push({
        kind: 'member_club_profile_version',
        job,
        sourceText,
        sourceHash,
        clubId: profileRow.club_id,
        memberId: profileRow.member_id,
        profileVersionId: profileRow.id,
      });
      continue;
    }

    const entityRow = row as EntityVersionRow;
    prepared.push({
      kind: 'content_version',
      job,
      sourceText,
      sourceHash,
      clubId: entityRow.club_id,
      contentId: entityRow.content_id,
      contentVersionId: entityRow.id,
    });
  }

  await completeJobs(pool, staleJobIds);
  if (prepared.length === 0) return staleJobIds.length;

  const emptyJobs = prepared.filter((job) => job.sourceText.trim().length === 0);
  await completeJobs(pool, emptyJobs.map((job) => job.job.id));

  const nonEmptyJobs = prepared.filter((job) => job.sourceText.trim().length > 0);
  const existingSourceHashes = await loadExistingSourceHashesByArtifactIdentity(pool, nonEmptyJobs);
  const unchangedJobs = nonEmptyJobs.filter((job) => existingSourceHashes.get(artifactLookupKey(job)) === job.sourceHash);
  if (unchangedJobs.length > 0) {
    await advanceArtifactVersionWithoutReembedding(pool, unchangedJobs);
    await completeJobs(pool, unchangedJobs.map((job) => job.job.id));
  }

  const jobsToEmbed = nonEmptyJobs.filter((job) => existingSourceHashes.get(artifactLookupKey(job)) !== job.sourceHash);
  if (jobsToEmbed.length === 0) {
    return staleJobIds.length + emptyJobs.length + unchangedJobs.length;
  }

  const preparedByClubAndTuple = new Map<string, PreparedJob[]>();
  for (const item of jobsToEmbed) {
    const key = `${item.clubId}|${item.job.model}|${item.job.dimensions}`;
    const list = preparedByClubAndTuple.get(key);
    if (list) {
      list.push(item);
    } else {
      preparedByClubAndTuple.set(key, [item]);
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !isEmbeddingStubEnabled()) {
    await releaseJobs(pool, jobsToEmbed.map((job) => job.job.id));
    for (const clubJobs of preparedByClubAndTuple.values()) {
      logEmbeddingSpend(
        pool,
        embeddingActionName(subjectKind),
        clubJobs[0]!.clubId,
        clubJobs[0]!.job.model,
        'skipped',
        'no_api_key',
        null,
        null,
        null,
      );
    }
    const error = workerFatalError(`OPENAI_API_KEY not set — released ${jobsToEmbed.length} ${planeName} jobs`);
    logger.error('embedding_worker_configuration_error', error, { planeName, releasedJobs: jobsToEmbed.length });
    throw error;
  }

  let processedCount = staleJobIds.length + emptyJobs.length + unchangedJobs.length;
  for (const clubJobs of preparedByClubAndTuple.values()) {
    const clubId = clubJobs[0]!.clubId;
    const spendReservation = (() => {
      const estimate = mergeEmbeddingEstimates(clubJobs.map((job) => estimateEmbeddingSpend(job.sourceText)));
      return reserveClubSpendBudget(pool, {
        clubId,
        memberId: null,
        actionName: embeddingActionName(subjectKind),
        usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
        provider: 'openai',
        model: clubJobs[0]!.job.model,
        estimate,
      });
    })();

    let reservationId: string;
    try {
      reservationId = (await spendReservation).reservationId;
    } catch (error) {
      if (error instanceof AppError && error.code === 'quota_exceeded') {
        await blockJobsByBudget(pool, {
          queuedJobIds: clubJobs.filter(({ job }) => job.previous_state === 'queued').map(({ job }) => job.id),
          reclaimedJobIds: clubJobs.filter(({ job }) => job.previous_state === 'budget_blocked').map(({ job }) => job.id),
          reason: EMBEDDING_BUDGET_EXCEEDED_ERROR_CODE,
        });
        logger.info('embedding_jobs_budget_blocked', {
          planeName,
          clubId,
          blockedJobs: clubJobs.length,
        });
        continue;
      }
      throw error;
    }

    let embeddings: number[][];
    let usageTokens = 0;
    try {
      const result = await embedWithTuple({
        values: clubJobs.map((job) => job.sourceText),
        model: clubJobs[0]!.job.model,
        dimensions: clubJobs[0]!.job.dimensions,
        abortSignal: outboundLlmSignal(),
      });
      embeddings = result.embeddings;
      usageTokens = result.usageTokens;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const providerErrorCode = normalizeErrorCode(err);
      const isFatalError = isFatalEmbeddingProviderError(errorMsg);
      const isTransientError = isTransientEmbeddingProviderError(errorMsg);

      await releaseClubSpendBudget(pool, { reservationId });
      if (isFatalError) {
        await releaseJobs(pool, clubJobs.map(({ job }) => job.id));
      } else {
        await retryJobs(pool, clubJobs.map(({ job }) => job.id), providerErrorCode);
      }
      logEmbeddingSpend(
        pool,
        embeddingActionName(subjectKind),
        clubId,
        clubJobs[0]!.job.model,
        'skipped',
        'provider_error',
        null,
        null,
        providerErrorCode,
      );
      logger.error('embedding_provider_error', err, {
        planeName,
        clubId,
        severity: isFatalError ? 'config' : isTransientError ? 'transient' : 'work',
        errorMessage: errorMsg,
      });

      if (isFatalError) {
        throw workerFatalError(errorMsg, { cause: err });
      }
      if (!isTransientError) {
        throw err;
      }
      continue;
    }

    logEmbeddingSpend(pool, embeddingActionName(subjectKind), clubId, clubJobs[0]!.job.model, 'passed', null, usageTokens, 0, null);
    await finalizeClubSpendBudget(pool, {
      reservationId,
      usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
      actualEmbeddingTokens: usageTokens,
    });

    const completedJobIds: string[] = [];
    for (let i = 0; i < clubJobs.length; i += 1) {
      const { job, sourceText, sourceHash } = clubJobs[i]!;
      const vectorStr = `[${embeddings[i]!.join(',')}]`;
      try {
        await insertArtifact(pool, job, sourceText, sourceHash, vectorStr);
        completedJobIds.push(job.id);
      } catch (err) {
        await retryJobs(pool, [job.id], normalizeErrorCode(err));
        logger.error('embedding_artifact_store_failed', err, { planeName, clubId, jobId: job.id });
      }
    }

    await completeJobs(pool, completedJobIds);
    processedCount += completedJobIds.length;
  }

  logger.info('embedding_plane_complete', {
    planeName,
    completedEmbeddings: processedCount - staleJobIds.length,
    staleEmbeddings: staleJobIds.length,
  });
  return processedCount;
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
  const pools = createPools({ name: 'embedding', requiredEnv: ['OPENAI_API_KEY'] });
  logger.info('embedding_worker_boot', { version: PACKAGE_VERSION });

  if (process.argv.includes('--once')) {
    await runWorkerOnce('embedding', pools, processEmbeddings);
  } else {
    await runWorkerLoop('embedding', pools, processEmbeddings, {
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  }
}

export { processEmbeddings };
