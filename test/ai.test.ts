import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClawClubAiTools,
  CLAWCLUB_OPENAI_MODEL,
  createClawClubOpenAIProvider,
  listCanonicalClawClubTools,
} from '../src/ai.ts';
import type { AuthResult, Repository } from '../src/app.ts';

function makeAuthResult(): AuthResult {
  return {
    actor: {
      member: {
        id: 'member-1',
        handle: 'member-one',
        publicName: 'Member One',
      },
      globalRoles: [],
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
          sponsorMemberId: null,
          joinedAt: '2026-03-12T00:00:00Z',
        },
      ],
    },
    requestScope: {
      requestedNetworkId: null,
      activeNetworkIds: ['network-1'],
    },
    sharedContext: {
      pendingDeliveries: [],
    },
  };
}

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listMemberships() { return []; },
    async listApplications() { return []; },
    async createApplication() { return null; },
    async transitionApplication() { return null; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews() { return []; },
    async listDeliveryEndpoints() { return []; },
    async createDeliveryEndpoint() { throw new Error('unused'); },
    async updateDeliveryEndpoint() { return null; },
    async revokeDeliveryEndpoint() { return null; },
    async searchMembers() { return []; },
    async listMembers() { return []; },
    async getMemberProfile() { return null; },
    async updateOwnProfile() { throw new Error('unused'); },
    async createEntity() { throw new Error('unused'); },
    async updateEntity() { return null; },
    async listEntities() { return []; },
    async createEvent() { throw new Error('unused'); },
    async listEvents() { return []; },
    async rsvpEvent() { return null; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('unused'); },
    async revokeBearerToken() { return null; },
    async acknowledgeDelivery() { return null; },
    async listDeliveries() { return []; },
    async listDeliveryAttempts() { return []; },
    async retryDelivery() { return null; },
    async claimNextDelivery() { return null; },
    async completeDeliveryAttempt() { return null; },
    async failDeliveryAttempt() { return null; },
    async sendDirectMessage() { return null; },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return []; },
    async readDirectMessageThread() { return null; },
    ...overrides,
  };
}

test('listCanonicalClawClubTools exposes the curated chat-facing tool set only', () => {
  const tools = listCanonicalClawClubTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'session_describe',
      'members_search',
      'profile_get',
      'profile_update',
      'entities_list',
      'entities_create',
      'events_list',
      'events_create',
      'events_rsvp',
      'messages_inbox',
      'messages_read',
      'messages_send',
    ],
  );
  assert.equal(tools.some((tool) => tool.action === 'tokens.create'), false);
  assert.equal(tools.some((tool) => tool.action === 'deliveries.execute'), false);
  assert.equal(tools.some((tool) => tool.action === 'memberships.transition'), false);
});

test('buildClawClubAiTools forwards tool execution through the existing app/auth layer', async () => {
  let capturedInput: Record<string, unknown> | null = null;

  const repository = makeRepository({
    async searchMembers(input) {
      capturedInput = input as Record<string, unknown>;
      return [
        {
          memberId: 'member-2',
          publicName: 'Member Two',
          displayName: 'Member Two',
          handle: 'member-two',
          tagline: 'Builder',
          summary: 'Helpful person',
          whatIDo: null,
          knownFor: null,
          servicesSummary: null,
          websiteUrl: null,
          sharedNetworks: [{ id: 'network-1', slug: 'alpha', name: 'Alpha' }],
        },
      ];
    },
  });

  const tools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' });
  const result = await tools.members_search.execute?.({ query: 'builder', networkId: 'network-1', limit: 3 }, {
    toolCallId: 'tool-call-1',
    messages: [],
  });

  assert.deepEqual(capturedInput, {
    networkIds: ['network-1'],
    query: 'builder',
    limit: 3,
  });
  assert.equal(result?.action, 'members.search');
  assert.equal(result?.actor.member.id, 'member-1');
  assert.equal(result?.actor.requestScope.requestedNetworkId, 'network-1');
  assert.equal(result?.data.results[0]?.memberId, 'member-2');
});

test('profile_update tool preserves targeted patch semantics instead of exposing raw CRUD', async () => {
  let capturedPatch: Record<string, unknown> | null = null;

  const repository = makeRepository({
    async updateOwnProfile({ patch }) {
      capturedPatch = patch as Record<string, unknown>;
      return {
        memberId: 'member-1',
        publicName: 'Member One',
        handle: 'member-one',
        displayName: 'Member One',
        tagline: patch.tagline ?? null,
        summary: patch.summary ?? null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: patch.links ?? [],
        profile: (patch.profile as Record<string, unknown> | undefined) ?? {},
        version: {
          id: 'profile-version-2',
          versionNo: 2,
          createdAt: '2026-03-12T00:10:00Z',
          createdByMemberId: 'member-1',
        },
        sharedNetworks: [{ id: 'network-1', slug: 'alpha', name: 'Alpha' }],
      };
    },
  });

  const tools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' });
  const result = await tools.profile_update.execute?.({
    tagline: '  ',
    summary: 'Available for small facilitation gigs',
    profile: { city: 'Lisbon' },
  }, {
    toolCallId: 'tool-call-2',
    messages: [],
  });

  assert.deepEqual(capturedPatch, {
    handle: undefined,
    displayName: undefined,
    tagline: null,
    summary: 'Available for small facilitation gigs',
    whatIDo: undefined,
    knownFor: undefined,
    servicesSummary: undefined,
    websiteUrl: undefined,
    links: undefined,
    profile: { city: 'Lisbon' },
  });
  assert.equal(result?.action, 'profile.update');
  assert.equal(result?.data.version.versionNo, 2);
  assert.equal(result?.data.summary, 'Available for small facilitation gigs');
});

test('createClawClubOpenAIProvider keeps OpenAI pinned to the approved model', () => {
  const provider = createClawClubOpenAIProvider('test-key');
  const model = provider(CLAWCLUB_OPENAI_MODEL);

  assert.equal(CLAWCLUB_OPENAI_MODEL, 'gpt-5.4');
  assert.equal(model.modelId, 'gpt-5.4');
});
