import type {
  ActorContext,
  AuthResult,
  MembershipSummary,
  PendingUpdate,
  Repository,
} from '../src/app.ts';
import type { MemberUpdateNotifier } from '../src/member-updates-notifier.ts';

export function makeActor(overrides: {
  memberId?: string;
  handle?: string;
  publicName?: string;
  globalRoles?: ActorContext['globalRoles'];
  memberships?: MembershipSummary[];
} = {}): ActorContext {
  return {
    member: {
      id: overrides.memberId ?? 'member-1',
      handle: overrides.handle ?? 'member-one',
      publicName: overrides.publicName ?? 'Member One',
    },
    globalRoles: overrides.globalRoles ?? [],
    memberships: overrides.memberships ?? [{
      membershipId: 'membership-1',
      clubId: 'club-1',
      slug: 'alpha',
      name: 'Alpha',
      summary: 'First club',
      manifestoMarkdown: null,
      role: 'owner',
      status: 'active',
      sponsorMemberId: null,
      joinedAt: '2026-03-14T10:00:00Z',
    }],
  };
}

export function makeAuthResult(overrides: {
  memberId?: string;
  handle?: string;
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
      pendingUpdates: [],
    },
  };
}

export function makeAdminAuthResult(): AuthResult {
  return makeAuthResult({
    memberId: 'admin-1',
    handle: 'admin',
    publicName: 'Admin User',
    globalRoles: ['superadmin'],
  });
}

export function makePendingUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    updateId: 'update-1',
    streamSeq: 1,
    recipientMemberId: 'member-1',
    clubId: 'club-1',
    entityId: null,
    entityVersionId: null,
    transcriptMessageId: 'message-1',
    topic: 'transcript.message.created',
    payload: { kind: 'dm', threadId: 'thread-1' },
    createdAt: '2026-03-14T11:00:00Z',
    createdByMemberId: 'member-2',
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    async authenticateBearerToken() { return null; },
    async listMemberships() { return []; },
    async listApplications() { return []; },
    async createApplication() { return null; },
    async transitionApplication() { return null; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews() { return []; },
    async searchMembers() { return []; },
    async listMembers() { return []; },
    async getMemberProfile() { return null; },
    async updateOwnProfile() { throw new Error('not used'); },
    async createEntity() { throw new Error('not used'); },
    async updateEntity() { return null; },
    async listEntities() { return []; },
    async createEvent() { throw new Error('not used'); },
    async listEvents() { return []; },
    async rsvpEvent() { return null; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('not used'); },
    async revokeBearerToken() { return null; },
    async createVouch() { return null; },
    async listVouches() { return []; },
    async createSponsorship() { throw new Error('not used'); },
    async listSponsorships() { return []; },
    async getQuotaStatus() { return []; },
    async sendDirectMessage() { return null; },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return []; },
    async readDirectMessageThread() { return null; },
    ...overrides,
  };
}

export function makeUpdatesNotifier(): MemberUpdateNotifier {
  return {
    async waitForUpdate() { return 'timed_out'; },
    async close() {},
  };
}
