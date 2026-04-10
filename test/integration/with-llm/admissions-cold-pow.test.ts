/**
 * Real cold-admission integration tests covering PoW solving plus the
 * admission completeness gate.
 *
 * These tests require OPENAI_API_KEY. They run against the real HTTP server,
 * real Postgres, and the real admission gate. A test-only env override lowers
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

async function countAdmissions(clubId: string, email: string): Promise<number> {
  const rows = await h.sql<{ count: string }>(
    `select count(*)::text as count
     from current_admissions
     where club_id = $1 and applicant_email = $2 and status = 'submitted'`,
    [clubId, email],
  );
  return Number(rows[0]?.count ?? 0);
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_DIFFICULTY;
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
  if (previousColdDifficulty === undefined) {
    delete process.env[COLD_DIFFICULTY_ENV];
  } else {
    process.env[COLD_DIFFICULTY_ENV] = previousColdDifficulty;
  }
}, { timeout: 15_000 });

describe('admissions.public cold PoW (LLM-gated)', () => {
  it('accepts the canonical trailing-zero PoW and creates an admission', async () => {
    const owner = await h.seedOwner('llm-cold-pow-trailing', 'LLM Cold PoW Trailing');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const challengeBody = await h.apiOk(null, 'admissions.public.requestChallenge', {
      clubSlug: owner.club.slug,
    });
    const challenge = challengeBody.data as Record<string, unknown>;
    const challengeId = challenge.challengeId as string;
    const difficulty = challenge.difficulty as number;

    assert.equal(difficulty, 1);

    const nonce = findNonce(challengeId, difficulty, 'trailing');
    const submitBody = await h.apiOk(null, 'admissions.public.submitApplication', {
      challengeId,
      nonce,
      name: 'Taylor Builder',
      email: 'taylor.trailing@example.com',
      socials: '@taylorbuilder',
      application: '1. I live in London.\n2. I build workflow tools for operations teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'accepted');
    assert.equal(submitBody.notices, undefined);
    assert.equal(await countAdmissions(owner.club.id, 'taylor.trailing@example.com'), 1);
  });

  it('accepts leading-zero compatibility proofs and emits a notice', async () => {
    const owner = await h.seedOwner('llm-cold-pow-leading', 'LLM Cold PoW Leading');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const challengeBody = await h.apiOk(null, 'admissions.public.requestChallenge', {
      clubSlug: owner.club.slug,
    });
    const challenge = challengeBody.data as Record<string, unknown>;
    const challengeId = challenge.challengeId as string;
    const difficulty = challenge.difficulty as number;

    assert.equal(difficulty, 1);

    const nonce = findNonce(challengeId, difficulty, 'leading_only');
    const submitBody = await h.apiOk(null, 'admissions.public.submitApplication', {
      challengeId,
      nonce,
      name: 'Morgan Operator',
      email: 'morgan.leading@example.com',
      socials: '@morganoperator',
      application: '1. I live in Bristol.\n2. I build internal tools for finance teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'accepted');
    assert.deepEqual(submitBody.notices, [{
      code: 'pow_compatibility_fallback',
      message: 'ClawClub accepted this nonce via a compatibility fallback for leading hex zeros. Clients should solve the canonical trailing-zero rule on sha256(challengeId + ":" + nonce).',
    }]);
    assert.equal(await countAdmissions(owner.club.id, 'morgan.leading@example.com'), 1);
  });

  it('rejects invalid proofs and still allows a valid retry on the same challenge', async () => {
    const owner = await h.seedOwner('llm-cold-pow-invalid', 'LLM Cold PoW Invalid');
    await setAdmissionPolicy(
      owner.club.id,
      'Answer these two questions directly:\n1. What city do you live in?\n2. What do you build?',
    );

    const challengeBody = await h.apiOk(null, 'admissions.public.requestChallenge', {
      clubSlug: owner.club.slug,
    });
    const challenge = challengeBody.data as Record<string, unknown>;
    const challengeId = challenge.challengeId as string;
    const difficulty = challenge.difficulty as number;

    assert.equal(difficulty, 1);

    const invalidNonce = findNonce(challengeId, difficulty, 'invalid');
    const invalid = await h.apiErr(null, 'admissions.public.submitApplication', {
      challengeId,
      nonce: invalidNonce,
      name: 'Jamie Retry',
      email: 'jamie.retry@example.com',
      socials: '@jamieretry',
      application: '1. I live in Leeds.\n2. I build analytics software for logistics teams.',
    }, 'invalid_proof');

    assert.equal(invalid.status, 400);

    const attemptRows = await h.sql<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [challengeId],
    );
    assert.equal(Number(attemptRows[0]?.count ?? 0), 0);

    const challengeRows = await h.sql<{ count: string }>(
      `select count(*)::text as count from admission_challenges where id = $1`,
      [challengeId],
    );
    assert.equal(Number(challengeRows[0]?.count ?? 0), 1);

    const trailingNonce = findNonce(challengeId, difficulty, 'trailing');
    const submitBody = await h.apiOk(null, 'admissions.public.submitApplication', {
      challengeId,
      nonce: trailingNonce,
      name: 'Jamie Retry',
      email: 'jamie.retry@example.com',
      socials: '@jamieretry',
      application: '1. I live in Leeds.\n2. I build analytics software for logistics teams.',
    });

    const result = submitBody.data as Record<string, unknown>;
    assert.equal(result.status, 'accepted');
    assert.equal(await countAdmissions(owner.club.id, 'jamie.retry@example.com'), 1);
  });
});
