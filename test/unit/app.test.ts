import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  type ApplicationSummary,
  AppError,
  type CreateContentInput,
  type BearerTokenSummary,
  type CreatedBearerToken,
  type DirectMessageSummary,
  type DirectMessageInboxSummary,
  type DirectMessageThreadSummary,
  type Content,
  type Content,
  type IncludedBundle,
  type ListContentInput,
  type ListEventsInput,
  type AdminApplicationSummary,
  type AdminMemberSummary,
  type MembershipAdminSummary,
  type MemberProfileEnvelope,
  type ClubSummary,
  type JoinClubResult,
  type PublicMemberSummary,
  type RsvpEventInput,
  type UpdateContentInput,
  type MemberSearchResult,
  type NotificationItem,
  type NotificationReceipt,
  type DirectMessageEntry,
  type Repository,
} from '../../src/repository.ts';
import type { AuthResult, AuthenticatedActor } from '../../src/actors.ts';
import { buildDispatcher } from '../../src/dispatch.ts';
import { registerActions } from '../../src/schemas/registry.ts';
import { passthroughGate } from './fixtures.ts';
import { encodeNotificationCursor } from '../../src/notifications-core.ts';

const EMPTY_INCLUDED: IncludedBundle = { membersById: {} };
let testActionCounter = 0;

function nextTestActionName(prefix: string): string {
  testActionCounter += 1;
  return `test.${prefix}.${testActionCounter}`;
}

function withIncluded<T>(value: T): T & { included: IncludedBundle } {
  return { ...value, included: EMPTY_INCLUDED };
}

function makeActor(): AuthenticatedActor {
  return {
    kind: 'authenticated',
    member: {
      id: 'member-1',
      publicName: 'Member One',
      onboardedAt: '2026-03-12T00:00:00Z',
    },
    globalRoles: ['superadmin'],
    memberships: [
      {
        membershipId: 'membership-1',
        clubId: 'club-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First club',
        role: 'clubadmin',
        isOwner: false,
        status: 'active',
        sponsorId: 'member-2',
        joinedAt: '2026-03-12T00:00:00Z',
      },
      {
        membershipId: 'membership-2',
        clubId: 'club-2',
        slug: 'beta',
        name: 'Beta',
        summary: 'Second club',
        role: 'clubadmin',
        isOwner: true,
        status: 'active',
        sponsorId: 'member-3',
        joinedAt: '2026-03-12T00:00:00Z',
      },
    ],
  };
}

function makeAuthResult(): AuthResult {
  const actor = makeActor();
  return {
    actor,
    requestScope: {
      requestedClubId: null,
      activeClubIds: actor.memberships.map((membership) => membership.clubId),
    },
    sharedContext: {
      notifications: [makeNotificationItem()],
      notificationsTruncated: false,
    },
  };
}

function makeNotificationItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  const seq = overrides.seq ?? 1;
  const createdAt = overrides.createdAt ?? '2026-03-12T00:00:00Z';
  const notificationId = overrides.notificationId ?? 'notification-1';
  return {
    notificationId,
    seq,
    cursor: overrides.cursor ?? encodeNotificationCursor(seq),
    producerId: 'core',
    topic: 'core.example_notice',
    clubId: 'club-1',
    payloadVersion: 1,
    payload: { hello: 'world' },
    refs: [{ role: 'subject', kind: 'content', id: 'content-1' }],
    createdAt,
    expiresAt: null,
    ...overrides,
  };
}

function makeNotificationReceipt(overrides: Partial<NotificationReceipt> = {}): NotificationReceipt {
  return {
    notificationId: 'notification-1',
    acknowledgedAt: '2026-03-12T00:02:00Z',
    ...overrides,
  };
}


function makeDeliveryEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    endpointId: 'endpoint-1',
    memberId: 'member-1',
    channel: 'openclaw_webhook',
    label: 'Primary webhook',
    endpointUrl: 'https://example.test/webhook',
    sharedSecretRef: 'op://clawclub/primary',
    state: 'active',
    lastSuccessAt: null,
    lastFailureAt: null,
    health: {
      pendingCount: 0,
      processingCount: 0,
      sentCount: 0,
      failedCount: 0,
      canceledCount: 0,
      lastDeliveryAt: null,
    },
    metadata: { environment: 'test' },
    createdAt: '2026-03-12T00:00:00Z',
    disabledAt: null,
    ...overrides,
  };
}

function makeBearerTokenSummary(overrides: Partial<BearerTokenSummary> = {}): BearerTokenSummary {
  return {
    tokenId: 'token-1',
    memberId: 'member-1',
    label: 'default',
    createdAt: '2026-03-12T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
    metadata: {},
    ...overrides,
  };
}

function makeCreatedBearerToken(overrides: Partial<CreatedBearerToken> = {}): CreatedBearerToken {
  return {
    ...makeBearerTokenSummary(),
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    ...overrides,
  };
}

function makeDeliveryAcknowledgement(overrides: Partial<DeliveryAcknowledgement> = {}): DeliveryAcknowledgement {
  return {
    acknowledgementId: 'ack-1',
    deliveryId: 'delivery-1',
    clubId: 'club-1',
    recipientMemberId: 'member-1',
    state: 'shown',
    suppressionReason: null,
    no: 1,
    supersedesAcknowledgementId: null,
    createdAt: '2026-03-12T00:02:00Z',
    creatorMemberId: 'member-1',
    ...overrides,
  };
}

function makeDeliverySummary(overrides: Partial<DeliverySummary> = {}): DeliverySummary {
  return {
    deliveryId: 'delivery-1',
    clubId: 'club-1',
    recipientMemberId: 'member-1',
    endpointId: 'endpoint-1',
    topic: 'dm.message.created',
    payload: { kind: 'dm', threadId: 'thread-1' },
    status: 'sent',
    attemptCount: 1,
    contentId: null,
    contentVersionId: null,
    dmMessageId: 'message-1',
    scheduledAt: '2026-03-12T00:02:00Z',
    sentAt: '2026-03-12T00:03:00Z',
    failedAt: null,
    lastError: null,
    createdAt: '2026-03-12T00:02:00Z',
    acknowledgement: null,
    ...overrides,
  };
}

function makeClaimedDelivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    delivery: makeDeliverySummary({ status: 'processing', attemptCount: 2, sentAt: null, failedAt: null, lastError: null }),
    attempt: {
      attemptId: 'attempt-1',
      deliveryId: 'delivery-1',
      clubId: 'club-1',
      endpointId: 'endpoint-1',
      workerKey: 'worker-a',
      status: 'processing',
      attemptNo: 2,
      responseStatusCode: null,
      responseBody: null,
      errorMessage: null,
      startedAt: '2026-03-12T00:04:00Z',
      finishedAt: null,
      creatorMemberId: 'member-1',
    },
    endpoint: makeDeliveryEndpoint(),
    ...overrides,
  };
}

function makeDirectMessage(overrides: Partial<DirectMessageSummary> = {}): DirectMessageSummary {
  return {
    threadId: 'thread-1',
    senderMemberId: 'member-1',
    role: 'member',
    messageId: 'message-1',
    messageText: 'Hello there',
    mentions: [],
    payload: {},
    createdAt: '2026-03-12T00:03:00Z',
    ...overrides,
  };
}

function makeDirectMessageThread(overrides: Partial<DirectMessageThreadSummary> = {}): DirectMessageThreadSummary {
  return {
    threadId: 'thread-1',
    sharedClubs: [{ clubId: 'club-1', slug: 'alpha', name: 'Alpha' }],
    counterpart: {
      memberId: 'member-2',
      publicName: 'Member Two',
    },
    latestMessage: {
      messageId: 'message-1',
      senderMemberId: 'member-2',
      role: 'member',
      messageText: 'Hello there',
      mentions: [],
      createdAt: '2026-03-12T00:03:00Z',
    },
    messageCount: 2,
    ...overrides,
  };
}

function makeDirectMessageInbox(overrides: Partial<DirectMessageInboxSummary> = {}): DirectMessageInboxSummary {
  return {
    ...makeDirectMessageThread(),
    unread: {
      hasUnread: true,
      unreadMessageCount: 1,
      unreadUpdateCount: 1,
      latestUnreadMessageCreatedAt: '2026-03-12T00:03:00Z',
    },
    ...overrides,
  };
}

function makeDirectMessageTranscriptEntry(
  overrides: Partial<DirectMessageEntry> = {},
): DirectMessageEntry {
  return {
    messageId: 'message-1',
    threadId: 'thread-1',
    senderMemberId: 'member-2',
    role: 'member',
    messageText: 'Hello there',
    mentions: [],
    payload: {},
    createdAt: '2026-03-12T00:03:00Z',
    ...overrides,
  };
}

function makeClub(overrides: Partial<ClubSummary> = {}): ClubSummary {
  return {
    clubId: 'club-1',
    slug: 'alpha',
    name: 'Alpha',
    summary: 'First club',
    admissionPolicy: null,
    archivedAt: null,
    usesFreeAllowance: true,
    memberCap: null,
    owner: {
      memberId: 'member-1',
      publicName: 'Member One',
      email: 'one@example.com',
    },
    version: {
      no: 1,
      createdAt: '2026-03-12T00:00:00Z',
      creatorMemberId: 'member-1',
    },
    ...overrides,
  };
}

function makeMembershipAdmin(overrides: Partial<MembershipAdminSummary> = {}): MembershipAdminSummary {
  return {
    membershipId: 'membership-9',
    clubId: 'club-1',
    member: {
      memberId: 'member-9',
      publicName: 'Member Nine',
    },
    sponsor: {
      memberId: 'member-1',
      publicName: 'Member One',
    },
    role: 'member',
    version: {
      no: 1,
      status: 'active',
      reason: 'Accepted',
      createdAt: '2026-03-12T00:00:00Z',
      createdByMember: {
        memberId: 'member-1',
        publicName: 'Member One',
      },
    },
    joinedAt: '2026-03-12T00:00:00Z',
    acceptedCovenantAt: null,
    metadata: {},
    ...overrides,
  };
}

function makeAdminApplication(overrides: Partial<AdminApplicationSummary> = {}): AdminApplicationSummary {
  return {
    membershipId: 'membership-9',
    memberId: 'member-9',
    publicName: 'Member Nine',
    displayName: 'Member Nine',
    state: {
      status: 'submitted',
      reason: 'Warm intro via existing member',
      no: 1,
      createdAt: '2026-03-12T00:00:00Z',
      creatorMemberId: 'member-1',
    },
    appliedAt: '2026-03-12T00:00:00Z',
    submittedAt: '2026-03-12T00:05:00Z',
    applicationName: 'Member Nine',
    applicationEmail: 'nine@example.com',
    applicationSocials: '@membernine',
    applicationText: 'Warm intro via sponsor',
    proofKind: 'invitation',
    submissionPath: 'invitation',
    generatedProfileDraft: { tagline: 'Warm systems builder', summary: null, whatIDo: null, knownFor: null, servicesSummary: null, websiteUrl: null, links: [] },
    sponsor: {
      memberId: 'member-1',
      publicName: 'Member One',
    },
    invitation: {
      id: 'invitation-1',
      reason: 'Strong collaborator',
    },
    sponsorStats: {
      activeSponsoredCount: 1,
      sponsoredThisMonthCount: 2,
    },
    ...overrides,
  };
}

function makeApplicationSummary(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    membershipId: 'membership-9',
    clubId: 'club-2',
    clubSlug: 'beta',
    clubName: 'Beta',
    state: 'submitted',
    submissionPath: 'invitation',
    appliedAt: '2026-03-12T00:00:00Z',
    submittedAt: '2026-03-12T00:05:00Z',
    decidedAt: null,
    applicationName: 'Member Nine',
    applicationEmail: 'nine@example.com',
    applicationSocials: '@membernine',
    applicationText: 'Warm intro via sponsor',
    billing: {
      required: true,
      membershipState: 'submitted',
      accessible: false,
    },
    ...overrides,
  };
}

function makeAdminApplicationEnvelope(overrides: {
  club?: {
    clubId: string;
    slug: string;
    name: string;
    summary: string | null;
    admissionPolicy: string | null;
    ownerName: string | null;
    priceUsd: number | null;
  };
  application?: Partial<AdminApplicationSummary>;
} = {}) {
  return {
    club: {
      clubId: 'club-2',
      slug: 'beta',
      name: 'Beta',
      summary: 'Second club',
      admissionPolicy: 'Tell us about yourself.',
      ownerName: 'Member One',
      priceUsd: 49,
      ...overrides.club,
    },
    application: makeAdminApplication(overrides.application),
  };
}

function makeJoinClubResult(overrides: Partial<JoinClubResult> = {}): JoinClubResult {
  return {
    memberToken: 'cc_live_join_abcdefgh_abcdefghjkmnpqrs',
    clubId: 'club-2',
    membershipId: 'membership-9',
    club: {
      name: 'Beta',
      summary: 'Second club',
      ownerName: 'Member One',
      admissionPolicy: 'Tell us about yourself.',
      priceUsd: 49,
    },
    ...overrides,
  };
}

function makeClubMember(overrides: Partial<PublicMemberSummary> = {}): PublicMemberSummary {
  return {
    membershipId: 'membership-1',
    memberId: 'member-1',
    publicName: 'Member One',
    displayName: 'Member One',
    tagline: 'Building warm things',
    summary: 'Short summary',
    whatIDo: 'Engineering and facilitation',
    knownFor: 'Bringing people together',
    servicesSummary: 'Advisory and product strategy',
    websiteUrl: 'https://example.test',
    links: [{ label: 'Site', url: 'https://example.test' }],
    role: 'member',
    isOwner: false,
    joinedAt: '2026-03-12T00:00:00Z',
    sponsor: null,
    vouches: [],
    ...overrides,
  };
}

function makeAdminMember(overrides: Partial<AdminMemberSummary> = {}): AdminMemberSummary {
  return {
    ...makeClubMember(),
    isComped: true,
    compedAt: '2026-03-12T00:00:00Z',
    compedByMemberId: 'member-1',
    approvedPriceAmount: null,
    approvedPriceCurrency: null,
    subscription: null,
    acceptedCovenantAt: null,
    leftAt: null,
    version: {
      no: 1,
      status: 'active',
      reason: null,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMember: {
        memberId: 'member-1',
        publicName: 'Member One',
      },
    },
    ...overrides,
  };
}

function makeClubProfile(clubId = 'club-1') {
  const club = makeActor().memberships.find((membership) => membership.clubId === clubId)
    ?? makeActor().memberships[0]!;
  return {
    club: {
      clubId: club.clubId,
      slug: club.slug,
      name: club.name,
    },
    tagline: 'Building warm things',
    summary: 'Short summary',
    whatIDo: 'Engineering and facilitation',
    knownFor: 'Bringing people together',
    servicesSummary: 'Advisory and product strategy',
    websiteUrl: 'https://example.test',
    links: [{ label: 'Site', url: 'https://example.test' }],
    version: {
      id: `profile-version-${clubId}`,
      no: 1,
      createdAt: '2026-03-12T00:00:00Z',
      creatorMemberId: 'member-1',
    },
  };
}

function makeProfile(memberId = 'member-1', clubIds = ['club-1']): MemberProfileEnvelope {
  return {
    memberId,
    publicName: memberId === 'member-1' ? 'Member One' : 'Member Two',
    displayName: memberId === 'member-1' ? 'Member One' : 'Member Two',
    profiles: clubIds.map((clubId) => ({
      ...makeClubProfile(clubId),
      version: {
        ...makeClubProfile(clubId).version,
        creatorMemberId: memberId,
      },
    })),
  };
}

function makeEntity(overrides: Partial<Content> = {}): Content {
  return {
    id: 'content-1',
    threadId: 'thread-1',
    clubId: 'club-1',
    kind: 'post',
    openLoop: null,
    author: {
      memberId: 'member-1',
      publicName: 'Member One',
      displayName: 'Member One',
      ...(overrides.author ?? {}),
    },
    version: {
      no: 1,
      status: 'published',
      reason: null,
      title: 'Hello',
      summary: 'Summary',
      body: 'Body',
      effectiveAt: '2026-03-12T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMember: {
        memberId: 'member-1',
        publicName: 'Member One',
      },
      mentions: { title: [], summary: [], body: [] },
      ...(overrides.version ?? {}),
    },
    event: null,
    rsvps: null,
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Content> = {}): Content {
  return {
    id: 'event-1',
    threadId: 'thread-1',
    clubId: 'club-1',
    kind: 'event',
    openLoop: null,
    author: {
      memberId: 'member-1',
      publicName: 'Member One',
      displayName: 'Member One',
      ...(overrides.author ?? {}),
    },
    version: {
      no: 1,
      status: 'published',
      reason: null,
      title: 'Dinner',
      summary: 'Shared meal',
      body: 'Let us gather.',
      effectiveAt: '2026-03-12T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMember: {
        memberId: 'member-1',
        publicName: 'Member One',
      },
      mentions: { title: [], summary: [], body: [] },
      ...(overrides.version ?? {}),
    },
    event: {
      location: 'Hackney, London',
      startsAt: '2026-03-20T19:00:00Z',
      endsAt: '2026-03-20T21:00:00Z',
      timezone: 'UTC',
      recurrenceRule: null,
      capacity: 8,
      ...(overrides.event ?? {}),
    },
    rsvps: {
      viewerResponse: null,
      counts: { yes: 0, maybe: 0, no: 0, waitlist: 0 },
      attendees: [],
      ...(overrides.rsvps ?? {}),
    },
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeThreadSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    clubId: 'club-1',
    firstContent: makeEntity(),
    contentCount: 1,
    latestActivityAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeRepository(results: MemberSearchResult[] = []): Repository {
  return {
    async authenticateBearerToken(bearerToken: string) {
      if (bearerToken !== 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs') {
        return null;
      }

      return makeAuthResult();
    },
    async findClubBySlug() {
      return null;
    },
    async listClubs() {
      return { results: [makeClub()], hasMore: false, nextCursor: null };
    },
    async createClub() {
      return makeClub();
    },
    async archiveClub() {
      return makeClub({ archivedAt: '2026-03-12T01:00:00Z' });
    },
    async assignClubOwner() {
      return makeClub({
        owner: { memberId: 'member-9', publicName: 'Member Nine' },
        version: { no: 2, createdAt: '2026-03-12T01:00:00Z', creatorMemberId: 'member-1' },
      });
    },
    async joinClub() {
      return makeJoinClubResult();
    },
    async submitClubApplication() {
      return {
        status: 'submitted',
        membershipId: 'membership-9',
        applicationSubmittedAt: '2026-03-12T00:05:00Z',
      };
    },
    async getClubApplication() {
      return makeApplicationSummary();
    },
    async listClubApplications() {
      return [makeApplicationSummary()];
    },
    async getMember() {
      return makeClubMember();
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async listAdminMembers() {
      return { results: [makeAdminMember()], hasMore: false, nextCursor: null };
    },
    async getAdminMember() {
      return makeAdminMember();
    },
    async listAdminApplications() {
      return { results: [makeAdminApplication()], hasMore: false, nextCursor: null };
    },
    async getAdminApplication() {
      return makeAdminApplicationEnvelope();
    },
    async createMembership() {
      return makeMembershipAdmin();
    },
    async updateMembership() {
      return {
        membership: makeMembershipAdmin({ version: { ...makeMembershipAdmin().version, status: 'active', no: 2 } }),
        changed: true,
      };
    },
    async issueInvitation() {
      return {
        invitation: {
          invitationId: 'invitation-1',
          clubId: 'club-2',
          candidateName: 'Jane Doe',
          candidateEmail: 'jane@example.com',
          candidateMemberId: null,
          deliveryKind: 'code',
          code: '7DK4-M9Q2',
          sponsor: {
            memberId: 'member-1',
            publicName: 'Member One',
          },
          reason: 'Strong collaborator',
          status: 'open',
          quotaState: 'counted',
          expiresAt: '2026-03-15T13:00:00.000Z',
          createdAt: '2026-03-12T00:00:00Z',
        },
      };
    },
    async listIssuedInvitations() {
      return [{
        invitationId: 'invitation-1',
        clubId: 'club-2',
        candidateName: 'Jane Doe',
        candidateEmail: 'jane@example.com',
        candidateMemberId: null,
        deliveryKind: 'code',
        code: '7DK4-M9Q2',
        sponsor: {
          memberId: 'member-1',
          publicName: 'Member One',
        },
        reason: 'Strong collaborator',
        status: 'open',
        quotaState: 'counted',
        expiresAt: '2026-03-15T13:00:00.000Z',
        createdAt: '2026-03-12T00:00:00Z',
      }];
    },
    async revokeInvitation() {
      return {
        invitationId: 'invitation-1',
        clubId: 'club-2',
        candidateName: 'Jane Doe',
        candidateEmail: 'jane@example.com',
        candidateMemberId: null,
        deliveryKind: 'code',
        sponsor: {
          memberId: 'member-1',
          publicName: 'Member One',
        },
        reason: 'Strong collaborator',
        status: 'revoked',
        expiresAt: '2026-03-15T13:00:00.000Z',
        createdAt: '2026-03-12T00:00:00Z',
      };
    },
    async fullTextSearchMembers() {
      return { results, hasMore: false, nextCursor: null };
    },
    async getMemberProfile({ targetMemberId }) {
      return makeProfile(targetMemberId);
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async loadProfileForGate() {
      return {
        tagline: 'Builder',
        summary: 'Profile summary',
        whatIDo: 'Builds useful things',
        knownFor: 'Reliable work',
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      };
    },
    async preflightCreateContentMentions() {},
    async preflightUpdateContentMentions() {},
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async readContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async loadContentForGate() {
      return {
        contentKind: 'post' as const,
        isReply: false,
        title: 'Test',
        summary: null,
        body: 'Test body',
        expiresAt: null,
        event: null,
      };
    },
    async resolveContentThreadClubIdForGate() {
      return 'club-1';
    },
    async resolveContentClubIdForGate() {
      return 'club-1';
    },
    async closeContentLoop() {
      return withIncluded({ content: makeEntity({ openLoop: false }) });
    },
    async reopenContentLoop() {
      return withIncluded({ content: makeEntity({ openLoop: true }) });
    },
    async removeContent() {
      return withIncluded({ content: makeEntity({ state: 'removed' }) });
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent() {
      return withIncluded({ content: makeEvent() });
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async sendDirectMessage() {
      return withIncluded({ message: makeDirectMessage() });
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return withIncluded({ results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null });
    },
    async readDirectMessageThread() {
      return withIncluded({
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      });
    },
    async listInboxSince() {
      return { frames: [], nextCursor: null };
    },
    async acknowledgeDirectMessageInbox() {
      return { threadId: 'thread-1', acknowledgedCount: 0 };
    },
    async listClubActivity() {
      return {
        items: [],
        highWaterMark: 0,
        hasMore: false,
      };
    },
    async listNotifications() {
      return {
        items: [],
        nextCursor: null,
      };
    },
    async acknowledgeNotifications() {
      return [];
    },
    async checkVouchTargetAccessible() {
      return { vouchable: true };
    },
    async createVouch() {
      return null;
    },
    async listVouches() {
      return { results: [], hasMore: false, nextCursor: null };
    },
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
    async peekIdempotencyReplay() {
      return false;
    },
    async withClientKeyBarrier({ execute }) {
      return execute();
    },
    async listContent() {
      return withIncluded({ results: [makeThreadSummary()], hasMore: false, nextCursor: null });
    },
  };
}

test('session.getContext returns the canonical actor session envelope once', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async listNotifications() {
      return {
        items: [makeNotificationItem()],
        nextCursor: null,
      };
    },
  };
  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'session.getContext',
  });

  assert.equal(result.action, 'session.getContext');
  assert.equal(result.actor.member.id, 'member-1');
  assert.deepEqual(result.actor.globalRoles, ['superadmin']);
  assert.equal(result.actor.activeMemberships.length, 2);
  assert.deepEqual(
    result.actor.activeMemberships.map((club) => club.clubId),
    ['club-1', 'club-2'],
  );
  assert.deepEqual(result.data, {});
  assert.equal(result.actor.sharedContext.notifications.length, 1);
  assert.equal(result.actor.sharedContext.notifications[0]?.notificationId, 'notification-1');
});

test('session.getContext works for a registered bearer holder with zero accessible memberships', async () => {
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    memberships: [],
  };
  auth.requestScope = { requestedClubId: null, activeClubIds: [] };

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return auth;
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'session.getContext',
  });

  assert.equal(result.actor.activeMemberships.length, 0);
  assert.deepEqual(result.actor.requestScope.activeClubIds, []);
});

test('registered zero-membership bearers can still call clubs.apply', async () => {
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    memberships: [],
  };
  auth.requestScope = { requestedClubId: null, activeClubIds: [] };
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return auth;
    },
    async applyToClub(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-9',
          clubSlug: 'gamma',
          clubName: 'Gamma',
          clubSummary: null,
          admissionPolicy: null,
          submissionPath: 'cold',
          sponsorName: null,
          phase: 'awaiting_review',
          submittedAt: '2026-03-14T12:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@jane',
          application: 'Love the community',
        },
        next: { action: 'updates.list', reason: 'Queued for review.' },
        roadmap: [],
        gate: {
          verdict: 'not_run',
          feedback: null,
        },
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubs.apply',
    payload: {
      clubSlug: 'gamma',
      draft: {
        name: 'Jane Doe',
        socials: '@jane',
        application: 'Love the community',
      },
      clientKey: 'apply-1',
    },
  });

  assert.equal(capturedInput?.actorMemberId, 'member-1');
  assert.equal(capturedInput?.clubSlug, 'gamma');
  assert.equal(result.data.application.phase, 'awaiting_review');
  assert.equal(result.actor.activeMemberships.length, 0);
});

test('superadmin.clubs.list requires superadmin and returns archived flag filter', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listClubs(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        results: [makeClub({ archivedAt: '2026-03-12T01:00:00Z' })],
        hasMore: false,
        nextCursor: null,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'superadmin.clubs.list',
    payload: { includeArchived: true },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    includeArchived: true,
    limit: 20,
    cursor: null,
  });
  assert.equal(result.data.results[0]?.archivedAt, '2026-03-12T01:00:00Z');
});

test('superadmin.clubs.create derives superadmin ownership assignment server-side', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async findClubBySlug() {
      return null;
    },
    async adminGetMember() {
      return {
        memberId: 'member-9',
        publicName: 'Member Nine',
        state: 'active',
        createdAt: '2026-03-14T10:00:00Z',
        membershipCount: 0,
        tokenCount: 0,
      };
    },
    async createClub(input) {
      capturedInput = input as Record<string, unknown>;
      return makeClub({
        clubId: 'club-9',
        slug: 'gamma',
        name: 'Gamma',
        owner: { memberId: 'member-9', publicName: 'Member Nine' },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'superadmin.clubs.create',
    payload: {
      clientKey: 'superadmin-create-1',
      slug: 'gamma',
      name: 'Gamma',
      summary: 'Third club',
      ownerMemberId: 'member-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    idempotencyActorContext: 'superadmin:member-1:clubs.create',
    clientKey: 'superadmin-create-1',
    idempotencyRequestValue: {
      clientKey: 'superadmin-create-1',
      slug: 'gamma',
      name: 'Gamma',
      summary: 'Third club',
      admissionPolicy: null,
      ownerMemberId: 'member-9',
      usesFreeAllowance: true,
    },
    slug: 'gamma',
    name: 'Gamma',
    summary: 'Third club',
    admissionPolicy: null,
    ownerMemberId: 'member-9',
    usesFreeAllowance: true,
    memberCap: null,
    enforceFreeClubLimit: false,
  });
  assert.equal(result.actor.requestScope.requestedClubId, 'club-9');
  assert.equal(result.data.club.owner.memberId, 'member-9');
});

test('superadmin.clubs.assignOwner appends a new owner version via the superadmin surface', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async assignClubOwner(input) {
      capturedInput = input as Record<string, unknown>;
      return makeClub({
        clubId: 'club-2',
        owner: { memberId: 'member-9', publicName: 'Member Nine' },
        version: { no: 2, createdAt: '2026-03-12T01:00:00Z', creatorMemberId: 'member-1' },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'superadmin.clubs.assignOwner',
    payload: {
      clubId: 'club-2',
      ownerMemberId: 'member-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    ownerMemberId: 'member-9',
  });
  assert.equal(result.data.club.owner.memberId, 'member-9');
  assert.equal(result.data.club.version.no, 2);
});

test('clubadmin.members.list stays inside owner club scope and can filter by status and role', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listAdminMembers(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        results: [makeAdminMember({
          membershipId: 'membership-10',
          memberId: 'member-9',
          publicName: 'Member Nine',
          role: 'member',
          version: { ...makeAdminMember().version, status: 'active', reason: 'Current member' },
        })],
        hasMore: false,
        nextCursor: null,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.members.list',
    payload: { clubId: 'club-2', statuses: ['active'], roles: ['member'], limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    limit: 4,
    statuses: ['active'],
    roles: ['member'],
    cursor: null,
  });
  assert.equal(result.action, 'clubadmin.members.list');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.equal(result.data.results[0]?.version.status, 'active');
});

// Auth rejection for clubadmin actions (regular member cannot call) is tested
// in integration tests with a real DB and bearer token flow.

test('clubadmin.applications.list stays inside owner club scope and returns application summaries', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listAdminClubApplications(input) {
      capturedInput = input as unknown as Record<string, unknown>;
      return {
        results: [{
          applicationId: 'application-10',
          clubId: 'club-2',
          clubSlug: 'beta',
          clubName: 'Beta',
          clubSummary: 'Second club',
          admissionPolicy: 'Be kind.',
          applicantMemberId: 'member-9',
          sponsorId: 'member-8',
          sponsorName: 'Sponsor Eight',
          submissionPath: 'invitation',
          phase: 'awaiting_review',
          draft: {
            name: 'Member Nine',
            socials: '@membernine',
            application: 'Ready to join.',
          },
          gate: {
            verdict: 'passed',
            feedback: null,
            lastRunAt: '2026-03-12T00:00:00Z',
          },
          admin: {
            note: null,
            workflowStage: null,
          },
          submittedAt: '2026-03-12T00:00:00Z',
          decidedAt: null,
          activatedMembershipId: null,
        }],
        hasMore: false,
        nextCursor: null,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.applications.list',
    payload: {
      clubId: 'club-2',
      limit: 3,
    },
  });

  assert.equal(capturedInput?.actorMemberId, 'member-1');
  assert.equal(capturedInput?.clubId, 'club-2');
  assert.equal(capturedInput?.limit, 3);
  assert.equal(capturedInput?.cursor, null);
  assert.equal(result.action, 'clubadmin.applications.list');
  assert.equal(result.data.results[0]?.phase, 'awaiting_review');
  assert.equal(result.data.results[0]?.submissionPath, 'invitation');
});

test('superadmin.memberships.create direct-adds an active member', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async adminCreateMembership(input) {
      capturedInput = input as Record<string, unknown>;
      return makeMembershipAdmin({
        membershipId: 'membership-10',
        clubId: 'club-2',
        member: { memberId: 'member-9', publicName: 'Member Nine' },
        sponsor: null,
        version: { ...makeMembershipAdmin().version, status: 'active', reason: 'Direct add' },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'superadmin.memberships.create',
    payload: {
      clubId: 'club-2',
      memberId: 'member-9',
      initialStatus: 'active',
      reason: 'Direct add',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    memberId: 'member-9',
    sponsorId: null,
    role: 'member',
    initialStatus: 'active',
    reason: 'Direct add',
    initialProfile: {
      fields: {
        tagline: null,
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      },
      generationSource: 'membership_seed',
    },
  });
  assert.equal(result.action, 'superadmin.memberships.create');
  assert.equal(result.data.membership.sponsor, null);
  assert.equal(result.data.membership.version.status, 'active');
});

test('memberships.transition appends a new membership state version inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async updateMembership(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        membership: makeMembershipAdmin({
          membershipId: 'membership-10',
          clubId: 'club-2',
          version: {
            no: 2,
            status: 'active',
            reason: 'Fit check complete',
            createdAt: '2026-03-12T00:05:00Z',
            createdByMember: {
              memberId: 'member-1',
              publicName: 'Member One',
            },
          },
        }),
        changed: true,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.members.update',
    payload: {
      clubId: 'club-2',
      memberId: 'member-10',
      patch: {
        status: 'active',
        reason: 'Fit check complete',
      },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    actorMemberships: makeActor().memberships,
    actorIsSuperadmin: true,
    clubId: 'club-2',
    memberId: 'member-10',
    patch: {
      status: 'active',
      reason: 'Fit check complete',
    },
    skipClubAdminCheck: true,
  });
  assert.equal(result.action, 'clubadmin.members.update');
  assert.equal(result.data.membership.version.no, 2);
  assert.equal(result.data.membership.version.status, 'active');
});

// Auth rejection for clubadmin.members.update (regular member cannot call) is tested
// in integration tests with a real DB and bearer token flow.

test('clubadmin.applications.get returns the admin application summary inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async getAdminClubApplicationById(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        applicationId: 'application-10',
        clubId: 'club-2',
        clubSlug: 'beta',
        clubName: 'Beta',
        clubSummary: 'Second club',
        admissionPolicy: 'Be kind.',
        applicantMemberId: 'member-9',
        sponsorId: null,
        sponsorName: null,
        submissionPath: 'cold',
        phase: 'awaiting_review',
        draft: {
          name: 'Member Nine',
          socials: '@membernine',
          application: 'Ready to join.',
        },
        gate: {
          verdict: 'passed',
          feedback: null,
          lastRunAt: '2026-03-12T00:00:00Z',
        },
        admin: {
          note: 'Looks good',
          workflowStage: 'queued',
        },
        submittedAt: '2026-03-12T00:00:00Z',
        decidedAt: null,
        activatedMembershipId: null,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.applications.get',
    payload: { clubId: 'club-2', applicationId: 'application-10' },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    applicationId: 'application-10',
  });
  assert.equal(result.action, 'clubadmin.applications.get');
  assert.equal(result.data.application.phase, 'awaiting_review');
  assert.equal(result.data.application.submissionPath, 'cold');
  assert.equal(result.data.application.clubSlug, 'beta');
});

test('accounts.register returns the unauthenticated envelope and forwards submit fields', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      throw new Error('authenticateBearerToken should not run for anonymous accounts.register');
    },
    async registerAccount(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        phase: 'registered',
        member: {
          memberId: 'member-9',
          publicName: 'Jane Doe',
          email: 'jane@example.com',
          registeredAt: '2026-03-12T00:00:00Z',
        },
        credentials: {
          kind: 'member_bearer',
          memberBearer: 'clawclub_member_token',
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
          summary: 'Welcome.',
          details: 'Save the token.',
        },
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: null,
    action: 'accounts.register',
    payload: {
      mode: 'submit',
      clientKey: 'register-1',
      name: 'Jane Doe',
      email: 'Jane@Example.com',
      challengeBlob: 'payload.signature',
      nonce: '42',
    },
  });

  assert.deepEqual(capturedInput, {
    mode: 'submit',
    clientKey: 'register-1',
    name: 'Jane Doe',
    email: 'jane@example.com',
    challengeBlob: 'payload.signature',
    nonce: '42',
  });
  assert.equal(result.action, 'accounts.register');
  assert.equal(result.data.phase, 'registered');
  assert.equal('actor' in result, false);
});

test('clubs.apply forwards the authenticated member and submitted payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async applyToClub(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-2',
          clubSlug: 'beta',
          clubName: 'Beta Club',
          clubSummary: 'A second club',
          admissionPolicy: 'Tell us why you fit.',
          submissionPath: 'cold' as const,
          sponsorName: null,
          phase: 'awaiting_review' as const,
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@janedoe',
          application: 'Love the community',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
          applicationId: 'application-1',
        },
        roadmap: [],
        feedback: null,
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubs.apply',
    payload: {
      clubSlug: 'beta',
      draft: {
        name: 'Jane Doe',
        socials: '@janedoe',
        application: 'Love the community',
      },
      clientKey: 'apply-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubSlug: 'beta',
    draft: {
      name: 'Jane Doe',
      socials: '@janedoe',
      application: 'Love the community',
    },
    clientKey: 'apply-1',
  });
  assert.equal(result.action, 'clubs.apply');
  assert.equal(result.data.application.phase, 'awaiting_review');
});

test('members.searchByFullText narrows scope when a permitted club is requested', async () => {
  let capturedClubId: string | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers({ clubId }) {
      capturedClubId = clubId;
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'members.searchByFullText',
    payload: {
      query: 'Chris',
      clubId: 'club-2',
      limit: 3,
    },
  });

  assert.equal(result.action, 'members.searchByFullText');
  assert.equal(capturedClubId, 'club-2');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.equal(result.data.clubScope.length, 1);
  assert.equal(result.data.clubScope[0]?.clubId, 'club-2');
});

test('members.list returns active members with flattened public member summaries', async () => {
  let capturedInput: { actorMemberId: string; clubId: string; limit: number; cursor: { joinedAt: string; membershipId: string } | null } | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers(input) {
      capturedInput = input;
      return { results: [
        makeClubMember({
          membershipId: 'membership-2',
          memberId: 'member-2',
          publicName: 'Member Two',
          displayName: 'Member Two',
          role: 'clubadmin',
          isOwner: true,
        }),
      ], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent() {
      return withIncluded({ content: makeEvent() });
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'members.list',
    payload: {
      clubId: 'club-2',
      limit: 4,
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    limit: 4,
    cursor: null,
  });
  assert.equal(result.action, 'members.list');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.results[0]?.memberId, 'member-2');
  assert.equal(result.data.results[0]?.membershipId, 'membership-2');
  assert.equal(result.data.results[0]?.role, 'clubadmin');
});

test('accounts.updateIdentity updates the actor displayName globally', async () => {
  let capturedPatch: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async updateMemberIdentity({ patch }) {
      capturedPatch = patch as Record<string, unknown>;
      return {
        memberId: 'member-1',
        publicName: 'Member One',
        displayName: String((patch as Record<string, unknown>).displayName ?? 'Member One'),
      };
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'accounts.updateIdentity',
    payload: {
      displayName: 'Renamed Member',
    },
  });

  assert.equal(result.action, 'accounts.updateIdentity');
  assert.deepEqual(capturedPatch, { displayName: 'Renamed Member' });
  assert.equal(result.data.memberId, 'member-1');
  assert.equal(result.data.displayName, 'Renamed Member');
});

test('members.updateProfile normalizes nullable strings for club-scoped fields', async () => {
  let capturedPatch: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async loadProfileForGate() {
      return {
        tagline: 'Building warm things',
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [{ label: 'Site', url: 'https://example.test' }],
      };
    },
    async updateClubProfile({ patch }) {
      capturedPatch = patch;
      return {
        ...makeProfile('member-1', ['club-2']),
        profiles: [{
          ...makeClubProfile('club-2'),
          tagline: patch.tagline !== undefined ? patch.tagline : 'Building warm things',
          links: patch.links !== undefined ? patch.links as Array<{ label: string | null; url: string }> : [{ label: 'Site', url: 'https://example.test' }],
        }],
      };
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'members.updateProfile',
    payload: {
      clubId: 'club-2',
      tagline: '  ',
      links: [{ label: 'GitHub', url: 'https://github.com/example' }],
    },
  });

  assert.equal(result.action, 'members.updateProfile');
  assert.deepEqual(capturedPatch, {
    clubId: 'club-2',
    clientKey: null,
    tagline: null,
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
  });
  assert.equal(result.actor.member.publicName, 'Member One');
  assert.equal(result.data.profiles[0]?.club.clubId, 'club-2');
  assert.equal(result.data.profiles[0]?.tagline, null);
});

test('content.create uses one shared flow for post/ask/service/opportunity kinds', async () => {
  let capturedInput: CreateContentInput | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async loadContentForGate() {
      return {
        contentKind: 'post' as const,
        isReply: false,
        title: 'Old title',
        summary: 'Old summary',
        body: 'Old body',
        event: null,
      };
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent(input) {
      capturedInput = input;
      return withIncluded({
        content: {
          ...makeEntity(),
          clubId: input.clubId,
          kind: input.kind,
          version: {
            ...makeEntity().version,
            title: input.title,
            summary: input.summary,
            body: input.body,
            expiresAt: input.expiresAt,
          },
        },
      });
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
    async getQuotaStatus() { return []; },

  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.create',
    payload: {
      clubId: 'club-2',
      kind: 'service',
      title: 'Debugging help',
      summary: 'Fast TypeScript debugging',
      body: 'Can help unblock hairy backend issues.',
      expiresAt: '2026-04-01T00:00:00Z',
    },
  });

  assert.deepEqual(capturedInput, {
    authorMemberId: 'member-1',
    clubId: 'club-2',
    kind: 'service',
    title: 'Debugging help',
    summary: 'Fast TypeScript debugging',
    body: 'Can help unblock hairy backend issues.',
    expiresAt: '2026-04-01T00:00:00Z',
    clientKey: null,
  });
  assert.equal(result.action, 'content.create');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.content.kind, 'service');
});

test('content.update appends a new version on the shared content surface', async () => {
  let capturedInput: UpdateContentInput | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async loadContentForGate() {
      return {
        contentKind: 'post' as const,
        isReply: false,
        title: 'Old title',
        summary: 'Old summary',
        body: 'Old body',
        event: null,
      };
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent(input) {
      capturedInput = input;
      return withIncluded({
        content: makeEntity({
          clubId: 'club-2',
          version: {
            ...makeEntity().version,
            no: 2,
            title: input.patch.title ?? null,
            summary: input.patch.summary ?? null,
            body: input.patch.body ?? null,
            expiresAt: input.patch.expiresAt ?? null,
          },
        }),
      });
    },
    async resolveContentClubIdForGate() {
      return 'club-2';
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.update',
    payload: {
      id: 'content-1',
      title: 'Hello again',
      summary: '  ',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-1', 'club-2'],
    id: 'content-1',
    clientKey: null,
    patch: {
      title: 'Hello again',
      summary: null,
    },
  });
  assert.equal(result.action, 'content.update');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.content.version.no, 2);
});

test('content.remove appends a removed version on the shared content surface', async () => {
  let capturedInput: { actorMemberId: string; accessibleClubIds: string[]; id: string; reason?: string | null } | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async removeContent(input) {
      capturedInput = input;
      return withIncluded({
        content: makeEntity({
          clubId: 'club-2',
          version: {
            ...makeEntity().version,
            no: 3,
            status: 'removed',
            effectiveAt: '2026-03-12T01:00:00Z',
            expiresAt: '2026-03-12T01:00:00Z',
            createdAt: '2026-03-12T01:00:00Z',
          },
        }),
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.remove',
    payload: {
      id: 'content-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-1', 'club-2'],
    id: 'content-1',
    reason: null,
  });
  assert.equal(result.action, 'content.remove');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.content.version.no, 3);
  assert.equal(result.data.content.version.status, 'removed');
});

test('content.update rejects empty patches', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'content.update',
        payload: {
          id: 'content-1',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_input');
      return true;
    },
  );
});

test('content.update rejects non-author updates', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return null;
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'content.update',
        payload: {
          id: 'content-1',
          body: 'Nope',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'content_not_found');
      return true;
    },
  );
});

test('content.create(kind=event) writes the smallest sane event payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return withIncluded({ content: makeEntity() });
    },
    async updateContent() {
      return withIncluded({ content: makeEntity() });
    },
    async createContent(input) {
      capturedInput = input as Record<string, unknown>;
      return withIncluded({
        content: makeEvent({
          clubId: input.clubId ?? 'club-2',
          version: { ...makeEvent().version, title: input.title },
          event: { ...makeEvent().event!, capacity: input.event?.capacity ?? null },
        }),
      });
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent() {
      return withIncluded({ content: makeEvent() });
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
    async getQuotaStatus() { return []; },

  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.create',
    payload: {
      clubId: 'club-2',
      kind: 'event',
      title: 'Supper club',
      summary: 'Monthly supper club in Hackney',
      event: {
        location: 'Hackney, London',
        startsAt: '2026-03-20T19:00:00Z',
        endsAt: '2026-03-20T21:00:00Z',
        timezone: 'UTC',
        capacity: 12,
      },
    },
  });

  assert.deepEqual(capturedInput, {
    authorMemberId: 'member-1',
    clubId: 'club-2',
    kind: 'event',
    title: 'Supper club',
    summary: 'Monthly supper club in Hackney',
    body: null,
    expiresAt: null,
    clientKey: null,
    event: {
      location: 'Hackney, London',
      startsAt: '2026-03-20T19:00:00Z',
      endsAt: '2026-03-20T21:00:00Z',
      timezone: 'UTC',
      recurrenceRule: null,
      capacity: 12,
    },
  });
  assert.equal(result.action, 'content.create');
  assert.equal(result.data.content.clubId, 'club-2');
});

test('events.list stays inside accessible scope and forwards optional query', async () => {
  let capturedInput: ListEventsInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents(input) {
      capturedInput = input;
      return { results: [makeEvent({ clubId: 'club-2' })], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.list',
    payload: { clubId: 'club-2', query: 'hetzner', limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubIds: ['club-2'],
    limit: 4,
    query: 'hetzner',
    cursor: null,
  });
  assert.equal(result.data.query, 'hetzner');
  assert.equal(result.data.results[0]?.clubId, 'club-2');
});

test('events.setRsvp uses the actor membership in the event club', async () => {
  let capturedInput: RsvpEventInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent(input) {
      capturedInput = input;
      return withIncluded({
        content: makeEvent({
          clubId: 'club-2',
          rsvps: {
            viewerResponse: 'yes',
            counts: { yes: 1, maybe: 0, no: 0, waitlist: 0 },
            attendees: [
              {
                membershipId: 'membership-2',
                memberId: 'member-1',
                publicName: 'Member One',
                response: 'yes',
                note: 'I am in',
                createdAt: '2026-03-12T00:00:00Z',
              },
            ],
          },
        }),
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.setRsvp',
    payload: { eventId: 'event-1', response: 'yes', note: 'I am in' },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    eventId: 'event-1',
    response: 'yes',
    note: 'I am in',
    accessibleMemberships: [
      { membershipId: 'membership-1', clubId: 'club-1' },
      { membershipId: 'membership-2', clubId: 'club-2' },
    ],
  });
  assert.equal(result.action, 'events.setRsvp');
  assert.equal(result.data.content.rsvps.viewerResponse, 'yes');
});

test('content.list can span accessible clubs and filter by kinds with optional query', async () => {
  let capturedInput: ListContentInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listContent(input) {
      capturedInput = input;
      return { results: [makeThreadSummary({ firstContent: { ...makeEntity(), kind: 'ask' } })], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.list',
    payload: {
      query: 'backend',
      kinds: ['ask', 'service'],
      limit: 5,
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubIds: ['club-1', 'club-2'],
    kinds: ['ask', 'service'],
    limit: 5,
    query: 'backend',
    includeClosed: false,
    cursor: null,
  });
  assert.equal(result.action, 'content.list');
  assert.equal(result.data.query, 'backend');
  assert.equal(result.data.results[0]?.firstContent.kind, 'ask');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-1', 'club-2']);
});

test('superadmin.clubs.create rejects non-superadmins', async () => {
  const actor = makeActor();
  actor.globalRoles = [];
  const dispatcher = buildDispatcher({
    repository: {
      ...makeRepository(),
      async authenticateBearerToken() {
        return {
          actor,
          requestScope: { requestedClubId: null, activeClubIds: actor.memberships.map((membership) => membership.clubId) },
          sharedContext: { notifications: [makeNotificationItem()], notificationsTruncated: false },
        };
      },
    },
  });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'superadmin.clubs.create',
      payload: { clientKey: 'forbidden-create', slug: 'gamma', name: 'Gamma', summary: 'Test club', ownerMemberId: 'member-9' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden_role');
      return true;
    },
  );
});

test('superadmin role checks run before privileged input parsing', async () => {
  const actor = makeActor();
  actor.globalRoles = [];
  const dispatcher = buildDispatcher({
    repository: {
      ...makeRepository(),
      async authenticateBearerToken() {
        return {
          actor,
          requestScope: { requestedClubId: null, activeClubIds: actor.memberships.map((membership) => membership.clubId) },
          sharedContext: { notifications: [], notificationsTruncated: false },
        };
      },
    },
  });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'superadmin.clubs.create',
      payload: { malformed: true },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden_role');
      return true;
    },
  );
});

test('raw club scope checks run before clubadmin input parsing', async () => {
  const actor = makeActor();
  actor.globalRoles = [];
  actor.memberships = actor.memberships.filter((membership) => membership.clubId === 'club-1');
  const dispatcher = buildDispatcher({
    repository: {
      ...makeRepository(),
      async authenticateBearerToken() {
        return {
          actor,
          requestScope: { requestedClubId: null, activeClubIds: actor.memberships.map((membership) => membership.clubId) },
          sharedContext: { notifications: [], notificationsTruncated: false },
        };
      },
    },
  });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'clubadmin.members.list',
      payload: { clubId: 'club-2', limit: 'not-a-number' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden_scope');
      return true;
    },
  );
});

test('members.searchByFullText rejects a club outside the actor scope', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'members.searchByFullText',
        payload: {
          query: 'Chris',
          clubId: 'club-999',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden_scope');
      return true;
    },
  );
});

test('members.get returns 404 when the target member is not in the requested club', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMember() {
      return null;
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'members.get',
        payload: {
          clubId: 'club-1',
          memberId: 'member-999',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'member_not_found');
      return true;
    },
  );
});

test('messages.send picks a shared club, appends the request scope, and returns update metadata', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
	    async sendDirectMessage(input) {
	      capturedInput = input as Record<string, unknown>;
	      return withIncluded({
	        message: makeDirectMessage({
	          messageText: input.messageText,
	        }),
	        thread: {
	          threadId: 'thread-1',
	          recipientMemberId: 'member-9',
	          sharedClubs: [{ clubId: 'club-1', slug: 'alpha', name: 'Alpha' }],
	        },
	      });
	    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
    async getQuotaStatus() { return []; },

  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.send',
    payload: {
      recipientMemberId: 'member-9',
      messageText: 'Hello from the club edge',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-1', 'club-2'],
    recipientMemberId: 'member-9',
    messageText: 'Hello from the club edge',
    clientKey: null,
	  });
	  assert.equal(result.action, 'messages.send');
	  assert.equal(result.data.thread.recipientMemberId, 'member-9');
	  assert.equal(result.data.message.messageText, 'Hello from the club edge');
	});

test('messages.send returns 404 when the recipient is outside shared scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return null;
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
    async getQuotaStatus() { return []; },

  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'messages.send',
        payload: {
          recipientMemberId: 'member-404',
          messageText: 'hello',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'member_not_found');
      return true;
    },
  );
});

test('updates.list returns inbox summaries inside actor scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async listDirectMessageInbox(input) {
      capturedInput = input as Record<string, unknown>;
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.list',
    payload: { inbox: { limit: 4, unreadOnly: false } },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    limit: 4,
    unreadOnly: false,
    cursor: null,
  });
  assert.equal(result.action, 'updates.list');
  assert.equal(result.data.inbox.unreadOnly, false);
  assert.ok(Array.isArray(result.data.inbox.results[0]?.sharedClubs));
  assert.equal(result.data.inbox.results[0]?.counterpart.memberId, 'member-2');
  assert.equal(result.data.inbox.results[0]?.unread.hasUnread, true);
});

test('updates.list inbox unreadOnly returns thread-focused unread summaries inside actor scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async listDirectMessageInbox(input) {
      capturedInput = input as Record<string, unknown>;
      return { results: [
        makeDirectMessageInbox({
          unread: {
            hasUnread: true,
            unreadMessageCount: 2,
            unreadUpdateCount: 3,
            latestUnreadMessageCreatedAt: '2026-03-12T00:04:00Z',
          },
        }),
      ], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.list',
    payload: { inbox: { limit: 4, unreadOnly: true } },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    limit: 4,
    unreadOnly: true,
    cursor: null,
  });
  assert.equal(result.action, 'updates.list');
  assert.equal(result.data.inbox.unreadOnly, true);
  assert.ok(Array.isArray(result.data.inbox.results[0]?.sharedClubs));
  assert.equal(result.data.inbox.results[0]?.unread.unreadMessageCount, 2);
  assert.equal(result.data.inbox.results[0]?.unread.unreadUpdateCount, 3);
});

test('messages.get scopes thread access server-side and returns DM entries', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async readDirectMessageThread(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        thread: makeDirectMessageThread(),
        messages: [
          makeDirectMessageTranscriptEntry({
            messageId: 'message-1',
            createdAt: '2026-03-12T00:01:00Z',
            messageText: 'Earlier',
          }),
          makeDirectMessageTranscriptEntry({
            messageId: 'message-2',
            createdAt: '2026-03-12T00:02:00Z',
            senderMemberId: 'member-1',
            messageText: 'Later',
          }),
        ],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.get',
    payload: { threadId: 'thread-1', limit: 2 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    threadId: 'thread-1',
    limit: 2,
    cursor: null,
  });
  assert.equal(result.action, 'messages.get');
  assert.equal(result.data.thread.threadId, 'thread-1');
  assert.equal(result.data.messages.results.length, 2);
  assert.equal(Object.hasOwn(result.data.messages.results[1] ?? {}, 'inReplyToMessageId'), false);
  assert.equal(result.data.messages.results[0]?.messageText, 'Earlier');
  assert.equal(result.data.messages.results[1]?.messageText, 'Later');
});

test('accessTokens.list returns the actor token inventory', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'accessTokens.list',
  });

  assert.equal(result.action, 'accessTokens.list');
  assert.equal(result.data.tokens.length, 1);
  assert.equal(result.data.tokens[0]?.tokenId, 'token-1');
});

test('accessTokens.create mints a new bearer token for the actor member', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken(input) {
      capturedInput = input as Record<string, unknown>;
      return makeCreatedBearerToken({
        ...makeBearerTokenSummary({ tokenId: 'token-2', label: 'laptop', metadata: { device: 'mbp' } }),
        bearerToken: 'cc_live_3456789abcde_3456789abcdefghjkmnpqrst',
      });
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
    async getQuotaStatus() { return []; },

  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'accessTokens.create',
    payload: {
      label: 'laptop',
      metadata: { device: 'mbp' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    label: 'laptop',
    expiresAt: null,
    metadata: { device: 'mbp' },
  });
  assert.equal(result.action, 'accessTokens.create');
  assert.equal(result.data.tokenId, 'token-2');
  assert.equal(result.data.bearerToken, 'cc_live_3456789abcde_3456789abcdefghjkmnpqrst');
});

test('accessTokens.revoke only revokes actor-owned tokens', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken(input) {
      capturedInput = input as Record<string, unknown>;
      return makeBearerTokenSummary({ tokenId: 'token-9', revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return { results: [makeDirectMessageInbox()], hasMore: false, nextCursor: null };
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'accessTokens.revoke',
    payload: {
      tokenId: 'token-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    tokenId: 'token-9',
  });
  assert.equal(result.action, 'accessTokens.revoke');
  assert.equal(result.data.token.tokenId, 'token-9');
  assert.equal(result.data.token.revokedAt, '2026-03-12T01:00:00Z');
});

test('updates.list returns the paginated notification worklist when only notifications are requested', async () => {
  const capturedInputs: Record<string, unknown>[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async listNotifications(input) {
      capturedInputs.push(input as Record<string, unknown>);
      if (input.after === null) {
        return {
          items: [],
          nextCursor: null,
        };
      }
      return {
        items: [
          makeNotificationItem({
            notificationId: 'notification-9',
            createdAt: '2026-03-12T00:09:00Z',
            clubId: 'club-2',
            seq: 9,
          }),
        ],
        nextCursor: 'cursor-next',
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.list',
    payload: { notifications: { cursor: 'test-cursor', limit: 3 } },
  });

  assert.equal(capturedInputs.length, 1);
  assert.equal(capturedInputs[0]?.actorMemberId, 'member-1');
  assert.equal(capturedInputs[0]?.after, 'test-cursor');
  assert.equal(capturedInputs[0]?.limit, 3);
  assert.ok(Array.isArray(capturedInputs[0]?.accessibleClubIds));
  assert.ok(Array.isArray(capturedInputs[0]?.adminClubIds));
  assert.equal(result.action, 'updates.list');
  assert.equal(result.data.notifications.results[0]?.notificationId, 'notification-9');
  assert.equal(result.data.notifications.nextCursor, 'cursor-next');
  assert.deepEqual(result.actor.sharedContext.notifications, []);
});

test('updates.list aggregates activity, notifications, and unread inbox in one response', async () => {
  const captured: {
    activity: Record<string, unknown>[];
    notifications: Record<string, unknown>[];
    inbox: Record<string, unknown>[];
  } = {
    activity: [],
    notifications: [],
    inbox: [],
  };

  const repository: Repository = {
    ...makeRepository(),
    async listClubActivity(input) {
      captured.activity.push(input as Record<string, unknown>);
      return {
        items: [{
          activityId: 'activity-1',
          seq: 9,
          clubId: 'club-2',
          topic: 'test.updates.activity',
          payload: { title: 'club change' },
          contentId: null,
          contentVersionId: null,
          audience: 'members',
          createdAt: '2026-03-12T00:09:00Z',
          createdByMember: {
            memberId: 'member-2',
            publicName: 'Activity Creator',
          },
        }],
        highWaterMark: 9,
        hasMore: false,
      };
    },
    async listNotifications(input) {
      captured.notifications.push(input as Record<string, unknown>);
      return {
        items: [
          makeNotificationItem({
            notificationId: 'notification-9',
            topic: 'test.updates.notification',
            clubId: 'club-2',
            createdAt: '2026-03-12T00:10:00Z',
            seq: 10,
          }),
        ],
        nextCursor: 'notif-cursor-next',
      };
    },
    async listDirectMessageInbox(input) {
      captured.inbox.push(input as Record<string, unknown>);
      return {
        results: [makeDirectMessageInbox({
          counterpart: {
            memberId: 'member-2',
            publicName: 'Member Two',
          },
          unread: {
            hasUnread: true,
            unreadMessageCount: 1,
            unreadUpdateCount: 1,
            latestUnreadMessageCreatedAt: '2026-03-12T00:11:00Z',
          },
        })],
        hasMore: false,
        nextCursor: 'dm-cursor-next',
        included: EMPTY_INCLUDED,
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.list',
    payload: {
      clubId: 'club-2',
      activity: { cursor: 'latest', limit: 5 },
      notifications: { cursor: 'notif-cursor-1', limit: 3 },
      inbox: { cursor: 'WyIyMDI2LTAzLTEyVDAwOjAwOjAwWiIsInRocmVhZC0xIl0', limit: 4, unreadOnly: true },
    },
  });

  assert.equal(captured.activity.length, 1);
  assert.equal(captured.activity[0]?.afterSeq, null);
  assert.deepEqual(captured.activity[0]?.clubIds, ['club-2']);

  assert.equal(captured.notifications.length, 1);
  assert.equal(captured.notifications[0]?.after, 'notif-cursor-1');
  assert.equal(captured.notifications[0]?.limit, 3);

  assert.equal(captured.inbox.length, 1);
  assert.equal(captured.inbox[0]?.limit, 4);
  assert.equal(captured.inbox[0]?.unreadOnly, true);
  assert.deepEqual(captured.inbox[0]?.cursor, {
    latestActivityAt: '2026-03-12T00:00:00Z',
    threadId: 'thread-1',
  });

  assert.equal(result.action, 'updates.list');
  assert.equal(result.data.activity.results[0]?.topic, 'test.updates.activity');
  assert.equal(result.data.notifications.results[0]?.notificationId, 'notification-9');
  assert.equal(result.data.inbox.results[0]?.counterpart.memberId, 'member-2');
  assert.equal(result.data.inbox.unreadOnly, true);
});

test('updates.acknowledge appends receipts and removes items from shared context', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeNotifications(input) {
      capturedInput = input as Record<string, unknown>;
      return [
        makeNotificationReceipt({
          notificationId: 'notification-1',
        }),
      ];
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.acknowledge',
    payload: {
      target: {
        kind: 'notification',
        notificationIds: ['notification-1'],
      },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    notificationIds: ['notification-1'],
  });
  assert.equal(result.action, 'updates.acknowledge');
  assert.deepEqual(result.actor.sharedContext.notifications, []);
  assert.equal(result.data.kind, 'notification');
  assert.equal(result.data.receipts[0]?.notificationId, 'notification-1');
  assert.equal(result.data.receipts[0]?.acknowledgedAt, '2026-03-12T00:02:00Z');
});

test('updates.acknowledge passes raw notification ids through without topic parsing', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeNotifications(input) {
      capturedInput = input as Record<string, unknown>;
      return [];
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.acknowledge',
    payload: {
      target: {
        kind: 'notification',
        notificationIds: ['application-notification-404'],
      },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    notificationIds: ['application-notification-404'],
  });
  assert.equal(result.action, 'updates.acknowledge');
  assert.equal(result.data.kind, 'notification');
  assert.deepEqual(result.data.receipts, []);
});

test('messages.get returns 404 when the thread is outside actor scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async fullTextSearchMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
    async listMembers() {
      return { results: [makeClubMember()], hasMore: false, nextCursor: null };
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createContent() {
      return makeEntity();
    },
    async updateContent() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return { results: [makeEvent()], hasMore: false, nextCursor: null };
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listBearerTokens() {
      return [makeBearerTokenSummary()];
    },
    async createBearerToken() {
      return makeCreatedBearerToken();
    },
    async revokeBearerToken() {
      return makeBearerTokenSummary({ revokedAt: '2026-03-12T01:00:00Z' });
    },
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listDeliveries() {
      return [makeDeliverySummary()];
    },
    async retryDelivery() {
      return makeDeliverySummary({ deliveryId: 'delivery-2', status: 'pending', attemptCount: 0, sentAt: null, failedAt: null, lastError: null });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async readDirectMessageThread() {
      return null;
    },
    async listContent() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'messages.get',
        payload: {
          threadId: 'thread-404',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'thread_not_found');
      return true;
    },
  );
});

test('session.getContext rejects unknown bearer tokens', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb',
        action: 'session.getContext',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'unauthenticated');
      return true;
    },
  );
});

test('gated actions fail with 503 gate_unavailable when the gate returns failed', async () => {
  const failingGate: typeof passthroughGate = async () => ({
    status: 'failed' as const,
    reason: 'provider_error' as const,
    errorCode: 'upstream_failure',
  });

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: failingGate });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'content.create',
      payload: { clubId: 'club-1', kind: 'post', title: 'Test', body: 'Test body' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'gate_unavailable');
      return true;
    },
  );
});

test('gated actions fail with 422 gate_rejected when the gate returns malformed feedback', async () => {
  const rejectingGate: typeof passthroughGate = async () => ({
    status: 'rejected_malformed' as const,
    rawText: 'Ambiguous response from LLM',
    usage: { promptTokens: 10, completionTokens: 5 },
  });

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: rejectingGate });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'content.create',
      payload: { clubId: 'club-1', kind: 'post', title: 'Test', body: 'Test body' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, 'gate_rejected');
      assert.equal(error.message, 'The content gate returned an unexpected response. Please try again.');
      return true;
    },
  );
});

test('gated actions reserve and finalize llm output budget around successful gate calls', async () => {
  let reserved: Record<string, unknown> | null = null;
  let finalized: Record<string, unknown> | null = null;
  let gateOptions: { maxOutputTokens?: number } | undefined;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async reserveLlmOutputBudget(input) {
      reserved = input as Record<string, unknown>;
      return {
        reservationId: 'reservation-1',
        quota: {
          action: 'llm.outputTokens',
          metric: 'output_tokens',
          scope: 'per_club_member',
          clubId: input.clubId,
          windows: [
            { window: 'day', max: 10000, used: 64, remaining: 9936 },
            { window: 'week', max: 45000, used: 64, remaining: 44936 },
            { window: 'month', max: 180000, used: 64, remaining: 179936 },
          ],
        },
      };
    },
    async finalizeLlmOutputBudget(input) {
      finalized = input as Record<string, unknown>;
    },
  };

  const gate: typeof passthroughGate = async (_artifact, options) => {
    gateOptions = options;
    return {
      status: 'passed',
      usage: { promptTokens: 12, completionTokens: 7 },
    };
  };

  const dispatcher = buildDispatcher({ repository, llmGate: gate });
  await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.create',
    payload: { clubId: 'club-1', kind: 'post', title: 'Test', body: 'Test body' },
  });

  assert.deepEqual(reserved, {
    memberId: 'member-1',
    clubId: 'club-1',
    actionName: 'content.create',
    provider: 'openai',
    model: 'gpt-5.4-nano',
    maxOutputTokens: 64,
  });
  assert.deepEqual(gateOptions, { maxOutputTokens: 64 });
  assert.deepEqual(finalized, {
    reservationId: 'reservation-1',
    actualOutputTokens: 7,
  });
});

test('gated actions release llm output budget when the gate throws', async () => {
  let finalized: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async reserveLlmOutputBudget(input) {
      return {
        reservationId: 'reservation-2',
        quota: {
          action: 'llm.outputTokens',
          metric: 'output_tokens',
          scope: 'per_club_member',
          clubId: input.clubId,
          windows: [
            { window: 'day', max: 10000, used: 64, remaining: 9936 },
            { window: 'week', max: 45000, used: 64, remaining: 44936 },
            { window: 'month', max: 180000, used: 64, remaining: 179936 },
          ],
        },
      };
    },
    async finalizeLlmOutputBudget(input) {
      finalized = input as Record<string, unknown>;
    },
  };

  const gate: typeof passthroughGate = async () => {
    throw new Error('boom');
  };

  const dispatcher = buildDispatcher({ repository, llmGate: gate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'content.create',
      payload: { clubId: 'club-1', kind: 'post', title: 'Test', body: 'Test body' },
    }),
    /boom/,
  );

  assert.deepEqual(finalized, {
    reservationId: 'reservation-2',
    actualOutputTokens: 0,
  });
});

test('gated actions skip the llm gate for exact idempotent replays', async () => {
  let gateCalled = false;
  let reserveCalled = false;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async peekIdempotencyReplay() {
      return true;
    },
    async reserveLlmOutputBudget(input) {
      reserveCalled = true;
      return {
        reservationId: 'reservation-3',
        quota: {
          action: 'llm.outputTokens',
          metric: 'output_tokens',
          scope: 'per_club_member',
          clubId: input.clubId,
          windows: [{ window: 'day', max: 1000, used: 0, remaining: 1000 }],
        },
      };
    },
  };

  const gate: typeof passthroughGate = async () => {
    gateCalled = true;
    return {
      status: 'passed',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };

  const dispatcher = buildDispatcher({ repository, llmGate: gate });
  await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.create',
    payload: {
      clubId: 'club-1',
      kind: 'post',
      title: 'Replay me',
      body: 'Same client key, same request.',
      clientKey: 'client-key-1',
    },
  });

  assert.equal(gateCalled, false);
  assert.equal(reserveCalled, false);
});

test('gated actions fail closed when no budget club can be resolved', async () => {
  const action = nextTestActionName('missing-budget-club');
  let gateCalled = false;

  registerActions([{
    action,
    domain: 'test',
    description: 'Missing budget club should fail closed',
    auth: 'member',
    safety: 'read_only',
    llmGate: {
      async buildArtifact() {
        return {
          kind: 'content',
          contentKind: 'post',
          isReply: false,
          title: null,
          summary: null,
          body: 'budget me',
        };
      },
      async resolveBudgetClubId() {
        return null;
      },
    },
    wire: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({}),
    },
    handle: async () => ({ data: { ok: true } }),
  }]);

  const gate: typeof passthroughGate = async () => {
    gateCalled = true;
    return { status: 'passed', usage: { promptTokens: 0, completionTokens: 0 } };
  };

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: gate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action,
      payload: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'invalid_data');
      assert.match(error.message, /resolved budget club/i);
      return true;
    },
  );

  assert.equal(gateCalled, false);
});

test('dispatcher runs preGate after parse and before the llm gate', async () => {
  const action = nextTestActionName('pregate-order');
  const calls: string[] = [];

  registerActions([{
    action,
    domain: 'test',
    description: 'PreGate ordering test',
    auth: 'member',
    safety: 'read_only',
    llmGate: {
      async buildArtifact(input) {
        return {
          kind: 'content',
          contentKind: 'post',
          isReply: false,
          title: null,
          summary: null,
          body: (input as { text: string }).text,
        };
      },
      async resolveBudgetClubId() {
        return 'club-1';
      },
    },
    wire: {
      input: z.object({ text: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({ text: z.string().trim() }),
    },
    preGate: async (input) => {
      const parsed = input as { text: string };
      calls.push(`preGate:${parsed.text}`);
    },
    handle: async () => {
      calls.push('handle');
      return { data: { ok: true } };
    },
  }]);

  const gate: typeof passthroughGate = async (artifact) => {
    calls.push(`gate:${(artifact as { body: string }).body}`);
    return { status: 'passed', usage: { promptTokens: 0, completionTokens: 0 } };
  };

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: gate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action,
    payload: { text: '  parsed first  ' },
  });

  assert.deepEqual(calls, ['preGate:parsed first', 'gate:parsed first', 'handle']);
  assert.deepEqual(result.data, { ok: true });
});

test('dispatcher runs preGate even when no llm gate is configured', async () => {
  const action = nextTestActionName('pregate-no-gate');
  const calls: string[] = [];

  registerActions([{
    action,
    domain: 'test',
    description: 'PreGate without llm gate',
    auth: 'member',
    safety: 'read_only',
    wire: {
      input: z.object({ text: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({ text: z.string().trim() }),
    },
    preGate: async (input) => {
      calls.push(`preGate:${(input as { text: string }).text}`);
    },
    handle: async () => {
      calls.push('handle');
      return { data: { ok: true } };
    },
  }]);

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });
  await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action,
    payload: { text: '  still runs  ' },
  });

  assert.deepEqual(calls, ['preGate:still runs', 'handle']);
});

test('AppError thrown from preGate propagates through the dispatcher unchanged', async () => {
  const action = nextTestActionName('pregate-error');

  registerActions([{
    action,
    domain: 'test',
    description: 'PreGate failure test',
    auth: 'member',
    safety: 'read_only',
    wire: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({}),
    },
    preGate: async () => {
      throw new AppError('invalid_input', 'preGate rejected this input');
    },
    handle: async () => ({ data: { ok: true } }),
  }]);

  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action,
      payload: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.message, 'preGate rejected this input');
      return true;
    },
  );
});

test('registerActions rejects cold actions that define preGate', () => {
  const action = nextTestActionName('cold-pregate');

  assert.throws(
    () => registerActions([{
      action,
      domain: 'test',
      description: 'Cold preGate rejection test',
      auth: 'none',
      safety: 'read_only',
      wire: {
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      },
      parse: {
        input: z.object({}),
      },
      preGate: async () => {},
      handleCold: async () => ({ data: { ok: true } }),
    }]),
    /must not define preGate/,
  );
});
