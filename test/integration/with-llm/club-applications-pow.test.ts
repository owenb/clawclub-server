import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { findInvalidPowNonce, findPowNonce, prepareAccountRegistration, registerWithPow } from '../helpers.ts';

const TEST_DIFFICULTY = '1';
const COLD_DIFFICULTY_ENV = 'CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY';

let h: TestHarness;
let previousColdDifficulty: string | undefined;

async function setAdmissionPolicy(clubId: string, policy: string): Promise<void> {
  await h.sql(
    `insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
     select c.id, c.owner_member_id, c.name, c.summary, $2,
            coalesce((select max(version_no) from club_versions where club_id = $1), 0) + 1,
            c.owner_member_id
     from clubs c where c.id = $1`,
    [clubId, policy],
  );
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_DIFFICULTY;
  h = await TestHarness.start({ embeddingStub: false });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
  if (previousColdDifficulty === undefined) {
    delete process.env[COLD_DIFFICULTY_ENV];
  } else {
    process.env[COLD_DIFFICULTY_ENV] = previousColdDifficulty;
  }
}, { timeout: 15_000 });

describe('accounts.register + club applications (LLM-gated)', () => {
  it('solves PoW once at registration and then applies to a club without another proof step', async () => {
    const owner = await h.seedOwner('llm-app-register-cold', 'LLM App Register Cold');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const registration = await registerWithPow(h, {
      name: 'Taylor Builder',
      email: 'taylor.builder@example.com',
      clientKey: 'llm-register-cold',
    });

    const applyBody = await h.apiOk(registration.bearerToken, 'clubs.apply', {
      clubSlug: owner.club.slug,
      clientKey: 'llm-apply-cold',
      draft: {
        name: 'Taylor Builder',
        socials: '@taylorbuilder',
        application: '1. I live in London.\n2. I build workflow tools for operations teams.',
      },
    });

    const result = applyBody.data as Record<string, unknown>;
    const application = result.application as Record<string, unknown>;
    const phase = application.phase as string;

    assert.ok(
      phase === 'awaiting_review' || phase === 'revision_required',
      `expected a live application phase, got ${phase}`,
    );
    assert.equal(application.submissionPath, 'cold');

    const rows = await h.sql<{ count: string }>(
      `select count(*)::text as count
         from club_applications
        where club_id = $1
          and applicant_member_id = $2`,
      [owner.club.id, registration.memberId],
    );
    assert.equal(Number(rows[0]?.count ?? 0), 1);
  });

  it('rejects invalid registration proofs', async () => {
    const challenge = await prepareAccountRegistration(h, 'llm-register-invalid-discover');
    const err = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'llm-register-invalid-submit',
      name: 'Jamie Invalid',
      email: 'jamie.invalid@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce: findInvalidPowNonce(challenge.challengeId, challenge.difficulty),
    }, 'invalid_proof');

    assert.equal(err.status, 422);
  });

  it('redeems an invite after registration without another proof-of-work round', async () => {
    const owner = await h.seedOwner('llm-app-invite', 'LLM App Invite');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const issued = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Invited Taylor',
      candidateEmail: 'invited.taylor@example.com',
      reason: 'I worked with Taylor on moderation tooling. They shipped strong operator workflows and handled feedback well.',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const code = String(invitation.code).toLowerCase();

    const registration = await registerWithPow(h, {
      name: 'Invited Taylor',
      email: 'invited.taylor@example.com',
      clientKey: 'llm-register-invite',
    });

    const redeemBody = await h.apiOk(registration.bearerToken, 'invitations.redeem', {
      code,
      clientKey: 'llm-redeem-invite',
      draft: {
        name: 'Invited Taylor',
        socials: '@invitedtaylor',
        application: '1. I live in Bristol.\n2. I build tools for community moderators.',
      },
    });

    const result = redeemBody.data as Record<string, unknown>;
    const application = result.application as Record<string, unknown>;
    const phase = application.phase as string;

    assert.ok(
      phase === 'awaiting_review' || phase === 'revision_required',
      `expected a live invitation application phase, got ${phase}`,
    );
    assert.equal(application.submissionPath, 'invitation');
  });

  it('still accepts the canonical trailing-zero proof format at registration', async () => {
    const challenge = await prepareAccountRegistration(h, 'llm-register-canonical-discover');
    assert.equal(challenge.difficulty, 1);

    const body = await h.apiOk(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'llm-register-canonical-submit',
      name: 'Canonical Nonce',
      email: 'canonical.nonce@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce: findPowNonce(challenge.challengeId, challenge.difficulty),
    });

    const data = body.data as Record<string, unknown>;
    assert.equal(data.phase, 'registered');
    assert.equal(((data.member as Record<string, unknown>).email), 'canonical.nonce@example.com');
  });
});
