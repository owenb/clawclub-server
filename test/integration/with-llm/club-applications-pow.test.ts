/**
 * Real club-application integration tests covering PoW solving plus the
 * application completeness gate.
 *
 * These tests require OPENAI_API_KEY. They run against the real HTTP server,
 * real Postgres, and the real application gate. A test-only env override lowers
 * the cold PoW difficulty so the suite can solve proofs quickly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestHarness } from '../harness.ts';

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

function findNonce(challengeId: string, difficulty: number, mode: 'trailing' | 'leading_only' | 'invalid'): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 100_000; nonce++) {
    const candidate = String(nonce);
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');

    if (mode === 'trailing' && hash.endsWith(zeros)) {
      return candidate;
    }

    if (mode === 'leading_only' && hash.startsWith(zeros) && !hash.endsWith(zeros)) {
      return candidate;
    }

    if (mode === 'invalid' && !hash.startsWith(zeros) && !hash.endsWith(zeros)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find ${mode} nonce for difficulty ${difficulty}`);
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

async function readPowChallenge(membershipId: string): Promise<{ attempts: number; solvedAt: string | null } | null> {
  const rows = await h.sql<{ attempts: string; solved_at: string | null }>(
    `select attempts::text as attempts, solved_at::text as solved_at
     from application_pow_challenges
     where membership_id = $1
     order by created_at desc
     limit 1`,
    [membershipId],
  );
  if (!rows[0]) return null;
  return {
    attempts: Number(rows[0].attempts),
    solvedAt: rows[0].solved_at,
  };
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

describe('clubs.join + clubs.applications.submit cold PoW (LLM-gated)', () => {
  it('accepts the canonical trailing-zero PoW and submits the application', async () => {
    const owner = await h.seedOwner('llm-app-pow-trailing', 'LLM App Pow Trailing');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'taylor.trailing@example.com',
    });
    const join = joinBody.data as Record<string, unknown>;
    const proof = join.proof as Record<string, unknown>;
    const memberToken = join.memberToken as string;
    const membershipId = join.membershipId as string;
    const challengeId = proof.challengeId as string;
    const difficulty = proof.difficulty as number;

    assert.equal(proof.kind, 'pow');
    assert.equal(difficulty, 1);

    const nonce = findNonce(challengeId, difficulty, 'trailing');
    const submitBody = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce,
      name: 'Taylor Builder',
      socials: '@taylorbuilder',
      application: '1. I live in London.\n2. I build workflow tools for operations teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'submitted');
    assert.equal(result.membershipId, membershipId);
    assert.equal(await countSubmittedApplications(owner.club.id, 'taylor.trailing@example.com'), 1);

    const challenge = await readPowChallenge(membershipId);
    assert.equal(challenge?.attempts, 1);
    assert.notEqual(challenge?.solvedAt, null);

    const application = await h.apiOk(memberToken, 'clubs.applications.get', { membershipId });
    assert.equal((application.data as any).application.state, 'submitted');
  });

  it('rejects leading-zero-only compatibility proofs and leaves the challenge unsolved', async () => {
    const owner = await h.seedOwner('llm-app-pow-leading', 'LLM App Pow Leading');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'morgan.leading@example.com',
    });
    const join = joinBody.data as Record<string, unknown>;
    const proof = join.proof as Record<string, unknown>;
    const memberToken = join.memberToken as string;
    const membershipId = join.membershipId as string;
    const challengeId = proof.challengeId as string;
    const difficulty = proof.difficulty as number;

    const nonce = findNonce(challengeId, difficulty, 'leading_only');
    const invalid = await h.apiErr(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce,
      name: 'Morgan Operator',
      socials: '@morganoperator',
      application: '1. I live in Bristol.\n2. I build internal tools for finance teams.',
    }, 'invalid_proof');

    assert.equal(invalid.status, 400);

    const challenge = await readPowChallenge(membershipId);
    assert.equal(challenge?.attempts, 0);
    assert.equal(challenge?.solvedAt, null);
  });

  it('rejects invalid proofs and still allows a valid retry on the same challenge', async () => {
    const owner = await h.seedOwner('llm-app-pow-invalid', 'LLM App Pow Invalid');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'jamie.retry@example.com',
    });
    const join = joinBody.data as Record<string, unknown>;
    const proof = join.proof as Record<string, unknown>;
    const memberToken = join.memberToken as string;
    const membershipId = join.membershipId as string;
    const challengeId = proof.challengeId as string;
    const difficulty = proof.difficulty as number;

    const invalidNonce = findNonce(challengeId, difficulty, 'invalid');
    const invalid = await h.apiErr(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce: invalidNonce,
      name: 'Jamie Retry',
      socials: '@jamieretry',
      application: '1. I live in Leeds.\n2. I build analytics software for logistics teams.',
    }, 'invalid_proof');

    assert.equal(invalid.status, 400);
    const beforeRetry = await readPowChallenge(membershipId);
    assert.equal(beforeRetry?.attempts, 0);
    assert.equal(beforeRetry?.solvedAt, null);

    const trailingNonce = findNonce(challengeId, difficulty, 'trailing');
    const submitBody = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce: trailingNonce,
      name: 'Jamie Retry',
      socials: '@jamieretry',
      application: '1. I live in Leeds.\n2. I build analytics software for logistics teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'submitted');
    assert.equal(await countSubmittedApplications(owner.club.id, 'jamie.retry@example.com'), 1);
  });
});
