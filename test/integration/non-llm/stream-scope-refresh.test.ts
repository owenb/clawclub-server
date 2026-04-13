import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

// Use a short refresh cadence so tests don't have to wait 60s.
const SCOPE_REFRESH_MS = 500;

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ streamScopeRefreshMs: SCOPE_REFRESH_MS });
});

after(async () => {
  await h.stop();
});

// Helper: insert a club_activity row directly (bypasses LLM quality gate).
async function insertActivity(clubId: string, memberId: string, topic: string): Promise<void> {
  await h.sql(
    `INSERT INTO club_activity (club_id, topic, payload, created_by_member_id)
     VALUES ($1::short_id, $2, '{}'::jsonb, $3::short_id)`,
    [clubId, topic, memberId],
  );
}

// Helper: wait for a duration.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('stream scope refresh', () => {
  it('stops delivering activity from a club after membership is removed', async () => {
    const owner = await h.seedOwner('scope-remove', 'Scope Remove Club');
    const member = await h.seedCompedMember(owner.club.id, 'Alice Scope', 'alice-scope-remove');

    // Open stream and wait for ready
    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Remove the membership — member loses access
      await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
        clubId: owner.club.id,
        membershipId: member.membership.id,
        status: 'removed',
        reason: 'test scope removal',
      });

      // Wait for the scope refresh to pick up the change
      await sleep(SCOPE_REFRESH_MS + 200);

      // Insert activity in the club the member was removed from
      await insertActivity(owner.club.id, owner.id, 'test.after_removal');

      // Give the stream time to process
      await sleep(500);

      // The stream should NOT have delivered an activity frame for this row
      const activityEvents = stream.events.filter((e) => e.event === 'activity');
      const removedClubUpdate = activityEvents.find(
        (e) => (e.data as Record<string, unknown>).topic === 'test.after_removal',
      );
      assert.equal(removedClubUpdate, undefined, 'stream should not deliver activity from a club the member was removed from');
    } finally {
      stream.close();
    }
  });

  it('starts delivering updates from a newly-joined club without reconnect', async () => {
    const ownerA = await h.seedOwner('scope-expand-a', 'Scope Expand A');
    const ownerB = await h.seedOwner('scope-expand-b', 'Scope Expand B');
    const member = await h.seedCompedMember(ownerA.club.id, 'Bob Expand', 'bob-expand');

    // Open stream — member is only in club A
    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Add member to club B
      await h.seedCompedMembership(ownerB.club.id, member.id);

      // Wait for scope refresh cadence to elapse
      await sleep(SCOPE_REFRESH_MS + 200);

      // Insert activity in club B (the thing we want to see)
      await insertActivity(ownerB.club.id, ownerB.id, 'test.new_club_activity');

      // The stream's waiter is still registered with old clubIds (only club A).
      // Insert activity in club A to force a wakeup — the loop will then
      // run the scope refresh, pick up club B, and read with fresh scope.
      await insertActivity(ownerA.club.id, ownerA.id, 'test.wakeup_trigger');

      // Wait for the full scope-change burst:
      // notifications_dirty + club A wakeup activity + club B activity.
      const eventCountBefore = stream.events.length;
      await stream.waitForEvents(eventCountBefore + 3, 5000);

      const newUpdate = stream.events.find(
        (e) => e.event === 'activity' && (e.data as Record<string, unknown>).topic === 'test.new_club_activity',
      );
      assert.ok(newUpdate, 'stream should deliver activity from a newly-joined club');
      const notificationsDirty = stream.events.find((e) => e.event === 'notifications_dirty');
      assert.ok(notificationsDirty, 'scope change should invalidate the seeded notification snapshot');
    } finally {
      stream.close();
    }
  });

  it('server closes the stream when the token is revoked', async () => {
    const owner = await h.seedOwner('scope-revoke', 'Scope Revoke Club');
    const member = await h.seedCompedMember(owner.club.id, 'Charlie Revoke', 'charlie-revoke');

    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Revoke the token directly via SQL
      await h.sql(
        `UPDATE member_bearer_tokens SET revoked_at = now() WHERE member_id = $1`,
        [member.id],
      );

      // Wait for the scope refresh cadence to elapse
      await sleep(SCOPE_REFRESH_MS + 200);

      // The stream is stuck in waitForUpdate — insert activity to wake it.
      // Once awake, the loop hits the scope refresh, validates the token,
      // gets null, and calls response.end().
      await insertActivity(owner.club.id, owner.id, 'test.wakeup_for_revoke');

      const closedOrTimeout = await Promise.race([
        stream.closed.then(() => 'closed' as const),
        sleep(3000).then(() => 'timed_out' as const),
      ]);
      assert.equal(closedOrTimeout, 'closed', 'server should close the stream after token revocation');
    } finally {
      stream.close();
    }
  });

  it('activeStreams decrements when server closes a revoked stream (same member can reopen)', async () => {
    const owner = await h.seedOwner('scope-count', 'Scope Count Club');
    const member = await h.seedCompedMember(owner.club.id, 'Dana Count', 'dana-count');

    // Open a stream for this member
    const stream1 = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream1.waitForEvents(1);
      assert.equal(stream1.events[0]!.event, 'ready');

      // Revoke the token
      await h.sql(
        `UPDATE member_bearer_tokens SET revoked_at = now() WHERE member_id = $1`,
        [member.id],
      );

      // Wait for scope refresh cadence, then wake the stream
      await sleep(SCOPE_REFRESH_MS + 200);
      await insertActivity(owner.club.id, owner.id, 'test.wakeup_for_count');

      // Wait for server to close the stream
      const closedOrTimeout = await Promise.race([
        stream1.closed.then(() => 'closed' as const),
        sleep(3000).then(() => 'timed_out' as const),
      ]);
      assert.equal(closedOrTimeout, 'closed', 'server should close the revoked stream');
    } finally {
      stream1.close();
    }

    // Un-revoke the token so the same member can reconnect
    await h.sql(
      `UPDATE member_bearer_tokens SET revoked_at = null WHERE member_id = $1`,
      [member.id],
    );

    // Open a new stream for the SAME member — this proves activeStreams
    // was decremented. If it wasn't, this would hit the per-member cap.
    const stream2 = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream2.waitForEvents(1);
      assert.equal(stream2.events[0]!.event, 'ready', 'same member should open a new stream after server-closed the revoked one');
    } finally {
      stream2.close();
    }
  });
});
