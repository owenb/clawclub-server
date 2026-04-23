import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

type Draft = {
  name: string;
  socials: string;
  application: string;
};

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function legacyGateInputHash(draft: Draft, admissionPolicy: string | null): string {
  return createHash('sha256').update(
    JSON.stringify({
      name: draft.name,
      socials: draft.socials,
      application: draft.application,
      admissionPolicy: admissionPolicy && admissionPolicy.trim().length > 0 ? admissionPolicy : null,
    }),
    'utf8',
  ).digest('hex');
}

function currentGateInputHash(input: {
  draft: Draft;
  memberEmail: string | null;
  clubName: string;
  clubSummary: string | null;
  admissionPolicy: string | null;
}): string {
  return createHash('sha256').update(
    JSON.stringify({
      name: input.draft.name,
      memberEmail: input.memberEmail,
      socials: input.draft.socials,
      application: input.draft.application,
      clubName: input.clubName,
      clubSummary: input.clubSummary,
      admissionPolicy: input.admissionPolicy && input.admissionPolicy.trim().length > 0
        ? input.admissionPolicy
        : null,
    }),
    'utf8',
  ).digest('hex');
}

async function countApplicationReservations(memberId: string, clubId: string): Promise<number> {
  const [row] = await h.sql<{ count: string }>(
    `select count(*)::text as count
       from ai_llm_quota_reservations
      where member_id = $1
        and club_id = $2
        and action_name = 'clubs.apply'`,
    [memberId, clubId],
  );
  return Number(row?.count ?? 0);
}

async function insertClubVersion(input: {
  clubId: string;
  actorMemberId: string;
  name?: string;
  summary?: string | null;
  admissionPolicy?: string | null;
}): Promise<void> {
  const [current] = await h.sql<{
    current_version_id: string;
    current_version_no: number;
    owner_member_id: string;
    name: string;
    summary: string | null;
    admission_policy: string | null;
    uses_free_allowance: boolean;
    member_cap: number | null;
  }>(
    `select
        cv.id as current_version_id,
        cv.version_no as current_version_no,
        cv.owner_member_id,
        cv.name,
        cv.summary,
        cv.admission_policy,
        cv.uses_free_allowance,
        cv.member_cap
     from current_club_versions cv
     where cv.club_id = $1
     limit 1`,
    [input.clubId],
  );
  assert.ok(current, 'expected a current club version');

  await h.sql(
    `insert into club_versions (
       club_id,
       owner_member_id,
       name,
       summary,
       admission_policy,
       uses_free_allowance,
       member_cap,
       version_no,
       supersedes_version_id,
       created_by_member_id
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.clubId,
      current.owner_member_id,
      input.name ?? current.name,
      input.summary !== undefined ? input.summary : current.summary,
      input.admissionPolicy !== undefined ? input.admissionPolicy : current.admission_policy,
      current.uses_free_allowance,
      current.member_cap,
      Number(current.current_version_no) + 1,
      current.current_version_id,
      input.actorMemberId,
    ],
  );
}

async function readApplicationCache(applicationId: string): Promise<{
  generatedProfileDraft: Record<string, unknown> | null;
  gateLastRunAt: string | null;
}> {
  const [row] = await h.sql<{
    generated_profile_draft: Record<string, unknown> | null;
    gate_last_run_at: string | null;
  }>(
    `select
        generated_profile_draft,
        gate_last_run_at::text as gate_last_run_at
     from club_applications
     where id = $1
     limit 1`,
    [applicationId],
  );
  assert.ok(row, 'expected application row');
  return {
    generatedProfileDraft: row.generated_profile_draft,
    gateLastRunAt: row.gate_last_run_at,
  };
}

describe('application gate input hash', () => {
  it('reuses the stored verdict and generated profile when the revise input is unchanged', async () => {
    const owner = await h.seedOwner('gate-hash-unchanged', 'Gate Hash Unchanged Club');
    const applicantEmail = 'gate-hash-unchanged@test.clawclub.local';
    const applicant = await h.seedMember('Gate Hash Unchanged Applicant', applicantEmail);
    const draft = {
      name: 'Gate Hash Unchanged Applicant',
      socials: 'https://example.com/gate-hash-unchanged',
      application: 'I care about careful operations and would like to join.',
    };
    const admissionPolicy = 'Explain why you are a fit for this club.';
    const generatedProfileDraft = {
      tagline: 'Careful operator',
      summary: 'I care about careful operations and would like to join.',
      whatIDo: null,
      knownFor: null,
      servicesSummary: null,
      websiteUrl: 'https://example.com/gate-hash-unchanged',
      links: [],
    };
    const gateLastRunAt = '2026-01-02T03:04:05.000Z';

    await insertClubVersion({
      clubId: owner.club.id,
      actorMemberId: owner.id,
      admissionPolicy,
    });
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: draft.name,
      draftSocials: draft.socials,
      draftApplication: draft.application,
      generatedProfileDraft,
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Please add more specifics.', missingItems: ['specifics'] },
    });
    await h.sql(
      `update club_applications
          set gate_input_hash = $2,
              gate_last_run_at = $3::timestamptz
        where id = $1`,
      [
        application.id,
        currentGateInputHash({
          draft,
          memberEmail: applicantEmail,
          clubName: owner.club.name,
          clubSummary: `Test club ${owner.club.slug}`,
          admissionPolicy,
        }),
        gateLastRunAt,
      ],
    );

    const beforeReservations = await countApplicationReservations(applicant.id, owner.club.id);
    const beforeCache = await readApplicationCache(application.id);

    await h.apiOk(applicant.token, 'clubs.applications.revise', {
      applicationId: application.id,
      draft,
      clientKey: 'gate-hash-unchanged-1',
    });

    const afterReservations = await countApplicationReservations(applicant.id, owner.club.id);
    const afterCache = await readApplicationCache(application.id);

    assert.equal(afterReservations - beforeReservations, 0, 'unchanged revise should not reserve new LLM quota');
    assert.deepEqual(afterCache.generatedProfileDraft, beforeCache.generatedProfileDraft, 'unchanged revise should reuse the stored generated profile');
    assert.equal(afterCache.gateLastRunAt, beforeCache.gateLastRunAt, 'unchanged revise should reuse the prior gate verdict timestamp');
  });

  it('reruns the gate when the applicant email changes', async () => {
    const owner = await h.seedOwner('gate-hash-email', 'Gate Hash Email Club');
    const applicant = await h.seedMember('Gate Hash Email Applicant', 'gate-hash-email-before@test.clawclub.local');
    const draft = {
      name: 'Gate Hash Email Applicant',
      socials: '@gatehash',
      application: 'I work on careful operations and want to join this club.',
    };
    const admissionPolicy = 'Explain why this club is the right fit for you.';

    await insertClubVersion({
      clubId: owner.club.id,
      actorMemberId: owner.id,
      admissionPolicy,
    });
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: draft.name,
      draftSocials: draft.socials,
      draftApplication: draft.application,
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Please add more specifics.', missingItems: ['specifics'] },
    });
    await h.sql(
      `update club_applications
          set gate_input_hash = $2
        where id = $1`,
      [application.id, legacyGateInputHash(draft, admissionPolicy)],
    );

    await h.sql(`update members set email = $2 where id = $1`, [
      applicant.id,
      'gate-hash-email-after@test.clawclub.local',
    ]);

    const before = await countApplicationReservations(applicant.id, owner.club.id);
    await h.apiOk(applicant.token, 'clubs.applications.revise', {
      applicationId: application.id,
      draft,
      clientKey: 'gate-hash-email-1',
    });
    const after = await countApplicationReservations(applicant.id, owner.club.id);

    assert.equal(after - before, 2, 'profile generation and the application gate should both reserve quota after an email change');
  });

  it('reruns the gate when club name or summary changes', async () => {
    const owner = await h.seedOwner('gate-hash-club', 'Gate Hash Club');
    const applicant = await h.seedMember('Gate Hash Club Applicant');
    const draft = {
      name: 'Gate Hash Club Applicant',
      socials: '@gatehashclub',
      application: 'I care about durable backend systems and careful operations.',
    };
    const admissionPolicy = 'Tell us why you fit the club.';

    await insertClubVersion({
      clubId: owner.club.id,
      actorMemberId: owner.id,
      admissionPolicy,
    });
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: draft.name,
      draftSocials: draft.socials,
      draftApplication: draft.application,
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Please add more specifics.', missingItems: ['specifics'] },
    });
    await h.sql(
      `update club_applications
          set gate_input_hash = $2
        where id = $1`,
      [application.id, legacyGateInputHash(draft, admissionPolicy)],
    );

    await insertClubVersion({
      clubId: owner.club.id,
      actorMemberId: owner.id,
      name: 'Gate Hash Club Renamed',
      summary: 'A changed summary that should invalidate the cached gate verdict.',
    });

    const before = await countApplicationReservations(applicant.id, owner.club.id);
    await h.apiOk(applicant.token, 'clubs.applications.revise', {
      applicationId: application.id,
      draft,
      clientKey: 'gate-hash-club-1',
    });
    const after = await countApplicationReservations(applicant.id, owner.club.id);

    assert.equal(after - before, 2, 'profile generation and the application gate should both reserve quota after club text changes');
  });
});
