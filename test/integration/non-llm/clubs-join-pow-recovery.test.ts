import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestHarness } from '../harness.ts';

const COLD_DIFFICULTY_ENV = 'CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY';
const CROSS_DIFFICULTY_ENV = 'CLAWCLUB_TEST_CROSS_APPLICATION_DIFFICULTY';
const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

const TEST_COLD_DIFFICULTY = '2';
const TEST_CROSS_DIFFICULTY = '1';

let h: TestHarness;
let previousColdDifficulty: string | undefined;
let previousCrossDifficulty: string | undefined;
let previousApiKey: string | undefined;
let originalFetch: typeof globalThis.fetch;
const queuedGateResponses: string[] = [];

function enqueueGateResponses(...responses: string[]): void {
  queuedGateResponses.push(...responses);
}

function dequeueGateResponse(): string {
  const response = queuedGateResponses.shift();
  return response ?? 'PASS';
}

function makeOpenAiResponse(text: string): Response {
  return new Response(JSON.stringify({
    id: 'resp_test',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.4-mini',
    output: [{
      type: 'message',
      role: 'assistant',
      id: 'msg_test',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function findNonce(challengeId: string, difficulty: number): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 250_000; nonce++) {
    const candidate = String(nonce);
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');
    if (hash.endsWith(zeros)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find trailing-zero nonce for difficulty ${difficulty}`);
}

async function readLatestChallenge(membershipId: string): Promise<{
  challengeId: string;
  difficulty: number;
  attempts: number;
  solvedAt: string | null;
  expiresAt: string;
} | null> {
  const rows = await h.sql<{
    challenge_id: string;
    difficulty: string;
    attempts: string;
    solved_at: string | null;
    expires_at: string;
  }>(
    `select
        id as challenge_id,
        difficulty::text as difficulty,
        attempts::text as attempts,
        solved_at::text as solved_at,
        expires_at::text as expires_at
     from application_pow_challenges
     where membership_id = $1
     order by created_at desc
     limit 1`,
    [membershipId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    challengeId: row.challenge_id,
    difficulty: Number(row.difficulty),
    attempts: Number(row.attempts),
    solvedAt: row.solved_at,
    expiresAt: row.expires_at,
  };
}

async function expectCrossApplyDifficultyToStayColdForOnlyMembershipInState(input: {
  state: 'renewal_pending' | 'cancelled' | 'banned';
  access?: 'comped' | 'paid' | 'none';
  sourceSlug: string;
  sourceName: string;
  targetSlug: string;
  targetName: string;
  publicName: string;
  handle: string;
  email: string;
}): Promise<void> {
  const sourceOwner = await h.seedOwner(input.sourceSlug, input.sourceName);
  const targetOwner = await h.seedOwner(input.targetSlug, input.targetName);
  const member = await h.seedMember(input.publicName, input.handle);
  await h.seedClubMembership(sourceOwner.club.id, member.id, {
    status: input.state,
    access: input.access ?? 'comped',
  });

  const joinBody = await h.apiOk(member.token, 'clubs.join', {
    clubSlug: targetOwner.club.slug,
    email: input.email,
  });
  const joinData = joinBody.data as Record<string, unknown>;
  const proof = joinData.proof as Record<string, unknown>;

  assert.equal(proof.kind, 'pow');
  assert.equal(proof.difficulty, Number(TEST_COLD_DIFFICULTY));
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  previousCrossDifficulty = process.env[CROSS_DIFFICULTY_ENV];
  previousApiKey = process.env[OPENAI_API_KEY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_COLD_DIFFICULTY;
  process.env[CROSS_DIFFICULTY_ENV] = TEST_CROSS_DIFFICULTY;
  process.env[OPENAI_API_KEY_ENV] = 'test-openai-key';

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      text?: { format?: { type?: string } };
    };
    const text = body.text?.format?.type === 'json_schema'
      ? JSON.stringify({
          tagline: null,
          summary: 'Generated from application',
          whatIDo: null,
          knownFor: null,
          servicesSummary: null,
          websiteUrl: null,
          links: [],
          profile: {},
        })
      : dequeueGateResponse();
    return makeOpenAiResponse(text);
  };

  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
  globalThis.fetch = originalFetch;

  if (previousColdDifficulty === undefined) {
    delete process.env[COLD_DIFFICULTY_ENV];
  } else {
    process.env[COLD_DIFFICULTY_ENV] = previousColdDifficulty;
  }

  if (previousCrossDifficulty === undefined) {
    delete process.env[CROSS_DIFFICULTY_ENV];
  } else {
    process.env[CROSS_DIFFICULTY_ENV] = previousCrossDifficulty;
  }

  if (previousApiKey === undefined) {
    delete process.env[OPENAI_API_KEY_ENV];
  } else {
    process.env[OPENAI_API_KEY_ENV] = previousApiKey;
  }
}, { timeout: 15_000 });

describe('clubs.join proof-of-work challenge behavior', () => {
  it('keeps cold difficulty when an anonymous applicant refreshes an expired challenge while authenticated', async () => {
    const owner = await h.seedOwner('pow-refresh-cold-club', 'PoW Refresh Cold Club');

    const firstJoin = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'cold-refresh@example.com',
    });
    const firstData = firstJoin.data as Record<string, unknown>;
    const firstProof = firstData.proof as Record<string, unknown>;
    const memberToken = firstData.memberToken as string;
    const membershipId = firstData.membershipId as string;

    assert.equal(firstProof.kind, 'pow');
    assert.equal(firstProof.difficulty, Number(TEST_COLD_DIFFICULTY));

    await h.sql(
      `update application_pow_challenges
       set expires_at = now() - interval '1 minute'
       where membership_id = $1
         and solved_at is null`,
      [membershipId],
    );

    const refreshed = await h.apiOk(memberToken, 'clubs.join', {
      clubSlug: owner.club.slug,
    });
    const refreshedData = refreshed.data as Record<string, unknown>;
    const refreshedProof = refreshedData.proof as Record<string, unknown>;

    assert.equal(refreshedData.memberToken, null);
    assert.equal(refreshedData.membershipId, membershipId);
    assert.equal(refreshedProof.kind, 'pow');
    assert.equal(refreshedProof.difficulty, Number(TEST_COLD_DIFFICULTY));
    assert.notEqual(refreshedProof.challengeId, firstProof.challengeId);
  });

  it('gives cross-apply difficulty only to members with an active membership elsewhere', async () => {
    const sourceOwner = await h.seedOwner('pow-cross-source', 'PoW Cross Source');
    const targetOwner = await h.seedOwner('pow-cross-target', 'PoW Cross Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Cross Apply Casey', 'cross-apply-casey');

    const joinBody = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      email: 'cross.casey@example.com',
    });
    const joinData = joinBody.data as Record<string, unknown>;
    const proof = joinData.proof as Record<string, unknown>;

    assert.equal(proof.kind, 'pow');
    assert.equal(proof.difficulty, Number(TEST_CROSS_DIFFICULTY));
  });

  it('keeps cold difficulty when the caller only has a renewal_pending membership elsewhere', async () => {
    await expectCrossApplyDifficultyToStayColdForOnlyMembershipInState({
      state: 'renewal_pending',
      sourceSlug: 'pow-renewal-source',
      sourceName: 'PoW Renewal Source',
      targetSlug: 'pow-renewal-target',
      targetName: 'PoW Renewal Target',
      publicName: 'Renewal Pending Riley',
      handle: 'renewal-pending-riley',
      email: 'renewal.pending@example.com',
    });
  });

  it('keeps cold difficulty when the caller only has a cancelled membership elsewhere', async () => {
    await expectCrossApplyDifficultyToStayColdForOnlyMembershipInState({
      state: 'cancelled',
      sourceSlug: 'pow-cancelled-source',
      sourceName: 'PoW Cancelled Source',
      targetSlug: 'pow-cancelled-target',
      targetName: 'PoW Cancelled Target',
      publicName: 'Cancelled Casey',
      handle: 'cancelled-casey',
      email: 'cancelled.casey@example.com',
    });
  });

  it('keeps cold difficulty when the caller only has a banned membership elsewhere', async () => {
    await expectCrossApplyDifficultyToStayColdForOnlyMembershipInState({
      state: 'banned',
      access: 'none',
      sourceSlug: 'pow-banned-source',
      sourceName: 'PoW Banned Source',
      targetSlug: 'pow-banned-target',
      targetName: 'PoW Banned Target',
      publicName: 'Banned Bailey',
      handle: 'banned-bailey',
      email: 'banned.bailey@example.com',
    });
  });

  it('refreshes an exhausted cold challenge and allows the same membership to submit successfully', async () => {
    const owner = await h.seedOwner('pow-exhausted-club', 'PoW Exhausted Club');
    enqueueGateResponses(
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'PASS',
    );

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'retry.after.exhaustion@example.com',
    });
    const joinData = joinBody.data as Record<string, unknown>;
    const initialProof = joinData.proof as Record<string, unknown>;
    const memberToken = joinData.memberToken as string;
    const membershipId = joinData.membershipId as string;
    const nonce = findNonce(initialProof.challengeId as string, initialProof.difficulty as number);

    for (let attempt = 1; attempt < 5; attempt++) {
      const result = await h.apiOk(memberToken, 'clubs.applications.submit', {
        membershipId,
        nonce,
        name: 'Retry After Exhaustion',
        socials: '@retry-after-exhaustion',
        application: 'This draft still misses a required field.',
      });
      const data = result.data as Record<string, unknown>;
      assert.equal(data.status, 'needs_revision');
      assert.equal(data.attemptsRemaining, 5 - attempt);
    }

    const exhausted = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce,
      name: 'Retry After Exhaustion',
      socials: '@retry-after-exhaustion',
      application: 'This draft still misses a required field.',
    });
    const exhaustedData = exhausted.data as Record<string, unknown>;
    assert.equal(exhaustedData.status, 'attempts_exhausted');

    const exhaustedChallenge = await readLatestChallenge(membershipId);
    assert.equal(exhaustedChallenge?.attempts, 5);
    assert.notEqual(exhaustedChallenge?.solvedAt, null);

    const refreshed = await h.apiOk(memberToken, 'clubs.join', {
      clubSlug: owner.club.slug,
    });
    const refreshedData = refreshed.data as Record<string, unknown>;
    const refreshedProof = refreshedData.proof as Record<string, unknown>;

    assert.equal(refreshedData.memberToken, null);
    assert.equal(refreshedData.membershipId, membershipId);
    assert.equal(refreshedProof.kind, 'pow');
    assert.equal(refreshedProof.difficulty, Number(TEST_COLD_DIFFICULTY));
    assert.notEqual(refreshedProof.challengeId, initialProof.challengeId);

    const refreshedNonce = findNonce(refreshedProof.challengeId as string, refreshedProof.difficulty as number);
    const submitted = await h.apiOk(memberToken, 'clubs.applications.submit', {
      membershipId,
      nonce: refreshedNonce,
      name: 'Retry After Exhaustion',
      socials: '@retry-after-exhaustion',
      application: 'I live in London and build distributed systems for payments teams.',
    });
    const submittedData = submitted.data as Record<string, unknown>;
    assert.equal(submittedData.status, 'submitted');

    const application = await h.apiOk(memberToken, 'clubs.applications.get', { membershipId });
    assert.equal((application.data as Record<string, any>).application.state, 'submitted');
    assert.equal(queuedGateResponses.length, 0);
  });
});
