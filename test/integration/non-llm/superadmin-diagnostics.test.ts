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
    // This surface reports global worker tables, not club-scoped state. Keep this
    // cleanup local to the dedicated diagnostics file so other integration suites
    // never depend on these tables being globally wiped.
    await h.sqlClubs(`delete from signal_background_matches`);
    await h.sqlClubs(`delete from signal_recompute_queue`);
    await h.sqlClubs(`delete from worker_state`);
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

  it('returns diagnostics with correct shape', async () => {
    const admin = await h.seedSuperadmin('Admin Diag');

    const diagnostics = await getDiagnostics(admin.token);
    assert.ok(typeof diagnostics.migrationCount === 'number');
    assert.ok(diagnostics.migrationCount >= 1);
    assert.ok(typeof diagnostics.memberCount === 'number');
    assert.ok(typeof diagnostics.clubCount === 'number');
    assert.ok(typeof diagnostics.tablesWithRls === 'number');
    assert.ok(typeof diagnostics.totalAppTables === 'number');
    assert.ok(typeof diagnostics.databaseSize === 'string');
    const workers = diagnostics.workers as Record<string, unknown>;
    const embedding = workers.embedding as Record<string, unknown>;
    const queue = embedding.queue as Record<string, unknown>;
    assert.equal(queue.claimable, 0);
    assert.equal(queue.scheduledFuture, 0);
    assert.equal(queue.atOrOverMaxAttempts, 0);
    assert.deepEqual(embedding.byModel, []);
    assert.deepEqual(embedding.retryErrorSample, []);
    const synchronicity = workers.synchronicity as Record<string, unknown>;
    assert.deepEqual(synchronicity.contentPublicationBacklog, {
      pendingCount: null,
      oldestPendingAgeSeconds: null,
    });
    assert.deepEqual(synchronicity.recomputeQueue, {
      readyCount: 0,
      inFlightCount: 0,
      scheduledCount: 0,
    });
    assert.equal(synchronicity.pendingMatchesCount, 0);
    const cursors = synchronicity.cursors as Record<string, unknown>;
    assert.deepEqual(cursors.activitySeq, { value: null, updatedAt: null, ageSeconds: null });
    assert.deepEqual(cursors.profileArtifactAt, { value: null, updatedAt: null, ageSeconds: null });
    assert.deepEqual(cursors.membershipScanAt, { value: null, updatedAt: null, ageSeconds: null });
    assert.deepEqual(cursors.backstopSweepAt, { value: null, updatedAt: null, ageSeconds: null });
    assert.ok(typeof diagnostics.collectedAt === 'string');
    assert.ok(Math.abs(Date.parse(diagnostics.collectedAt as string) - Date.now()) < 60_000);
  });

  it('keeps content backlog null when activity_seq is missing even if activity exists', async () => {
    const admin = await h.seedSuperadmin('Admin Diag Null Cursor');
    const owner = await h.seedOwner('diag-null-cursor', 'Diag Null Cursor');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic)
       values
         ($1, 'content.version.published'),
         ($1, 'content.version.published'),
         ($1, 'content.version.published')`,
      [owner.club.id],
    );

    const diagnostics = await getDiagnostics(admin.token);
    const backlog = ((diagnostics.workers as Record<string, unknown>).synchronicity as Record<string, unknown>)
      .contentPublicationBacklog as Record<string, unknown>;
    assert.equal(backlog.pendingCount, null);
    assert.equal(backlog.oldestPendingAgeSeconds, null);
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
         (subject_kind, subject_version_id, model, dimensions, source_version, attempt_count, next_attempt_at, created_at)
       values
         ('member_club_profile_version', $1, $2, $3, 'diag_claimable', 0, now() - interval '1 minute', now() - interval '1 minute'),
         ('content_version', $4, $5, $6, 'diag_scheduled', 2, now() + interval '5 minutes', now()),
         ('member_club_profile_version', $1, $2, $3, 'diag_capped', 5, now() - interval '1 minute', now())`,
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
         (subject_kind, subject_version_id, model, dimensions, source_version, attempt_count, next_attempt_at, last_error)
       values
         ('content_version', $1, $2, $3, 'diag_retry', 4, now() + interval '1 minute', $4),
         ('content_version', $1, 'text-embedding-legacy', 768, 'diag_legacy', 2, now() + interval '10 minutes', 'legacy retry')`,
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

  it('surfaces typed synchronicity cursors and filters opaque internal state', async () => {
    const admin = await h.seedSuperadmin('Admin Diag Cursors');
    const owner = await h.seedOwner('diag-cursors', 'Diag Cursors');
    const now = Date.now();
    const profileArtifactAt = new Date(now - 120_000).toISOString();
    const membershipScanAt = new Date(now - 180_000).toISOString();
    const backstopSweepAt = new Date(now - 240_000).toISOString();

    await h.sqlClubs(
      `insert into worker_state (worker_id, state_key, state_value, updated_at)
       values
         ('synchronicity', 'activity_seq', '12', now() - interval '1 minute'),
         ('synchronicity', 'profile_artifact_at', $1, now() - interval '2 minutes'),
         ('synchronicity', 'membership_scan_at', $2, now() - interval '3 minutes'),
         ('synchronicity', 'backstop_sweep_at', $3, now() - interval '4 minutes'),
         ('synchronicity', 'profile_artifact_member_id', $4, now() - interval '2 minutes')`,
      [profileArtifactAt, membershipScanAt, backstopSweepAt, owner.id],
    );

    const diagnostics = await getDiagnostics(admin.token);
    const cursors = (((diagnostics.workers as Record<string, unknown>).synchronicity as Record<string, unknown>)
      .cursors as Record<string, unknown>);
    const activitySeq = cursors.activitySeq as Record<string, unknown>;
    const profileCursor = cursors.profileArtifactAt as Record<string, unknown>;
    const membershipCursor = cursors.membershipScanAt as Record<string, unknown>;
    const backstopCursor = cursors.backstopSweepAt as Record<string, unknown>;

    assert.equal(activitySeq.value, 12);
    assert.ok(Math.abs((activitySeq.ageSeconds as number) - 60) <= 5);
    assert.equal(profileCursor.value, profileArtifactAt);
    assert.ok(Math.abs((profileCursor.ageSeconds as number) - 120) <= 5);
    assert.equal(membershipCursor.value, membershipScanAt);
    assert.ok(Math.abs((membershipCursor.ageSeconds as number) - 180) <= 5);
    assert.equal(backstopCursor.value, backstopSweepAt);
    assert.ok(Math.abs((backstopCursor.ageSeconds as number) - 240) <= 5);
    assert.ok(!('profileArtifactMemberId' in cursors));
  });

  it('counts only content publication backlog rows past the cursor', async () => {
    const admin = await h.seedSuperadmin('Admin Diag Backlog');
    const owner = await h.seedOwner('diag-backlog', 'Diag Backlog');
    const [baseRow] = await h.sqlClubs<{ max_seq: string }>(
      `select coalesce(max(seq), 0)::text as max_seq from club_activity`,
    );

    await h.sqlClubs(
      `insert into worker_state (worker_id, state_key, state_value, updated_at)
       values ('synchronicity', 'activity_seq', $1, now())`,
      [baseRow!.max_seq],
    );
    await h.sqlClubs(
      `insert into club_activity (club_id, topic, created_at)
       select $1, 'content.version.published', now() - interval '1 minute'
       from generate_series(1, 5)
       union all
       select $1, 'profile.updated', now() - interval '1 minute'
       from generate_series(1, 5)`,
      [owner.club.id],
    );

    const diagnostics = await getDiagnostics(admin.token);
    const backlog = ((diagnostics.workers as Record<string, unknown>).synchronicity as Record<string, unknown>)
      .contentPublicationBacklog as Record<string, unknown>;
    assert.equal(backlog.pendingCount, 5);
    assert.ok((backlog.oldestPendingAgeSeconds as number) >= 60);
  });

  it('partitions recompute queue rows and counts pending matches', async () => {
    const admin = await h.seedSuperadmin('Admin Diag Recompute');
    const owner = await h.seedOwner('diag-recompute', 'Diag Recompute');
    const members = await Promise.all([
      h.seedCompedMember(owner.club.id, 'Diag Queue 1'),
      h.seedCompedMember(owner.club.id, 'Diag Queue 2'),
      h.seedCompedMember(owner.club.id, 'Diag Queue 3'),
      h.seedCompedMember(owner.club.id, 'Diag Queue 4'),
      h.seedCompedMember(owner.club.id, 'Diag Queue 5'),
    ]);

    await h.sqlClubs(
      `insert into signal_recompute_queue (queue_name, member_id, club_id, recompute_after, claimed_at)
       values
         ('introductions', $1, $6, now() - interval '1 minute', null),
         ('introductions', $2, $6, now() - interval '10 minutes', now() - interval '10 minutes'),
         ('introductions', $3, $6, now() - interval '1 minute', now() - interval '1 minute'),
         ('introductions', $4, $6, now() + interval '10 minutes', null),
         ('introductions', $5, $6, now() + interval '10 minutes', now() - interval '1 minute')`,
      [members[0]!.id, members[1]!.id, members[2]!.id, members[3]!.id, members[4]!.id, owner.club.id],
    );
    await h.sqlClubs(
      `insert into signal_background_matches
         (club_id, match_kind, source_id, target_member_id, score, state, delivered_at)
       values
         ($1, 'ask_to_member', 'diag_pending', $2, 0.1, 'pending', null),
         ($1, 'ask_to_member', 'diag_delivered', $2, 0.1, 'delivered', now())`,
      [owner.club.id, members[0]!.id],
    );

    const diagnostics = await getDiagnostics(admin.token);
    const synchronicity = (diagnostics.workers as Record<string, unknown>).synchronicity as Record<string, unknown>;
    const recomputeQueue = synchronicity.recomputeQueue as Record<string, unknown>;
    assert.deepEqual(recomputeQueue, {
      readyCount: 2,
      inFlightCount: 1,
      scheduledCount: 1,
    });
    assert.equal(
      (recomputeQueue.readyCount as number)
        + (recomputeQueue.inFlightCount as number)
        + (recomputeQueue.scheduledCount as number),
      4,
    );
    assert.equal(synchronicity.pendingMatchesCount, 1);
  });

  it('non-superadmin cannot access diagnostics', async () => {
    const member = await h.seedMember('Regular Diag');
    const err = await h.apiErr(member.token, 'superadmin.diagnostics.getHealth', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});
