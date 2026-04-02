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

      if (sql.includes('from app.list_publicly_listed_networks()')) {
        return { rows: [{ slug: 'alpha', name: 'Alpha Club', summary: 'A test club' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.createColdApplicationChallenge?.();

  assert.equal(result?.challengeId, 'challenge-1');
  assert.equal(result?.difficulty, 7);
  assert.equal(result?.expiresAt, expiresAt);
  assert.equal(result?.networks.length, 1);
  assert.equal(result?.networks[0].slug, 'alpha');

  const challengeCall = calls.find((call) => call.sql.includes('from app.create_cold_application_challenge('));
  assert.deepEqual(challengeCall?.params, [7, 60 * 60 * 1000]);
  const networksCall = calls.find((call) => call.sql.includes('from app.list_publicly_listed_networks()'));
  assert.ok(networksCall);
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
    networkSlug: 'alpha',
    name: 'Jane Doe',
    email: 'jane@example.com',
    socials: '@janedoe',
    reason: 'Love the community',
  });

  assert.deepEqual(result, { success: true });

  const getCall = calls.find((call) => call.sql.includes('from app.get_cold_application_challenge('));
  assert.deepEqual(getCall?.params, [challengeId]);
  const consumeCall = calls.find((call) => call.sql.includes('from app.consume_cold_application_challenge('));
  assert.ok(consumeCall);
  assert.equal(consumeCall?.params?.[0], challengeId);
  assert.equal(consumeCall?.params?.[1], 'alpha');
  assert.equal(consumeCall?.params?.[2], 'Jane Doe');
  assert.equal(consumeCall?.params?.[3], 'jane@example.com');
  const applicationDetails = JSON.parse(consumeCall?.params?.[4] as string);
  assert.equal(applicationDetails.socials, '@janedoe');
  assert.equal(applicationDetails.reason, 'Love the community');
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
      networkSlug: 'alpha',
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
