import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  buildApp,
  type ActorContext,
  type AuthResult,
  type CreateEntityInput,
  type DeliveryAcknowledgement,
  type EntitySummary,
  type EventSummary,
  type ListEntitiesInput,
  type ListEventsInput,
  type MemberProfile,
  type RsvpEventInput,
  type UpdateEntityInput,
  type MemberSearchResult,
  type PendingDelivery,
  type Repository,
  type UpdateOwnProfileInput,
} from '../src/app.ts';

function makeActor(): ActorContext {
  return {
    member: {
      id: 'member-1',
      handle: 'member-one',
      publicName: 'Member One',
    },
    memberships: [
      {
        membershipId: 'membership-1',
        networkId: 'network-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First network',
        manifestoMarkdown: null,
        role: 'member',
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
        role: 'member',
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
      pendingDeliveries: [makePendingDelivery()],
    },
  };
}

function makePendingDelivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    deliveryId: 'delivery-1',
    networkId: 'network-1',
    entityId: 'entity-1',
    entityVersionId: 'entity-version-1',
    transcriptMessageId: null,
    topic: 'entity.published',
    payload: { hello: 'world' },
    createdAt: '2026-03-12T00:00:00Z',
    sentAt: '2026-03-12T00:01:00Z',
    ...overrides,
  };
}

function makeDeliveryAcknowledgement(overrides: Partial<DeliveryAcknowledgement> = {}): DeliveryAcknowledgement {
  return {
    deliveryId: 'delivery-1',
    networkId: 'network-1',
    recipientMemberId: 'member-1',
    state: 'shown',
    suppressionReason: null,
    createdAt: '2026-03-12T00:02:00Z',
    createdByMemberId: 'member-1',
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
    async searchMembers() {
      return results;
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listEntities() {
      return [makeEntity()];
    },
  };
}

test('session.describe returns the current member and accessible networks', async () => {
  const app = buildApp({ repository: makeRepository() });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'session.describe',
  });

  assert.equal(result.action, 'session.describe');
  assert.equal(result.actor.member.id, 'member-1');
  assert.equal(result.data.member.id, 'member-1');
  assert.equal(result.data.accessibleNetworks.length, 2);
  assert.deepEqual(
    result.data.accessibleNetworks.map((network) => network.networkId),
    ['network-1', 'network-2'],
  );
  assert.equal(result.actor.sharedContext.pendingDeliveries.length, 1);
  assert.equal(result.actor.sharedContext.pendingDeliveries[0]?.deliveryId, 'delivery-1');
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
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

test('profile.get defaults to the actor member id', async () => {
  let capturedTargetMemberId: string | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listEntities() {
      return [makeEntity()];
    },
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listEntities() {
      return [makeEntity()];
    },
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

test('events.list stays inside accessible scope', async () => {
  let capturedInput: ListEventsInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'events.list',
    payload: { networkId: 'network-2', limit: 4 },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 4,
  });
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

test('entities.list can span accessible networks and filter by kinds', async () => {
  let capturedInput: ListEntitiesInput | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
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
      kinds: ['ask', 'service'],
      limit: 5,
    },
  });

  assert.deepEqual(capturedInput, {
    networkIds: ['network-1', 'network-2'],
    kinds: ['ask', 'service'],
    limit: 5,
  });
  assert.equal(result.action, 'entities.list');
  assert.equal(result.data.results[0]?.kind, 'ask');
  assert.deepEqual(result.actor.requestScope.activeNetworkIds, ['network-1', 'network-2']);
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
    async acknowledgeDelivery() {
      return makeDeliveryAcknowledgement();
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

test('deliveries.acknowledge derives scope server-side and removes the item from shared context', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
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
    async acknowledgeDelivery(input) {
      capturedInput = input as Record<string, unknown>;
      return makeDeliveryAcknowledgement({
        deliveryId: 'delivery-1',
        networkId: 'network-2',
        state: 'suppressed',
        suppressionReason: 'too noisy right now',
      });
    },
    async listEntities() {
      return [makeEntity()];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
    action: 'deliveries.acknowledge',
    payload: {
      deliveryId: 'delivery-1',
      state: 'suppressed',
      suppressionReason: 'too noisy right now',
      networkId: 'network-999',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-1', 'network-2'],
    deliveryId: 'delivery-1',
    state: 'suppressed',
    suppressionReason: 'too noisy right now',
  });
  assert.equal(result.action, 'deliveries.acknowledge');
  assert.equal(result.actor.requestScope.requestedNetworkId, 'network-2');
  assert.deepEqual(result.actor.sharedContext.pendingDeliveries, []);
  assert.equal(result.data.acknowledgement.state, 'suppressed');
  assert.equal(result.data.acknowledgement.suppressionReason, 'too noisy right now');
});

test('deliveries.acknowledge returns 404 when the delivery is outside actor scope', async () => {
  const repository: Repository = {
    async authenticateBearerToken() {
      return makeAuthResult();
    },
    async searchMembers() {
      return [];
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
    async acknowledgeDelivery() {
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
        action: 'deliveries.acknowledge',
        payload: {
          deliveryId: 'delivery-404',
          state: 'shown',
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
