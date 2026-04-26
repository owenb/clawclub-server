import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { DEFAULT_CONFIG_V1, type AppConfig } from '../../../src/config/index.ts';
import type { LlmGateFn } from '../../../src/dispatch.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfig;
}

describe('clubs.create gate ordering and idempotency', () => {
  let h: TestHarness;
  let gateMode: 'pass' | 'reject' = 'pass';
  let gateCalls = 0;

  const gate: LlmGateFn = async () => {
    gateCalls += 1;
    if (gateMode === 'reject') {
      return {
        status: 'rejected_quality',
        feedback: 'This club description does not explain a concrete lawful purpose or who it is for — add both.',
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    }
    return {
      status: 'passed',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };

  before(async () => {
    const config = cloneConfig();
    config.policy.clubs.maxClubsPerMember = 5;
    config.policy.quotas.actions['clubs.create'].dailyMax = 2;
    h = await TestHarness.start({ config, llmGate: gate });
  }, { timeout: 60_000 });

  after(async () => {
    await h?.stop();
  }, { timeout: 15_000 });

  it('reruns the gate after a rejected create and still consumes the create quota', async () => {
    gateMode = 'reject';
    gateCalls = 0;

    const member = await h.seedMember('Rejected Club Creator');
    const clientKey = randomUUID();

    const first = await h.apiErr(member.token, 'clubs.create', {
      clientKey,
      slug: 'rejected-club-one',
      name: 'Rejected Club One',
      summary: 'This will be rejected by the test gate.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    assert.equal(first.code, 'low_quality_content');
    assert.equal(gateCalls, 1);

    const replay = await h.apiErr(member.token, 'clubs.create', {
      clientKey,
      slug: 'rejected-club-one',
      name: 'Rejected Club One',
      summary: 'This will be rejected by the test gate.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    assert.equal(replay.code, 'low_quality_content');
    assert.equal(gateCalls, 2, 'failed attempts should not be cached by idempotency');

    const quotaErr = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'rejected-club-two',
      name: 'Rejected Club Two',
      summary: 'A third attempt should hit the request quota before the gate runs.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    assert.equal(quotaErr.code, 'quota_exceeded');
    assert.equal(gateCalls, 2, 'quota exhaustion should prevent a third gate call');
  });

  it('exact successful replay skips the gate and returns the original club', async () => {
    gateMode = 'pass';
    gateCalls = 0;

    const member = await h.seedMember('Replay Club Creator');
    const clientKey = randomUUID();
    const input = {
      clientKey,
      slug: `replay-club-${Date.now().toString(36)}`,
      name: 'Replay Club',
      summary: 'A specific club for replay verification.',
      admissionPolicy: 'Members should explain what they are building and how they will contribute.',
    };

    const first = await h.apiOk(member.token, 'clubs.create', input);
    const second = await h.apiOk(member.token, 'clubs.create', input);

    const firstClub = (first.data as Record<string, unknown>).club as Record<string, unknown>;
    const secondClub = (second.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(firstClub.clubId, secondClub.clubId);
    assert.equal(gateCalls, 1, 'exact replay should be served from idempotency without rerunning the gate');
  });
});

describe('superadmin club-cap updates', () => {
  let h: TestHarness;
  let gateCalls = 0;

  const gate: LlmGateFn = async () => {
    gateCalls += 1;
    return {
      status: 'passed',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };

  before(async () => {
    h = await TestHarness.start({ llmGate: gate });
  }, { timeout: 60_000 });

  after(async () => {
    await h?.stop();
  }, { timeout: 15_000 });

  it('skips the gate for memberCap-only updates and for exact no-op repeats', async () => {
    const admin = await h.seedSuperadmin('Lifecycle Gate Admin');
    const owner = await h.seedMember('Lifecycle Cap Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'member-cap-only-club',
      name: 'Member Cap Only Club',
      summary: 'A club used to verify cap-only updates.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const club = (created.data as Record<string, unknown>).club as Record<string, unknown>;
    const clubId = String(club.clubId);

    gateCalls = 0;

    const first = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 20,
    });
    const firstClub = (first.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(firstClub.usesFreeAllowance, false);
    assert.equal(firstClub.memberCap, 20);
    assert.equal((firstClub.version as Record<string, unknown>).no, 2);
    assert.equal(gateCalls, 0, 'memberCap-only updates should skip the gate');

    const second = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 20,
    });
    const secondClub = (second.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((secondClub.version as Record<string, unknown>).no, 2, 'no-op repeat should not append a new version');
    assert.equal(gateCalls, 0, 'no-op repeat should also skip the gate');
  });

  it('skips the gate for semantic no-op text updates and returns the current version unchanged', async () => {
    const owner = await h.seedMember('Lifecycle No-Op Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'clubadmin-noop-club',
      name: 'Clubadmin No-Op Club',
      summary: 'A club used to verify semantic no-op text updates.',
      admissionPolicy: 'Members should show up with one concrete thing they are working on.',
    });
    const club = (created.data as Record<string, unknown>).club as Record<string, unknown>;
    const clubId = String(club.clubId);

    gateCalls = 0;

    const noop = await h.apiOk(owner.token, 'clubadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      summary: String(club.summary),
      admissionPolicy: String(club.admissionPolicy),
    });
    const returnedClub = (noop.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((returnedClub.version as Record<string, unknown>).no, 1);
    assert.equal(gateCalls, 0, 'semantic no-op text updates should skip the gate entirely');
  });

  it('rejects archived club updates before running the gate', async () => {
    const admin = await h.seedSuperadmin('Lifecycle Archived Update Admin');
    const owner = await h.seedOwner('archived-update-club', 'Archived Update Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
    });

    gateCalls = 0;
    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      summary: 'This text should never be sent to the gate because the club is archived.',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'club_archived');
    assert.equal(gateCalls, 0, 'archived clubs should be rejected before the LLM gate');
  });

  it('rejects lowering the cap below the current active member count', async () => {
    const admin = await h.seedSuperadmin('Lifecycle Cap Admin');
    const owner = await h.seedMember('Lifecycle Cap Count Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'member-cap-floor-club',
      name: 'Member Cap Floor Club',
      summary: 'A club used to verify cap floor errors.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = String((((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId));

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 3,
    });

    const firstExtra = await h.seedMember('Cap Floor Member One');
    const secondExtra = await h.seedMember('Cap Floor Member Two');
    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId,
      memberId: firstExtra.id,
      initialStatus: 'active',
    });
    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId,
      memberId: secondExtra.id,
      initialStatus: 'active',
    });

    gateCalls = 0;
    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      memberCap: 2,
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'member_cap_below_current_count');
    assert.equal(gateCalls, 0, 'memberCap-only rejection should happen without running the gate');
  });

  it('serializes free-allowance toggles against concurrent member creation', async () => {
    const admin = await h.seedSuperadmin('Lifecycle Cap Race Admin');
    const owner = await h.seedMember('Lifecycle Cap Race Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'member-cap-race-club',
      name: 'Member Cap Race Club',
      summary: 'A club used to verify cap updates serialize with joins.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = String((((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId));

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 50,
    });

    for (let index = 0; index < 4; index += 1) {
      const member = await h.seedMember(`Cap Race Member ${index}`);
      await h.apiOk(admin.token, 'superadmin.memberships.create', {
        clientKey: randomUUID(),
        clubId,
        memberId: member.id,
        initialStatus: 'active',
      });
    }

    const overflow = await h.seedMember('Cap Race Overflow');
    const [toggleResult, createResult] = await Promise.all([
      h.api(admin.token, 'superadmin.clubs.update', {
        clientKey: randomUUID(),
        clubId,
        usesFreeAllowance: true,
      }),
      h.api(admin.token, 'superadmin.memberships.create', {
        clientKey: randomUUID(),
        clubId,
        memberId: overflow.id,
        initialStatus: 'active',
      }),
    ]);

    const failures = [toggleResult, createResult].filter((result) => result.status !== 200);
    assert.equal(failures.length, 1, 'exactly one side of the capacity race should lose');
    const failureCode = String(((failures[0]?.body as Record<string, unknown>).error as Record<string, unknown>).code);
    assert.ok(
      failureCode === 'member_cap_reached' || failureCode === 'member_cap_below_current_count',
      `unexpected race failure code: ${failureCode}`,
    );

    const [state] = await h.sql<{
      uses_free_allowance: boolean;
      member_cap: number | null;
      active_count: string;
    }>(
      `select
          cv.uses_free_allowance,
          cv.member_cap,
          (
            select count(*)::text
            from current_club_memberships cm
            where cm.club_id = cv.club_id
              and cm.status = 'active'
              and cm.left_at is null
          ) as active_count
       from current_club_versions cv
       where cv.club_id = $1`,
      [clubId],
    );
    assert.ok(state, 'club version should still exist after the race');
    const effectiveCap = state.uses_free_allowance ? 5 : state.member_cap;
    if (effectiveCap !== null) {
      assert.ok(Number(state.active_count) <= effectiveCap, 'final active count should respect the effective cap');
    }
  });
});

describe('removed club survivor guards', () => {
  let h: TestHarness;

  before(async () => {
    h = await TestHarness.start({ llmGate: passthroughGate });
  }, { timeout: 60_000 });

  after(async () => {
    await h?.stop();
  }, { timeout: 15_000 });

  it('rejects a mismatched confirmSlug', async () => {
    const admin = await h.seedSuperadmin('Removal Confirm Admin');
    const owner = await h.seedOwner('confirm-slug-club', 'Confirm Slug Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
    });

    const err = await h.apiErr(admin.token, 'superadmin.clubs.remove', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      confirmSlug: 'definitely-not-the-real-slug',
      reason: 'Intentional mismatch for verification.',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /slug/i);
  });

  it('nulls survivor links on removal and does not clobber them if they were re-pointed before restore', async () => {
    const admin = await h.seedSuperadmin('Removal Guard Admin');
    const owner = await h.seedOwner('restore-null-guard-club', 'Restore Null Guard Club');
    const counterpart = await h.seedMember('DM Counterpart');
    const otherOwner = await h.seedOwner('restore-null-guard-other', 'Restore Null Guard Other');

    const primaryContent = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Subject content',
      body: 'The removed club content that will anchor the DM subject link.',
    });
    const primaryContentId = String((((primaryContent.data as Record<string, unknown>).content as Record<string, unknown>).id));

    const alternateContent = await h.apiOk(otherOwner.token, 'content.create', {
      clubId: otherOwner.club.id,
      kind: 'post',
      title: 'Alternate subject content',
      body: 'The surviving content that should keep the re-pointed DM subject.',
    });
    const alternateContentId = String((((alternateContent.data as Record<string, unknown>).content as Record<string, unknown>).id));

    const memberA = owner.id < counterpart.id ? owner.id : counterpart.id;
    const memberB = owner.id < counterpart.id ? counterpart.id : owner.id;
    const threadRows = await h.sql<{ id: string }>(
      `insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, subject_content_id)
       values ('direct', $1, $2, $3, $4)
       returning id`,
      [owner.id, memberA, memberB, primaryContentId],
    );
    const threadId = threadRows[0]!.id;

    const usageRows = await h.sql<{ id: string }>(
      `insert into ai_llm_usage_log (
         member_id,
         requested_club_id,
         action_name,
         artifact_kind,
         provider,
         model,
         gate_status,
         prompt_tokens,
         completion_tokens,
         feedback
       )
       values ($1, $2, 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 11, 7, null)
       returning id`,
      [owner.id, owner.club.id],
    );
    const usageLogId = usageRows[0]!.id;

    await h.apiOk(admin.token, 'superadmin.clubs.archive', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
    });
    const removed = await h.apiOk(admin.token, 'superadmin.clubs.remove', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      confirmSlug: owner.club.slug,
      reason: 'Verify set-null survivors and restore guards.',
    });
    const archiveId = String((((removed.data as Record<string, unknown>).removedClub as Record<string, unknown>).archiveId));

    const nulled = await h.sql<{
      subject_content_id: string | null;
      requested_club_id: string | null;
    }>(
      `select
         (select subject_content_id from dm_threads where id = $1) as subject_content_id,
         (select requested_club_id from ai_llm_usage_log where id = $2) as requested_club_id`,
      [threadId, usageLogId],
    );
    assert.equal(nulled[0]!.subject_content_id, null);
    assert.equal(nulled[0]!.requested_club_id, null);

    await h.sql(
      `update dm_threads set subject_content_id = $2 where id = $1`,
      [threadId, alternateContentId],
    );
    await h.sql(
      `update ai_llm_usage_log set requested_club_id = $2 where id = $1`,
      [usageLogId, otherOwner.club.id],
    );

    await h.apiOk(admin.token, 'superadmin.removedClubs.restore', {
      clientKey: randomUUID(),
      archiveId,
    });

    const repointed = await h.sql<{
      subject_content_id: string | null;
      requested_club_id: string | null;
    }>(
      `select
         (select subject_content_id from dm_threads where id = $1) as subject_content_id,
         (select requested_club_id from ai_llm_usage_log where id = $2) as requested_club_id`,
      [threadId, usageLogId],
    );
    assert.equal(repointed[0]!.subject_content_id, alternateContentId);
    assert.equal(repointed[0]!.requested_club_id, otherOwner.club.id);
  });
});
