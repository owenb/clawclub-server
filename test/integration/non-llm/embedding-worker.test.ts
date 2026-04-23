import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { makeVector, seedPublishedContent } from '../helpers.ts';
import { EMBEDDING_PROFILES, embedManyDocuments } from '../../../src/ai.ts';
import { DEFAULT_CONFIG_V1, type AppConfig } from '../../../src/config/index.ts';
import { buildContentSourceText, buildProfileSourceText, computeSourceHash } from '../../../src/embedding-source.ts';
import { processEmbeddings } from '../../../src/workers/embedding.ts';
import type { WorkerPools } from '../../../src/workers/runner.ts';

let h: TestHarness;

function workerPools(): WorkerPools {
  return { db: h.pools.super };
}

function parseVector(vector: string): number[] {
  return JSON.parse(vector) as number[];
}

function assertVectorsClose(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(Math.abs(actual[i]! - expected[i]!) < 1e-5, `vector mismatch at index ${i}`);
  }
}

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('embedding worker', () => {
  it('processes queued profile and content jobs through the stub helper without an OpenAI key', async () => {
    const owner = await h.seedOwner('embedding-worker-club', 'Embedding Worker Club');
    const seededEntity = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Reliable migration notes',
      summary: 'A summary of the rollout plan',
      body: 'This text should be embedded without a network call.',
    });

    const [profile] = await h.sql<{
      id: string;
      public_name: string;
      display_name: string;
      tagline: string | null;
      summary: string | null;
      what_i_do: string | null;
      known_for: string | null;
      services_summary: string | null;
      website_url: string | null;
      links: Array<{ url: string; label: string | null }> | null;
    }>(
      `select
         cmp.id,
         m.public_name,
         m.display_name,
         cmp.tagline,
         cmp.summary,
         cmp.what_i_do,
         cmp.known_for,
         cmp.services_summary,
         cmp.website_url,
         cmp.links
       from current_member_club_profiles cmp
       join members m on m.id = cmp.member_id
       where cmp.member_id = $1
         and cmp.club_id = $2
       limit 1`,
      [owner.id, owner.club.id],
    );
    assert.ok(profile, 'owner should have a current club profile');

    const profileSourceText = buildProfileSourceText({
      publicName: profile.public_name,
      displayName: profile.display_name,
      tagline: profile.tagline,
      summary: profile.summary,
      whatIDo: profile.what_i_do,
      knownFor: profile.known_for,
      servicesSummary: profile.services_summary,
      websiteUrl: profile.website_url,
      links: profile.links,
    });
    const contentSourceText = buildContentSourceText({
      kind: 'post',
      title: 'Reliable migration notes',
      summary: 'A summary of the rollout plan',
      body: 'This text should be embedded without a network call.',
    });

    await h.sql(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values
         ('member_club_profile_version', $1, $2, $3, $4),
         ('content_version', $5, $6, $7, $8)`,
      [
        profile.id,
        EMBEDDING_PROFILES.member_profile.model,
        EMBEDDING_PROFILES.member_profile.dimensions,
        EMBEDDING_PROFILES.member_profile.sourceVersion,
        seededEntity.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        EMBEDDING_PROFILES.content.sourceVersion,
      ],
    );

    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const processed = await processEmbeddings(workerPools());
      assert.equal(processed, 2);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }

    const [profileArtifact] = await h.sql<{
      source_text: string;
      source_hash: string;
      embedding: string;
    }>(
      `select source_text, source_hash, embedding::text as embedding
       from member_profile_embeddings
       where profile_version_id = $1
       limit 1`,
      [profile.id],
    );
    const [contentArtifact] = await h.sql<{
      source_text: string;
      source_hash: string;
      embedding: string;
    }>(
      `select source_text, source_hash, embedding::text as embedding
       from content_embeddings
       where content_version_id = $1
       limit 1`,
      [seededEntity.contentVersionId],
    );
    assert.ok(profileArtifact, 'profile artifact should be written');
    assert.ok(contentArtifact, 'content artifact should be written');

    const expectedProfile = await embedManyDocuments({
      values: [profileSourceText],
      profile: 'member_profile',
    });
    const expectedContent = await embedManyDocuments({
      values: [contentSourceText],
      profile: 'content',
    });

    assert.equal(profileArtifact.source_text, profileSourceText);
    assert.equal(profileArtifact.source_hash, computeSourceHash(profileSourceText));
    assert.equal(contentArtifact.source_text, contentSourceText);
    assert.equal(contentArtifact.source_hash, computeSourceHash(contentSourceText));

    const storedProfileEmbedding = parseVector(profileArtifact.embedding);
    const storedContentEmbedding = parseVector(contentArtifact.embedding);
    assert.equal(storedProfileEmbedding.length, EMBEDDING_PROFILES.member_profile.dimensions);
    assert.equal(storedContentEmbedding.length, EMBEDDING_PROFILES.content.dimensions);
    assertVectorsClose(storedProfileEmbedding, expectedProfile.embeddings[0]!);
    assertVectorsClose(storedContentEmbedding, expectedContent.embeddings[0]!);

    const pendingJobs = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from ai_embedding_jobs
       where subject_version_id = any($1::text[])`,
      [[profile.id, seededEntity.contentVersionId]],
    );
    assert.equal(Number(pendingJobs[0]?.count ?? '0'), 0);

    const spendRows = await h.sql<{
      action_name: string;
      usage_kind: string;
      status: string;
      member_id: string | null;
      club_id: string;
      actual_embedding_tokens: number | null;
      actual_micro_cents: string;
    }>(
      `select action_name,
              usage_kind,
              status,
              member_id,
              club_id,
              actual_embedding_tokens,
              actual_micro_cents::text as actual_micro_cents
       from ai_club_spend_reservations
       where club_id = $1
       order by action_name`,
      [owner.club.id],
    );
    assert.deepEqual(
      spendRows.map((row) => row.action_name),
      ['content.embedding', 'member_profile.embedding'],
    );
    for (const row of spendRows) {
      assert.equal(row.usage_kind, 'embedding');
      assert.equal(row.status, 'finalized');
      assert.equal(row.member_id, null);
      assert.equal(row.club_id, owner.club.id);
      assert.ok((row.actual_embedding_tokens ?? 0) > 0);
      assert.ok(Number(row.actual_micro_cents) > 0);
    }

    const usageRows = await h.sql<{
      action_name: string;
      requested_club_id: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      gate_status: string;
    }>(
      `select action_name, requested_club_id, prompt_tokens, completion_tokens, gate_status::text as gate_status
       from ai_llm_usage_log
       where requested_club_id = $1
       order by action_name`,
      [owner.club.id],
    );
    assert.deepEqual(
      usageRows.map((row) => row.action_name),
      ['content.embedding', 'member_profile.embedding'],
    );
    for (const row of usageRows) {
      assert.equal(row.requested_club_id, owner.club.id);
      assert.equal(row.gate_status, 'passed');
      assert.ok((row.prompt_tokens ?? 0) > 0);
      assert.equal(row.completion_tokens, 0);
    }
  });

  it('marks jobs as budget_blocked instead of retrying forever when a club is over budget', async () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfig;
    config.policy.quotas.llm.clubSpendBudget.dailyMaxCents = 1;
    const local = await TestHarness.start({ config });
    try {
      const owner = await local.seedOwner('embedding-budget-block', 'Embedding Budget Block');
      const seededEntity = await seedPublishedContent(local, {
        clubId: owner.club.id,
        authorMemberId: owner.id,
        kind: 'post',
        title: 'Budget blocked embedding seed',
        body: 'This content would normally be embedded.',
      });

      await local.sql(
        `insert into ai_club_spend_reservations (
           club_id,
           member_id,
           action_name,
           usage_kind,
           provider,
           model,
           status,
           reserved_micro_cents,
           actual_micro_cents,
           reserved_input_tokens_estimate,
           reserved_output_tokens,
           actual_prompt_tokens,
           actual_completion_tokens,
           actual_embedding_tokens,
           expires_at,
           finalized_at
         )
         values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'finalized',
                 999980, 999980, 0, 64, 0, 0, null, now(), now())`,
        [owner.club.id, owner.id],
      );

      await local.sql(
        `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
         values ('content_version', $1, $2, $3, $4)`,
        [
          seededEntity.contentVersionId,
          EMBEDDING_PROFILES.content.model,
          EMBEDDING_PROFILES.content.dimensions,
          EMBEDDING_PROFILES.content.sourceVersion,
        ],
      );

      const processed = await processEmbeddings({ db: local.pools.super });
      assert.equal(processed, 0);

      const [job] = await local.sql<{
        state: string;
        failure_kind: string | null;
        attempt_count: number;
        last_error: string | null;
      }>(
        `select state, failure_kind, attempt_count, last_error
         from ai_embedding_jobs
         where subject_version_id = $1
         limit 1`,
        [seededEntity.contentVersionId],
      );
      assert.equal(job?.state, 'budget_blocked');
      assert.equal(job?.failure_kind, 'budget_blocked');
      assert.equal(job?.attempt_count, 0);
      assert.equal(job?.last_error, 'budget_exceeded');
    } finally {
      await local.stop();
    }
  });

  it('marks persistently failing jobs as failed and stops claiming them again', async () => {
    const owner = await h.seedOwner('embedding-dead-letter', 'Embedding Dead Letter');
    const seeded = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Bad dimensions',
      body: 'This job will fail at artifact insert time.',
    });

    await h.sqlClubs(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('content_version', $1, $2, $3, $4)`,
      [
        seeded.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        768,
        'dead_letter_v1',
      ],
    );

    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((value) => String(value)).join(' '));
    };

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const processed = await processEmbeddings(workerPools());
        assert.equal(processed, 0);
        if (attempt < 4) {
          await h.sqlClubs(
            `update ai_embedding_jobs
             set next_attempt_at = now()
             where subject_version_id = $1`,
            [seeded.contentVersionId],
          );
        }
      }
    } finally {
      console.error = originalConsoleError;
    }

    const [job] = await h.sqlClubs<{
      state: string;
      attempt_count: number;
      last_error: string | null;
    }>(
      `select state, attempt_count, last_error
       from ai_embedding_jobs
       where subject_version_id = $1
       limit 1`,
      [seeded.contentVersionId],
    );
    assert.equal(job?.state, 'failed');
    assert.equal(job?.attempt_count, 5);
    assert.equal(job?.last_error, '22000');

    const failedLogLines = errorLines.filter((line) => line.includes('"kind":"embedding_job_failed"'));
    assert.equal(failedLogLines.length, 1);

    const processedAfterFailure = await processEmbeddings(workerPools());
    assert.equal(processedAfterFailure, 0);
  });

  it('partitions worker batches by stored model tuple and preserves artifact dimensions', async () => {
    const owner = await h.seedOwner('embedding-tuples', 'Embedding Tuples');
    const currentTupleContent = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Current tuple',
      body: 'This should use the current tuple.',
    });
    const legacyTupleContent = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Legacy tuple',
      body: 'This should use the legacy tuple.',
    });

    await h.sql(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values
         ('content_version', $1, $2, $3, $4),
         ('content_version', $5, $6, $7, $8)`,
      [
        currentTupleContent.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        EMBEDDING_PROFILES.content.sourceVersion,
        legacyTupleContent.contentVersionId,
        'text-embedding-legacy',
        EMBEDDING_PROFILES.content.dimensions,
        'legacy_v1',
      ],
    );

    const processed = await processEmbeddings(workerPools());
    assert.equal(processed, 2);

    const artifacts = await h.sql<{
      content_version_id: string;
      model: string;
      dimensions: number;
      embedding: string;
    }>(
      `select content_version_id,
              model,
              dimensions,
              embedding::text as embedding
       from content_embeddings
       where content_version_id = any($1::text[])
       order by model asc`,
      [[currentTupleContent.contentVersionId, legacyTupleContent.contentVersionId]],
    );
    assert.equal(artifacts.length, 2);
    const currentArtifact = artifacts.find((row) => row.content_version_id === currentTupleContent.contentVersionId);
    const legacyArtifact = artifacts.find((row) => row.content_version_id === legacyTupleContent.contentVersionId);
    assert.equal(currentArtifact?.model, EMBEDDING_PROFILES.content.model);
    assert.equal(currentArtifact?.dimensions, EMBEDDING_PROFILES.content.dimensions);
    assert.equal(parseVector(currentArtifact!.embedding).length, EMBEDDING_PROFILES.content.dimensions);
    assert.equal(legacyArtifact?.model, 'text-embedding-legacy');
    assert.equal(legacyArtifact?.dimensions, EMBEDDING_PROFILES.content.dimensions);
    assert.equal(parseVector(legacyArtifact!.embedding).length, EMBEDDING_PROFILES.content.dimensions);

    const usageRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from ai_llm_usage_log
       where requested_club_id = $1
         and action_name = 'content.embedding'`,
      [owner.club.id],
    );
    assert.equal(Number(usageRows[0]?.count ?? '0'), 2);
  });

  it('reuses the existing vector when a new version has the same embedding source text', async () => {
    const owner = await h.seedOwner('embedding-source-hash-skip', 'Embedding Source Hash Skip');
    const seeded = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Stable title',
      summary: 'Stable summary',
      body: 'Stable body',
    });

    const [currentVersion] = await h.sql<{
      content_id: string;
      version_no: number;
      title: string | null;
      summary: string | null;
      body: string | null;
      created_by_member_id: string | null;
    }>(
      `select content_id, version_no, title, summary, body, created_by_member_id
       from content_versions
       where id = $1`,
      [seeded.contentVersionId],
    );
    assert.ok(currentVersion);

    const sourceText = buildContentSourceText({
      kind: 'post',
      title: currentVersion.title,
      summary: currentVersion.summary,
      body: currentVersion.body,
    });
    const sourceHash = computeSourceHash(sourceText);

    await h.sqlClubs(
      `insert into content_embeddings
         (content_id, content_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
       values ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector)`,
      [
        seeded.id,
        seeded.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        EMBEDDING_PROFILES.content.sourceVersion,
        sourceText,
        sourceHash,
        makeVector([0.25, -0.5, 0.75]),
      ],
    );

    const [nextVersion] = await h.sqlClubs<{ id: string }>(
      `insert into content_versions (
         content_id,
         version_no,
         state,
         title,
         summary,
         body,
         supersedes_version_id,
         created_by_member_id
       )
       values ($1, $2, 'published', $3, $4, $5, $6, $7)
       returning id`,
      [
        currentVersion.content_id,
        currentVersion.version_no + 1,
        currentVersion.title,
        currentVersion.summary,
        currentVersion.body,
        seeded.contentVersionId,
        currentVersion.created_by_member_id,
      ],
    );
    assert.ok(nextVersion);

    await h.sqlClubs(
      `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
       values ('content_version', $1, $2, $3, $4)`,
      [
        nextVersion.id,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        EMBEDDING_PROFILES.content.sourceVersion,
      ],
    );

    const processed = await processEmbeddings(workerPools());
    assert.equal(processed, 1);

    const [artifact] = await h.sqlClubs<{
      content_version_id: string;
      source_hash: string;
      embedding: string;
    }>(
      `select content_version_id, source_hash, embedding::text as embedding
       from content_embeddings
       where content_id = $1
         and model = $2
         and dimensions = $3
         and source_version = $4
       limit 1`,
      [
        seeded.id,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        EMBEDDING_PROFILES.content.sourceVersion,
      ],
    );
    assert.equal(artifact?.content_version_id, nextVersion.id);
    assert.equal(artifact?.source_hash, sourceHash);
    assert.equal(parseVector(artifact!.embedding).length, EMBEDDING_PROFILES.content.dimensions);

    const usageRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
       from ai_llm_usage_log
       where requested_club_id = $1
         and action_name = 'content.embedding'`,
      [owner.club.id],
    );
    const spendRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
       from ai_club_spend_reservations
       where club_id = $1
         and action_name = 'content.embedding'`,
      [owner.club.id],
    );
    assert.equal(Number(usageRows[0]?.count ?? '0'), 0);
    assert.equal(Number(spendRows[0]?.count ?? '0'), 0);
  });
});
