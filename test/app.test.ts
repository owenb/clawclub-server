import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  buildApp,
  type ActorContext,
  type ApplicationSummary,
  type AuthResult,
  type CreateEntityInput,
  type BearerTokenSummary,
  type CreatedBearerToken,
  type ClaimedDelivery,
  type DeliveryAcknowledgement,
  type DeliverySummary,
  type ListDeliveriesInput,
  type DirectMessageSummary,
  type DirectMessageInboxSummary,
  type DirectMessageThreadSummary,
  type DirectMessageTranscriptEntry,
  type EntitySummary,
  type EventSummary,
  type ListEntitiesInput,
  type ListEventsInput,
  type MembershipAdminSummary,
  type MembershipReviewSummary,
  type MemberProfile,
  type NetworkMemberSummary,
  type NetworkSummary,
  type RsvpEventInput,
  type UpdateEntityInput,
  type MemberSearchResult,
  type PendingUpdate,
  type Repository,
  type UpdateReceipt,
  type UpdateOwnProfileInput,
} from '../src/app.ts';

function makeActor(): ActorContext {
  return {
    member: {
      id: 'member-1',
      handle: 'member-one',
      publicName: 'Member One',
    },
    globalRoles: ['superadmin'],
    memberships: [
      {
        membershipId: 'membership-1',
        networkId: 'network-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First network',
        manifestoMarkdown: null,
        role: 'admin',
        status: 'active',
        sponsorMemberId: 'member-2',
        joinedAt: '2026-03-12T00:00:00Z',
      },
      {
        membershipId: 'membership-2',
        networkId: 'network-2',
        slug: 'beta',
        name: 'Beta',
        summary: 'Second network',
        manifestoMarkdown: null,
        role: 'owner',
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
      requestedNetworkId: null,
      activeNetworkIds: actor.memberships.map((membership) => membership.networkId),
    },
    sharedContext: {
      pendingUpdates: [makePendingUpdate()],
    },
  };
}

function makePendingUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    updateId: 'update-1',
    streamSeq: 1,
    recipientMemberId: 'member-1',
    networkId: 'network-1',
    entityId: 'entity-1',
    entityVersionId: 'entity-version-1',
    transcriptMessageId: null,
    topic: 'entity.version.published',
    payload: { hello: 'world' },
    createdAt: '2026-03-12T00:00:00Z',
    createdByMemberId: 'member-2',
    ...overrides,
  };
}

function makeUpdateReceipt(overrides: Partial<UpdateReceipt> = {}): UpdateReceipt {
  return {
    receiptId: 'receipt-1',
    updateId: 'update-1',
    recipientMemberId: 'member-1',
    networkId: 'network-1',
    state: 'processed',
    suppressionReason: null,
    versionNo: 1,
    supersedesReceiptId: null,
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
    networkId: 'network-1',
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
    networkId: 'network-1',
    recipientMemberId: 'member-1',
    endpointId: 'endpoint-1',
    topic: 'transcript.message.created',
    payload: { kind: 'dm', threadId: 'thread-1' },
    status: 'sent',
    attemptCount: 1,
    entityId: null,
    entityVersionId: null,
    transcriptMessageId: 'message-1',
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
      networkId: 'network-1',
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
    networkId: 'network-1',
    senderMemberId: 'member-1',
    recipientMemberId: 'member-2',
    messageId: 'message-1',
    messageText: 'Hello there',
    createdAt: '2026-03-12T00:03:00Z',
    updateCount: 1,
    ...overrides,
  };
}

function makeDirectMessageThread(overrides: Partial<DirectMessageThreadSummary> = {}): DirectMessageThreadSummary {
  return {
    threadId: 'thread-1',
    networkId: 'network-1',
    counterpartMemberId: 'member-2',
    counterpartPublicName: 'Member Two',
    counterpartHandle: 'member-two',
    latestMessage: {
      messageId: 'message-1',
      senderMemberId: 'member-2',
      role: 'member',
      messageText: 'Hello there',
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
  overrides: Partial<DirectMessageTranscriptEntry> = {},
): DirectMessageTranscriptEntry {
  return {
    messageId: 'message-1',
    threadId: 'thread-1',
    senderMemberId: 'member-2',
    role: 'member',
    messageText: 'Hello there',
    payload: {},
    createdAt: '2026-03-12T00:03:00Z',
    inReplyToMessageId: null,
    updateReceipts: [],
    ...overrides,
  };
}

function makeNetwork(overrides: Partial<NetworkSummary> = {}): NetworkSummary {
  return {
    networkId: 'network-1',
    slug: 'alpha',
    name: 'Alpha',
    summary: 'First network',
    manifestoMarkdown: null,
    archivedAt: null,
    owner: {
      memberId: 'member-1',
      publicName: 'Member One',
      handle: 'member-one',
    },
    ownerVersion: {
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
    networkId: 'network-1',
    member: {
      memberId: 'member-9',
      publicName: 'Member Nine',
      handle: 'member-nine',
    },
    sponsor: {
      memberId: 'member-1',
      publicName: 'Member One',
      handle: 'member-one',
    },
    role: 'member',
    state: {
      status: 'invited',
      reason: 'Warm intro',
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

function makeMembershipReview(overrides: Partial<MembershipReviewSummary> = {}): MembershipReviewSummary {
  return {
    ...makeMembershipAdmin(),
    sponsorStats: {
      activeSponsoredCount: 1,
      sponsoredThisMonthCount: 2,
    },
    vouches: [
      {
        edgeId: 'edge-1',
        fromMember: {
          memberId: 'member-2',
          publicName: 'Member Two',
          handle: 'member-two',
        },
        reason: 'I trust their presence and follow-through.',
        metadata: { strength: 'warm' },
        createdAt: '2026-03-12T00:02:00Z',
        createdByMemberId: 'member-2',
      },
    ],
    ...overrides,
  };
}

function makeApplication(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    applicationId: 'application-1',
    networkId: 'network-2',
    applicant: {
      memberId: 'member-9',
      publicName: 'Member Nine',
      handle: 'member-nine',
      email: null,
    },
    sponsor: {
      memberId: 'member-1',
      publicName: 'Member One',
      handle: 'member-one',
    },
    membershipId: 'membership-9',
    activation: {
      linkedMembershipId: 'membership-9',
      membershipStatus: 'pending_review',
      acceptedCovenantAt: null,
      readyForActivation: false,
    },
    path: 'sponsored',
    intake: {
      kind: 'fit_check',
      price: { amount: 49, currency: 'GBP' },
      bookingUrl: 'https://cal.example.test/fit-check',
      bookedAt: '2026-03-14T10:00:00Z',
      completedAt: null,
    },
    state: {
      status: 'submitted',
      notes: 'Warm intro via sponsor',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
    },
    metadata: { source: 'operator' },
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeNetworkMember(overrides: Partial<NetworkMemberSummary> = {}): NetworkMemberSummary {
  return {
    memberId: 'member-1',
    publicName: 'Member One',
    displayName: 'Member One',
    handle: 'member-one',
    tagline: 'Building warm things',
    summary: 'Short summary',
    whatIDo: 'Engineering and facilitation',
    knownFor: 'Bringing people together',
    servicesSummary: 'Advisory and product strategy',
    websiteUrl: 'https://example.test',
    memberships: [makeActor().memberships[0]!],
    ...overrides,
  };
}

function makeProfile(memberId = 'member-1'): MemberProfile {
  return {
    memberId,
    publicName: memberId === 'member-1' ? 'Member One' : 'Member Two',
    handle: memberId === 'member-1' ? 'member-one' : 'member-two',
    displayName: memberId === 'member-1' ? 'Member One' : 'Member Two',
    tagline: 'Building warm things',
    summary: 'Short summary',
    whatIDo: 'Engineering and facilitation',
    knownFor: 'Bringing people together',
    servicesSummary: 'Advisory and product strategy',
    websiteUrl: 'https://example.test',
    links: [{ label: 'Site', url: 'https://example.test' }],
    profile: { homeBase: 'Lisbon' },
    version: {
      id: 'profile-version-1',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: memberId,
      embedding: null,
    },
    sharedNetworks: [{ id: 'network-1', slug: 'alpha', name: 'Alpha' }],
  };
}

function makeEntity(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    entityId: 'entity-1',
    entityVersionId: 'entity-version-1',
    networkId: 'network-1',
    kind: 'post',
    author: {
      memberId: 'member-1',
      publicName: 'Member One',
      handle: 'member-one',
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
      content: {},
      embedding: null,
      ...(overrides.version ?? {}),
    },
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    entityId: 'event-1',
    entityVersionId: 'event-version-1',
    networkId: 'network-1',
    author: {
      memberId: 'member-1',
      publicName: 'Member One',
      handle: 'member-one',
      ...(overrides.author ?? {}),
    },
    version: {
      versionNo: 1,
      state: 'published',
      title: 'Dinner',
      summary: 'Shared meal',
      body: 'Let us gather.',
      startsAt: '2026-03-20T19:00:00Z',
      endsAt: '2026-03-20T21:00:00Z',
      timezone: 'UTC',
      recurrenceRule: null,
      capacity: 8,
      effectiveAt: '2026-03-12T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T00:00:00Z',
      content: {},
      ...(overrides.version ?? {}),
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

function makeRepository(results: MemberSearchResult[] = []): Repository {
  return {
    async authenticateBearerToken(bearerToken: string) {
      if (bearerToken !== 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs') {
        return null;
      }

      return makeAuthResult();
    },
    async listNetworks() {
      return [makeNetwork()];
    },
    async createNetwork() {
      return makeNetwork();
    },
    async archiveNetwork() {
      return makeNetwork({ archivedAt: '2026-03-12T01:00:00Z' });
    },
    async assignNetworkOwner() {
      return makeNetwork({
        owner: { memberId: 'member-9', publicName: 'Member Nine', handle: 'member-nine' },
        ownerVersion: { versionNo: 2, createdAt: '2026-03-12T01:00:00Z', createdByMemberId: 'member-1' },
      });
    },
    async listMemberships() {
      return [makeMembershipAdmin()];
    },
    async listApplications() {
      return [makeApplication()];
    },
    async createApplication() {
      return makeApplication();
    },
    async transitionApplication() {
      return makeApplication({ state: { ...makeApplication().state, status: 'interview_scheduled', versionNo: 2 } });
    },
    async createMembership() {
      return makeMembershipAdmin();
    },
    async transitionMembershipState() {
      return makeMembershipAdmin({ state: { ...makeMembershipAdmin().state, status: 'active', versionNo: 2 } });
    },
    async listMembershipReviews() {
      return [makeMembershipReview()];
    },
    async searchMembers() {
      return results;
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile({ targetMemberId }) {
      return makeProfile(targetMemberId);
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };
}

test('session.describe returns the canonical actor session envelope once', async () => {
  const app = buildApp({ repository: makeRepository() });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'session.describe',
  });

  assert.equal(result.action, 'session.describe');
  assert.equal(result.actor.member.id, 'member-1');
  assert.deepEqual(result.actor.globalRoles, ['superadmin']);
  assert.equal(result.actor.activeMemberships.length, 2);
  assert.deepEqual(
    result.actor.activeMemberships.map((network) => network.networkId),
    ['network-1', 'network-2'],
  );
  assert.deepEqual(result.data, {});
  assert.equal(result.actor.sharedContext.pendingUpdates.length, 1);
  assert.equal(result.actor.sharedContext.pendingUpdates[0]?.updateId, 'update-1');
});

test('networks.list requires superadmin and returns archived flag filter', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listNetworks(input) {
      capturedInput = input as Record<string, unknown>;
      return [makeNetwork({ archivedAt: '2026-03-12T01:00:00Z' })];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'networks.list',
    payload: { includeArchived: true },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    includeArchived: true,
  });
  assert.equal(result.data.networks[0]?.archivedAt, '2026-03-12T01:00:00Z');
});

test('networks.create derives superadmin ownership assignment server-side', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async createNetwork(input) {
      capturedInput = input as Record<string, unknown>;
      return makeNetwork({
        networkId: 'network-9',
        slug: 'gamma',
        name: 'Gamma',
        owner: { memberId: 'member-9', publicName: 'Member Nine', handle: 'member-nine' },
      });
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'networks.create',
    payload: {
      slug: 'gamma',
      name: 'Gamma',
      summary: 'Third network',
      ownerMemberId: 'member-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    slug: 'gamma',
    name: 'Gamma',
    summary: 'Third network',
    manifestoMarkdown: undefined,
    ownerMemberId: 'member-9',
  });
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-9');
  assert.equal(result.data.network.owner.memberId, 'member-9');
});

test('networks.assignOwner appends a new owner version via the superadmin surface', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async assignNetworkOwner(input) {
      capturedInput = input as Record<string, unknown>;
      return makeNetwork({
        networkId: 'network-2',
        owner: { memberId: 'member-9', publicName: 'Member Nine', handle: 'member-nine' },
        ownerVersion: { versionNo: 2, createdAt: '2026-03-12T01:00:00Z', createdByMemberId: 'member-1' },
      });
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'networks.assignOwner',
    payload: {
      networkId: 'network-2',
      ownerMemberId: 'member-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkId: 'network-2',
    ownerMemberId: 'member-9',
  });
  assert.equal(result.data.network.owner.memberId, 'member-9');
  assert.equal(result.data.network.ownerVersion.versionNo, 2);
});

test('memberships.list stays inside owner network scope and can filter by status', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listMemberships(input) {
      capturedInput = input as Record<string, unknown>;
      return [makeMembershipAdmin({ networkId: 'network-2', state: { ...makeMembershipAdmin().state, status: 'pending_review' } })];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'memberships.list',
    payload: { networkId: 'network-2', status: 'pending_review', limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
    status: 'pending_review',
  });
  assert.equal(result.action, 'memberships.list');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.equal(result.data.results[0]?.state.status, 'pending_review');
});

test('memberships.list rejects admin-only network membership', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'memberships.list',
      payload: { networkId: 'network-1', limit: 4 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden');
      assert.match(error.message, /owner membership/);
      return true;
    },
  );
});

test('memberships.review defaults to admissions-focused statuses and returns sponsor/vouch context', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listMembershipReviews(input) {
      capturedInput = input as unknown as Record<string, unknown>;
      return [makeMembershipReview()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'memberships.review',
    payload: {
      networkId: 'network-2',
      limit: 3,
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 3,
    statuses: ['invited', 'pending_review'],
  });
  assert.equal(result.action, 'memberships.review');
  assert.equal(result.data.results[0]?.sponsorStats.sponsoredThisMonthCount, 2);
  assert.equal(result.data.results[0]?.vouches[0]?.fromMember.memberId, 'member-2');
});

test('memberships.create derives scope server-side and preserves sponsor semantics', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async createMembership(input) {
      capturedInput = input as Record<string, unknown>;
      return makeMembershipAdmin({
        membershipId: 'membership-10',
        networkId: 'network-2',
        member: { memberId: 'member-9', publicName: 'Member Nine', handle: 'member-nine' },
        sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
        state: { ...makeMembershipAdmin().state, status: 'invited' },
      });
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'memberships.create',
    payload: {
      networkId: 'network-2',
      memberId: 'member-9',
      sponsorMemberId: 'member-1',
      initialStatus: 'invited',
      reason: 'Trusted intro',
      metadata: { source: 'operator' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkId: 'network-2',
    memberId: 'member-9',
    sponsorMemberId: 'member-1',
    role: 'member',
    initialStatus: 'invited',
    reason: 'Trusted intro',
    metadata: { source: 'operator' },
  });
  assert.equal(result.action, 'memberships.create');
  assert.equal(result.data.membership.sponsor.memberId, 'member-1');
  assert.equal(result.data.membership.state.status, 'invited');
});

test('memberships.transition appends a new membership state version inside owner scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async transitionMembershipState(input) {
      capturedInput = input as Record<string, unknown>;
      return makeMembershipAdmin({
        membershipId: 'membership-10',
        networkId: 'network-2',
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

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'memberships.transition',
    payload: {
      membershipId: 'membership-10',
      status: 'active',
      reason: 'Fit check complete',
      networkId: 'network-999',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    membershipId: 'membership-10',
    nextStatus: 'active',
    reason: 'Fit check complete',
    accessibleNetworkIds: ['network-2'],
  });
  assert.equal(result.action, 'memberships.transition');
  assert.equal(result.data.membership.state.versionNo, 2);
  assert.equal(result.data.membership.state.status, 'active');
});

test('memberships.transition rejects admin-only network scope', async () => {
  const actor = makeActor();
  actor.memberships = [actor.memberships[0]!];

  const app = buildApp({
    repository: {
      ...makeRepository(),
      async authenticateBearerToken() {
        return {
          actor,
          requestScope: {
            requestedNetworkId: null,
            activeNetworkIds: actor.memberships.map((membership) => membership.networkId),
          },
          sharedContext: { pendingUpdates: [makePendingUpdate()] },
        };
      },
      async transitionMembershipState(input) {
        assert.deepEqual(input.accessibleNetworkIds, []);
        return null;
      },
    },
  });

  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'memberships.transition',
      payload: {
        membershipId: 'membership-10',
        status: 'active',
        reason: 'Fit check complete',
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'not_found');
      assert.match(error.message, /owner scope/);
      return true;
    },
  );
});

test('applications.list stays inside owner scope and can filter interview workflow statuses', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listApplications(input) {
      capturedInput = input as Record<string, unknown>;
      return [makeApplication({ state: { ...makeApplication().state, status: 'interview_scheduled', versionNo: 2 } })];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'applications.list',
    payload: { networkId: 'network-2', statuses: ['submitted', 'interview_scheduled'], limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
    statuses: ['submitted', 'interview_scheduled'],
  });
  assert.equal(result.action, 'applications.list');
  assert.equal(result.data.results[0]?.state.status, 'interview_scheduled');
});

test('applications.create captures a sponsored fit-check intake and owner scope server-side', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async createApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return makeApplication({
        applicationId: 'application-9',
        applicant: { memberId: 'member-9', publicName: 'Member Nine', handle: 'member-nine' },
        sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
        state: { ...makeApplication().state, status: 'submitted' },
      });
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'applications.create',
    payload: {
      networkId: 'network-2',
      applicantMemberId: 'member-9',
      sponsorMemberId: 'member-1',
      membershipId: 'membership-9',
      path: 'sponsored',
      initialStatus: 'submitted',
      notes: 'Warm intro via sponsor',
      intake: {
        kind: 'fit_check',
        price: { amount: 49, currency: 'gbp' },
        bookingUrl: 'https://cal.example.test/fit-check',
        bookedAt: '2026-03-14T10:00:00Z',
      },
      metadata: { source: 'operator' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkId: 'network-2',
    applicantMemberId: 'member-9',
    sponsorMemberId: 'member-1',
    membershipId: 'membership-9',
    path: 'sponsored',
    initialStatus: 'submitted',
    notes: 'Warm intro via sponsor',
    intake: {
      kind: 'fit_check',
      price: { amount: 49, currency: 'GBP' },
      bookingUrl: 'https://cal.example.test/fit-check',
      bookedAt: '2026-03-14T10:00:00Z',
      completedAt: undefined,
    },
    metadata: { source: 'operator' },
  });
  assert.equal(result.action, 'applications.create');
  assert.equal(result.data.application.applicationId, 'application-9');
});

test('applications.transition can append accepted interview state and activate the linked membership', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async transitionApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return makeApplication({
        state: {
          status: 'accepted',
          notes: 'Interview complete and accepted',
          versionNo: 3,
          createdAt: '2026-03-12T00:05:00Z',
          createdByMemberId: 'member-1',
        },
        membershipId: 'membership-10',
        activation: {
          linkedMembershipId: 'membership-10',
          membershipStatus: 'active',
          acceptedCovenantAt: null,
          readyForActivation: false,
        },
        intake: {
          kind: 'fit_check',
          price: { amount: 49, currency: 'GBP' },
          bookingUrl: 'https://cal.example.test/fit-check',
          bookedAt: '2026-03-14T10:00:00Z',
          completedAt: '2026-03-14T10:30:00Z',
        },
        metadata: { source: 'operator', outcome: 'strong_yes' },
      });
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'applications.transition',
    payload: {
      applicationId: 'application-9',
      status: 'accepted',
      notes: 'Interview complete and accepted',
      membershipId: 'membership-10',
      activateMembership: true,
      activationReason: 'Interview passed and owner approved',
      intake: { completedAt: '2026-03-14T10:30:00Z' },
      metadata: { outcome: 'strong_yes' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    applicationId: 'application-9',
    nextStatus: 'accepted',
    notes: 'Interview complete and accepted',
    accessibleNetworkIds: ['network-2'],
    intake: {
      kind: undefined,
      price: undefined,
      bookingUrl: undefined,
      bookedAt: undefined,
      completedAt: '2026-03-14T10:30:00Z',
    },
    membershipId: 'membership-10',
    activateMembership: true,
    activationReason: 'Interview passed and owner approved',
    metadataPatch: { outcome: 'strong_yes' },
  });
  assert.equal(result.action, 'applications.transition');
  assert.equal(result.data.application.state.versionNo, 3);
  assert.equal(result.data.application.membershipId, 'membership-10');
  assert.deepEqual(result.data.application.activation, {
    linkedMembershipId: 'membership-10',
    membershipStatus: 'active',
    acceptedCovenantAt: null,
    readyForActivation: false,
  });
});

test('applications.challenge creates a cold application challenge without a bearer token', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      throw new Error('authenticateBearerToken should not run for cold application actions');
    },
    async createColdApplicationChallenge() {
      return {
        challengeId: 'challenge-1',
        difficulty: 7,
        expiresAt: '2026-03-15T13:00:00.000Z',
        clubs: [{ slug: 'alpha', name: 'Alpha Club', summary: 'A test club' }],
      };
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: null,
    action: 'applications.challenge',
  });

  assert.equal(result.action, 'applications.challenge');
  assert.equal(result.data.challengeId, 'challenge-1');
  assert.equal(result.data.difficulty, 7);
  assert.equal(result.data.clubs.length, 1);
  assert.equal(result.data.clubs[0].slug, 'alpha');
  assert.equal('actor' in result, false);
});

test('applications.solve submits a cold application with all required fields', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken() {
      throw new Error('authenticateBearerToken should not run for cold application actions');
    },
    async solveColdApplicationChallenge(input) {
      capturedInput = input as Record<string, unknown>;
      return { success: true };
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: null,
    action: 'applications.solve',
    payload: {
      challengeId: 'challenge-1',
      nonce: '183729471',
      networkSlug: 'alpha',
      name: 'Jane Doe',
      email: 'Jane@Example.com',
      socials: '@janedoe',
      reason: 'Love the community',
    },
  });

  assert.deepEqual(capturedInput, {
    challengeId: 'challenge-1',
    nonce: '183729471',
    networkSlug: 'alpha',
    name: 'Jane Doe',
    email: 'jane@example.com',
    socials: '@janedoe',
    reason: 'Love the community',
  });
  assert.equal(result.action, 'applications.solve');
  assert.equal(result.data.message, 'Application submitted. Watch your email — you will hear back soon.');
  assert.equal('actor' in result, false);
});

test('members.search narrows scope when a permitted network is requested', async () => {
  let capturedNetworkIds: string[] = [];

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers({ networkIds }) {
      capturedNetworkIds = networkIds;
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'members.search',
    payload: {
      query: 'Chris',
      networkId: 'network-2',
      limit: 3,
    },
  });

  assert.equal(result.action, 'members.search');
  assert.deepEqual(capturedNetworkIds, ['network-2']);
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.equal(result.data.networkScope.length, 1);
  assert.equal(result.data.networkScope[0]?.networkId, 'network-2');
});

test('members.list returns active members with scoped membership context', async () => {
  let capturedInput: { actorMemberId: string; networkIds: string[]; limit: number } | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers(input) {
      capturedInput = input;
      return [
        makeNetworkMember({
          memberId: 'member-2',
          publicName: 'Member Two',
          displayName: 'Member Two',
          handle: 'member-two',
          memberships: [makeActor().memberships[1]!],
        }),
      ];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'members.list',
    payload: {
      networkId: 'network-2',
      limit: 4,
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
  });
  assert.equal(result.action, 'members.list');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-2']);
  assert.equal(result.data.results[0]?.memberId, 'member-2');
  assert.equal(result.data.results[0]?.memberships[0]?.networkId, 'network-2');
});

test('profile.get defaults to the actor member id', async () => {
  let capturedTargetMemberId: string | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile({ targetMemberId }) {
      capturedTargetMemberId = targetMemberId;
      return makeProfile(targetMemberId);
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'profile.get',
  });

  assert.equal(result.action, 'profile.get');
  assert.equal(capturedTargetMemberId, 'member-1');
  assert.equal(result.data.memberId, 'member-1');
});

test('profile.update normalizes nullable strings and handle changes', async () => {
  let capturedPatch: UpdateOwnProfileInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile({ patch }) {
      capturedPatch = patch;
      return {
        ...makeProfile(),
        handle: patch.handle ?? 'member-one',
        displayName: patch.displayName ?? 'Member One',
        tagline: patch.tagline ?? null,
        links: patch.links ?? [],
        profile: (patch.profile as Record<string, unknown> | undefined) ?? {},
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'profile.update',
    payload: {
      handle: 'member-one-updated',
      displayName: 'Member One Updated',
      tagline: '  ',
      links: [{ label: 'GitHub', url: 'https://github.com/example' }],
      profile: { homeBase: 'Berlin' },
    },
  });

  assert.equal(result.action, 'profile.update');
  assert.deepEqual(capturedPatch, {
    handle: 'member-one-updated',
    displayName: 'Member One Updated',
    tagline: null,
    summary: undefined,
    whatIDo: undefined,
    knownFor: undefined,
    servicesSummary: undefined,
    websiteUrl: undefined,
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
    profile: { homeBase: 'Berlin' },
  });
  assert.equal(result.actor.member.handle, 'member-one-updated');
  assert.equal(result.data.handle, 'member-one-updated');
});

test('entities.create uses one shared flow for post/ask/service/opportunity kinds', async () => {
  let capturedInput: CreateEntityInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
      return makeProfile();
    },
    async createEntity(input) {
      capturedInput = input;
      return {
        ...makeEntity(),
        networkId: input.networkId,
        kind: input.kind,
        version: {
          ...makeEntity().version,
          title: input.title,
          summary: input.summary,
          body: input.body,
          expiresAt: input.expiresAt,
          content: input.content,
        },
      };
    },
    async updateEntity() {
      return makeEntity();
    },
    async createEvent() {
      return makeEvent();
    },
    async listEvents() {
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
    async getQuotaStatus() { return []; },

  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'entities.create',
    payload: {
      networkId: 'network-2',
      kind: 'service',
      title: 'Debugging help',
      summary: 'Fast TypeScript debugging',
      body: 'Can help unblock hairy backend issues.',
      expiresAt: '2026-04-01T00:00:00Z',
      content: { priceHint: '£120/hour' },
    },
  });

  assert.deepEqual(capturedInput, {
    authorMemberId: 'member-1',
    networkId: 'network-2',
    kind: 'service',
    title: 'Debugging help',
    summary: 'Fast TypeScript debugging',
    body: 'Can help unblock hairy backend issues.',
    expiresAt: '2026-04-01T00:00:00Z',
    content: { priceHint: '£120/hour' },
  });
  assert.equal(result.action, 'entities.create');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-2']);
  assert.equal(result.data.entity.kind, 'service');
});

test('entities.update appends a new version on the shared entity surface', async () => {
  let capturedInput: UpdateEntityInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity(input) {
      capturedInput = input;
      return makeEntity({
        entityVersionId: 'entity-version-2',
        networkId: 'network-2',
        version: {
          ...makeEntity().version,
          versionNo: 2,
          title: input.patch.title ?? null,
          summary: input.patch.summary ?? null,
          body: input.patch.body ?? null,
          expiresAt: input.patch.expiresAt ?? null,
          content: input.patch.content ?? {},
        },
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'entities.update',
    payload: {
      entityId: 'entity-1',
      title: 'Hello again',
      summary: '  ',
      content: { mood: 'fresh' },
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1', 'network-2'],
    entityId: 'entity-1',
    patch: {
      title: 'Hello again',
      summary: null,
      body: undefined,
      expiresAt: undefined,
      content: { mood: 'fresh' },
    },
  });
  assert.equal(result.action, 'entities.update');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-2']);
  assert.equal(result.data.entity.entityVersionId, 'entity-version-2');
  assert.equal(result.data.entity.version.versionNo, 2);
});

test('entities.archive appends an archived version on the shared entity surface', async () => {
  let capturedInput: { actorMemberId: string; accessibleNetworkIds: string[]; entityId: string } | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
      return makeEntity();
    },
    async archiveEntity(input) {
      capturedInput = input;
      return makeEntity({
        entityVersionId: 'entity-version-3',
        networkId: 'network-2',
        version: {
          ...makeEntity().version,
          versionNo: 3,
          state: 'archived',
          effectiveAt: '2026-03-12T01:00:00Z',
          expiresAt: '2026-03-12T01:00:00Z',
          createdAt: '2026-03-12T01:00:00Z',
        },
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'entities.archive',
    payload: {
      entityId: 'entity-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1', 'network-2'],
    entityId: 'entity-1',
  });
  assert.equal(result.action, 'entities.archive');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-2']);
  assert.equal(result.data.entity.entityVersionId, 'entity-version-3');
  assert.equal(result.data.entity.version.versionNo, 3);
  assert.equal(result.data.entity.version.state, 'archived');
});

test('entities.update rejects empty patches', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'entities.update',
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

test('entities.update rejects non-author updates', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
      return makeEntity({
        author: {
          memberId: 'member-2',
          publicName: 'Member Two',
          handle: 'member-two',
        },
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'entities.update',
        payload: {
          entityId: 'entity-1',
          body: 'Nope',
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

test('events.create writes the smallest sane event payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
      return makeProfile();
    },
    async createEntity() {
      return makeEntity();
    },
    async updateEntity() {
      return makeEntity();
    },
    async createEvent(input) {
      capturedInput = input as Record<string, unknown>;
      return makeEvent({ networkId: input.networkId, version: { ...makeEvent().version, title: input.title, capacity: input.capacity } });
    },
    async listEvents() {
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
    async getQuotaStatus() { return []; },

  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.create',
    payload: {
      networkId: 'network-2',
      title: 'Supper club',
      startsAt: '2026-03-20T19:00:00Z',
      endsAt: '2026-03-20T21:00:00Z',
      timezone: 'UTC',
      capacity: 12,
      content: { locationHint: 'Hackney' },
    },
  });

  assert.deepEqual(capturedInput, {
    authorMemberId: 'member-1',
    networkId: 'network-2',
    title: 'Supper club',
    summary: null,
    body: null,
    startsAt: '2026-03-20T19:00:00Z',
    endsAt: '2026-03-20T21:00:00Z',
    timezone: 'UTC',
    recurrenceRule: null,
    capacity: 12,
    expiresAt: null,
    content: { locationHint: 'Hackney' },
  });
  assert.equal(result.action, 'events.create');
  assert.equal(result.data.event.networkId, 'network-2');
});

test('events.list stays inside accessible scope and forwards optional query', async () => {
  let capturedInput: ListEventsInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent({ networkId: 'network-2' })];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.list',
    payload: { networkId: 'network-2', query: 'hetzner', limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
    query: 'hetzner',
  });
  assert.equal(result.data.query, 'hetzner');
  assert.equal(result.data.results[0]?.networkId, 'network-2');
});

test('events.rsvp uses the actor membership in the event network', async () => {
  let capturedInput: RsvpEventInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
    },
    async rsvpEvent(input) {
      capturedInput = input;
      return makeEvent({
        networkId: 'network-2',
        rsvps: {
          viewerResponse: 'yes',
          counts: { yes: 1, maybe: 0, no: 0, waitlist: 0 },
          attendees: [
            {
              membershipId: 'membership-2',
              memberId: 'member-1',
              publicName: 'Member One',
              handle: 'member-one',
              response: 'yes',
              note: 'I am in',
              createdAt: '2026-03-12T00:00:00Z',
            },
          ],
        },
      });
    },
    async sendDirectMessage() {
      return makeDirectMessage();
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
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
      { membershipId: 'membership-1', networkId: 'network-1' },
      { membershipId: 'membership-2', networkId: 'network-2' },
    ],
  });
  assert.equal(result.action, 'events.rsvp');
  assert.equal(result.data.event.rsvps.viewerResponse, 'yes');
});

test('entities.list can span accessible networks and filter by kinds with optional query', async () => {
  let capturedInput: ListEntitiesInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
    },
    async rsvpEvent() {
      return makeEvent();
    },
    async listEntities(input) {
      capturedInput = input;
      return [{ ...makeEntity(), kind: 'ask' }];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'entities.list',
    payload: {
      query: 'backend',
      kinds: ['ask', 'service'],
      limit: 5,
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-1', 'network-2'],
    kinds: ['ask', 'service'],
    limit: 5,
    query: 'backend',
  });
  assert.equal(result.action, 'entities.list');
  assert.equal(result.data.query, 'backend');
  assert.equal(result.data.results[0]?.kind, 'ask');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-1', 'network-2']);
});

test('networks.create rejects non-superadmins', async () => {
  const actor = makeActor();
  actor.globalRoles = [];
  const app = buildApp({
    repository: {
      ...makeRepository(),
      async authenticateBearerToken() {
        return {
          actor,
          requestScope: { requestedNetworkId: null, activeNetworkIds: actor.memberships.map((membership) => membership.networkId) },
          sharedContext: { pendingUpdates: [makePendingUpdate()] },
        };
      },
    },
  });

  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'networks.create',
      payload: { slug: 'gamma', name: 'Gamma', ownerMemberId: 'member-9' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden');
      return true;
    },
  );
});

test('members.search rejects a network outside the actor scope', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'members.search',
        payload: {
          query: 'Chris',
          networkId: 'network-999',
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

test('profile.get returns 404 when the target member is outside shared scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return null;
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'profile.get',
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

test('profile.update rejects invalid handles', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'profile.update',
        payload: {
          handle: 'Bad Handle',
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

test('messages.send picks a shared network, appends the request scope, and returns update metadata', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return makeDirectMessage({
        networkId: 'network-2',
        recipientMemberId: 'member-9',
        messageText: input.messageText,
        updateCount: 2,
      });
    },
    async listDirectMessageThreads() {
      return [makeDirectMessageThread()];
    },
    async listDirectMessageInbox() {
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
    async getQuotaStatus() { return []; },

  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.send',
    payload: {
      recipientMemberId: 'member-9',
      networkId: 'network-2',
      messageText: 'Hello from the network edge',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1', 'network-2'],
    recipientMemberId: 'member-9',
    networkId: 'network-2',
    messageText: 'Hello from the network edge',
  });
  assert.equal(result.action, 'messages.send');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-2']);
  assert.equal(result.data.message.updateCount, 2);
  assert.equal(result.data.message.messageText, 'Hello from the network edge');
});

test('messages.send returns 404 when the recipient is outside shared scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
    async getQuotaStatus() { return []; },

  };

  const app = buildApp({ repository });

  await assert.rejects(
    () =>
      app.handleAction({
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

test('messages.list stays inside accessible scope and returns dm thread summaries', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
    async listDirectMessageThreads(input) {
      capturedInput = input as Record<string, unknown>;
      return [makeDirectMessageThread({ networkId: 'network-2' })];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.list',
    payload: { networkId: 'network-2', limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
  });
  assert.equal(result.action, 'messages.list');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.equal(result.data.results[0]?.networkId, 'network-2');
  assert.equal(result.data.results[0]?.counterpartMemberId, 'member-2');
});

test('messages.inbox returns thread-focused unread summaries inside actor scope', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
    async listDirectMessageInbox(input) {
      capturedInput = input as Record<string, unknown>;
      return [
        makeDirectMessageInbox({
          networkId: 'network-2',
          unread: {
            hasUnread: true,
            unreadMessageCount: 2,
            unreadUpdateCount: 3,
            latestUnreadMessageCreatedAt: '2026-03-12T00:04:00Z',
          },
        }),
      ];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.inbox',
    payload: { networkId: 'network-2', limit: 4, unreadOnly: true },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
    unreadOnly: true,
  });
  assert.equal(result.action, 'messages.inbox');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.equal(result.data.unreadOnly, true);
  assert.equal(result.data.results[0]?.networkId, 'network-2');
  assert.equal(result.data.results[0]?.unread.unreadMessageCount, 2);
  assert.equal(result.data.results[0]?.unread.unreadUpdateCount, 3);
});

test('messages.read scopes thread access server-side and returns transcript entries', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
        thread: makeDirectMessageThread({ networkId: 'network-2' }),
        messages: [
          makeDirectMessageTranscriptEntry({
            messageId: 'message-1',
            createdAt: '2026-03-12T00:01:00Z',
            messageText: 'Earlier',
            updateReceipts: [
              {
                updateId: 'update-1',
                recipientMemberId: 'member-1',
                topic: 'transcript.message.created',
                createdAt: '2026-03-12T00:01:00Z',
                receipt: {
                  receiptId: 'receipt-1',
                  state: 'processed',
                  suppressionReason: null,
                  versionNo: 1,
                  createdAt: '2026-03-12T00:01:20Z',
                  createdByMemberId: 'member-1',
                },
              },
            ],
          }),
          makeDirectMessageTranscriptEntry({
            messageId: 'message-2',
            createdAt: '2026-03-12T00:02:00Z',
            senderMemberId: 'member-1',
            messageText: 'Later',
            inReplyToMessageId: 'message-1',
            updateReceipts: [
              {
                updateId: 'update-2',
                recipientMemberId: 'member-2',
                topic: 'transcript.message.created',
                createdAt: '2026-03-12T00:02:00Z',
                receipt: null,
              },
            ],
          }),
        ],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'messages.read',
    payload: { threadId: 'thread-1', limit: 2 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1', 'network-2'],
    threadId: 'thread-1',
    limit: 2,
  });
  assert.equal(result.action, 'messages.read');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.equal(result.data.thread.threadId, 'thread-1');
  assert.equal(result.data.messages.length, 2);
  assert.equal(result.data.messages[1]?.inReplyToMessageId, 'message-1');
  assert.equal(result.data.messages[0]?.updateReceipts[0]?.receipt?.state, 'processed');
  assert.equal(result.data.messages[1]?.updateReceipts[0]?.recipientMemberId, 'member-2');
});

test('tokens.list returns the actor token inventory', async () => {
  const app = buildApp({ repository: makeRepository() });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'tokens.list',
  });

  assert.equal(result.action, 'tokens.list');
  assert.equal(result.data.tokens.length, 1);
  assert.equal(result.data.tokens[0]?.tokenId, 'token-1');
});

test('tokens.create mints a new bearer token for the actor member', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
    async getQuotaStatus() { return []; },

  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'tokens.create',
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
  assert.equal(result.action, 'tokens.create');
  assert.equal(result.data.token.tokenId, 'token-2');
  assert.equal(result.data.bearerToken, 'cc_live_3456789abcde_3456789abcdefghjkmnpqrst');
});

test('tokens.revoke only revokes actor-owned tokens', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeDirectMessageInbox()];
    },
    async readDirectMessageThread() {
      return {
        thread: makeDirectMessageThread(),
        messages: [makeDirectMessageTranscriptEntry()],
      };
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'tokens.revoke',
    payload: {
      tokenId: 'token-9',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    tokenId: 'token-9',
  });
  assert.equal(result.action, 'tokens.revoke');
  assert.equal(result.data.token.tokenId, 'token-9');
  assert.equal(result.data.token.revokedAt, '2026-03-12T01:00:00Z');
});

test('updates.list returns the pending update feed with cursor semantics', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async listMemberUpdates(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        items: [
          makePendingUpdate({
            updateId: 'update-9',
            streamSeq: 9,
            networkId: 'network-2',
          }),
        ],
        nextAfter: 9,
        polledAt: '2026-03-12T00:05:00Z',
      };
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.list',
    payload: { after: 4, limit: 3 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    after: 4,
    limit: 3,
  });
  assert.equal(result.action, 'updates.list');
  assert.equal(result.data.updates.items[0]?.updateId, 'update-9');
  assert.equal(result.data.updates.nextAfter, 9);
});

test('updates.acknowledge appends receipts and removes items from shared context', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeUpdates(input) {
      capturedInput = input as Record<string, unknown>;
      return [
        makeUpdateReceipt({
          updateId: 'update-1',
          state: 'suppressed',
          suppressionReason: 'already handled elsewhere',
        }),
      ];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'updates.acknowledge',
    payload: {
      updateIds: ['update-1'],
      state: 'suppressed',
      suppressionReason: 'already handled elsewhere',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    updateIds: ['update-1'],
    state: 'suppressed',
    suppressionReason: 'already handled elsewhere',
  });
  assert.equal(result.action, 'updates.acknowledge');
  assert.deepEqual(result.actor.sharedContext.pendingUpdates, []);
  assert.equal(result.data.receipts[0]?.updateId, 'update-1');
  assert.equal(result.data.receipts[0]?.state, 'suppressed');
});

test('updates.acknowledge returns 404 when an update is outside actor scope', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async acknowledgeUpdates() {
      return [];
    },
  };

  const app = buildApp({ repository });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'updates.acknowledge',
        payload: {
          updateIds: ['update-404'],
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

test('messages.read returns 404 when the thread is outside actor scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
    },
    async listMembers() {
      return [makeNetworkMember()];
    },
    async getMemberProfile() {
      return makeProfile();
    },
    async updateOwnProfile() {
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
      return [makeEvent()];
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
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
        action: 'messages.read',
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

test('session.describe rejects unknown bearer tokens', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        bearerToken: 'cc_live_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb',
        action: 'session.describe',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'unauthorized');
      return true;
    },
  );
});
