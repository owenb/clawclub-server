import type {
  ActorContext,
  AuthResult,
  ActivityEvent,
  MembershipSummary,
  NotificationItem,
  Repository,
} from '../../src/contract.ts';
import type { MemberUpdateNotifier } from '../../src/member-updates-notifier.ts';
import type { LlmGateFn } from '../../src/dispatch.ts';
import { encodeNotificationCursor } from '../../src/notifications-core.ts';

/** Passthrough gate for mocked unit tests — always returns 'passed'. */
export const passthroughGate: LlmGateFn = async () => ({
  status: 'passed' as const,
  usage: { promptTokens: 0, completionTokens: 0 },
});

export function makeActor(overrides: {
  memberId?: string;
  publicName?: string;
  globalRoles?: ActorContext['globalRoles'];
  memberships?: MembershipSummary[];
} = {}): ActorContext {
  return {
    member: {
      id: overrides.memberId ?? 'member-1',
      publicName: overrides.publicName ?? 'Member One',
    },
    globalRoles: overrides.globalRoles ?? [],
    memberships: overrides.memberships ?? [{
      membershipId: 'membership-1',
      clubId: 'club-1',
      slug: 'alpha',
      name: 'Alpha',
      summary: 'First club',
      role: 'clubadmin',
      isOwner: true,
      status: 'active',
      sponsorMemberId: null,
      joinedAt: '2026-03-14T10:00:00Z',
    }],
  };
}

export function makeAuthResult(overrides: {
  memberId?: string;
  publicName?: string;
  globalRoles?: ActorContext['globalRoles'];
  memberships?: MembershipSummary[];
  clubIds?: string[];
} = {}): AuthResult {
  const actor = makeActor(overrides);
  const activeClubIds = overrides.clubIds ?? actor.memberships.map((m) => m.clubId);

  return {
    actor,
    requestScope: {
      requestedClubId: null,
      activeClubIds,
    },
    sharedContext: {
      notifications: [],
      notificationsTruncated: false,
    },
  };
}

export function makeAdminAuthResult(): AuthResult {
  return makeAuthResult({
    memberId: 'admin-1',
    publicName: 'Admin User',
    globalRoles: ['superadmin'],
  });
}

export function makeActivityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    activityId: 'activity-1',
    seq: 1,
    clubId: 'club-1',
    topic: 'entity.version.published',
    payload: {},
    entityId: 'entity-1',
    entityVersionId: 'entity-version-1',
    audience: 'members',
    createdAt: '2026-03-14T11:00:00Z',
    createdByMemberId: 'member-2',
    ...overrides,
  };
}

export function makeNotificationItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  const createdAt = overrides.createdAt ?? '2026-03-14T11:00:00Z';
  const notificationId = overrides.notificationId ?? 'synchronicity.ask_to_member:notification-1';
  return {
    notificationId,
    cursor: overrides.cursor ?? encodeNotificationCursor(createdAt, notificationId),
    kind: 'synchronicity.ask_to_member',
    clubId: 'club-1',
    ref: { matchId: 'match-1', entityId: 'entity-1' },
    payload: { kind: 'synchronicity.ask_to_member', matchId: 'match-1' },
    createdAt,
    acknowledgeable: true,
    acknowledgedState: null,
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    async authenticateBearerToken() { return null; },
    async joinClub() {
      return {
        memberToken: 'cc_live_member_abc',
        clubId: 'club-1',
        membershipId: 'membership-1',
        proof: {
          kind: 'pow' as const,
          challengeId: 'challenge-1',
          difficulty: 7,
          expiresAt: '2026-04-03T00:00:00Z',
          maxAttempts: 5,
        },
        club: {
          name: 'Alpha Club',
          summary: 'A test club',
          ownerName: 'Owner One',
          admissionPolicy: 'Tell us your name and city.',
          priceUsd: null,
        },
      };
    },
    async submitClubApplication() {
      return { status: 'submitted' as const, membershipId: 'membership-1', applicationSubmittedAt: '2026-04-03T00:00:00Z' };
    },
    async getClubApplication() { return null; },
    async listClubApplications() { return []; },
    async startMembershipCheckout() { return null; },
    async issueInvitation() { return null; },
    async listIssuedInvitations() { return []; },
    async revokeInvitation() { return null; },
    async getMembershipApplication() { return null; },
    async listMemberships() { return { results: [], hasMore: false, nextCursor: null }; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews() { return { results: [], hasMore: false, nextCursor: null }; },
    async listMembers() { return { results: [], hasMore: false, nextCursor: null }; },
    async buildMembershipSeedProfile() {
      return {
        tagline: null,
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      };
    },
    async listMemberProfiles() { return null; },
    async updateMemberIdentity() { throw new Error('not used'); },
    async updateClubProfile() { throw new Error('not used'); },
    async createEntity() { throw new Error('not used'); },
    async updateEntity() { return null; },
    async closeEntityLoop() { return null; },
    async reopenEntityLoop() { return null; },
    async listEntities() { return { results: [], hasMore: false, nextCursor: null }; },
    async readContentThread() { return null; },
    async listEvents() { return { results: [], hasMore: false, nextCursor: null }; },
    async rsvpEvent() { return null; },
    async cancelEventRsvp() { return null; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('not used'); },
    async revokeBearerToken() { return null; },
    async listClubActivity() { return { items: [], nextAfterSeq: 0 }; },
    async listNotifications() { return { items: [], nextAfter: null }; },
    async acknowledgeNotifications() { return []; },
    async createVouch() { return null; },
    async listVouches() { return { results: [], hasMore: false, nextCursor: null }; },
    async getQuotaStatus() { return []; },
    async fullTextSearchMembers() { return { results: [], hasMore: false, nextCursor: null }; },
    async findMembersViaEmbedding() { return { results: [], hasMore: false, nextCursor: null }; },
    async findEntitiesViaEmbedding() { return { results: [], hasMore: false, nextCursor: null }; },
    async sendDirectMessage() { return null; },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return { results: [], hasMore: false, nextCursor: null }; },
    async readDirectMessageThread() { return null; },
    async listInboxSince() { return { frames: [], nextAfter: null }; },
    async acknowledgeDirectMessageInbox() { return { threadId: 'thread-1', acknowledgedCount: 0 }; },
    ...overrides,
  };
}

export function makeUpdatesNotifier(): MemberUpdateNotifier {
  return {
    async waitForUpdate() { return { outcome: 'timed_out' } as const; },
    async close() {},
  };
}
