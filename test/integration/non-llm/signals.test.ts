import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getActivity, getNotifications } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('activity and notifications surfaces', () => {
  it('notifications.list paginates FIFO materialized notifications', async () => {
    const owner = await h.seedOwner('notifclub', 'NotificationClub');

    const inserted = await h.sqlClubs<{ id: string; created_at: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload, created_at)
       values
         ($1, $2, 'synchronicity.ask_to_member', '{"kind":"synchronicity.ask_to_member","message":"first"}'::jsonb, '2026-03-12T00:00:00Z'),
         ($1, $2, 'synchronicity.offer_to_ask', '{"kind":"synchronicity.offer_to_ask","message":"second"}'::jsonb, '2026-03-12T00:01:00Z')
       returning id, created_at::text`,
      [owner.club.id, owner.id],
    );
    assert.equal(inserted.length, 2);

    const firstPage = getNotifications(await h.apiOk(owner.token, 'notifications.list', { limit: 1 }));
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.kind, 'synchronicity.ask_to_member');
    assert.ok(typeof firstPage.items[0]?.cursor === 'string');
    assert.equal(
      firstPage.items[0]?.notificationId,
      `synchronicity.ask_to_member:${inserted[0]!.id}`,
    );
    assert.ok(firstPage.nextAfter, 'first page should expose a nextAfter cursor');

    const secondPage = getNotifications(await h.apiOk(owner.token, 'notifications.list', {
      limit: 1,
      after: firstPage.nextAfter,
    }));
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0]?.kind, 'synchronicity.offer_to_ask');
    assert.equal(
      secondPage.items[0]?.notificationId,
      `synchronicity.offer_to_ask:${inserted[1]!.id}`,
    );
    assert.equal(secondPage.nextAfter, null);
  });

  it('notifications.acknowledge marks materialized notifications processed and hides them', async () => {
    const owner = await h.seedOwner('notifackclub', 'NotificationAckClub');

    const rows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'synchronicity.ask_to_member', '{"kind":"synchronicity.ask_to_member"}'::jsonb)
       returning id`,
      [owner.club.id, owner.id],
    );
    const notificationId = `synchronicity.ask_to_member:${rows[0]!.id}`;

    const ack = await h.apiOk(owner.token, 'notifications.acknowledge', {
      notificationIds: [notificationId],
      state: 'processed',
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.notificationId, notificationId);
    assert.equal(receipts[0]?.state, 'processed');

    const dbRows = await h.sqlClubs<{ acknowledged_state: string; suppression_reason: string | null }>(
      `select acknowledged_state, suppression_reason from member_notifications where id = $1`,
      [rows[0]!.id],
    );
    assert.equal(dbRows[0]?.acknowledged_state, 'processed');
    assert.equal(dbRows[0]?.suppression_reason, null);

    const after = getNotifications(await h.apiOk(owner.token, 'notifications.list', {}));
    assert.equal(after.items.some((item) => item.notificationId === notificationId), false);
  });

  it('notifications.acknowledge persists suppressed state and reason', async () => {
    const owner = await h.seedOwner('notifsupclub', 'NotificationSupClub');

    const rows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'synchronicity.member_to_member', '{"kind":"synchronicity.member_to_member"}'::jsonb)
       returning id`,
      [owner.club.id, owner.id],
    );
    const notificationId = `synchronicity.member_to_member:${rows[0]!.id}`;

    await h.apiOk(owner.token, 'notifications.acknowledge', {
      notificationIds: [notificationId],
      state: 'suppressed',
      suppressionReason: 'not relevant',
    });

    const dbRows = await h.sqlClubs<{ acknowledged_state: string; suppression_reason: string | null }>(
      `select acknowledged_state, suppression_reason from member_notifications where id = $1`,
      [rows[0]!.id],
    );
    assert.equal(dbRows[0]?.acknowledged_state, 'suppressed');
    assert.equal(dbRows[0]?.suppression_reason, 'not relevant');
  });

  it('notifications.acknowledge rejects derived application notifications', async () => {
    const owner = await h.seedOwner('notifderivedclub', 'NotificationDerivedClub');

    const err = await h.apiErr(owner.token, 'notifications.acknowledge', {
      notificationIds: ['application.submitted:membership-1'],
      state: 'processed',
    });
    assert.equal(err.status, 422);
    assert.equal(err.code, 'invalid_input');
  });

  it('activity.list after=latest skips backlog and returns only later activity', async () => {
    const owner = await h.seedOwner('activityclub', 'ActivityClub');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{}'::jsonb, $2)`,
      [owner.club.id, owner.id],
    );

    const latest = getActivity(await h.apiOk(owner.token, 'activity.list', { after: 'latest' }));
    assert.equal(latest.items.length, 0);
    assert.ok(latest.nextAfter, 'after=latest should seed a cursor');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'entity.version.published', '{"title":"after latest"}'::jsonb, $2)`,
      [owner.club.id, owner.id],
    );

    const poll = getActivity(await h.apiOk(owner.token, 'activity.list', { after: latest.nextAfter }));
    assert.equal(poll.items.length, 1);
    assert.equal(poll.items[0]?.topic, 'entity.version.published');
    assert.equal((poll.items[0]?.payload as Record<string, unknown>).title, 'after latest');
  });

  it('activity.list enforces audience filtering by role', async () => {
    const owner = await h.seedOwner('activityaudienceclub', 'ActivityAudienceClub');
    const member = await h.seedCompedMember(owner.club.id, 'Regular Member');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, audience, created_by_member_id)
       values
         ($1, 'test.members', '{}'::jsonb, 'members', $2),
         ($1, 'test.clubadmins', '{}'::jsonb, 'clubadmins', $2),
         ($1, 'test.owners', '{}'::jsonb, 'owners', $2)`,
      [owner.club.id, owner.id],
    );

    const ownerView = getActivity(await h.apiOk(owner.token, 'activity.list', { clubId: owner.club.id }));
    const ownerTopics = ownerView.items.map((item) => item.topic);
    assert.ok(ownerTopics.includes('test.members'));
    assert.ok(ownerTopics.includes('test.clubadmins'));
    assert.ok(ownerTopics.includes('test.owners'));

    const memberView = getActivity(await h.apiOk(member.token, 'activity.list', { clubId: owner.club.id }));
    const memberTopics = memberView.items.map((item) => item.topic);
    assert.ok(memberTopics.includes('test.members'));
    assert.equal(memberTopics.includes('test.clubadmins'), false);
    assert.equal(memberTopics.includes('test.owners'), false);
  });
});
