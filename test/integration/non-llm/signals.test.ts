import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getActivity, getNotifications, registerWithPow } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

function assertParseableTimestamp(value: string | null | undefined): void {
  assert.equal(Number.isNaN(Date.parse(String(value))), false, `expected parseable timestamp, got ${String(value)}`);
}

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function insertActivity(
  clubId: string,
  memberId: string,
  topic: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await h.sqlClubs(
    `insert into club_activity (club_id, topic, payload, created_by_member_id)
     values ($1, $2, $3::jsonb, $4)`,
    [clubId, topic, JSON.stringify(payload), memberId],
  );
}

describe('activity and notifications surfaces', () => {
  it('application notifications are visible to zero-membership applicants and can be directly acknowledged', async () => {
    const owner = await h.seedOwner('application-notify-club', 'Application Notify Club');
    const applicant = await registerWithPow(h, {
      name: 'Notification Applicant',
      email: 'application-notify@example.com',
      clientKey: 'register-application-notify',
    });

    await h.apiOk(applicant.bearerToken, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Notification Applicant',
        socials: '@notifyapplicant',
        application: 'I would like to join this club.',
      },
      clientKey: 'apply-notification-1',
    });

    const updatesBody = (await h.getUpdates(applicant.bearerToken, {
      notifications: { limit: 20 },
    })).body;
    const updatesNotifications = ((updatesBody.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const updatesItem = updatesNotifications.find((item) => item.topic === 'application.awaiting_review');
    assert.ok(updatesItem, 'applicant should see application.awaiting_review on updates.list');
    assert.equal(updatesItem?.clubId, null);
    assert.equal('acknowledgeable' in (updatesItem ?? {}), false);
    const updatesPayload = updatesItem?.payload as Record<string, unknown>;
    const updatesWorkflow = updatesPayload.workflow as Record<string, unknown>;
    assert.equal(updatesPayload.phase, 'awaiting_review');
    assert.equal(updatesWorkflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof updatesWorkflow.submittedToAdminsAt, 'string');
    assert.equal(updatesWorkflow.applicantMustActNow, false);
    assert.equal(updatesWorkflow.canApplicantRevise, false);
    assert.equal(updatesWorkflow.awaitingActor, 'clubadmins');
    assert.equal((updatesPayload.next as Record<string, unknown>).action, 'updates.list');
    assert.match(String((updatesPayload.messages as Record<string, unknown>).summary), /submitted to club admins/i);
    assert.equal(
      (((updatesBody.actor as Record<string, unknown>).sharedContext as Record<string, unknown>).notifications as Array<unknown>).length,
      0,
      'updates.list must not duplicate notifications into sharedContext',
    );

    const notificationsBody = (await h.getNotifications(applicant.bearerToken, { limit: 20 })).body;
    const listed = getNotifications(notificationsBody);
    const listedItem = listed.results.find((item) => item.topic === 'application.awaiting_review');
    assert.ok(listedItem, 'applicant should see application.awaiting_review on updates.list notifications');
    assert.equal(listedItem?.clubId, null);
    assert.equal('acknowledgeable' in (listedItem ?? {}), false);
    const listedPayload = listedItem?.payload as Record<string, unknown>;
    const listedWorkflow = listedPayload.workflow as Record<string, unknown>;
    assert.equal(listedPayload.phase, 'awaiting_review');
    assert.equal(listedWorkflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof listedWorkflow.submittedToAdminsAt, 'string');
    assert.equal(listedWorkflow.applicantMustActNow, false);
    assert.equal(listedWorkflow.canApplicantRevise, false);
    assert.equal(listedWorkflow.awaitingActor, 'clubadmins');
    assert.equal(
      (((notificationsBody.actor as Record<string, unknown>).sharedContext as Record<string, unknown>).notifications as Array<unknown>).length,
      0,
      'updates.list notifications slice must not duplicate notifications into sharedContext',
    );

    const ack = await h.apiOk(applicant.bearerToken, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [listedItem!.notificationId],
      },
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.notificationId, listedItem!.notificationId);
    assert.match(String(receipts[0]?.acknowledgedAt), /^\d{4}-\d{2}-\d{2}T/);

    const afterAck = getNotifications((await h.getNotifications(applicant.bearerToken, { limit: 20 })).body);
    assert.equal(
      afterAck.results.some((item) => item.notificationId === listedItem!.notificationId),
      false,
      'application notifications should leave the unread queue after acknowledge',
    );
  });

  it('club admins receive acknowledgeable pending-application notifications for fresh submissions', async () => {
    const owner = await h.seedOwner('admin-pending-club', 'Admin Pending Club');
    const extraAdmin = await h.seedMember('Extra Clubadmin', 'extra-clubadmin@example.com');
    await h.seedClubMembership(owner.club.id, extraAdmin.id, { role: 'clubadmin', status: 'active' });
    const applicant = await registerWithPow(h, {
      name: 'Fresh Pending Applicant',
      email: 'fresh-pending@example.com',
      clientKey: 'register-admin-pending',
    });

    const apply = await h.apiOk(applicant.bearerToken, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Fresh Pending Applicant',
        socials: '@freshpending',
        application: 'I would like to contribute to this club.',
      },
      clientKey: 'apply-admin-pending-1',
    });
    const applicationId = String((((apply.data as Record<string, unknown>).application as Record<string, unknown>).applicationId));

    for (const admin of [owner, extraAdmin]) {
      const notifications = getNotifications((await h.getNotifications(admin.token, { limit: 20 })).body);
      const pending = notifications.results.find((item) => item.topic === 'clubadmin.application_pending');
      assert.ok(pending, 'each clubadmin should receive a pending-application notification');
      assert.equal(pending?.clubId, owner.club.id);
      const payload = pending?.payload as Record<string, unknown>;
      assert.equal(payload.applicationId, applicationId);
      assert.equal(payload.clubId, owner.club.id);
      assert.equal(payload.clubName, owner.club.name);
      assert.equal(payload.previousPhase, null);
    }

    const ownerNotifications = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
    const ownerPending = ownerNotifications.results.find((item) => item.topic === 'clubadmin.application_pending');
    assert.ok(ownerPending, 'owner should have a pending-application notification to acknowledge');
    const ownerPendingRefs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [ownerPending?.notificationId],
    );
    assert.deepEqual(ownerPendingRefs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: applicant.memberId },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'application', ref_id: applicationId },
    ]);

    const ack = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [ownerPending!.notificationId],
      },
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.notificationId, ownerPending!.notificationId);
    assert.match(String(receipts[0]?.acknowledgedAt), /^\d{4}-\d{2}-\d{2}T/);

    const afterAck = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
    assert.equal(
      afterAck.results.some((item) => item.notificationId === ownerPending!.notificationId),
      false,
      'acknowledging clubadmin.application_pending should remove it from the unread queue',
    );
  });

  it('revision_required applications only ping admins once revised back to awaiting_review', async () => {
    const owner = await h.seedOwner('admin-revise-club', 'Admin Revise Club');
    const applicant = await registerWithPow(h, {
      name: 'Needs Revision Applicant',
      email: 'needs-revision@example.com',
      clientKey: 'register-admin-revise',
    });

    const seeded = await h.seedApplication(owner.club.id, applicant.memberId, {
      phase: 'revision_required',
      submissionPath: 'cold',
      draftName: 'Needs Revision Applicant',
      draftSocials: '@revisionapplicant',
      draftApplication: 'Initial draft that needs revision.',
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Please add more detail.', missingItems: ['why_now'] },
    });

    const before = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
    assert.equal(
      before.results.some((item) => item.topic === 'clubadmin.application_pending'),
      false,
      'revision_required rows should not notify admins until they return to awaiting_review',
    );

    await h.apiOk(applicant.bearerToken, 'clubs.applications.revise', {
      applicationId: seeded.id,
      draft: {
        name: 'Needs Revision Applicant',
        socials: '@revisionapplicant',
        application: 'Revised draft with the missing details filled in.',
      },
      clientKey: 'revise-admin-pending-1',
    });

    const after = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
    const pending = after.results.find((item) => item.topic === 'clubadmin.application_pending');
    assert.ok(pending, 'admins should be pinged when a revision returns to awaiting_review');
    const payload = pending?.payload as Record<string, unknown>;
    assert.equal(payload.applicationId, seeded.id);
    assert.equal(payload.previousPhase, 'revision_required');
    assert.equal(payload.submissionPath, 'cold');
  });

  it('updates.list notifications paginate FIFO materialized notifications', async () => {
    const owner = await h.seedOwner('notifclub', 'NotificationClub');
    await h.sqlClubs(`delete from member_notifications where recipient_member_id = $1`, [owner.id]);

    const inserted = await h.sqlClubs<{ id: string; created_at: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload, created_at)
       values
         ($1, $2, 'core.example_first', '{"kind":"core.example_first","message":"first"}'::jsonb, '2026-03-12T00:00:00Z'),
         ($1, $2, 'core.example_second', '{"kind":"core.example_second","message":"second"}'::jsonb, '2026-03-12T00:01:00Z')
       returning id, created_at::text`,
      [owner.club.id, owner.id],
    );
    assert.equal(inserted.length, 2);

    const firstPage = getNotifications((await h.getNotifications(owner.token, { limit: 1 })).body);
    assert.equal(firstPage.results.length, 1);
    assert.equal(firstPage.results[0]?.topic, 'core.example_first');
    assert.ok(typeof firstPage.results[0]?.cursor === 'string');
    assert.equal(firstPage.results[0]?.notificationId, inserted[0]!.id);
    assert.ok(firstPage.nextCursor, 'first page should expose a nextCursor cursor');

    const secondPage = getNotifications((await h.getNotifications(owner.token, {
      limit: 1,
      after: firstPage.nextCursor,
    })).body);
    assert.equal(secondPage.results.length, 1);
    assert.equal(secondPage.results[0]?.topic, 'core.example_second');
    assert.equal(secondPage.results[0]?.notificationId, inserted[1]!.id);
    assert.equal(secondPage.nextCursor, null);
  });

  it('updates.acknowledge marks materialized notifications processed and hides them', async () => {
    const owner = await h.seedOwner('notifackclub', 'NotificationAckClub');

    const rows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'core.example_ack', '{"kind":"core.example_ack"}'::jsonb)
       returning id`,
      [owner.club.id, owner.id],
    );
    const notificationId = rows[0]!.id;

    const ack = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [notificationId],
      },
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.notificationId, notificationId);
    assert.match(String(receipts[0]?.acknowledgedAt), /^\d{4}-\d{2}-\d{2}T/);

    const dbRows = await h.sqlClubs<{ acknowledged_at: string | null }>(
      `select acknowledged_at::text as acknowledged_at from member_notifications where id = $1`,
      [rows[0]!.id],
    );
    assertParseableTimestamp(dbRows[0]?.acknowledged_at);

    const after = getNotifications((await h.getNotifications(owner.token, {})).body);
    assert.equal(after.results.some((item) => item.notificationId === notificationId), false);
  });

  it('updates.acknowledge is idempotent once a notification is already acknowledged', async () => {
    const owner = await h.seedOwner('notifsupclub', 'NotificationSupClub');

    const rows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'core.example_repeat', '{"kind":"core.example_repeat"}'::jsonb)
       returning id`,
      [owner.club.id, owner.id],
    );
    const notificationId = rows[0]!.id;

    const firstAck = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [notificationId],
      },
    });
    const firstReceipts = (firstAck.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(firstReceipts.length, 1);

    const secondAck = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [notificationId],
      },
    });
    const secondReceipts = (secondAck.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.deepEqual(secondReceipts, []);

    const dbRows = await h.sqlClubs<{ acknowledged_at: string | null }>(
      `select acknowledged_at::text as acknowledged_at from member_notifications where id = $1`,
      [rows[0]!.id],
    );
    assertParseableTimestamp(dbRows[0]?.acknowledged_at);
  });

  it('vouches.create emits an acknowledgeable vouch.received notification with server-authored message', async () => {
    const owner = await h.seedOwner('vouch-notif-club', 'Vouch Notif Club');
    const target = await h.seedCompedMember(owner.club.id, 'Target Tia');

    await h.apiOk(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: target.id,
      reason: 'Shows up consistently',
    });

    const notifications = getNotifications((await h.getNotifications(target.token, { limit: 20 })).body);
    const item = notifications.results.find((entry) => entry.topic === 'vouch.received');
    assert.ok(item, 'target should receive a vouch.received notification');
    const payload = item?.payload as Record<string, unknown>;
    assert.match(String(payload.message), /vouches\.list/);
    assert.match(String(payload.message), /members\.get/);
    assert.equal((payload.voucher as Record<string, unknown>).memberId, owner.id);

    const refs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [item?.notificationId],
    );
    assert.deepEqual(refs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: owner.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'member', ref_id: target.id },
    ]);

    const ack = await h.apiOk(target.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [item!.notificationId],
      },
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts[0]?.notificationId, item!.notificationId);
    assert.match(String(receipts[0]?.acknowledgedAt), /^\d{4}-\d{2}-\d{2}T/);

    const dbRows = await h.sqlClubs<{ acknowledged_at: string | null }>(
      `select acknowledged_at::text as acknowledged_at from member_notifications where id = $1`,
      [item!.notificationId],
    );
    assertParseableTimestamp(dbRows[0]?.acknowledged_at);
  });

  it('updates.acknowledge allows future materialized topics by default', async () => {
    const owner = await h.seedOwner('future-topic-club', 'Future Topic Club');

    const rows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'core.future_topic', '{"kind":"core.future_topic","message":"future"}'::jsonb)
       returning id`,
      [owner.club.id, owner.id],
    );
    const notificationId = rows[0]!.id;

    const ack = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'notification',
        notificationIds: [notificationId],
      },
    });
    const receipts = (ack.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts[0]?.notificationId, notificationId);
  });

  it('updates.list activity.cursor=latest skips backlog and returns only later activity', async () => {
    const owner = await h.seedOwner('activityclub', 'ActivityClub');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'content.version.published', '{}'::jsonb, $2)`,
      [owner.club.id, owner.id],
    );

    const latest = getActivity((await h.getActivity(owner.token, { after: 'latest' })).body);
    assert.equal(latest.results.length, 0);
    assert.ok(latest.nextCursor, 'after=latest should seed a cursor');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'content.version.published', '{"title":"after latest"}'::jsonb, $2)`,
      [owner.club.id, owner.id],
    );

    const poll = getActivity((await h.getActivity(owner.token, { after: latest.nextCursor })).body);
    assert.equal(poll.results.length, 1);
    assert.equal(poll.results[0]?.topic, 'content.version.published');
    assert.equal((poll.results[0]?.payload as Record<string, unknown>).title, 'after latest');
    assert.equal(poll.hasMore, false);
  });

  it('updates.list activity pagination terminates cleanly at the tail', async () => {
    const owner = await h.seedOwner('activity-tail-club', 'Activity Tail Club');
    for (let index = 1; index <= 3; index += 1) {
      await insertActivity(owner.club.id, owner.id, `test.tail.${index}`, { index });
    }

    const firstPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 2,
    })).body);
    assert.equal(firstPage.results.length, 2);
    assert.equal(firstPage.hasMore, true);

    const secondPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 2,
      after: firstPage.nextCursor,
    })).body);
    assert.equal(secondPage.results.length, 1);
    assert.equal(secondPage.hasMore, false);

    const tailPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 2,
      after: secondPage.nextCursor,
    })).body);
    assert.equal(tailPage.results.length, 0);
    assert.equal(tailPage.hasMore, false);
    assert.equal(tailPage.nextCursor, secondPage.nextCursor);
  });

  it('updates.list activity keeps a stable cursor across a short final page', async () => {
    const owner = await h.seedOwner('activity-short-club', 'Activity Short Club');
    for (let index = 1; index <= 7; index += 1) {
      await insertActivity(owner.club.id, owner.id, `test.short.${index}`, { index });
    }

    const firstPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 5,
    })).body);
    assert.equal(firstPage.results.length, 5);
    assert.equal(firstPage.hasMore, true);

    const secondPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 5,
      after: firstPage.nextCursor,
    })).body);
    assert.equal(secondPage.results.length, 2);
    assert.equal(secondPage.hasMore, false);

    const tailPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 5,
      after: secondPage.nextCursor,
    })).body);
    assert.equal(tailPage.results.length, 0);
    assert.equal(tailPage.hasMore, false);
    assert.equal(tailPage.nextCursor, secondPage.nextCursor);
  });

  it('updates.list activity resumes cleanly from a stored tail cursor after new rows arrive', async () => {
    const owner = await h.seedOwner('activity-resume-club', 'Activity Resume Club');
    for (let index = 1; index <= 3; index += 1) {
      await insertActivity(owner.club.id, owner.id, `test.resume.initial.${index}`, { index });
    }

    const tailPage = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 10,
    })).body);
    assert.equal(tailPage.results.length, 3);
    assert.equal(tailPage.hasMore, false);

    await insertActivity(owner.club.id, owner.id, 'test.resume.new.1', { index: 4 });
    await insertActivity(owner.club.id, owner.id, 'test.resume.new.2', { index: 5 });

    const resumed = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      limit: 10,
      after: tailPage.nextCursor,
    })).body);
    assert.deepEqual(
      resumed.results.map((row) => row.topic),
      ['test.resume.new.1', 'test.resume.new.2'],
    );
    assert.equal(resumed.hasMore, false);
    assert.notEqual(resumed.nextCursor, tailPage.nextCursor);
  });

  it('updates.list activity seeds a stable cursor even when the actor has no club scope', async () => {
    const owner = await h.seedOwner('activity-noscope-club', 'Activity No Scope Club');
    const outsider = await h.seedMember('No Scope Poller');
    await insertActivity(owner.club.id, owner.id, 'test.no_scope.backlog');

    const noScope = getActivity((await h.getActivity(outsider.token, {})).body);
    assert.equal(noScope.results.length, 0);
    assert.equal(noScope.hasMore, false);

    await h.seedCompedMembership(owner.club.id, outsider.id);

    const afterJoin = getActivity((await h.getActivity(outsider.token, {
      clubId: owner.club.id,
      after: noScope.nextCursor,
    })).body);
    assert.equal(afterJoin.results.length, 0, 'stored no-scope cursor should not replay old backlog');

    await insertActivity(owner.club.id, owner.id, 'test.no_scope.new');
    const future = getActivity((await h.getActivity(outsider.token, {
      clubId: owner.club.id,
      after: afterJoin.nextCursor,
    })).body);
    assert.deepEqual(future.results.map((row) => row.topic), ['test.no_scope.new']);
  });

  it('updates.list activity slice enforces audience filtering by role', async () => {
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

    const ownerView = getActivity((await h.getActivity(owner.token, { clubId: owner.club.id })).body);
    const ownerTopics = ownerView.results.map((item) => item.topic);
    assert.ok(ownerTopics.includes('test.members'));
    assert.ok(ownerTopics.includes('test.clubadmins'));
    assert.ok(ownerTopics.includes('test.owners'));

    const memberView = getActivity((await h.getActivity(member.token, { clubId: owner.club.id })).body);
    const memberTopics = memberView.results.map((item) => item.topic);
    assert.ok(memberTopics.includes('test.members'));
    assert.equal(memberTopics.includes('test.clubadmins'), false);
    assert.equal(memberTopics.includes('test.owners'), false);
  });

  it('updates.list returns activity, notifications, and unread inbox together', async () => {
    const owner = await h.seedOwner('updatesclub', 'UpdatesClub');
    const member = await h.seedCompedMember(owner.club.id, 'Updates Member');

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, payload, created_by_member_id)
       values ($1, 'test.updates.activity', '{"title":"club change"}'::jsonb, $2)`,
      [owner.club.id, owner.id],
    );

    await h.sqlClubs(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload, created_at)
       values ($1, $2, 'test.updates.notification', '{"kind":"test.updates.notification","message":"heads up"}'::jsonb, '2026-03-12T00:02:00Z')`,
      [owner.club.id, member.id],
    );

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: member.id,
      messageText: 'Unread DM for updates.list',
    });

    const result = await h.apiOk(member.token, 'updates.list', {
      clubId: owner.club.id,
      activity: { limit: 20 },
      notifications: { limit: 20 },
      inbox: { limit: 20, unreadOnly: true },
    });

    const data = result.data as Record<string, unknown>;
    const activity = data.activity as Record<string, unknown>;
    const notifications = data.notifications as Record<string, unknown>;
    const inbox = data.inbox as Record<string, unknown>;

    const activityItems = activity.results as Array<Record<string, unknown>>;
    const notificationItems = notifications.results as Array<Record<string, unknown>>;
    const inboxResults = inbox.results as Array<Record<string, unknown>>;

    assert.ok(activityItems.some((item) => item.topic === 'test.updates.activity'));
    assert.ok(notificationItems.some((item) => item.topic === 'test.updates.notification'));
    assert.ok(inboxResults.some((thread) => {
      const unread = thread.unread as Record<string, unknown>;
      return thread.counterpartMemberId === owner.id && unread.hasUnread === true;
    }));
    assert.equal(inbox.unreadOnly, true);
    assert.equal(
      (((result.actor as Record<string, unknown>).sharedContext as Record<string, unknown>).notifications as Array<unknown>).length,
      0,
      'updates.list should not duplicate notifications into sharedContext',
    );
  });

  it('invitation redemption notifies the sponsor with invitation.redeemed', async () => {
    const sponsor = await h.seedOwner('invite-redeemed-club', 'Invite Redeemed Club');
    const candidate = await registerWithPow(h, {
      name: 'Redeeming Candidate',
      email: 'redeeming-candidate@example.com',
      clientKey: 'register-redeeming-candidate',
    });

    const issue = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Redeeming Candidate',
      candidateEmail: 'external-redeeming-candidate@example.com',
      reason: 'I know them well and they will contribute thoughtfully.',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;

    await h.apiOk(candidate.bearerToken, 'invitations.redeem', {
      code: invitation.code,
      draft: {
        name: 'Redeeming Candidate',
        socials: '@redeemingcandidate',
        application: 'I want to join through this invitation.',
      },
      clientKey: 'redeem-invitation-1',
    });

    const updatesBody = (await h.getUpdates(sponsor.token, {
      notifications: { limit: 20 },
    })).body;
    const notifications = ((updatesBody.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const redeemed = notifications.find((item) => item.topic === 'invitation.redeemed');
    assert.ok(redeemed, 'sponsor should see invitation.redeemed on updates.list');
    assert.equal(redeemed?.clubId, sponsor.club.id);
    const payload = redeemed?.payload as Record<string, unknown>;
    assert.equal(payload.clubId, sponsor.club.id);
    assert.equal(payload.clubName, sponsor.club.name);
    assert.equal(payload.candidateMemberId, candidate.memberId);
    assert.equal(payload.candidatePublicName, 'Redeeming Candidate');
    assert.equal(payload.applicationPhase, 'awaiting_review');
    const workflow = payload.applicationWorkflow as Record<string, unknown>;
    assert.equal(workflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof workflow.submittedToAdminsAt, 'string');
    assert.equal(workflow.applicantMustActNow, false);
    assert.equal(workflow.canApplicantRevise, false);
    assert.equal(workflow.awaitingActor, 'clubadmins');
    assert.match(String((payload.applicationMessages as Record<string, unknown>).summary), /submitted to club admins/i);
  });
});
