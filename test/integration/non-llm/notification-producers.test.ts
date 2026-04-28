import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

async function createProducer(
  h: TestHarness,
  adminToken: string,
  input: {
    producerId: string;
    namespacePrefix: string;
    burstLimit?: number | null;
    hourlyLimit?: number | null;
    dailyLimit?: number | null;
    topics: Array<{
      topic: string;
      deliveryClass: 'transactional' | 'informational' | 'suggestion';
      status?: 'active' | 'disabled';
    }>;
  },
): Promise<{ secret: string }> {
  const result = await h.apiOk(adminToken, 'superadmin.notificationProducers.create', {
    clientKey: randomUUID(),
    ...input,
  });
  const data = result.data as Record<string, unknown>;
  return {
    secret: data.secret as string,
  };
}

test('producer transport delivers, rate-limits by delivery class, and acknowledges by producer ownership', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const admin = await h.seedSuperadmin('Notification Producer Admin');
  const owner = await h.seedOwner('notification-producer-club', 'Notification Producer Club');
  const recipient = await h.seedCompedMember(owner.club.id, 'Notification Producer Recipient');

  const created = await createProducer(h, admin.token, {
    producerId: 'test_producer',
    namespacePrefix: 'test.',
    burstLimit: 1,
    topics: [
      { topic: 'test.info', deliveryClass: 'informational' },
      { topic: 'test.transactional', deliveryClass: 'transactional' },
      { topic: 'test.suggestion', deliveryClass: 'suggestion' },
    ],
  });

  const delivered = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.suggestion',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'suggestion:1',
      payload: { message: 'hello' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal(delivered.status, 200);
  assert.equal((delivered.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'delivered');
  const deliveredId = (delivered.body.data.results as Array<Record<string, unknown>>)[0]?.notificationId as string;
  assert.ok(deliveredId);

  const duplicate = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.suggestion',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'suggestion:1',
      payload: { message: 'hello' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((duplicate.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'duplicate');

  const mismatch = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.suggestion',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'suggestion:1',
      payload: { message: 'changed' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((mismatch.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'idempotency_key_mismatch');

  const rateLimited = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.suggestion',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'suggestion:2',
      payload: { message: 'second' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((rateLimited.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'rate_limited');

  const transactional = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.transactional',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'txn:1',
      payload: { message: 'urgent' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((transactional.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'delivered');
  const transactionalId = (transactional.body.data.results as Array<Record<string, unknown>>)[0]?.notificationId as string;

  const acked = await h.internalProducerAcknowledge('test_producer', created.secret, {
    notificationIds: [deliveredId, transactionalId],
  });
  assert.equal(acked.status, 200);
  assert.deepEqual(
    (acked.body.data.results as Array<Record<string, unknown>>).map((row) => row.outcome),
    ['acknowledged', 'acknowledged'],
  );

  const ackedAgain = await h.internalProducerAcknowledge('test_producer', created.secret, {
    notificationIds: [deliveredId],
  });
  assert.equal((ackedAgain.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'already_acknowledged');

  const otherProducer = await createProducer(h, admin.token, {
    producerId: 'other_producer',
    namespacePrefix: 'other.',
    topics: [
      { topic: 'other.info', deliveryClass: 'informational' },
    ],
  });

  const wrongProducer = await h.internalProducerAcknowledge('other_producer', otherProducer.secret, {
    notificationIds: [transactionalId, 'missing_notification'],
  });
  assert.deepEqual(
    (wrongProducer.body.data.results as Array<Record<string, unknown>>).map((row) => row.outcome),
    ['not_found', 'not_found'],
  );

  const rotated = await h.apiOk(admin.token, 'superadmin.notificationProducers.rotateSecret', {
    clientKey: randomUUID(),
    producerId: 'test_producer',
  });
  const newSecret = ((rotated.data as Record<string, unknown>).secret as string);
  assert.ok(newSecret);
  assert.notEqual(newSecret, created.secret);

  const oldSecretStillWorks = await h.internalProducerDeliver('test_producer', created.secret, {
    notifications: [{
      topic: 'test.info',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'info:secret-rotation',
      payload: { message: 'old secret still valid' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((oldSecretStillWorks.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'delivered');

  const newSecretWorks = await h.internalProducerDeliver('test_producer', newSecret, {
    notifications: [{
      topic: 'test.info',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'info:secret-rotation',
      payload: { message: 'old secret still valid' },
      refs: [
        { role: 'club_context', kind: 'club', id: owner.club.id },
        { role: 'subject', kind: 'member', id: recipient.id },
      ],
    }],
  });
  assert.equal((newSecretWorks.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'duplicate');

  const disabledTopic = await h.apiOk(admin.token, 'superadmin.notificationProducerTopics.updateStatus', {
    producerId: 'test_producer',
    topic: 'test.transactional',
    status: 'disabled',
  });
  assert.equal((((disabledTopic.data as Record<string, unknown>).topic as Record<string, unknown>).status), 'disabled');

  const topicDisabledDeliver = await h.internalProducerDeliver('test_producer', newSecret, {
    notifications: [{
      topic: 'test.transactional',
      recipientMemberId: recipient.id,
      clubId: owner.club.id,
      payloadVersion: 1,
      idempotencyKey: 'txn:disabled-topic',
      payload: { message: 'disabled topic' },
    }],
  });
  assert.equal((topicDisabledDeliver.body.data.results as Array<Record<string, unknown>>)[0]?.outcome, 'topic_disabled');

  await h.apiOk(admin.token, 'superadmin.notificationProducers.updateStatus', {
    producerId: 'test_producer',
    status: 'disabled',
  });
  const disabledProducerDeliver = await h.internalProducerDeliver('test_producer', newSecret, {
    notifications: [],
  });
  assert.equal(disabledProducerDeliver.status, 403);
});

test('producer transport returns the full row-level outcome matrix for generic producers', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const admin = await h.seedSuperadmin('Notification Producer Matrix Admin');
  const owner = await h.seedOwner('notification-producer-matrix', 'Notification Producer Matrix Club');
  const otherOwner = await h.seedOwner('notification-producer-other', 'Notification Producer Other Club');
  const recipient = await h.seedCompedMember(owner.club.id, 'Matrix Recipient');
  const outsider = await h.seedMember('Matrix Outsider');
  const application = await h.seedApplication(owner.club.id, recipient.id, {
    phase: 'awaiting_review',
    submissionPath: 'cold',
    draftName: 'Matrix Recipient',
    draftSocials: '@matrix',
    draftApplication: 'matrix app',
  });

  const created = await createProducer(h, admin.token, {
    producerId: 'matrix_producer',
    namespacePrefix: 'matrix.',
    topics: [
      { topic: 'matrix.good', deliveryClass: 'informational' },
      { topic: 'matrix.disabled', deliveryClass: 'informational', status: 'disabled' },
    ],
  });

  await h.sql(
    `insert into notification_producer_topics (producer_id, topic, delivery_class, status)
     values ('matrix_producer', 'badprefix.registered', 'informational', 'active')`,
  );

  const response = await h.internalProducerDeliver('matrix_producer', created.secret, {
    notifications: [
      {
        topic: 'matrix.good',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'good',
        payload: {},
        refs: [
          { role: 'club_context', kind: 'club', id: owner.club.id },
          { role: 'subject', kind: 'application', id: application.id },
        ],
      },
      {
        topic: 'matrix.good',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'expired',
        expiresAt: '2020-01-01T00:00:00Z',
        payload: {},
      },
      {
        topic: 'matrix.disabled',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'disabled',
        payload: {},
      },
      {
        topic: 'matrix.missing',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'missing-topic',
        payload: {},
      },
      {
        topic: 'badprefix.registered',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'namespace',
        payload: {},
      },
      {
        topic: 'matrix.good',
        recipientMemberId: 'missing_member',
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'missing-recipient',
        payload: {},
      },
      {
        topic: 'matrix.good',
        recipientMemberId: outsider.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'inaccessible',
        payload: {},
      },
      {
        topic: 'matrix.good',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'invalid-ref',
        payload: {},
        refs: [
          { role: 'subject', kind: 'application', id: 'missing_application' },
        ],
      },
      {
        topic: 'matrix.good',
        recipientMemberId: recipient.id,
        clubId: owner.club.id,
        payloadVersion: 1,
        idempotencyKey: 'ref-club-mismatch',
        payload: {},
        refs: [
          { role: 'club_context', kind: 'club', id: otherOwner.club.id },
          { role: 'subject', kind: 'application', id: application.id },
        ],
      },
    ],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(
    (response.body.data.results as Array<Record<string, unknown>>).map((row) => row.outcome),
    [
      'delivered',
      'expired',
      'topic_disabled',
      'topic_not_registered',
      'topic_namespace_mismatch',
      'recipient_not_found',
      'recipient_not_accessible_in_club',
      'invalid_ref',
      'ref_club_mismatch',
    ],
  );
});
