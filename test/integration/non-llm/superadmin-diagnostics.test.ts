import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_PROFILES } from '../../../src/ai.ts';
import { TestHarness } from '../harness.ts';
import { seedPublishedContent } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('superadmin.diagnostics.getHealth', () => {
  beforeEach(async () => {
    await h.sqlClubs(`delete from ai_embedding_jobs`);
  });

  async function getDiagnostics(adminToken: string): Promise<Record<string, unknown>> {
    const result = await h.apiOk(adminToken, 'superadmin.diagnostics.getHealth', {});
    const data = result.data as Record<string, unknown>;
    return data.diagnostics as Record<string, unknown>;
  }

  async function currentProfileVersionId(memberId: string): Promise<string> {
    const rows = await h.sqlClubs<{ id: string }>(
      `select id from current_member_club_profiles where member_id = $1`,
      [memberId],
    );
    assert.equal(rows.length, 1);
    return rows[0]!.id;
  }

  it('returns diagnostics with the embedding-only health shape', async () => {
    const admin = await h.seedSuperadmin('Admin Diag');

    const diagnostics = await getDiagnostics(admin.token);
    assert.ok(typeof diagnostics.migrationCount === 'number');
    assert.ok(diagnostics.migrationCount >= 1);
    assert.ok(typeof diagnostics.memberCount === 'number');
    assert.ok(typeof diagnostics.clubCount === 'number');
    assert.ok(typeof diagnostics.totalAppTables === 'number');
    assert.ok(typeof diagnostics.databaseSize === 'string');
    assert.ok(typeof diagnostics.collectedAt === 'string');
    assert.ok(Math.abs(Date.parse(diagnostics.collectedAt as string) - Date.now()) < 60_000);

    const workers = diagnostics.workers as Record<string, unknown>;
    assert.deepEqual(Object.keys(workers).sort(), ['embedding']);

    const embedding = workers.embedding as Record<string, unknown>;
    const queue = embedding.queue as Record<string, unknown>;
    assert.deepEqual(queue, {
      claimable: 0,
      scheduledFuture: 0,
      atOrOverMaxAttempts: 0,
    });
    assert.equal(embedding.failedEmbeddingJobs, 0);
    assert.equal(embedding.oldestClaimableAgeSeconds, null);
    assert.deepEqual(embedding.byModel, []);
    assert.deepEqual(embedding.retryErrorSample, []);
  });

  it('surfaces embedding queue metrics, by-model counts, and retry samples in attention order', async () => {
    const admin = await h.seedSuperadmin('Admin Diag Embeddings');
    const owner = await h.seedOwner('diag-embedding-club', 'Diag Embedding Club');
    const profileVersionId = await currentProfileVersionId(owner.id);
    const seededEntity = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Diagnostics content',
    });
    const longError = 'x'.repeat(1000);

    await h.sqlClubs(
      `insert into ai_embedding_jobs
         (subject_kind, subject_version_id, model, dimensions, source_version, attempt_count, next_attempt_at, created_at, state)
       values
         ('member_club_profile_version', $1, $2, $3, 'diag_claimable', 0, now() - interval '1 minute', now() - interval '1 minute', 'queued'),
         ('content_version', $4, $5, $6, 'diag_scheduled', 2, now() + interval '5 minutes', now(), 'queued'),
         ('member_club_profile_version', $1, $2, $3, 'diag_capped', 5, now() - interval '1 minute', now(), 'failed')`,
      [
        profileVersionId,
        EMBEDDING_PROFILES.member_profile.model,
        EMBEDDING_PROFILES.member_profile.dimensions,
        seededEntity.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
      ],
    );
    await h.sqlClubs(
      `insert into ai_embedding_jobs
         (subject_kind, subject_version_id, model, dimensions, source_version, attempt_count, next_attempt_at, last_error, state)
       values
         ('content_version', $1, $2, $3, 'diag_retry', 4, now() + interval '1 minute', $4, 'queued'),
         ('content_version', $1, 'text-embedding-legacy', 768, 'diag_legacy', 2, now() + interval '10 minutes', 'legacy retry', 'queued')`,
      [
        seededEntity.contentVersionId,
        EMBEDDING_PROFILES.content.model,
        EMBEDDING_PROFILES.content.dimensions,
        longError,
      ],
    );

    const diagnostics = await getDiagnostics(admin.token);
    const workers = diagnostics.workers as Record<string, unknown>;
    const embedding = workers.embedding as Record<string, unknown>;
    const queue = embedding.queue as Record<string, unknown>;
    assert.deepEqual(queue, {
      claimable: 1,
      scheduledFuture: 3,
      atOrOverMaxAttempts: 1,
    });
    assert.equal(embedding.failedEmbeddingJobs, 1);
    assert.ok((embedding.oldestClaimableAgeSeconds as number) >= 60);

    const byModel = embedding.byModel as Array<Record<string, unknown>>;
    const currentRow = byModel.find((row) =>
      row.model === EMBEDDING_PROFILES.content.model
      && row.dimensions === EMBEDDING_PROFILES.content.dimensions,
    );
    assert.deepEqual(currentRow, {
      model: EMBEDDING_PROFILES.content.model,
      dimensions: EMBEDDING_PROFILES.content.dimensions,
      claimable: 1,
      scheduledFuture: 2,
      atOrOverMaxAttempts: 1,
    });
    const legacyRow = byModel.find((row) => row.model === 'text-embedding-legacy' && row.dimensions === 768);
    assert.deepEqual(legacyRow, {
      model: 'text-embedding-legacy',
      dimensions: 768,
      claimable: 0,
      scheduledFuture: 1,
      atOrOverMaxAttempts: 0,
    });

    const retryErrorSample = embedding.retryErrorSample as Array<Record<string, unknown>>;
    assert.equal(retryErrorSample.length, 2);
    assert.equal(retryErrorSample[0]!.attemptCount, 4);
    assert.equal((retryErrorSample[0]!.lastError as string).length, 500);
    assert.equal(retryErrorSample[1]!.attemptCount, 2);
  });

  it('non-superadmin cannot access diagnostics', async () => {
    const member = await h.seedMember('Regular Diag');
    const err = await h.apiErr(member.token, 'superadmin.diagnostics.getHealth', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });
});
