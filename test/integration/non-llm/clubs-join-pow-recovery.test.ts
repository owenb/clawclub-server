import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { findPowNonce, prepareAnonymousJoin } from '../helpers.ts';

const COLD_DIFFICULTY_ENV = 'CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY';
const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
const TEST_COLD_DIFFICULTY = '2';

let h: TestHarness;
let previousColdDifficulty: string | undefined;
let previousApiKey: string | undefined;
let originalFetch: typeof globalThis.fetch;
const queuedGateResponses: string[] = [];

function enqueueGateResponses(...responses: string[]): void {
  queuedGateResponses.push(...responses);
}

function dequeueGateResponse(): string {
  return queuedGateResponses.shift() ?? 'PASS';
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

async function joinCold(clubSlug: string, email: string): Promise<{
  challengeBlob: string;
  challengeId: string;
  difficulty: number;
  token: string;
  membershipId: string;
}> {
  const challenge = await prepareAnonymousJoin(h, clubSlug);
  const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
  const join = await h.apiOk(null, 'clubs.join', {
    clubSlug,
    email,
    challengeBlob: challenge.challengeBlob,
    nonce,
  });
  const data = join.data as Record<string, unknown>;
  return {
    ...challenge,
    token: data.memberToken as string,
    membershipId: data.membershipId as string,
  };
}

async function readSubmitBudget(membershipId: string): Promise<{ attempts: number; expiresAt: string | null }> {
  const rows = await h.sql<{ attempts: string; expires_at: string | null }>(
    `select submit_attempt_count::text as attempts,
            submit_window_expires_at::text as expires_at
     from club_memberships
     where id = $1`,
    [membershipId],
  );
  return {
    attempts: Number(rows[0]?.attempts ?? 0),
    expiresAt: rows[0]?.expires_at ?? null,
  };
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  previousApiKey = process.env[OPENAI_API_KEY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_COLD_DIFFICULTY;
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

  if (previousApiKey === undefined) {
    delete process.env[OPENAI_API_KEY_ENV];
  } else {
    process.env[OPENAI_API_KEY_ENV] = previousApiKey;
  }
}, { timeout: 15_000 });

describe('clubs.prepareJoin and submit budget behavior', () => {
  it('issues a cold-join challenge and rejects replay after one successful join', async () => {
    const owner = await h.seedOwner('pow-replay-club', 'PoW Replay Club');
    const challenge = await prepareAnonymousJoin(h, owner.club.slug);

    assert.equal(challenge.difficulty, Number(TEST_COLD_DIFFICULTY));

    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
    const firstJoin = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'pow-replay@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
    });
    const firstData = firstJoin.data as Record<string, unknown>;
    assert.ok(firstData.memberToken);

    const replay = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'pow-replay@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
    }, 'challenge_already_used');
    assert.equal(replay.status, 409);

    const consumedRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from consumed_pow_challenges
       where challenge_id = $1`,
      [challenge.challengeId],
    );
    assert.equal(Number(consumedRows[0]?.count ?? 0), 1);
  });

  it('tracks submit attempts on club_memberships without requiring nonce', async () => {
    const owner = await h.seedOwner('pow-submit-budget', 'PoW Submit Budget');
    const joined = await joinCold(owner.club.slug, 'pow-budget@example.com');

    enqueueGateResponses(
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'Missing city.',
      'Missing city.',
    );

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await h.apiOk(joined.token, 'clubs.applications.submit', {
        membershipId: joined.membershipId,
        name: 'Budget Bailey',
        socials: '@budgetbailey',
        application: 'Still missing the city.',
      });
      const data = response.data as Record<string, unknown>;
      assert.equal(data.status, 'needs_revision');
      assert.equal(data.attemptsRemaining, Math.max(0, 6 - attempt));

      const budget = await readSubmitBudget(joined.membershipId);
      assert.equal(budget.attempts, attempt);
      assert.ok(budget.expiresAt);
    }

    const exhausted = await h.apiOk(joined.token, 'clubs.applications.submit', {
      membershipId: joined.membershipId,
      name: 'Budget Bailey',
      socials: '@budgetbailey',
      application: 'Still missing the city.',
    });
    const exhaustedData = exhausted.data as Record<string, unknown>;
    assert.equal(exhaustedData.status, 'attempts_exhausted');

    const finalBudget = await readSubmitBudget(joined.membershipId);
    assert.equal(finalBudget.attempts, 6);
  });

  it('surfaces challenge_expired from the submission window on the membership row', async () => {
    const owner = await h.seedOwner('pow-submit-window', 'PoW Submit Window');
    const joined = await joinCold(owner.club.slug, 'pow-window@example.com');

    await h.sql(
      `update club_memberships
       set submit_window_expires_at = now() - interval '1 minute'
       where id = $1`,
      [joined.membershipId],
    );

    const err = await h.apiErr(joined.token, 'clubs.applications.submit', {
      membershipId: joined.membershipId,
      name: 'Window Wren',
      socials: '@windowwren',
      application: 'I missed the window.',
    }, 'challenge_expired');
    assert.equal(err.status, 410);
    assert.match(err.message, /submission window/i);
  });
});
