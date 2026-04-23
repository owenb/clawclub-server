import test from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../integration/harness.ts';
import { passthroughGate } from '../unit/fixtures.ts';
import {
  autoAcknowledgeNotifications,
  deliverCoreNotifications,
  deliverNotifications,
} from '../../src/notification-substrate.ts';

test('deliverNotifications inserts substrate-shaped rows and distinguishes duplicate from idempotency mismatch', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const owner = await h.seedOwner('notification-phase1-owner', 'Notification Phase 1 Owner Club');
  const recipient = await h.seedCompedMember(owner.club.id, 'Notification Recipient');
  const application = await h.seedApplication(owner.club.id, recipient.id, {
    phase: 'awaiting_review',
    submissionPath: 'cold',
    draftName: 'Notification Recipient',
    draftSocials: '@notification-recipient',
    draftApplication: 'Please let me in.',
  });

  const first = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'application.accepted',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      applicationId: application.id,
      phase: 'accepted',
      workflow: {
        next: 'updates.list',
      },
    },
    idempotencyKey: `application-accepted:${application.id}`,
    refs: [
      { role: 'club_context', kind: 'club', id: owner.club.id },
      { role: 'subject', kind: 'application', id: application.id },
    ],
  }]);

  assert.equal(first.length, 1);
  assert.equal(first[0]?.outcome, 'delivered');
  assert.ok(first[0]?.notificationId);

  const notificationId = first[0]!.notificationId!;
  const storedRows = await h.sql<{
    producer_id: string;
    payload_version: number;
    idempotency_key: string | null;
    request_fingerprint: string | null;
  }>(
    `select producer_id, payload_version, idempotency_key, request_fingerprint
       from member_notifications
      where id = $1`,
    [notificationId],
  );
  assert.deepEqual(storedRows[0], {
    producer_id: 'core',
    payload_version: 1,
    idempotency_key: `application-accepted:${application.id}`,
    request_fingerprint: storedRows[0]!.request_fingerprint,
  });
  assert.ok(storedRows[0]?.request_fingerprint);

  const refs = await h.sql<{
    ref_role: string;
    ref_kind: string;
    ref_id: string;
  }>(
    `select ref_role, ref_kind, ref_id
       from notification_refs
      where notification_id = $1
      order by ref_role, ref_kind, ref_id`,
    [notificationId],
  );
  assert.deepEqual(refs, [
    { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
    { ref_role: 'subject', ref_kind: 'application', ref_id: application.id },
  ]);

  const duplicate = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'application.accepted',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      workflow: {
        next: 'updates.list',
      },
      phase: 'accepted',
      applicationId: application.id,
    },
    idempotencyKey: `application-accepted:${application.id}`,
    refs: [
      { role: 'subject', kind: 'application', id: application.id },
      { role: 'club_context', kind: 'club', id: owner.club.id },
    ],
  }]);
  assert.deepEqual(duplicate, [{
    index: 0,
    outcome: 'duplicate',
    notificationId,
  }]);

  const mismatch = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'application.accepted',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      applicationId: application.id,
      phase: 'declined',
      workflow: {
        next: 'updates.list',
      },
    },
    idempotencyKey: `application-accepted:${application.id}`,
    refs: [
      { role: 'club_context', kind: 'club', id: owner.club.id },
      { role: 'subject', kind: 'application', id: application.id },
    ],
  }]);
  assert.deepEqual(mismatch, [{
    index: 0,
    outcome: 'idempotency_key_mismatch',
    notificationId,
  }]);
});

test('deliverNotifications returns invalid_ref and ref_club_mismatch outcomes without inserting rows', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const owner = await h.seedOwner('notification-phase1-ref-owner', 'Notification Ref Owner Club');
  const otherOwner = await h.seedOwner('notification-phase1-ref-other', 'Notification Ref Other Club');
  const recipient = await h.seedCompedMember(owner.club.id, 'Ref Validation Recipient');
  const application = await h.seedApplication(owner.club.id, recipient.id, {
    phase: 'awaiting_review',
    submissionPath: 'cold',
    draftName: 'Ref Validation Recipient',
    draftSocials: '@ref-recipient',
    draftApplication: 'Please validate my refs.',
  });

  const invalid = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'application.accepted',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      applicationId: application.id,
      phase: 'accepted',
    },
    idempotencyKey: 'invalid-ref',
    refs: [
      { role: 'subject', kind: 'application', id: 'missing_application' },
    ],
  }]);
  assert.deepEqual(invalid, [{
    index: 0,
    outcome: 'invalid_ref',
    notificationId: null,
  }]);

  const mismatch = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'application.accepted',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      applicationId: application.id,
      phase: 'accepted',
    },
    idempotencyKey: 'ref-club-mismatch',
    refs: [
      { role: 'club_context', kind: 'club', id: otherOwner.club.id },
      { role: 'subject', kind: 'application', id: application.id },
    ],
  }]);
  assert.deepEqual(mismatch, [{
    index: 0,
    outcome: 'ref_club_mismatch',
    notificationId: null,
  }]);

  const countRows = await h.sql<{ count: string }>(
    `select count(*)::text as count
       from member_notifications
      where idempotency_key in ('invalid-ref', 'ref-club-mismatch')`,
  );
  assert.equal(countRows[0]?.count, '0');
});

test('deliverNotifications returns expired for notifications already past expiry', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const owner = await h.seedOwner('notification-phase1-expiry-owner', 'Notification Expiry Owner Club');
  const recipient = await h.seedCompedMember(owner.club.id, 'Expiry Recipient');

  const expired = await deliverNotifications(h.pools.app, [{
    producerId: 'core',
    topic: 'membership.activated',
    recipientMemberId: recipient.id,
    clubId: owner.club.id,
    payloadVersion: 1,
    payload: {
      clubId: owner.club.id,
      status: 'active',
    },
    idempotencyKey: 'expired-notification',
    expiresAt: '2020-01-01T00:00:00Z',
    refs: [
      { role: 'club_context', kind: 'club', id: owner.club.id },
      { role: 'recipient', kind: 'member', id: recipient.id },
    ],
  }]);

  assert.deepEqual(expired, [{
    index: 0,
    outcome: 'expired',
    notificationId: null,
  }]);

  const countRows = await h.sql<{ count: string }>(
    `select count(*)::text as count
       from member_notifications
      where idempotency_key = 'expired-notification'`,
  );
  assert.equal(countRows[0]?.count, '0');
});

test('autoAcknowledgeNotifications matches both ref-backed and historical payload-only rows', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const owner = await h.seedOwner('notification-phase2-autoack-owner', 'Notification Phase 2 Auto Ack Club');
  const extraAdmin = await h.seedCompedMember(owner.club.id, 'Notification Phase 2 Extra Admin');
  const applicant = await h.seedMember('Notification Phase 2 Applicant');
  const application = await h.seedApplication(owner.club.id, applicant.id, {
    phase: 'awaiting_review',
    submissionPath: 'cold',
    draftName: 'Notification Phase 2 Applicant',
    draftSocials: '@phase2autoack',
    draftApplication: 'Please review this application.',
  });

  const delivered = await deliverCoreNotifications(h.pools.app, [{
    clubId: owner.club.id,
    recipientMemberId: owner.id,
    topic: 'clubadmin.application_pending',
    payloadVersion: 1,
    payload: {
      applicationId: application.id,
      clubId: owner.club.id,
      clubName: owner.club.name,
      applicantName: 'Notification Phase 2 Applicant',
      submissionPath: 'cold',
      previousPhase: null,
    },
    refs: [
      { role: 'subject', kind: 'application', id: application.id },
      { role: 'club_context', kind: 'club', id: owner.club.id },
      { role: 'actor', kind: 'member', id: applicant.id },
    ],
  }]);
  assert.equal(delivered[0]?.outcome, 'delivered');

  const legacyRows = await h.sqlClubs<{ id: string }>(
    `insert into member_notifications (club_id, recipient_member_id, topic, payload)
     values ($1, $2, 'clubadmin.application_pending', $3::jsonb)
     returning id`,
    [
      owner.club.id,
      extraAdmin.id,
      JSON.stringify({
        applicationId: application.id,
        clubId: owner.club.id,
        clubName: owner.club.name,
        applicantName: 'Notification Phase 2 Applicant',
        submissionPath: 'cold',
        previousPhase: null,
      }),
    ],
  );
  assert.ok(legacyRows[0]?.id);

  await h.sqlClubs(
    `insert into member_notifications (club_id, recipient_member_id, topic, payload)
     values ($1, $2, 'clubadmin.application_pending', $3::jsonb)`,
    [
      owner.club.id,
      extraAdmin.id,
      JSON.stringify({
        applicationId: 'other_application',
        clubId: owner.club.id,
        clubName: owner.club.name,
        applicantName: 'Other Applicant',
        submissionPath: 'cold',
        previousPhase: null,
      }),
    ],
  );

  const acknowledgedIds = await autoAcknowledgeNotifications(h.pools.app, {
    producerId: 'core',
    topic: 'clubadmin.application_pending',
    clubId: owner.club.id,
    matchesAny: [
      {
        ref: {
          role: 'subject',
          kind: 'application',
          id: application.id,
        },
      },
      {
        payloadFields: {
          applicationId: application.id,
        },
      },
    ],
  });

  assert.equal(acknowledgedIds.length, 2);

  const rows = await h.sqlClubs<{ recipient_member_id: string; acknowledged_at: string | null }>(
    `select recipient_member_id, acknowledged_at::text as acknowledged_at
       from member_notifications
      where topic = 'clubadmin.application_pending'
      order by recipient_member_id asc, created_at asc`,
  );
  const normalizedRows = rows
    .map((row) => `${row.recipient_member_id}:${row.acknowledged_at ? 'acknowledged' : 'pending'}`)
    .sort();
  assert.deepEqual(normalizedRows, [
    `${extraAdmin.id}:pending`,
    `${extraAdmin.id}:acknowledged`,
    `${owner.id}:acknowledged`,
  ].sort());
});
