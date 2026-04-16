/**
 * Real club-application integration tests covering PoW-at-join plus the
 * application completeness gate.
 *
 * These tests require OPENAI_API_KEY. They run against the real HTTP server,
 * real Postgres, and the real application gate. A test-only env override lowers
 * the cold PoW difficulty so the suite can solve proofs quickly.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { findPowNonce, prepareAnonymousJoin } from '../helpers.ts';

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

async function countSubmittedApplications(clubId: string, email: string): Promise<number> {
  const rows = await h.sql<{ count: string }>(
    `select count(*)::text as count
     from current_club_memberships
     where club_id = $1
       and application_email = $2
       and status = 'submitted'`,
    [clubId, email],
  );
  return Number(rows[0]?.count ?? 0);
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

describe('clubs.prepareJoin + clubs.applications.submit (LLM-gated)', () => {
  it('accepts a canonical trailing-zero proof at join time and submits the application without nonce', async () => {
    const owner = await h.seedOwner('llm-app-pow-trailing', 'LLM App Pow Trailing');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const challenge = await prepareAnonymousJoin(h, owner.club.slug);
    assert.equal(challenge.difficulty, 1);

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'taylor.trailing@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce: findPowNonce(challenge.challengeId, challenge.difficulty),
    });
    const join = joinBody.data as Record<string, unknown>;
    const memberToken = join.memberToken as string;
    const membershipId = join.membershipId as string;

    const submitBody = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      name: 'Taylor Builder',
      socials: '@taylorbuilder',
      application: '1. I live in London.\n2. I build workflow tools for operations teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'submitted');
    assert.equal(result.membershipId, membershipId);
    assert.equal(await countSubmittedApplications(owner.club.id, 'taylor.trailing@example.com'), 1);

    const budget = await h.sql<{ attempts: string }>(
      `select submit_attempt_count::text as attempts
       from club_memberships
       where id = $1`,
      [membershipId],
    );
    assert.equal(Number(budget[0]?.attempts ?? 0), 1);

    const application = await h.apiOk(memberToken, 'clubs.applications.get', { membershipId });
    assert.equal((application.data as any).application.state, 'submitted');
  });

  it('rejects invalid join-time proofs', async () => {
    const owner = await h.seedOwner('llm-app-pow-invalid', 'LLM App Pow Invalid');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const challenge = await prepareAnonymousJoin(h, owner.club.slug);
    const err = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'jamie.invalid@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce: 'not-a-hit',
    }, 'invalid_proof');

    assert.equal(err.status, 422);
  });

  it('accepts an invited join without prepareJoin and still submits without nonce', async () => {
    const owner = await h.seedOwner('llm-app-pow-invite', 'LLM App Pow Invite');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const issued = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Invited Taylor',
      candidateEmail: 'invited.taylor@example.com',
      reason: 'I worked with Taylor for six months on a moderation tooling project. They shipped the queue triage workflow we used every day, documented the rollout clearly, and handled feedback without drama.',
    });
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'invited.taylor@example.com',
      invitationCode,
    });
    const join = joinBody.data as Record<string, unknown>;
    const memberToken = join.memberToken as string;
    const membershipId = join.membershipId as string;

    const submitBody = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      name: 'Invited Taylor',
      socials: '@invitedtaylor',
      application: '1. I live in Bristol.\n2. I build tools for community moderators.',
    });

    assert.equal((submitBody.data as Record<string, unknown>).status, 'submitted');
  });
});
