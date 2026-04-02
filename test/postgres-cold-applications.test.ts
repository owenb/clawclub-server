import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../src/app.ts';
import { buildApplicationsRepository } from '../src/postgres/applications.ts';

function buildRepository(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>; release: () => void }) {
  return buildApplicationsRepository({
    pool: {
      connect: async () => client,
      query: async (sql: string, params?: unknown[]) => client.query(sql, params),
    } as any,
    applyActorContext: async () => {
      throw new Error('applyActorContext should not be called for cold application flows');
    },
    withActorContext: async () => {
      throw new Error('withActorContext should not be called for cold application flows');
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

test('postgres applications repository creates a cold application challenge', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const expiresAt = '2026-03-20T12:00:00.000Z';

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.create_cold_application_challenge(')) {
        return { rows: [{ challenge_id: 'challenge-1', expires_at: expiresAt }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.createColdApplicationChallenge?.({
    networkSlug: 'consciousclaw',
    email: 'jane@example.com',
    name: 'Jane Doe',
  });

  assert.equal(result?.challengeId, 'challenge-1');
  assert.equal(result?.difficulty, 7);
  assert.equal(result?.expiresAt, expiresAt);

  const insertCall = calls.find((call) => call.sql.includes('insert into app.cold_application_challenges'));
  assert.equal(insertCall, undefined);
  const functionCall = calls.find((call) => call.sql.includes('from app.create_cold_application_challenge('));
  assert.deepEqual(functionCall?.params, ['consciousclaw', 'jane@example.com', 'Jane Doe', 7, 60 * 60 * 1000]);
});

test('postgres applications repository verifies a solved cold application challenge', async () => {
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

      if (sql.includes('from app.get_cold_application_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            network_id: 'network-1',
            applicant_email: 'jane@example.com',
            applicant_name: 'Jane Doe',
            difficulty,
            expires_at: expiresAt,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('from app.consume_cold_application_challenge(')) {
        return { rows: [{ application_id: 'application-1' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.solveColdApplicationChallenge?.({
    challengeId,
    nonce,
  });

  assert.deepEqual(result, { success: true });

  const getCall = calls.find((call) => call.sql.includes('from app.get_cold_application_challenge('));
  assert.deepEqual(getCall?.params, [challengeId]);
  const consumeCall = calls.find((call) => call.sql.includes('from app.consume_cold_application_challenge('));
  assert.deepEqual(consumeCall?.params, [challengeId]);
});

test('postgres applications repository rejects invalid proof for cold applications', async () => {
  const challengeId = 'challenge-2';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_cold_application_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            network_id: 'network-1',
            applicant_email: 'jane@example.com',
            applicant_name: 'Jane Doe',
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
    () => repository.solveColdApplicationChallenge?.({
      challengeId,
      nonce: 'definitely-not-valid',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_proof');
      return true;
    },
  );
});
