import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationRequestFingerprint } from '../../src/notification-substrate.ts';

test('notification request fingerprint is stable across payload key order and ref order', () => {
  const left = createNotificationRequestFingerprint({
    topic: 'application.accepted',
    recipientMemberId: 'm_left',
    clubId: 'c_left',
    payloadVersion: 1,
    payload: {
      zeta: true,
      nested: {
        beta: 2,
        alpha: 1,
      },
    },
    refs: [
      { role: 'club_context', kind: 'club', id: 'c_left' },
      { role: 'subject', kind: 'application', id: 'app_left' },
    ],
  });

  const right = createNotificationRequestFingerprint({
    topic: 'application.accepted',
    recipientMemberId: 'm_left',
    clubId: 'c_left',
    payloadVersion: 1,
    payload: {
      nested: {
        alpha: 1,
        beta: 2,
      },
      zeta: true,
    },
    refs: [
      { role: 'subject', kind: 'application', id: 'app_left' },
      { role: 'club_context', kind: 'club', id: 'c_left' },
    ],
  });

  assert.equal(left, right);
});

test('notification request fingerprint changes when the semantic payload changes', () => {
  const left = createNotificationRequestFingerprint({
    topic: 'application.accepted',
    recipientMemberId: 'm_left',
    clubId: 'c_left',
    payloadVersion: 1,
    payload: {
      phase: 'accepted',
      applicationId: 'app_left',
    },
    refs: [
      { role: 'subject', kind: 'application', id: 'app_left' },
    ],
  });

  const right = createNotificationRequestFingerprint({
    topic: 'application.accepted',
    recipientMemberId: 'm_left',
    clubId: 'c_left',
    payloadVersion: 1,
    payload: {
      phase: 'declined',
      applicationId: 'app_left',
    },
    refs: [
      { role: 'subject', kind: 'application', id: 'app_left' },
    ],
  });

  assert.notEqual(left, right);
});
