import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../src/app.ts';
import { buildApplicationsRepository } from '../src/postgres/applications.ts';

function buildRepository(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>; release: () => void }) {
  return buildApplicationsRepository({
    pool: { connect: async () => client } as any,
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

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback' || sql.includes(`set local app.allow_cold_application = '1'`)) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.networks')) {
        return { rows: [{ network_id: 'network-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.applications')) {
        return { rows: [{ application_id: 'challenge-1' }], rowCount: 1 };
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
  assert.equal(typeof result?.expiresAt, 'string');

  const insertCall = calls.find((call) => call.sql.includes('insert into app.applications'));
  const metadata = JSON.parse(String(insertCall?.params?.[3]));
  assert.equal(metadata.challenge.difficulty, 7);
  assert.equal(typeof metadata.challenge.expiresAt, 'string');
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

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback' || sql.includes(`set local app.allow_cold_application = '1'`)) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.applications a') && sql.includes('for update of a')) {
        return {
          rows: [{
            application_id: challengeId,
            metadata: { challenge: { difficulty, expiresAt } },
            status: 'draft',
            current_version_id: 'version-1',
            current_version_no: 1,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('update app.applications')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('insert into app.application_versions')) {
        return { rows: [], rowCount: 1 };
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

  const updateCall = calls.find((call) => call.sql.includes('update app.applications'));
  const metadata = JSON.parse(String(updateCall?.params?.[1]));
  assert.equal(metadata.challenge.nonce, nonce);
  assert.equal(typeof metadata.challenge.solvedAt, 'string');
  assert.match(metadata.challenge.hash, /[0-9a-f]{64}/);

  const versionCall = calls.find((call) => call.sql.includes('insert into app.application_versions'));
  assert.deepEqual(versionCall?.params, [challengeId, 2, 'version-1']);
});

test('postgres applications repository rejects invalid proof for cold applications', async () => {
  const challengeId = 'challenge-2';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback' || sql.includes(`set local app.allow_cold_application = '1'`)) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.applications a') && sql.includes('for update of a')) {
        return {
          rows: [{
            application_id: challengeId,
            metadata: { challenge: { difficulty: 2, expiresAt } },
            status: 'draft',
            current_version_id: 'version-1',
            current_version_no: 1,
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
