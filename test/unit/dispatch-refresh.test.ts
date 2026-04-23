import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import type { MembershipSummary, NotificationItem } from '../../src/repository.ts';
import { makeAuthResult, makeNotificationItem, makeRepository, passthroughGate } from './fixtures.ts';

test('clubs.create refreshes actor membership context after a successful mutation', async () => {
  const alphaMembership: MembershipSummary = {
    membershipId: 'membership-1',
    clubId: 'club-1',
    slug: 'alpha',
    name: 'Alpha',
    summary: 'First club',
    role: 'clubadmin',
    isOwner: true,
    status: 'active',
    sponsor: null,
    joinedAt: '2026-03-14T10:00:00Z',
  };
  const betaMembership: MembershipSummary = {
    membershipId: 'membership-2',
    clubId: 'club-2',
    slug: 'beta',
    name: 'Beta',
    summary: 'Second club',
    role: 'clubadmin',
    isOwner: true,
    status: 'active',
    sponsor: null,
    joinedAt: '2026-03-15T10:00:00Z',
  };

  let authCalls = 0;
  const betaNotification: NotificationItem = makeNotificationItem({
    notificationId: 'notification-2',
    clubId: 'club-2',
    payload: { kind: 'club.created', clubId: 'club-2' },
    topic: 'club.created',
    seq: 2,
  });
  const repository = makeRepository({
    async authenticateBearerToken() {
      authCalls += 1;
      return authCalls === 1
        ? makeAuthResult({ memberships: [alphaMembership], clubIds: ['club-1'] })
        : makeAuthResult({ memberships: [alphaMembership, betaMembership], clubIds: ['club-1', 'club-2'] });
    },
    async listClubs() {
      return [];
    },
    async enforceClubsCreateQuota() {},
    async createClub() {
      return {
        clubId: 'club-2',
        slug: 'beta',
        name: 'Beta',
        summary: 'Second club',
        admissionPolicy: null,
        usesFreeAllowance: true,
        memberCap: null,
        archivedAt: null,
        owner: { memberId: 'member-1', publicName: 'Member One', email: 'member-1@example.com' },
        version: {
          no: 1,
          status: 'active',
          reason: null,
          createdAt: '2026-03-15T10:00:00Z',
          createdByMember: { memberId: 'member-1', publicName: 'Member One' },
        },
      };
    },
    async listNotifications(input) {
      return {
        items: input.accessibleClubIds.includes('club-2') ? [betaNotification] : [],
        nextCursor: null,
      };
    },
  });

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.create',
    payload: {
      slug: 'beta',
      name: 'Beta',
      summary: 'Second club',
      admissionPolicy: 'Tell us what you build and link one recent project.',
      clientKey: 'clubs-create-refresh-1',
    },
  });

  assert.equal(authCalls, 2);
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.ok(result.actor.activeMemberships.some((membership: Record<string, unknown>) => membership.clubId === 'club-2'));
  assert.deepEqual(result.actor.sharedContext.notifications, [betaNotification]);
});
