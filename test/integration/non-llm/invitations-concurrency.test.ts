import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function withInviteRequestInsertDelay<T>(run: () => Promise<T>): Promise<T> {
  const functionName = 'test_delay_invite_requests_insert';
  const triggerName = `${functionName}_trigger`;
  await h.sql(
    `create or replace function ${functionName}() returns trigger
     language plpgsql
     as $$
     begin
       perform pg_sleep(0.2);
       return new;
     end;
     $$;`,
  );
  await h.sql(`drop trigger if exists ${triggerName} on invite_requests`);
  await h.sql(
    `create trigger ${triggerName}
     before insert on invite_requests
     for each row
     execute function ${functionName}()`,
  );

  try {
    return await run();
  } finally {
    await h.sql(`drop trigger if exists ${triggerName} on invite_requests`);
    await h.sql(`drop function if exists ${functionName}()`);
  }
}

describe('invitations.issue concurrency', () => {
  it('serializes same-sponsor quota checks at the cap boundary', async () => {
    const sponsor = await h.seedOwner('invite-race-club', 'Invite Race Club');
    const requests = Array.from({ length: 5 }, (_, index) => ({
      clubId: sponsor.club.id,
      candidateName: `Candidate ${index} Person`,
      candidateEmail: `candidate-${index}@example.com`,
      reason: `Candidate ${index} has worked with the sponsor on repeated community operations and moderation workflows.`,
      clientKey: `invite-race-${index}`,
    }));

    const results = await withInviteRequestInsertDelay(async () => Promise.all(
      requests.map((request) => h.api(sponsor.token, 'invitations.issue', request)),
    ));

    const successes = results.filter((result) => result.status === 200 && result.body.ok === true);
    const failures = results.filter((result) => result.status === 429 && result.body.ok === false);
    assert.equal(successes.length, 3);
    assert.equal(failures.length, 2);
    assert.deepEqual(
      failures.map((result) => (result.body.error as Record<string, unknown>).code).sort(),
      ['invitation_quota_exceeded', 'invitation_quota_exceeded'],
    );

    const openRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from invite_requests
       where club_id = $1
         and sponsor_member_id = $2
         and revoked_at is null
         and used_at is null
         and expired_at is null
         and expires_at > now()`,
      [sponsor.club.id, sponsor.id],
    );
    assert.equal(openRows[0]?.count, '3');
  });
});
