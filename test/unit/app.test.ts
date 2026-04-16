import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  type ApplicationSummary,
  AppError,
  type ActorContext,
  type AuthResult,
  type CreateEntityInput,
  type BearerTokenSummary,
  type CreatedBearerToken,
  type DirectMessageSummary,
  type DirectMessageInboxSummary,
  type DirectMessageThreadSummary,
  type EntitySummary,
  type EventSummary,
  type IncludedBundle,
  type ListEntitiesInput,
  type ListEventsInput,
  type AdminApplicationSummary,
  type AdminMemberSummary,
  type MembershipAdminSummary,
  type MemberProfileEnvelope,
  type ClubSummary,
  type JoinClubResult,
  type PublicMemberSummary,
  type RsvpEventInput,
  type UpdateEntityInput,
  type MemberSearchResult,
  type NotificationItem,
  type NotificationReceipt,
  type DirectMessageEntry,
  type Repository,
} from '../../src/contract.ts';
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

function makeActor(): ActorContext {
  return {
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
        sponsorMemberId: 'member-2',
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
        sponsorMemberId: 'member-3',
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
  const createdAt = overrides.createdAt ?? '2026-03-12T00:00:00Z';
  const notificationId = overrides.notificationId ?? 'synchronicity.ask_to_member:notification-1';
  return {
    notificationId,
    cursor: overrides.cursor ?? encodeNotificationCursor(createdAt, notificationId),
    kind: 'synchronicity.ask_to_member',
    clubId: 'club-1',
    ref: { matchId: 'match-1', entityId: 'entity-1' },
    payload: { hello: 'world' },
    createdAt,
    acknowledgeable: true,
    acknowledgedState: null,
    ...overrides,
  };
}

function makeNotificationReceipt(overrides: Partial<NotificationReceipt> = {}): NotificationReceipt {
  return {
    notificationId: 'synchronicity.ask_to_member:notification-1',
    recipientMemberId: 'member-1',
    entityId: 'entity-1',
    clubId: 'club-1',
    state: 'processed',
    suppressionReason: null,
    versionNo: 1,
    createdAt: '2026-03-12T00:02:00Z',
    createdByMemberId: 'member-1',
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
    token: makeBearerTokenSummary(),
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
    versionNo: 1,
    supersedesAcknowledgementId: null,
    createdAt: '2026-03-12T00:02:00Z',
    createdByMemberId: 'member-1',
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
    entityId: null,
    entityVersionId: null,
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
      createdByMemberId: 'member-1',
    },
    endpoint: makeDeliveryEndpoint(),
    ...overrides,
  };
}

function makeDirectMessage(overrides: Partial<DirectMessageSummary> = {}): DirectMessageSummary {
  return {
    threadId: 'thread-1',
    sharedClubs: [{ clubId: 'club-1', slug: 'alpha', name: 'Alpha' }],
    senderMemberId: 'member-1',
    recipientMemberId: 'member-2',
    messageId: 'message-1',
    messageText: 'Hello there',
    mentions: [],
    createdAt: '2026-03-12T00:03:00Z',
    updateCount: 1,
    ...overrides,
  };
}

function makeDirectMessageThread(overrides: Partial<DirectMessageThreadSummary> = {}): DirectMessageThreadSummary {
  return {
    threadId: 'thread-1',
    sharedClubs: [{ clubId: 'club-1', slug: 'alpha', name: 'Alpha' }],
    counterpartMemberId: 'member-2',
    counterpartPublicName: 'Member Two',
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
    inReplyToMessageId: null,
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
    owner: {
      memberId: 'member-1',
      publicName: 'Member One',
      email: 'one@example.com',
    },
    version: {
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
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
    state: {
      status: 'active',
      reason: 'Accepted',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
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
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
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
    state: {
      status: 'active',
      reason: null,
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
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
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
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
        createdByMemberId: memberId,
      },
    })),
  };
}

function makeEntity(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    entityId: 'entity-1',
    contentThreadId: 'thread-1',
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
      versionNo: 1,
      state: 'published',
      title: 'Hello',
      summary: 'Summary',
      body: 'Body',
      effectiveAt: '2026-03-12T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T00:00:00Z',
      mentions: { title: [], summary: [], body: [] },
      ...(overrides.version ?? {}),
    },
    event: null,
    rsvps: null,
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    entityId: 'event-1',
    contentThreadId: 'thread-1',
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
      versionNo: 1,
      state: 'published',
      title: 'Dinner',
      summary: 'Shared meal',
      body: 'Let us gather.',
      effectiveAt: '2026-03-12T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T00:00:00Z',
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
    threadId: 'thread-1',
    clubId: 'club-1',
    firstEntity: makeEntity(),
    thread: {
      entityCount: 1,
      lastActivityAt: '2026-03-12T00:00:00Z',
    },
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
    async listClubs() {
      return [makeClub()];
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
        version: { versionNo: 2, createdAt: '2026-03-12T01:00:00Z', createdByMemberId: 'member-1' },
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
    async transitionMembershipState() {
      return makeMembershipAdmin({ state: { ...makeMembershipAdmin().state, status: 'active', versionNo: 2 } });
    },
    async issueInvitation() {
      return {
        invitation: {
          invitationId: 'invitation-1',
          clubId: 'club-2',
          candidateName: 'Jane Doe',
          candidateEmail: 'jane@example.com',
          sponsor: {
            memberId: 'member-1',
            publicName: 'Member One',
          },
          reason: 'Strong collaborator',
          status: 'open',
          expiresAt: '2026-03-15T13:00:00.000Z',
          createdAt: '2026-03-12T00:00:00Z',
        },
        invitationCode: 'cc_inv_invitation-1_secret',
      };
    },
    async listIssuedInvitations() {
      return [{
        invitationId: 'invitation-1',
        clubId: 'club-2',
        candidateName: 'Jane Doe',
        candidateEmail: 'jane@example.com',
        sponsor: {
          memberId: 'member-1',
          publicName: 'Member One',
        },
        reason: 'Strong collaborator',
        status: 'open',
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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent() {
      return withIncluded({ entity: makeEvent() });
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
    async listEntities() {
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
        nextAfter: null,
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
  assert.equal(result.actor.onboardingPending, false);
  assert.equal(result.actor.sharedContext.notifications.length, 1);
  assert.equal(result.actor.sharedContext.notifications[0]?.notificationId, 'synchronicity.ask_to_member:notification-1');
});

test('session.getContext keeps onboardingPending false for a pre-admission bearer holder with zero accessible memberships', async () => {
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    member: {
      ...auth.actor.member,
      onboardedAt: null,
    },
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

  assert.equal(result.actor.onboardingPending, false);
});

test('dispatch gates non-allowlisted actions before input parsing for onboarding-pending members', async () => {
  const auth = makeAuthResult();
  auth.actor = {
    ...auth.actor,
    member: {
      ...auth.actor.member,
      onboardedAt: null,
    },
    memberships: [auth.actor.memberships[0]!],
  };
  auth.requestScope = { requestedClubId: null, activeClubIds: [auth.actor.memberships[0]!.clubId] };

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return auth;
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'content.create',
      payload: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'onboarding_required');
      assert.match(error.message, /clubs\.onboard/);
      return true;
    },
  );
});

test('clubs.onboard refreshes the actor envelope after the handler marks onboarding complete', async () => {
  const initialAuth = makeAuthResult();
  initialAuth.actor = {
    ...initialAuth.actor,
    member: {
      ...initialAuth.actor.member,
      onboardedAt: null,
    },
    memberships: [initialAuth.actor.memberships[0]!],
  };
  initialAuth.requestScope = { requestedClubId: null, activeClubIds: [initialAuth.actor.memberships[0]!.clubId] };

  const refreshedAuth = makeAuthResult();
  refreshedAuth.actor = {
    ...refreshedAuth.actor,
    member: {
      ...refreshedAuth.actor.member,
      onboardedAt: '2026-03-14T12:00:00Z',
    },
    memberships: [refreshedAuth.actor.memberships[0]!],
  };
  refreshedAuth.requestScope = { requestedClubId: null, activeClubIds: [refreshedAuth.actor.memberships[0]!.clubId] };

  let onboardCalls = 0;
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      return initialAuth;
    },
    async validateBearerTokenPassive() {
      return refreshedAuth;
    },
    async onboardMember() {
      onboardCalls += 1;
      return {
        alreadyOnboarded: false,
        member: { id: 'member-1', displayName: 'Member One' },
        club: { id: 'club-1', slug: 'alpha', name: 'Alpha', summary: 'First club' },
        welcome: {
          greeting: 'Welcome to Alpha, Member One.',
          preamble: 'You have been accepted.',
          capabilities: ['Ask me to show you who else is in Alpha.'],
          closing: 'Tell me when you are ready.',
        },
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubs.onboard',
    payload: {},
  });

  assert.equal(onboardCalls, 1);
  assert.equal(result.actor.onboardingPending, false);
  assert.equal(result.actor.member.id, 'member-1');
  assert.equal((result.data as Record<string, unknown>).alreadyOnboarded, false);
});

test('superadmin.clubs.list requires superadmin and returns archived flag filter', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listClubs(input) {
      capturedInput = input as Record<string, unknown>;
      return [makeClub({ archivedAt: '2026-03-12T01:00:00Z' })];
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
  });
  assert.equal(result.data.clubs[0]?.archivedAt, '2026-03-12T01:00:00Z');
});

test('superadmin.clubs.create derives superadmin ownership assignment server-side', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
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
      slug: 'gamma',
      name: 'Gamma',
      summary: 'Third club',
      ownerMemberId: 'member-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    slug: 'gamma',
    name: 'Gamma',
    summary: 'Third club',
    ownerMemberId: 'member-9',
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
        version: { versionNo: 2, createdAt: '2026-03-12T01:00:00Z', createdByMemberId: 'member-1' },
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
  assert.equal(result.data.club.version.versionNo, 2);
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
          state: { ...makeAdminMember().state, status: 'active', reason: 'Current member' },
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
  assert.equal(result.data.results[0]?.state.status, 'active');
});

// Auth rejection for clubadmin actions (regular member cannot call) is tested
// in integration tests with a real DB and bearer token flow.

test('clubadmin.applications.list stays inside owner club scope and returns application summaries', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listAdminApplications(input) {
      capturedInput = input as unknown as Record<string, unknown>;
      return { results: [makeAdminApplication()], hasMore: false, nextCursor: null };
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
  assert.equal(result.data.results[0]?.sponsorStats.sponsoredThisMonthCount, 2);
  assert.equal(result.data.results[0]?.submissionPath, 'invitation');
});

test('memberships.create direct-adds an active member inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async createMembership(input) {
      capturedInput = input as Record<string, unknown>;
      return makeMembershipAdmin({
        membershipId: 'membership-10',
        clubId: 'club-2',
        member: { memberId: 'member-9', publicName: 'Member Nine' },
        sponsor: null,
        state: { ...makeMembershipAdmin().state, status: 'active', reason: 'Direct add' },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.memberships.create',
    payload: {
      clubId: 'club-2',
      memberId: 'member-9',
      initialStatus: 'active',
      reason: 'Direct add',
      metadata: { source: 'operator' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    memberId: 'member-9',
    sponsorMemberId: null,
    role: 'member',
    initialStatus: 'active',
    reason: 'Direct add',
    metadata: { source: 'operator' },
    skipClubAdminCheck: true,
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
  assert.equal(result.action, 'clubadmin.memberships.create');
  assert.equal(result.data.membership.sponsor, null);
  assert.equal(result.data.membership.state.status, 'active');
});

test('memberships.transition appends a new membership state version inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async transitionMembershipState(input) {
      capturedInput = input as Record<string, unknown>;
      return makeMembershipAdmin({
        membershipId: 'membership-10',
        clubId: 'club-2',
        state: {
          status: 'active',
          reason: 'Fit check complete',
          versionNo: 2,
          createdAt: '2026-03-12T00:05:00Z',
          createdByMemberId: 'member-1',
        },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.memberships.setStatus',
    payload: {
      clubId: 'club-2',
      membershipId: 'membership-10',
      status: 'active',
      reason: 'Fit check complete',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    membershipId: 'membership-10',
    nextStatus: 'active',
    reason: 'Fit check complete',
    accessibleClubIds: ['club-2'],
    skipClubAdminCheck: true,
  });
  assert.equal(result.action, 'clubadmin.memberships.setStatus');
  assert.equal(result.data.membership.state.versionNo, 2);
  assert.equal(result.data.membership.state.status, 'active');
});

// Auth rejection for clubadmin.memberships.setStatus (regular member cannot call) is tested
// in integration tests with a real DB and bearer token flow.

test('clubadmin.applications.get returns the admin application summary inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async getAdminApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return makeAdminApplicationEnvelope({
        application: {
          state: {
            ...makeAdminApplication().state,
            status: 'interview_scheduled',
            versionNo: 2,
          },
          submissionPath: 'cross_apply',
          proofKind: 'pow',
        },
      });
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubadmin.applications.get',
    payload: { clubId: 'club-2', membershipId: 'membership-10' },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubId: 'club-2',
    membershipId: 'membership-10',
  });
  assert.equal(result.action, 'clubadmin.applications.get');
  assert.equal(result.data.application.state.status, 'interview_scheduled');
  assert.equal(result.data.application.submissionPath, 'cross_apply');
  assert.equal(result.data.club.slug, 'beta');
});

test('clubs.join returns the anonymous envelope and forwards normalized email', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      throw new Error('authenticateBearerToken should not run for anonymous clubs.join');
    },
    async joinClub(input) {
      capturedInput = input as Record<string, unknown>;
      return makeJoinClubResult();
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: null,
    action: 'clubs.join',
    payload: {
      clubSlug: 'beta',
      email: 'Jane@Example.com',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: null,
    clubSlug: 'beta',
    email: 'jane@example.com',
    invitationCode: undefined,
    challengeBlob: undefined,
    nonce: undefined,
  });
  assert.equal(result.action, 'clubs.join');
  assert.equal(result.data.membershipId, 'membership-9');
  assert.equal('actor' in result, false);
});

test('clubs.applications.submit forwards the authenticated member and submitted payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async submitClubApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        status: 'submitted',
        membershipId: 'membership-9',
        applicationSubmittedAt: '2026-03-12T00:05:00Z',
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'clubs.applications.submit',
    payload: {
      membershipId: 'membership-9',
      name: 'Jane Doe',
      socials: '@janedoe',
      application: 'Love the community',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    membershipId: 'membership-9',
    name: 'Jane Doe',
    socials: '@janedoe',
    application: 'Love the community',
  });
  assert.equal(result.action, 'clubs.applications.submit');
  assert.equal(result.data.status, 'submitted');
});

test('members.searchByFullText narrows scope when a permitted club is requested', async () => {
  let capturedClubId: string | null = null;

  const repository: Repository = {
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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity() {
      return withIncluded({ entity: makeEntity() });
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
    async listEntities() {
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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return withIncluded({ results: [makeEvent()], hasMore: false, nextCursor: null });
    },
    async rsvpEvent() {
      return withIncluded({ entity: makeEvent() });
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
    async listEntities() {
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

test('profile.list defaults to the actor member id', async () => {
  let capturedTargetMemberId: string | null = null;
  let capturedActorClubIds: string[] | null = null;

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
    async listMemberProfiles({ targetMemberId, actorClubIds }) {
      capturedTargetMemberId = targetMemberId;
      capturedActorClubIds = actorClubIds;
      return makeProfile(targetMemberId, actorClubIds);
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'profile.list',
  });

  assert.equal(result.action, 'profile.list');
  assert.equal(capturedTargetMemberId, 'member-1');
  assert.deepEqual(capturedActorClubIds, ['club-1', 'club-2']);
  assert.equal(result.data.memberId, 'member-1');
  assert.equal(result.data.profiles.length, 2);
});

test('profile.update normalizes nullable strings for club-scoped fields', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'profile.update',
    payload: {
      clubId: 'club-2',
      tagline: '  ',
      links: [{ label: 'GitHub', url: 'https://github.com/example' }],
    },
  });

  assert.equal(result.action, 'profile.update');
  assert.deepEqual(capturedPatch, {
    clubId: 'club-2',
    tagline: null,
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
  });
  assert.equal(result.actor.member.publicName, 'Member One');
  assert.equal(result.data.profiles[0]?.club.clubId, 'club-2');
  assert.equal(result.data.profiles[0]?.tagline, null);
});

test('content.create uses one shared flow for post/ask/service/opportunity kinds', async () => {
  let capturedInput: CreateEntityInput | null = null;

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
    async loadEntityForGate() {
      return {
        entityKind: 'post' as const,
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
    async createEntity(input) {
      capturedInput = input;
      return withIncluded({
        entity: {
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
    async updateEntity() {
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
    async listEntities() {
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
  assert.equal(result.data.entity.kind, 'service');
});

test('content.update appends a new version on the shared entity surface', async () => {
  let capturedInput: UpdateEntityInput | null = null;

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
    async loadEntityForGate() {
      return {
        entityKind: 'post' as const,
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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity(input) {
      capturedInput = input;
      return withIncluded({
        entity: makeEntity({
          entityVersionId: 'entity-version-2',
          clubId: 'club-2',
          version: {
            ...makeEntity().version,
            versionNo: 2,
            title: input.patch.title ?? null,
            summary: input.patch.summary ?? null,
            body: input.patch.body ?? null,
            expiresAt: input.patch.expiresAt ?? null,
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.update',
    payload: {
      entityId: 'entity-1',
      title: 'Hello again',
      summary: '  ',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-1', 'club-2'],
    entityId: 'entity-1',
    patch: {
      title: 'Hello again',
      summary: null,
    },
  });
  assert.equal(result.action, 'content.update');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.entity.entityVersionId, 'entity-version-2');
  assert.equal(result.data.entity.version.versionNo, 2);
});

test('content.remove appends a removed version on the shared entity surface', async () => {
  let capturedInput: { actorMemberId: string; accessibleClubIds: string[]; entityId: string; reason?: string | null } | null = null;

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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async removeEntity(input) {
      capturedInput = input;
      return withIncluded({
        entity: makeEntity({
          entityVersionId: 'entity-version-3',
          clubId: 'club-2',
          version: {
            ...makeEntity().version,
            versionNo: 3,
            state: 'removed',
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'content.remove',
    payload: {
      entityId: 'entity-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-1', 'club-2'],
    entityId: 'entity-1',
    reason: null,
  });
  assert.equal(result.action, 'content.remove');
  assert.equal(result.actor.requestScope.requestedClubId, 'club-2');
  assert.deepEqual(result.actor.requestScope.activeClubIds, ['club-2']);
  assert.equal(result.data.entity.entityVersionId, 'entity-version-3');
  assert.equal(result.data.entity.version.versionNo, 3);
  assert.equal(result.data.entity.version.state, 'removed');
});

test('content.update rejects empty patches', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository(), llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'content.update',
        payload: {
          entityId: 'entity-1',
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
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
          entityId: 'entity-1',
          body: 'Nope',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'not_found');
      return true;
    },
  );
});

test('content.create(kind=event) writes the smallest sane event payload', async () => {
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
    async createEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async updateEntity() {
      return withIncluded({ entity: makeEntity() });
    },
    async createEntity(input) {
      capturedInput = input as Record<string, unknown>;
      return withIncluded({
        entity: makeEvent({
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
      return withIncluded({ entity: makeEvent() });
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
    async listEntities() {
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
  assert.equal(result.data.entity.clubId, 'club-2');
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
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

test('events.rsvp uses the actor membership in the event club', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
        entity: makeEvent({
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.rsvp',
    payload: { eventEntityId: 'event-1', response: 'yes', note: 'I am in' },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    eventEntityId: 'event-1',
    response: 'yes',
    note: 'I am in',
    accessibleMemberships: [
      { membershipId: 'membership-1', clubId: 'club-1' },
      { membershipId: 'membership-2', clubId: 'club-2' },
    ],
  });
  assert.equal(result.action, 'events.rsvp');
  assert.equal(result.data.entity.rsvps.viewerResponse, 'yes');
});

test('content.list can span accessible clubs and filter by kinds with optional query', async () => {
  let capturedInput: ListEntitiesInput | null = null;

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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities(input) {
      capturedInput = input;
      return { results: [makeThreadSummary({ firstEntity: { ...makeEntity(), kind: 'ask' } })], hasMore: false, nextCursor: null };
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
  assert.equal(result.data.results[0]?.firstEntity.kind, 'ask');
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
      payload: { slug: 'gamma', name: 'Gamma', summary: 'Test club', ownerMemberId: 'member-9' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden');
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
      assert.equal(error.code, 'forbidden');
      return true;
    },
  );
});

test('profile.list returns 404 when the target member is outside shared scope', async () => {
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
    async listMemberProfiles() {
      return null;
    },
    async updateClubProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'profile.list',
        payload: {
          memberId: 'member-999',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'not_found');
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
          recipientMemberId: 'member-9',
          messageText: input.messageText,
          updateCount: 2,
        }),
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
    async listEntities() {
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
  assert.equal(result.data.message.updateCount, 2);
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
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
      assert.equal(error.code, 'not_found');
      return true;
    },
  );
});

test('messages.getInbox stays inside accessible scope and returns inbox summaries', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listDirectMessageInbox(input) {
      capturedInput = input as Record<string, unknown>;
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.getInbox',
    payload: { limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    limit: 4,
    unreadOnly: false,
    cursor: null,
  });
  assert.equal(result.action, 'messages.getInbox');
  assert.equal(result.data.unreadOnly, false);
  assert.ok(Array.isArray(result.data.results[0]?.sharedClubs));
  assert.equal(result.data.results[0]?.counterpartMemberId, 'member-2');
  assert.equal(result.data.results[0]?.unread.hasUnread, true);
});

test('messages.getInbox with unreadOnly returns thread-focused unread summaries inside actor scope', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.getInbox',
    payload: { limit: 4, unreadOnly: true },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    limit: 4,
    unreadOnly: true,
    cursor: null,
  });
  assert.equal(result.action, 'messages.getInbox');
  assert.equal(result.data.unreadOnly, true);
  assert.ok(Array.isArray(result.data.results[0]?.sharedClubs));
  assert.equal(result.data.results[0]?.unread.unreadMessageCount, 2);
  assert.equal(result.data.results[0]?.unread.unreadUpdateCount, 3);
});

test('messages.getThread scopes thread access server-side and returns DM entries', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
            inReplyToMessageId: 'message-1',
          }),
        ],
        hasMore: false,
        nextCursor: null,
      };
    },
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.getThread',
    payload: { threadId: 'thread-1', limit: 2 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    threadId: 'thread-1',
    limit: 2,
    cursor: null,
  });
  assert.equal(result.action, 'messages.getThread');
  assert.equal(result.data.thread.threadId, 'thread-1');
  assert.equal(result.data.messages.length, 2);
  assert.equal(result.data.messages[1]?.inReplyToMessageId, 'message-1');
  assert.equal(result.data.messages[0]?.messageText, 'Earlier');
  assert.equal(result.data.messages[1]?.messageText, 'Later');
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
        token: makeBearerTokenSummary({ tokenId: 'token-2', label: 'laptop', metadata: { device: 'mbp' } }),
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
    async listEntities() {
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
  assert.equal(result.data.token.tokenId, 'token-2');
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
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

test('notifications.list returns the paginated notification worklist', async () => {
  const capturedInputs: Record<string, unknown>[] = [];

  const repository: Repository = {
    ...makeRepository(),
    async listNotifications(input) {
      capturedInputs.push(input as Record<string, unknown>);
      if (input.after === null) {
        return {
          items: [],
          nextAfter: null,
        };
      }
      return {
        items: [
          makeNotificationItem({
            notificationId: 'synchronicity.ask_to_member:notification-9',
            createdAt: '2026-03-12T00:09:00Z',
            clubId: 'club-2',
          }),
        ],
        nextAfter: 'cursor-next',
      };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'notifications.list',
    payload: { after: 'test-cursor', limit: 3 },
  });

  assert.equal(capturedInputs.length, 2);
  assert.equal(capturedInputs[0]?.actorMemberId, 'member-1');
  assert.equal(capturedInputs[0]?.after, 'test-cursor');
  assert.equal(capturedInputs[0]?.limit, 3);
  assert.ok(Array.isArray(capturedInputs[0]?.accessibleClubIds));
  assert.ok(Array.isArray(capturedInputs[0]?.adminClubIds));
  assert.equal(capturedInputs[1]?.after, null, 'shared-context piggyback should still read the default head');
  assert.equal(result.action, 'notifications.list');
  assert.equal(result.data.items[0]?.notificationId, 'synchronicity.ask_to_member:notification-9');
  assert.equal(result.data.nextAfter, 'cursor-next');
});

test('notifications.acknowledge appends receipts and removes items from shared context', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeNotifications(input) {
      capturedInput = input as Record<string, unknown>;
      return [
        makeNotificationReceipt({
          notificationId: 'synchronicity.ask_to_member:notification-1',
          state: 'suppressed',
          suppressionReason: 'already handled elsewhere',
        }),
      ];
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result = await dispatcher.dispatch({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'notifications.acknowledge',
    payload: {
      notificationIds: ['synchronicity.ask_to_member:notification-1'],
      state: 'suppressed',
      suppressionReason: 'already handled elsewhere',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    notificationIds: ['synchronicity.ask_to_member:notification-1'],
    state: 'suppressed',
    suppressionReason: 'already handled elsewhere',
  });
  assert.equal(result.action, 'notifications.acknowledge');
  assert.deepEqual(result.actor.sharedContext.notifications, []);
  assert.equal(result.data.receipts[0]?.notificationId, 'synchronicity.ask_to_member:notification-1');
  assert.equal(result.data.receipts[0]?.state, 'suppressed');
});

test('notifications.acknowledge rejects derived notification IDs', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeNotifications() {
      return [];
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'notifications.acknowledge',
        payload: {
          notificationIds: ['application.submitted:membership-404'],
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, 'invalid_input');
      return true;
    },
  );
});

test('messages.getThread returns 404 when the thread is outside actor scope', async () => {
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
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
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
    async listEntities() {
      return { results: [makeEntity()], hasMore: false, nextCursor: null };
    },
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'messages.getThread',
        payload: {
          threadId: 'thread-404',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'not_found');
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
      assert.equal(error.code, 'unauthorized');
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
    feedback: 'Ambiguous response from LLM',
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
      return true;
    },
  );
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
          entityKind: 'post',
          isReply: false,
          title: null,
          summary: null,
          body: (input as { text: string }).text,
        };
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
      throw new AppError(400, 'invalid_input', 'preGate rejected this input');
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
