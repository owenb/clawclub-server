import type {
  ActivityEvent,
  MembershipSummary,
  NotificationItem,
  Repository,
} from '../../src/repository.ts';
import type { AuthResult, AuthenticatedActor } from '../../src/actors.ts';
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
  globalRoles?: AuthenticatedActor['globalRoles'];
  memberships?: MembershipSummary[];
} = {}): AuthenticatedActor {
  return {
    kind: 'authenticated',
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
      sponsorId: null,
      joinedAt: '2026-03-14T10:00:00Z',
    }],
  };
}

export function makeAuthResult(overrides: {
  memberId?: string;
  publicName?: string;
  globalRoles?: AuthenticatedActor['globalRoles'];
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
    topic: 'content.version.published',
    payload: {},
    contentId: 'content-1',
    contentVersionId: 'content-version-1',
    audience: 'members',
    createdAt: '2026-03-14T11:00:00Z',
    createdByMember: {
      memberId: 'member-2',
      publicName: 'Activity Creator',
    },
    ...overrides,
  };
}

export function makeNotificationItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  const seq = overrides.seq ?? 1;
  const createdAt = overrides.createdAt ?? '2026-03-14T11:00:00Z';
  const notificationId = overrides.notificationId ?? 'notification-1';
  return {
    notificationId,
    seq,
    cursor: overrides.cursor ?? encodeNotificationCursor(seq),
    producerId: 'core',
    topic: 'core.example_notice',
    clubId: 'club-1',
    payloadVersion: 1,
    payload: { kind: 'core.example_notice', message: 'example notification' },
    refs: [{ role: 'subject', kind: 'content', id: 'content-1' }],
    createdAt,
    expiresAt: null,
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    async authenticateBearerToken() { return null; },
    async registerAccount() {
      return {
        phase: 'registered',
        member: {
          memberId: 'member-1',
          publicName: 'Member One',
          email: 'member-1@example.com',
          registeredAt: '2026-04-03T00:00:00Z',
        },
        credentials: {
          kind: 'member_bearer',
          memberBearer: 'clawclub_test_token',
          guidance: 'Save this token.',
        },
        next: {
          action: 'updates.list',
          reason: 'Registration succeeded.',
        },
        applicationLimits: {
          inFlightCount: 0,
          maxInFlight: 3,
        },
        messages: {
          summary: 'Registered.',
          details: 'Save the token.',
        },
      };
    },
    async updateContactEmail() {
      return {
        member: {
          memberId: 'member-1',
          publicName: 'Member One',
          email: 'member-1@example.com',
        },
        messages: {
          summary: 'Email updated.',
          details: 'Admins will now use this address for out-of-band contact.',
        },
      };
    },
    async applyToClub() {
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'A test club',
          admissionPolicy: 'Tell us your name and city.',
          submissionPath: 'cold',
          sponsorName: null,
          phase: 'awaiting_review',
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@jane',
          application: 'Love the community',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
        },
        roadmap: [],
        gate: {
          verdict: 'not_run',
          feedback: null,
        },
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
    async redeemInvitationApplication() {
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'A test club',
          admissionPolicy: 'Tell us your name and city.',
          submissionPath: 'invitation',
          sponsorName: 'Sponsor One',
          phase: 'awaiting_review',
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@jane',
          application: 'Love the community',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
        },
        roadmap: [],
        gate: {
          verdict: 'not_run',
          feedback: null,
        },
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
    async reviseClubApplication() {
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'A test club',
          admissionPolicy: 'Tell us your name and city.',
          submissionPath: 'cold',
          sponsorName: null,
          phase: 'awaiting_review',
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@jane',
          application: 'Love the community',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
        },
        roadmap: [],
        gate: {
          verdict: 'not_run',
          feedback: null,
        },
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
    async getMemberApplicationById() { return null; },
    async listMemberApplications() { return { results: [], hasMore: false, nextCursor: null }; },
    async withdrawClubApplication() { return null; },
    async listAdminClubApplications() { return { results: [], hasMore: false, nextCursor: null }; },
    async getAdminClubApplicationById() { return null; },
    async decideClubApplication() { return null; },
    async resolveInvitationTarget(input) {
      if (input.candidateMemberId) {
        return {
          kind: 'member' as const,
          memberId: input.candidateMemberId,
          publicName: 'Existing Member',
          email: 'existing@example.com',
          source: 'member_id' as const,
          sponsorLabel: 'Existing Member',
        };
      }
      return {
        kind: 'external_email' as const,
        email: input.candidateEmail ?? 'invitee@example.com',
        nameHint: input.candidateName ?? 'Invitee Example',
        source: 'email' as const,
        sponsorLabel: input.candidateName ?? 'Invitee Example',
      };
    },
    async prepareClubJoin() {
      return {
        clubId: 'club-1',
        challengeBlob: 'payload.signature',
        challengeId: 'challenge-1',
        difficulty: 7,
        expiresAt: '2026-04-03T00:00:00Z',
      };
    },
    async joinClub() {
      return {
        memberToken: 'cc_live_member_abc',
        clubId: 'club-1',
        membershipId: 'membership-1',
        club: {
          name: 'Alpha Club',
          summary: 'A test club',
          ownerName: 'Owner One',
          admissionPolicy: 'Tell us your name and city.',
          priceUsd: null,
        },
      };
    },
    async onboardMember() {
      return { alreadyOnboarded: true };
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
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async updateMembership() { return null; },
    async listMembers() { return { results: [], hasMore: false, nextCursor: null }; },
    async getMember() { return null; },
    async listAdminMembers() { return { results: [], hasMore: false, nextCursor: null }; },
    async getAdminMember() { return null; },
    async listAdminApplications() { return { results: [], hasMore: false, nextCursor: null }; },
    async getAdminApplication() { return null; },
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
    async createContent() { throw new Error('not used'); },
    async readContent() { return null; },
    async updateContent() { return null; },
    async closeContentLoop() { return null; },
    async reopenContentLoop() { return null; },
    async listContent() { return { results: [], hasMore: false, nextCursor: null }; },
    async readContentThread() { return null; },
    async listEvents() { return { results: [], hasMore: false, nextCursor: null }; },
    async rsvpEvent() { return null; },
    async cancelEventRsvp() { return null; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('not used'); },
    async revokeBearerToken() { return null; },
    async listClubActivity() { return { items: [], highWaterMark: 0, hasMore: false }; },
    async listNotifications() { return { items: [], nextCursor: null }; },
    async acknowledgeNotifications() { return []; },
    async checkVouchTargetAccessible() { return { vouchable: true }; },
    async createVouch() { return null; },
    async listVouches() { return { results: [], hasMore: false, nextCursor: null }; },
    async getQuotaStatus() { return []; },
    async enforceContentCreateQuota() {
      return {
        action: 'content.create',
        metric: 'requests',
        scope: 'per_club_member',
        clubId: 'club-1',
        windows: [{ window: 'day', max: 50, used: 0, remaining: 50 }],
      };
    },
    async logApiRequest() {},
    async reserveLlmOutputBudget() {
      return {
        reservationId: 'reservation-1',
        quota: {
          action: 'content.create',
          metric: 'output_tokens',
          scope: 'per_club_member',
          clubId: 'club-1',
          windows: [{ window: 'day', max: 1000, used: 0, remaining: 1000 }],
        },
      };
    },
    async finalizeLlmOutputBudget() {},
    async reserveClubSpendBudget() {
      return { reservationId: 'club-spend-1' };
    },
    async finalizeClubSpendBudget() {},
    async releaseClubSpendBudget() {},
    async peekIdempotencyReplay() { return false; },
    async withClientKeyBarrier({ execute }) { return execute(); },
    async fullTextSearchMembers() { return { results: [], hasMore: false, nextCursor: null }; },
    async findMembersViaEmbedding() { return { results: [], hasMore: false, nextCursor: null }; },
    async findContentViaEmbedding() { return { results: [], hasMore: false, nextCursor: null, included: { membersById: {} } }; },
    async sendDirectMessage() { return null; },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return { results: [], hasMore: false, nextCursor: null, included: { membersById: {} } }; },
    async readDirectMessageThread() { return null; },
    async listInboxSince() { return { frames: [], nextCursor: null }; },
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
