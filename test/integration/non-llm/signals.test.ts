import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getUpdates } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('member signals', () => {
  it('signal appears in updates.list with source=signal', async () => {
    const owen = await h.seedOwner('sigclub', 'SignalClub');

    // Seed the cursor by doing an initial poll
    const initial = await h.apiOk(owen.token, 'updates.list', { limit: 50 });
    const cursor = getUpdates(initial).nextAfter;
    assert.ok(cursor, 'expected a cursor from initial poll');

    // Insert a signal directly via SQL
    await h.sqlClubs(
      `insert into signal_deliveries (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'signal.test', $3::jsonb)`,
      [owen.club.id, owen.id, JSON.stringify({ kind: 'test', message: 'hello' })],
    );

    // Poll again with the cursor
    const result = await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 });
    const updatesData = getUpdates(result);
    const signalItems = updatesData.items.filter((u) => u.source === 'signal');

    assert.equal(signalItems.length, 1, 'expected exactly one signal');
    assert.equal(signalItems[0].topic, 'signal.test');
    assert.equal(signalItems[0].createdByMemberId, null, 'signals have no sender');
    assert.equal(signalItems[0].clubId, owen.club.id);

    const payload = signalItems[0].payload as Record<string, unknown>;
    assert.equal(payload.kind, 'test');
    assert.equal(payload.message, 'hello');

    // The updateId should have signal: prefix
    assert.ok((signalItems[0].updateId as string).startsWith('signal:'));
  });

  it('acknowledged signals do not reappear', async () => {
    const owen = await h.seedOwner('sigackclub', 'SignalAckClub');

    // Seed cursor
    const cursor = getUpdates(await h.apiOk(owen.token, 'updates.list', { limit: 50 })).nextAfter;

    // Insert a signal
    await h.sqlClubs(
      `insert into signal_deliveries (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'signal.ack_test', '{}'::jsonb)`,
      [owen.club.id, owen.id],
    );

    // Poll to get the signal
    const poll1 = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 }));
    const signalItems = poll1.items.filter((u) => u.source === 'signal');
    assert.equal(signalItems.length, 1);
    const signalId = signalItems[0].updateId as string;

    // Acknowledge it as processed
    await h.apiOk(owen.token, 'updates.acknowledge', {
      updateIds: [signalId],
      state: 'processed',
    });

    // Verify durable state in DB
    const dbRows = await h.sqlClubs<{ acknowledged_state: string; suppression_reason: string | null }>(
      `select acknowledged_state, suppression_reason from signal_deliveries where id = $1`,
      [signalId.replace('signal:', '')],
    );
    assert.equal(dbRows.length, 1);
    assert.equal(dbRows[0].acknowledged_state, 'processed');
    assert.equal(dbRows[0].suppression_reason, null);

    // Poll again — signal should not reappear
    const poll2 = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 }));
    const reappeared = poll2.items.filter((u) => u.source === 'signal');
    assert.equal(reappeared.length, 0, 'acknowledged signal should not reappear');
  });

  it('suppressed acknowledgement persists state and reason', async () => {
    const owen = await h.seedOwner('sigsupclub', 'SignalSupClub');

    const cursor = getUpdates(await h.apiOk(owen.token, 'updates.list', { limit: 50 })).nextAfter;

    await h.sqlClubs(
      `insert into signal_deliveries (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'signal.suppress_test', '{}'::jsonb)`,
      [owen.club.id, owen.id],
    );

    const poll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 }));
    const signalId = poll.items.filter((u) => u.source === 'signal')[0].updateId as string;

    await h.apiOk(owen.token, 'updates.acknowledge', {
      updateIds: [signalId],
      state: 'suppressed',
      suppressionReason: 'not relevant',
    });

    const dbRows = await h.sqlClubs<{ acknowledged_state: string; suppression_reason: string | null }>(
      `select acknowledged_state, suppression_reason from signal_deliveries where id = $1`,
      [signalId.replace('signal:', '')],
    );
    assert.equal(dbRows[0].acknowledged_state, 'suppressed');
    assert.equal(dbRows[0].suppression_reason, 'not relevant');
  });

  it('activity acknowledgements are rejected because activity is cursor-driven', async () => {
    const owen = await h.seedOwner('sigactivityclub', 'SignalActivityClub');

    const cursor = getUpdates(await h.apiOk(owen.token, 'updates.list', { limit: 50 })).nextAfter;
    assert.ok(cursor, 'expected a cursor from initial poll');

    const activityRows = await h.sqlClubs<{ seq: string }>(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{}'::jsonb, $2)
       returning seq::text as seq`,
      [owen.club.id, owen.id],
    );
    const activityUpdateId = `activity:${activityRows[0]!.seq}`;

    const poll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 }));
    const activity = poll.items.find((item) => item.updateId === activityUpdateId);
    assert.ok(activity, 'expected the activity update to be visible');

    const ack = await h.apiErr(owen.token, 'updates.acknowledge', {
      updateIds: [activityUpdateId],
      state: 'processed',
    });
    assert.equal(ack.code, 'not_found');
  });

  it('activity cursor does not regress after returning activity items', async () => {
    const owen = await h.seedOwner('sigactivitycursorclub', 'SignalActivityCursorClub');

    const initial = getUpdates(await h.apiOk(owen.token, 'updates.list', { limit: 50 }));
    const seedCursor = initial.nextAfter;
    assert.ok(seedCursor, 'expected a cursor from initial poll');

    const firstRows = await h.sqlClubs<{ seq: string }>(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{}'::jsonb, $2)
       returning seq::text as seq`,
      [owen.club.id, owen.id],
    );
    const firstUpdateId = `activity:${firstRows[0]!.seq}`;

    const firstPoll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: seedCursor, limit: 50 }));
    const firstActivities = firstPoll.items.filter((u) => u.source === 'activity');
    assert.deepEqual(firstActivities.map((u) => u.updateId), [firstUpdateId]);

    const secondRows = await h.sqlClubs<{ seq: string }>(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{}'::jsonb, $2)
       returning seq::text as seq`,
      [owen.club.id, owen.id],
    );
    const secondUpdateId = `activity:${secondRows[0]!.seq}`;

    const secondPoll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: firstPoll.nextAfter, limit: 50 }));
    const secondActivities = secondPoll.items.filter((u) => u.source === 'activity');
    assert.deepEqual(
      secondActivities.map((u) => u.updateId),
      [secondUpdateId],
      'older activity items should not replay after the cursor advances',
    );

    const thirdPoll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: secondPoll.nextAfter, limit: 50 }));
    const thirdActivities = thirdPoll.items.filter((u) => u.source === 'activity');
    assert.equal(thirdActivities.length, 0, 'activity cursor should remain advanced after follow-up polls');
  });

  it('signal cursor tracks independently from activity cursor', async () => {
    const owen = await h.seedOwner('sigcurclub', 'SignalCurClub');

    const cursor = getUpdates(await h.apiOk(owen.token, 'updates.list', { limit: 50 })).nextAfter;

    // Insert a signal
    await h.sqlClubs(
      `insert into signal_deliveries (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'signal.cursor_test', '{}'::jsonb)`,
      [owen.club.id, owen.id],
    );

    // Insert activity directly (avoids needing LLM quality gate)
    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{}'::jsonb, $2)`,
      [owen.club.id, owen.id],
    );

    // Poll — both should appear
    const poll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: cursor, limit: 50 }));
    const signals = poll.items.filter((u) => u.source === 'signal');
    const activities = poll.items.filter((u) => u.source === 'activity');

    assert.equal(signals.length, 1, 'expected one signal');
    assert.ok(activities.length >= 1, 'expected at least one activity item');

    // Poll again with advanced cursor — activity consumed, signal still pending
    // (unacknowledged signals reappear until acknowledged — at-least-once delivery)
    const poll2 = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: poll.nextAfter, limit: 50 }));
    const activities2 = poll2.items.filter((u) => u.source === 'activity');
    assert.equal(activities2.length, 0, 'activity should not reappear after cursor advanced');

    // Acknowledge the signal, then verify it stops appearing
    const signalId = signals[0].updateId as string;
    await h.apiOk(owen.token, 'updates.acknowledge', { updateIds: [signalId], state: 'processed' });

    const poll3 = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: poll.nextAfter, limit: 50 }));
    const signals3 = poll3.items.filter((u) => u.source === 'signal');
    assert.equal(signals3.length, 0, 'acknowledged signal should not reappear');
  });

  it('old-format cursor is backward compatible', async () => {
    const owen = await h.seedOwner('sigoldclub', 'SignalOldClub');

    // Insert a signal
    await h.sqlClubs(
      `insert into signal_deliveries (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'signal.compat_test', '{}'::jsonb)`,
      [owen.club.id, owen.id],
    );

    // Craft an old-format cursor (only s and t, no a) — signal position defaults to 0
    const oldCursor = Buffer.from(JSON.stringify({ s: 0, t: new Date(0).toISOString() })).toString('base64url');

    const poll = getUpdates(await h.apiOk(owen.token, 'updates.list', { after: oldCursor, limit: 50 }));
    const signals = poll.items.filter((u) => u.source === 'signal');
    assert.ok(signals.length >= 1, 'old cursor format should return unacknowledged signals');
  });
});
