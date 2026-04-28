import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.ts';
import { assertCanApplyToClub } from '../../src/application-policy.ts';
import type { DbClient } from '../../src/db.ts';

test('assertCanApplyToClub formats temporary block expirations as ISO instants', async () => {
  let calls = 0;
  const client = {
    async query() {
      calls += 1;
      if (calls === 1) return { rows: [] };
      return {
        rows: [{
          block_kind: 'declined',
          expires_at: '2026-05-28 10:52:44.341149+01',
        }],
      };
    },
  } as unknown as DbClient;

  await assert.rejects(
    () => assertCanApplyToClub(client, { clubId: 'club_1', memberId: 'mbr_1' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'application_blocked');
      assert.match(error.message, /until 2026-05-28T09:52:44\.341Z/);
      assert.doesNotMatch(error.message, /2026-05-28 10:52:44/);
      return true;
    },
  );
});
