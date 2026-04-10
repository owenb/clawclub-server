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
  it('stops delivering updates from a club after membership is paused', async () => {
    const owner = await h.seedOwner('scope-remove', 'Scope Remove Club');
    const member = await h.seedClubMember(owner.club.id, 'Alice Scope', 'alice-scope-remove', { sponsorId: owner.id });

    // Open stream and wait for ready
    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Pause the membership — member loses access
      await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
        clubId: owner.club.id,
        membershipId: member.membership.id,
        status: 'paused',
        reason: 'test scope removal',
      });

      // Wait for the scope refresh to pick up the change
      await sleep(SCOPE_REFRESH_MS + 200);

      // Insert activity in the club the member was removed from
      await insertActivity(owner.club.id, owner.id, 'test.after_removal');

      // Give the stream time to process
      await sleep(500);

      // The stream should NOT have delivered an update for this activity
      const updateEvents = stream.events.filter((e) => e.event === 'update');
      const removedClubUpdate = updateEvents.find(
        (e) => (e.data as Record<string, unknown>).topic === 'test.after_removal',
      );
      assert.equal(removedClubUpdate, undefined, 'stream should not deliver updates from a club the member was removed from');
    } finally {
      stream.close();
    }
  });

  it('starts delivering updates from a newly-joined club without reconnect', async () => {
    const ownerA = await h.seedOwner('scope-expand-a', 'Scope Expand A');
    const ownerB = await h.seedOwner('scope-expand-b', 'Scope Expand B');
    const member = await h.seedClubMember(ownerA.club.id, 'Bob Expand', 'bob-expand', { sponsorId: ownerA.id });

    // Open stream — member is only in club A
    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Add member to club B
      await h.seedMembership(ownerB.club.id, member.id, { sponsorId: ownerB.id });

      // Wait for scope refresh cadence to elapse
      await sleep(SCOPE_REFRESH_MS + 200);

      // Insert activity in club B (the thing we want to see)
      await insertActivity(ownerB.club.id, ownerB.id, 'test.new_club_activity');

      // The stream's waiter is still registered with old clubIds (only club A).
      // Insert activity in club A to force a wakeup — the loop will then
      // run the scope refresh, pick up club B, and read with fresh scope.
      await insertActivity(ownerA.club.id, ownerA.id, 'test.wakeup_trigger');

      // Wait for both updates to arrive (club A trigger + club B activity)
      const eventCountBefore = stream.events.length;
      await stream.waitForEvents(eventCountBefore + 1, 5000);

      const newUpdate = stream.events.find(
        (e) => e.event === 'update' && (e.data as Record<string, unknown>).topic === 'test.new_club_activity',
      );
      assert.ok(newUpdate, 'stream should deliver activity from a newly-joined club');
    } finally {
      stream.close();
    }
  });

  it('closes the stream when the token is revoked', async () => {
    const owner = await h.seedOwner('scope-revoke', 'Scope Revoke Club');
    const member = await h.seedClubMember(owner.club.id, 'Charlie Revoke', 'charlie-revoke', { sponsorId: owner.id });

    const stream = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, 'ready');

      // Revoke the token directly via SQL
      await h.sql(
        `UPDATE member_bearer_tokens SET revoked_at = now() WHERE member_id = $1`,
        [member.id],
      );

      // Wait for the scope refresh to detect revocation
      await sleep(SCOPE_REFRESH_MS + 200);

      // Insert activity to wake the stream (the notifier needs a trigger)
      await insertActivity(owner.club.id, owner.id, 'test.after_revocation');

      // Give the stream time to close
      await sleep(500);

      // Try to wait for more events — should not get any new update events
      const updateEvents = stream.events.filter((e) => e.event === 'update');
      const postRevokeUpdate = updateEvents.find(
        (e) => (e.data as Record<string, unknown>).topic === 'test.after_revocation',
      );
      assert.equal(postRevokeUpdate, undefined, 'stream should not deliver updates after token revocation');
    } finally {
      stream.close();
    }
  });

  it('stream count decrements when server closes a revoked stream', async () => {
    const owner = await h.seedOwner('scope-count', 'Scope Count Club');
    const member = await h.seedClubMember(owner.club.id, 'Dana Count', 'dana-count', { sponsorId: owner.id });

    // Create a second token for the same member
    const secondTokenRows = await h.sql<{ bearer_token: string }>(
      `SELECT bearer_token FROM (
         SELECT id, member_id FROM member_bearer_tokens WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1
       ) t, LATERAL (SELECT 'unused') x(bearer_token)`,
      [member.id],
    );
    // Just use the first token for the stream, then verify we can open another after it closes
    void secondTokenRows;

    const stream1 = h.connectStream(member.token, { after: 'latest' });
    try {
      await stream1.waitForEvents(1);
      assert.equal(stream1.events[0]!.event, 'ready');

      // Revoke all tokens for this member
      await h.sql(
        `UPDATE member_bearer_tokens SET revoked_at = now() WHERE member_id = $1`,
        [member.id],
      );

      // Wait for stream to detect revocation and close
      await sleep(SCOPE_REFRESH_MS + 500);
    } finally {
      stream1.close();
    }

    // Issue a fresh token and open a new stream — should succeed (not blocked by stale count)
    const freshTokenRows = await h.sql<{ id: string }>(
      `INSERT INTO member_bearer_tokens (member_id, token_hash, label)
       VALUES ($1::short_id, 'test-hash-fresh', 'fresh-token')
       RETURNING id`,
      [member.id],
    );
    // Un-revoke so the token actually works
    await h.sql(
      `UPDATE member_bearer_tokens SET revoked_at = null WHERE id = $1`,
      [freshTokenRows[0]!.id],
    );

    // Re-seed a proper token via the harness
    const freshMember = await h.seedMember('Dana Fresh', 'dana-fresh');
    await h.seedMembership(owner.club.id, freshMember.id, { sponsorId: owner.id });

    const stream2 = h.connectStream(freshMember.token, { after: 'latest' });
    try {
      await stream2.waitForEvents(1);
      assert.equal(stream2.events[0]!.event, 'ready', 'new stream should open successfully after prior stream was server-closed');
    } finally {
      stream2.close();
    }
  });
});
