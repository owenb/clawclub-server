import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('membership-state stream noise', () => {
  it('does not emit notifications_dirty for membership-state writes alone', async () => {
    const owner = await h.seedOwner('membership-state-stream', 'Membership State Stream');
    const member = await h.seedCompedMember(owner.club.id, 'Membership State Stream Member');

    const memberships = await h.sql<{ membershipId: string }>(
      `select id as "membershipId"
         from club_memberships
        where member_id = $1
          and club_id = $2
        limit 1`,
      [member.id, owner.club.id],
    );
    const membershipId = memberships[0]?.membershipId;
    assert.ok(membershipId);

    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]?.event, 'ready');

      await h.sql(
        `with base as (
           select coalesce(max(version_no), 0) as max_version
           from club_membership_state_versions
           where membership_id = $1
         )
         insert into club_membership_state_versions (
           membership_id,
           status,
           reason,
           version_no,
           created_by_member_id
         )
         select
           $1,
           'removed',
           'stream-noise-test',
           base.max_version + seq.n,
           $2
         from base
         cross join generate_series(1, 20) as seq(n)`,
        [membershipId, owner.id],
      );

      await sleep(500);

      const notificationsDirty = stream.events.filter((event) => event.event === 'notifications_dirty');
      assert.equal(notificationsDirty.length, 0);
    } finally {
      stream.close();
    }
  });
});
