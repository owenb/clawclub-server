import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClawClubAiTools,
  CLAWCLUB_OPENAI_MODEL,
  createClawClubOpenAIModel,
  createClawClubOpenAIProvider,
  listCanonicalClawClubTools,
} from '../src/ai.ts';
import type { AdmissionSummary, MembershipReviewSummary, Repository } from '../src/app.ts';
import { makeAuthResult, makeRepository as makeBaseRepository } from './fixtures.ts';

function makeMembershipReview(): MembershipReviewSummary {
  return {
    membershipId: 'membership-2',
    clubId: 'club-1',
    member: { memberId: 'member-2', publicName: 'Member Two', handle: 'member-two' },
    sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
    role: 'member',
    state: {
      status: 'pending_review',
      reason: 'Strong intro',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
    },
    joinedAt: '2026-03-12T00:00:00Z',
    acceptedCovenantAt: null,
    metadata: {},
    sponsorStats: {
      activeSponsoredCount: 1,
      sponsoredThisMonthCount: 1,
    },
    vouches: [{
      edgeId: 'edge-1',
      fromMemberId: 'member-3',
      fromPublicName: 'Member Three',
      fromHandle: 'member-three',
      reason: 'Worked together well',
      metadata: {},
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-3',
    }],
  };
}

function makeApplication(overrides: Partial<AdmissionSummary> = {}): AdmissionSummary {
  return {
    admissionId: 'application-1',
    clubId: 'club-1',
    applicant: { memberId: 'member-2', publicName: 'Member Two', handle: 'member-two', email: null },
    sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
    membershipId: null,
    origin: 'owner_nominated' as const,
    intake: {
      kind: 'fit_check' as const,
      price: { amount: 49, currency: 'GBP' },
      bookingUrl: 'https://cal.example.test/fit-check',
      bookedAt: '2026-03-14T10:00:00Z',
      completedAt: null,
    },
    state: {
      status: 'submitted' as const,
      notes: 'Warm intro',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
    },
    admissionDetails: {},
    metadata: {},
    createdAt: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return makeBaseRepository({
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    ...overrides,
  });
}

test('listCanonicalClawClubTools exposes the curated chat-facing tool set only', () => {
  const tools = listCanonicalClawClubTools();

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'admissions_list',
      'admissions_nominate',
      'admissions_sponsor',
      'admissions_transition',
      'entities_archive',
      'entities_create',
      'entities_list',
      'events_create',
      'events_list',
      'events_rsvp',
      'members_search',
      'memberships_review',
      'messages_inbox',
      'messages_read',
      'messages_send',
      'profile_get',
      'profile_update',
      'session_describe',
      'vouches_create',
      'vouches_list',
    ],
  );
  assert.equal(tools.some((tool) => tool.action === 'tokens.create'), false);
  assert.equal(tools.some((tool) => tool.action === 'memberships.transition'), false);
  assert.equal(tools.some((tool) => tool.action === 'memberships.create'), false);
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
          sharedClubs: [{ id: 'club-1', slug: 'alpha', name: 'Alpha' }],
        },
      ];
    },
  });

  const tools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' });
  const result = await tools.members_search.execute?.({ query: 'builder', clubId: 'club-1', limit: 3 }, {
    toolCallId: 'tool-call-1',
    messages: [],
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    query: 'builder',
    limit: 3,
  });
  assert.equal(result?.action, 'members.search');
  assert.equal(result?.actor.member.id, 'member-1');
  assert.equal(result?.actor.requestScope.requestedClubId, 'club-1');
  assert.equal(result?.data.results[0]?.memberId, 'member-2');
});

test('admissions tools stay small and operator-ready through the curated layer', async () => {
  let reviewInput: Record<string, unknown> | null = null;
  let listInput: Record<string, unknown> | null = null;
  let createInput: Record<string, unknown> | null = null;
  let transitionInput: Record<string, unknown> | null = null;

  const repository = makeRepository({
    async listMembershipReviews(input) {
      reviewInput = input as Record<string, unknown>;
      return [makeMembershipReview()];
    },
    async listAdmissions(input) {
      listInput = input as Record<string, unknown>;
      return [makeApplication()];
    },
    async createAdmission(input) {
      createInput = input as Record<string, unknown>;
      return makeApplication();
    },
    async transitionAdmission(input) {
      transitionInput = input as Record<string, unknown>;
      return makeApplication({
        state: {
          ...makeApplication().state,
          status: 'interview_scheduled',
          versionNo: 2,
        },
      });
    },
  });

  const tools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' });
  const reviewResult = await tools.memberships_review.execute?.({ clubId: 'club-1', limit: 5 }, { toolCallId: 'tool-call-review', messages: [] });
  const listResult = await tools.admissions_list.execute?.({ clubId: 'club-1', statuses: ['submitted'], limit: 5 }, { toolCallId: 'tool-call-list', messages: [] });
  const createResult = await tools.admissions_nominate.execute?.({
    clubId: 'club-1',
    applicantMemberId: 'member-2',
    sponsorMemberId: 'member-1',
    notes: 'Warm intro',
    intake: { kind: 'fit_check', price: { amount: 49, currency: 'gbp' } },
  }, { toolCallId: 'tool-call-create', messages: [] });
  const transitionResult = await tools.admissions_transition.execute?.({
    admissionId: 'application-1',
    status: 'interview_scheduled',
    notes: 'Call booked',
    intake: { bookingUrl: 'https://cal.example.test/fit-check', bookedAt: '2026-03-14T10:00:00Z' },
    metadata: { outcome: 'strong_yes' },
  }, { toolCallId: 'tool-call-transition', messages: [] });

  assert.deepEqual(reviewInput, {
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    limit: 5,
    statuses: ['invited', 'pending_review'],
  });
  assert.deepEqual(listInput, {
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    limit: 5,
    statuses: ['submitted'],
  });
  assert.deepEqual(createInput, {
    actorMemberId: 'member-1',
    clubId: 'club-1',
    applicantMemberId: 'member-2',
    sponsorMemberId: 'member-1',
    initialStatus: 'submitted',
    notes: 'Warm intro',
    intake: { kind: 'fit_check', price: { amount: 49, currency: 'GBP' }, bookingUrl: undefined, bookedAt: undefined, completedAt: undefined },
    metadata: {},
  });
  assert.deepEqual(transitionInput, {
    actorMemberId: 'member-1',
    admissionId: 'application-1',
    nextStatus: 'interview_scheduled',
    notes: 'Call booked',
    accessibleClubIds: ['club-1'],
    intake: { kind: undefined, price: undefined, bookingUrl: 'https://cal.example.test/fit-check', bookedAt: '2026-03-14T10:00:00Z', completedAt: undefined },
    metadataPatch: { outcome: 'strong_yes' },
  });
  assert.equal(reviewResult?.action, 'memberships.review');
  assert.equal(listResult?.action, 'admissions.list');
  assert.equal(createResult?.action, 'admissions.nominate');
  assert.equal(transitionResult?.action, 'admissions.transition');
  assert.equal(transitionResult?.data.admission.state.versionNo, 2);
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
          embedding: null,
        },
        sharedClubs: [{ id: 'club-1', slug: 'alpha', name: 'Alpha' }],
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

test('createClawClubOpenAIModel disables structured outputs for optional tool schemas', () => {
  let capturedModelId: string | null = null;
  let capturedSettings: Record<string, unknown> | null = null;

  const model = createClawClubOpenAIModel(((modelId: string, settings?: Record<string, unknown>) => {
    capturedModelId = modelId;
    capturedSettings = settings ?? null;
    return { modelId } as { modelId: string };
  }) as any);

  assert.equal(capturedModelId, CLAWCLUB_OPENAI_MODEL);
  assert.deepEqual(capturedSettings, { structuredOutputs: false });
  assert.equal(model.modelId, CLAWCLUB_OPENAI_MODEL);
});

test('buildClawClubAiTools readOnly mode excludes mutating tools', () => {
  const repository = makeRepository();
  const allTools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' });
  const readOnlyTools = buildClawClubAiTools({ repository, bearerToken: 'cc_live_test' }, { readOnly: true });

  const allNames = Object.keys(allTools);
  const readOnlyNames = Object.keys(readOnlyTools);

  assert.ok(allNames.includes('messages_send'), 'full mode includes mutating tools');
  assert.ok(allNames.includes('admissions_nominate'), 'full mode includes mutating tools');
  assert.ok(allNames.includes('entities_create'), 'full mode includes mutating tools');

  assert.ok(!readOnlyNames.includes('messages_send'), 'readOnly excludes messages_send');
  assert.ok(!readOnlyNames.includes('admissions_nominate'), 'readOnly excludes admissions_nominate');
  assert.ok(!readOnlyNames.includes('admissions_transition'), 'readOnly excludes admissions_transition');
  assert.ok(!readOnlyNames.includes('profile_update'), 'readOnly excludes profile_update');
  assert.ok(!readOnlyNames.includes('entities_create'), 'readOnly excludes entities_create');
  assert.ok(!readOnlyNames.includes('entities_archive'), 'readOnly excludes entities_archive');
  assert.ok(!readOnlyNames.includes('events_create'), 'readOnly excludes events_create');
  assert.ok(!readOnlyNames.includes('events_rsvp'), 'readOnly excludes events_rsvp');

  assert.ok(readOnlyNames.includes('session_describe'), 'readOnly includes session_describe');
  assert.ok(readOnlyNames.includes('members_search'), 'readOnly includes members_search');
  assert.ok(readOnlyNames.includes('messages_inbox'), 'readOnly includes messages_inbox');
  assert.ok(readOnlyNames.includes('messages_read'), 'readOnly includes messages_read');
  assert.ok(readOnlyNames.includes('profile_get'), 'readOnly includes profile_get');

  assert.ok(readOnlyNames.length < allNames.length, 'readOnly has fewer tools');
});

test('listCanonicalClawClubTools includes safety classification', () => {
  const tools = listCanonicalClawClubTools();
  const readOnly = tools.filter((t) => t.safety === 'read_only');
  const mutating = tools.filter((t) => t.safety === 'mutating');

  assert.ok(readOnly.length > 0, 'has read_only tools');
  assert.ok(mutating.length > 0, 'has mutating tools');
  assert.equal(readOnly.length + mutating.length, tools.length, 'every tool has a safety classification');
});

test('action manifest covers exactly the set of handled actions', async () => {
  const { ACTION_MANIFEST, KNOWN_ACTIONS } = await import('../src/action-manifest.ts');

  const handledActions = new Set<string>();
  const handlerFiles = [
    '../src/app-admin.ts',
    '../src/app-admissions.ts',
    '../src/app-cold-admissions.ts',
    '../src/app-content.ts',
    '../src/app-messages.ts',
    '../src/app-platform.ts',
    '../src/app-profile.ts',
    
    '../src/app-updates.ts',
  ];

  for (const file of handlerFiles) {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL(file, import.meta.url), 'utf-8'),
    );
    const matches = source.matchAll(/case\s+'([^']+)'/g);
    for (const match of matches) {
      handledActions.add(match[1]);
    }
  }

  const manifestActions = new Set(ACTION_MANIFEST.map((s: { action: string }) => s.action));

  for (const action of handledActions) {
    assert.ok(manifestActions.has(action), `handled action '${action}' is missing from ACTION_MANIFEST`);
  }

  for (const action of manifestActions) {
    assert.ok(handledActions.has(action), `manifest action '${action}' is not handled by any module`);
  }

  assert.equal(KNOWN_ACTIONS.size, handledActions.size, 'manifest and handlers have the same action count');
});
