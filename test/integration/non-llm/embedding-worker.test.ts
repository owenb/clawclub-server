import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { seedPublishedContent } from '../helpers.ts';
import { EMBEDDING_PROFILES, embedManyDocuments } from '../../../src/ai.ts';
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
  });
});
