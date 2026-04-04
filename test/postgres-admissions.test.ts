import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../src/contract.ts';
import { buildAdmissionWorkflowRepository } from '../src/postgres/admissions.ts';

function buildRepository(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>; release: () => void }) {
  return buildAdmissionWorkflowRepository({
    pool: {
      connect: async () => client,
      query: async (sql: string, params?: unknown[]) => client.query(sql, params),
    } as any,
    applyActorContext: async () => {
      throw new Error('applyActorContext should not be called for admission flows');
    },
    withActorContext: async () => {
      throw new Error('withActorContext should not be called for admission flows');
    },
  });
}

function findValidNonce(challengeId: string, difficulty: number): string {
  const suffix = '0'.repeat(difficulty);
  let nonce = 0;

  while (true) {
    const hash = createHash('sha256')
      .update(`${challengeId}:${nonce}`, 'utf8')
      .digest('hex');
    if (hash.endsWith(suffix)) {
      return String(nonce);
    }
    nonce += 1;
  }
}

test('admissions repository creates a admission challenge', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const expiresAt = '2026-03-20T12:00:00.000Z';

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.create_admission_challenge(')) {
        return { rows: [{ challenge_id: 'challenge-1', expires_at: expiresAt }], rowCount: 1 };
      }

      if (sql.includes('from app.list_publicly_listed_clubs()')) {
        return { rows: [{ slug: 'alpha', name: 'Alpha Club', summary: 'A test club', owner_name: 'Alice Owner', owner_email: 'alice@example.com' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.createAdmissionChallenge?.();

  assert.equal(result?.challengeId, 'challenge-1');
  assert.equal(result?.difficulty, 7);
  assert.equal(result?.expiresAt, expiresAt);
  assert.equal(result?.clubs.length, 1);
  assert.equal(result?.clubs[0].slug, 'alpha');
  assert.equal(result?.clubs[0].ownerName, 'Alice Owner');
  assert.equal(result?.clubs[0].ownerEmail, 'alice@example.com');

  const challengeCall = calls.find((call) => call.sql.includes('from app.create_admission_challenge('));
  assert.deepEqual(challengeCall?.params, [7, 60 * 60 * 1000]);
  const clubsCall = calls.find((call) => call.sql.includes('from app.list_publicly_listed_clubs()'));
  assert.ok(clubsCall);
});

test('admissions repository verifies a solved admission challenge', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const challengeId = 'challenge-1';
  const difficulty = 1;
  const nonce = findValidNonce(challengeId, difficulty);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_admission_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            difficulty,
            expires_at: expiresAt,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('from app.consume_admission_challenge(')) {
        return { rows: [{ admission_id: 'application-1' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.solveAdmissionChallenge?.({
    challengeId,
    nonce,
    clubSlug: 'alpha',
    name: 'Jane Doe',
    email: 'jane@example.com',
    socials: '@janedoe',
    reason: 'Love the community',
  });

  assert.deepEqual(result, { success: true });

  const getCall = calls.find((call) => call.sql.includes('from app.get_admission_challenge('));
  assert.deepEqual(getCall?.params, [challengeId]);
  const consumeCall = calls.find((call) => call.sql.includes('from app.consume_admission_challenge('));
  assert.ok(consumeCall);
  assert.equal(consumeCall?.params?.[0], challengeId);
  assert.equal(consumeCall?.params?.[1], 'alpha');
  assert.equal(consumeCall?.params?.[2], 'Jane Doe');
  assert.equal(consumeCall?.params?.[3], 'jane@example.com');
  const admissionDetailsStr = consumeCall?.params?.[4] as string;
  const admissionDetails = JSON.parse(admissionDetailsStr);
  assert.equal(admissionDetails.socials, '@janedoe');
  assert.equal(admissionDetails.reason, 'Love the community');
});

test('admissions repository rejects invalid proof for admissions', async () => {
  const challengeId = 'challenge-2';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_admission_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            difficulty: 2,
            expires_at: expiresAt,
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  await assert.rejects(
    () => repository.solveAdmissionChallenge?.({
      challengeId,
      nonce: 'definitely-not-valid',
      clubSlug: 'alpha',
      name: 'Jane Doe',
      email: 'jane@example.com',
      socials: '@janedoe',
      reason: 'Testing',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_proof');
      return true;
    },
  );
});
