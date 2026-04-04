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

test('listPubliclyVisibleClubs returns lightweight club list', async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes('from app.list_publicly_listed_clubs()')) {
        return {
          rows: [
            { slug: 'alpha', name: 'Alpha Club', summary: 'A test club', owner_name: 'Alice', owner_email: 'alice@example.com' },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.listPubliclyVisibleClubs?.();

  assert.equal(result?.clubs.length, 1);
  assert.equal(result?.clubs[0].slug, 'alpha');
  assert.equal(result?.clubs[0].name, 'Alpha Club');
  // Lightweight — no summary, ownerName, admissionPolicy, ownerEmail
  assert.equal((result?.clubs[0] as any).summary, undefined);
  assert.equal((result?.clubs[0] as any).ownerName, undefined);
  assert.equal((result?.clubs[0] as any).admissionPolicy, undefined);
});

test('createAdmissionChallenge looks up club and creates bound challenge', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const expiresAt = '2026-03-20T12:00:00.000Z';

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.get_admission_eligible_club(')) {
        return {
          rows: [{
            club_id: 'club-1', name: 'Alpha Club', summary: 'A test club',
            admission_policy: 'Tell us your name.', owner_name: 'Alice',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('from app.create_admission_challenge(')) {
        return { rows: [{ challenge_id: 'challenge-1', expires_at: expiresAt }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.createAdmissionChallenge?.({ clubSlug: 'alpha' });

  assert.equal(result?.challengeId, 'challenge-1');
  assert.equal(result?.difficulty, 7);
  assert.equal(result?.maxAttempts, 5);
  assert.equal(result?.club.slug, 'alpha');
  assert.equal(result?.club.name, 'Alpha Club');
  assert.equal(result?.club.admissionPolicy, 'Tell us your name.');
  assert.equal(result?.club.ownerName, 'Alice');

  // Should have called get_admission_eligible_club with the slug
  const clubCall = calls.find((call) => call.sql.includes('from app.get_admission_eligible_club('));
  assert.deepEqual(clubCall?.params, ['alpha']);

  // Should have called create_admission_challenge with 7 params
  const challengeCall = calls.find((call) => call.sql.includes('from app.create_admission_challenge('));
  assert.ok(challengeCall);
  assert.equal(challengeCall?.params?.[0], 7); // difficulty
  assert.equal(challengeCall?.params?.[2], 'club-1'); // club_id
  assert.equal(challengeCall?.params?.[3], 'Tell us your name.'); // policy_snapshot
});

test('createAdmissionChallenge rejects non-existent or ineligible club', async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes('from app.get_admission_eligible_club(')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  await assert.rejects(
    () => repository.createAdmissionChallenge?.({ clubSlug: 'nonexistent' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'club_not_found');
      return true;
    },
  );
});

test('solveAdmissionChallenge rejects invalid proof', async () => {
  const challengeId = 'challenge-2';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback' || sql === 'commit') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_admission_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            difficulty: 2,
            expires_at: expiresAt,
            club_id: 'club-1',
            policy_snapshot: 'Tell us your name.',
            club_name: 'Alpha Club',
            club_summary: 'A test club',
            owner_name: 'Alice',
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
      name: 'Jane Doe',
      email: 'jane@example.com',
      socials: '@janedoe',
      application: 'Testing',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_proof');
      return true;
    },
  );
});

test('solveAdmissionChallenge rejects expired challenge', async () => {
  const challengeId = 'challenge-3';
  const expiresAt = new Date(Date.now() - 60_000).toISOString(); // expired

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback' || sql === 'commit') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_admission_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            difficulty: 1,
            expires_at: expiresAt,
            club_id: 'club-1',
            policy_snapshot: 'Policy.',
            club_name: 'Club',
            club_summary: null,
            owner_name: 'Owner',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('delete_admission_challenge')) {
        return { rows: [{ delete_admission_challenge: true }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  await assert.rejects(
    () => repository.solveAdmissionChallenge?.({
      challengeId,
      nonce: '0',
      name: 'Jane Doe',
      email: 'jane@example.com',
      socials: '@janedoe',
      application: 'Testing',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 410);
      assert.equal(error.code, 'challenge_expired');
      return true;
    },
  );
});

test('solveAdmissionChallenge returns attempts_exhausted when count >= 5', async () => {
  const challengeId = 'challenge-4';
  const difficulty = 1;
  const nonce = findValidNonce(challengeId, difficulty);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'rollback' || sql === 'commit') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('from app.get_admission_challenge(')) {
        return {
          rows: [{
            challenge_id: challengeId,
            difficulty,
            expires_at: expiresAt,
            club_id: 'club-1',
            policy_snapshot: 'Policy.',
            club_name: 'Club',
            club_summary: null,
            owner_name: 'Owner',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('check_club_admission_eligible')) {
        return { rows: [{ eligible: true }], rowCount: 1 };
      }

      if (sql.includes('count_admission_attempts')) {
        return { rows: [{ count_admission_attempts: 5 }], rowCount: 1 };
      }

      if (sql.includes('delete_admission_challenge')) {
        return { rows: [{ delete_admission_challenge: true }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = buildRepository(client);
  const result = await repository.solveAdmissionChallenge?.({
    challengeId,
    nonce,
    name: 'Jane Doe',
    email: 'jane@example.com',
    socials: '@janedoe',
    application: 'Testing',
  });

  assert.equal(result?.status, 'attempts_exhausted');
});
