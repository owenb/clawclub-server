import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1FunctionToolCall } from '@ai-sdk/provider';
import { MockLanguageModelV1 } from 'ai/test';
import { generateClawClubChatText, type CanonicalClawClubToolName } from './ai.ts';
import type {
  ApplicationSummary,
  AuthResult,
  DirectMessageInboxSummary,
  DirectMessageSummary,
  DirectMessageThreadSummary,
  DirectMessageTranscriptEntry,
  EntitySummary,
  EventSummary,
  MemberProfile,
  MemberSearchResult,
  MembershipReviewSummary,
  Repository,
} from './app.ts';

type SmokeScenario = {
  name: string;
  prompt: string;
  steps: Array<
    | { type: 'tool'; toolName: CanonicalClawClubToolName; args: Record<string, unknown> }
    | { type: 'text'; text: string }
  >;
  assert: (result: { text: string; callLog: string[] }) => void;
};

type SmokeRunResult = {
  scenarios: Array<{ name: string; text: string; callLog: string[] }>;
};

function makeAuthResult(): AuthResult {
  return {
    actor: {
      member: {
        id: 'member-1',
        handle: 'owen',
        publicName: 'Owen',
      },
      globalRoles: [],
      memberships: [
        {
          membershipId: 'membership-1',
          networkId: 'network-conscious',
          slug: 'conscious-engineers',
          name: 'Conscious Engineers',
          summary: 'Private member network',
          manifestoMarkdown: null,
          role: 'owner',
          status: 'active',
          sponsorMemberId: 'member-9',
          joinedAt: '2026-03-12T00:00:00Z',
        },
      ],
    },
    requestScope: {
      requestedNetworkId: null,
      activeNetworkIds: ['network-conscious'],
    },
    sharedContext: {
      pendingUpdates: [
        {
          updateId: 'update-1',
          streamSeq: 1,
          recipientMemberId: 'member-1',
          networkId: 'network-conscious',
          entityId: null,
          entityVersionId: null,
          transcriptMessageId: 'message-2',
          topic: 'transcript.message.created',
          payload: { kind: 'dm', threadId: 'thread-1' },
          createdAt: '2026-03-12T09:00:00Z',
          createdByMemberId: 'member-2',
        },
      ],
    },
  };
}

function makeMemberSearchResult(): MemberSearchResult {
  return {
    memberId: 'member-2',
    publicName: 'Ava Builder',
    displayName: 'Ava Builder',
    handle: 'ava',
    tagline: 'Backend + AI systems',
    summary: 'Helps teams ship thoughtful systems',
    whatIDo: 'AI product engineering',
    knownFor: 'Fast execution',
    servicesSummary: 'Fractional technical leadership',
    websiteUrl: 'https://ava.example.test',
    sharedNetworks: [{ id: 'network-conscious', slug: 'conscious-engineers', name: 'Conscious Engineers' }],
  };
}

function makeMembershipReview(): MembershipReviewSummary {
  return {
    membershipId: 'membership-review-1',
    networkId: 'network-conscious',
    member: { memberId: 'member-7', publicName: 'Lina Vector', handle: 'lina' },
    sponsor: { memberId: 'member-1', publicName: 'Owen', handle: 'owen' },
    role: 'member',
    state: {
      status: 'pending_review',
      reason: 'Strong fit and clean intro',
      versionNo: 1,
      createdAt: '2026-03-12T10:00:00Z',
      createdByMemberId: 'member-1',
    },
    joinedAt: '2026-03-12T10:00:00Z',
    acceptedCovenantAt: null,
    metadata: {},
    sponsorStats: {
      activeSponsoredCount: 1,
      sponsoredThisMonthCount: 1,
    },
    vouches: [{
      edgeId: 'edge-2',
      fromMemberId: 'member-2',
      fromPublicName: 'Ava Builder',
      fromHandle: 'ava',
      reason: 'Careful operator, good taste',
      metadata: {},
      createdAt: '2026-03-12T10:01:00Z',
      createdByMemberId: 'member-2',
    }],
  };
}

function makeApplication(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    applicationId: 'application-1',
    networkId: 'network-conscious',
    applicant: { memberId: 'member-7', publicName: 'Lina Vector', handle: 'lina', email: null },
    sponsor: { memberId: 'member-1', publicName: 'Owen', handle: 'owen' },
    membershipId: null,
    activation: {
      linkedMembershipId: null,
      membershipStatus: null,
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
      notes: 'Warm intro from Ava',
      versionNo: 1,
      createdAt: '2026-03-12T10:00:00Z',
      createdByMemberId: 'member-1',
    },
    metadata: {},
    createdAt: '2026-03-12T10:00:00Z',
    ...overrides,
  };
}

function makeProfile(): MemberProfile {
  return {
    memberId: 'member-1',
    publicName: 'Owen',
    handle: 'owen',
    displayName: 'Owen',
    tagline: 'Building aligned software',
    summary: 'Developer building Claw Club',
    whatIDo: 'Product and backend engineering',
    knownFor: 'Shipping agent-native systems',
    servicesSummary: null,
    websiteUrl: 'https://conscious.engineer',
    links: [],
    profile: { city: 'Lisbon' },
    version: {
      id: 'profile-version-1',
      versionNo: 1,
      createdAt: '2026-03-12T00:00:00Z',
      createdByMemberId: 'member-1',
      embedding: null,
    },
    sharedNetworks: [{ id: 'network-conscious', slug: 'conscious-engineers', name: 'Conscious Engineers' }],
  };
}

function makeInboxThread(): DirectMessageInboxSummary {
  return {
    threadId: 'thread-1',
    networkId: 'network-conscious',
    counterpartMemberId: 'member-2',
    counterpartPublicName: 'Ava Builder',
    counterpartHandle: 'ava',
    latestMessage: {
      messageId: 'message-2',
      senderMemberId: 'member-2',
      role: 'member',
      messageText: 'Happy to jam on the Hetzner rollout.',
      createdAt: '2026-03-12T09:00:00Z',
    },
    messageCount: 2,
    unread: {
      hasUnread: true,
      unreadMessageCount: 1,
      unreadUpdateCount: 1,
      latestUnreadMessageCreatedAt: '2026-03-12T09:00:00Z',
    },
  };
}

function makeTranscript(): { thread: DirectMessageThreadSummary; messages: DirectMessageTranscriptEntry[] } {
  return {
    thread: {
      threadId: 'thread-1',
      networkId: 'network-conscious',
      counterpartMemberId: 'member-2',
      counterpartPublicName: 'Ava Builder',
      counterpartHandle: 'ava',
      latestMessage: {
        messageId: 'message-2',
        senderMemberId: 'member-2',
        role: 'member',
        messageText: 'Happy to jam on the Hetzner rollout.',
        createdAt: '2026-03-12T09:00:00Z',
      },
      messageCount: 2,
    },
    messages: [
      {
        messageId: 'message-1',
        threadId: 'thread-1',
        senderMemberId: 'member-1',
        role: 'member',
        messageText: 'Want to compare notes on infra?',
        payload: {},
        createdAt: '2026-03-12T08:00:00Z',
        inReplyToMessageId: null,
        updateReceipts: [],
      },
      {
        messageId: 'message-2',
        threadId: 'thread-1',
        senderMemberId: 'member-2',
        role: 'member',
        messageText: 'Happy to jam on the Hetzner rollout.',
        payload: {},
        createdAt: '2026-03-12T09:00:00Z',
        inReplyToMessageId: null,
        updateReceipts: [],
      },
    ],
  };
}

function makeSentMessage(): DirectMessageSummary {
  return {
    threadId: 'thread-1',
    networkId: 'network-conscious',
    senderMemberId: 'member-1',
    recipientMemberId: 'member-2',
    messageId: 'message-3',
    messageText: 'Perfect — let us do 15:00 UTC tomorrow.',
    createdAt: '2026-03-12T09:05:00Z',
    updateCount: 1,
  };
}

function makeEvent(): EventSummary {
  return {
    entityId: 'event-1',
    entityVersionId: 'event-version-1',
    networkId: 'network-conscious',
    author: {
      memberId: 'member-1',
      publicName: 'Owen',
      handle: 'owen',
    },
    version: {
      versionNo: 1,
      state: 'published',
      title: 'Hetzner operator session',
      summary: 'Review rollout plan',
      body: 'Short sync for infra assumptions and next steps',
      startsAt: '2026-03-14T15:00:00Z',
      endsAt: '2026-03-14T15:30:00Z',
      timezone: 'UTC',
      recurrenceRule: null,
      capacity: 6,
      effectiveAt: '2026-03-12T09:10:00Z',
      expiresAt: null,
      createdAt: '2026-03-12T09:10:00Z',
      content: {},
      embedding: null,
    },
    rsvps: {
      viewerResponse: null,
      counts: { yes: 0, maybe: 0, no: 0, waitlist: 0 },
      attendees: [],
    },
    createdAt: '2026-03-12T09:10:00Z',
  };
}

function makeRepository(callLog: string[]): Repository {
  let profile = makeProfile();

  return {
    async authenticateBearerToken(token) {
      return token === 'cc_live_test' ? makeAuthResult() : null;
    },
    async listMemberships() { return []; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews(input) {
      callLog.push(`listMembershipReviews:${JSON.stringify(input)}`);
      return [makeMembershipReview()];
    },
    async listApplications(input) {
      callLog.push(`listApplications:${JSON.stringify(input)}`);
      return [makeApplication()];
    },
    async createApplication(input) {
      callLog.push(`createApplication:${JSON.stringify(input)}`);
      return makeApplication();
    },
    async transitionApplication(input) {
      callLog.push(`transitionApplication:${JSON.stringify(input)}`);
      if (input.activateMembership) {
        return makeApplication({
          membershipId: input.membershipId ?? 'membership-1',
          activation: {
            linkedMembershipId: input.membershipId ?? 'membership-1',
            membershipStatus: 'active',
            acceptedCovenantAt: null,
            readyForActivation: false,
          },
          state: {
            ...makeApplication().state,
            status: 'accepted',
            versionNo: 3,
            notes: input.notes ?? 'Interview complete and accepted',
          },
          intake: {
            ...makeApplication().intake,
            completedAt: input.intake?.completedAt ?? '2026-03-14T10:30:00Z',
          },
        });
      }

      return makeApplication({
        state: {
          ...makeApplication().state,
          status: 'interview_scheduled',
          versionNo: 2,
          notes: input.notes ?? 'Interview booked',
        },
        intake: {
          ...makeApplication().intake,
          bookingUrl: input.intake?.bookingUrl ?? makeApplication().intake.bookingUrl,
          bookedAt: input.intake?.bookedAt ?? makeApplication().intake.bookedAt,
        },
      });
    },
    async searchMembers(input) {
      callLog.push(`searchMembers:${JSON.stringify(input)}`);
      return [makeMemberSearchResult()];
    },
    async listMembers() { return []; },
    async getMemberProfile(input) {
      callLog.push(`getMemberProfile:${JSON.stringify(input)}`);
      return profile;
    },
    async updateOwnProfile(input) {
      callLog.push(`updateOwnProfile:${JSON.stringify(input)}`);
      profile = {
        ...profile,
        tagline: input.patch.tagline ?? profile.tagline,
        summary: input.patch.summary ?? profile.summary,
        profile: typeof input.patch.profile === 'object' && input.patch.profile !== null
          ? input.patch.profile as Record<string, unknown>
          : profile.profile,
        version: {
          id: 'profile-version-2',
          versionNo: 2,
          createdAt: '2026-03-12T09:02:00Z',
          createdByMemberId: 'member-1',
        },
      };
      return profile;
    },
    async createEntity() { throw new Error('unused'); },
    async updateEntity() { return null; },
    async listEntities() { return []; },
    async createEvent(input) {
      callLog.push(`createEvent:${JSON.stringify(input)}`);
      return makeEvent();
    },
    async listEvents(input) {
      callLog.push(`listEvents:${JSON.stringify(input)}`);
      return [makeEvent()];
    },
    async rsvpEvent() { return null; },
    async listBearerTokens() { return []; },
    async createBearerToken() { throw new Error('unused'); },
    async revokeBearerToken() { return null; },
    async sendDirectMessage(input) {
      callLog.push(`sendDirectMessage:${JSON.stringify(input)}`);
      return makeSentMessage();
    },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox(input) {
      callLog.push(`listDirectMessageInbox:${JSON.stringify(input)}`);
      return [makeInboxThread()];
    },
    async readDirectMessageThread(input) {
      callLog.push(`readDirectMessageThread:${JSON.stringify(input)}`);
      return makeTranscript();
    },
    async getQuotaStatus() { return []; },

  };
}

function makeToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): LanguageModelV1FunctionToolCall {
  return {
    toolCallType: 'function',
    toolCallId,
    toolName,
    args: JSON.stringify(args),
  };
}

function makeScriptedModel(steps: SmokeScenario['steps']): LanguageModelV1 {
  let index = 0;

  return new MockLanguageModelV1({
    modelId: 'mock-clawclub-scripted',
    doGenerate: async (_options: LanguageModelV1CallOptions) => {
      const step = steps[index++];
      if (!step) {
        throw new Error('Scripted model exhausted before generateText finished');
      }

      if (step.type === 'tool') {
        return {
          finishReason: 'tool-calls',
          usage: { promptTokens: 1, completionTokens: 1 },
          rawCall: { rawPrompt: _options.prompt, rawSettings: {} },
          toolCalls: [makeToolCall(`tool-call-${index}`, step.toolName, step.args)],
        };
      }

      return {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: _options.prompt, rawSettings: {} },
        text: step.text,
      };
    },
    doStream: async () => {
      throw new Error('Streaming smoke not implemented');
    },
  });
}

const smokeScenarios: SmokeScenario[] = [
  {
    name: 'session describe',
    prompt: 'Who am I here?',
    steps: [
      { type: 'tool', toolName: 'session_describe', args: {} },
      { type: 'text', text: 'You are Owen in Conscious Engineers with one pending DM update.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /Owen/);
      assert.equal(callLog.length, 0);
    },
  },
  {
    name: 'admissions operator flow',
    prompt: 'Review pending admissions, check submitted applications, book Lina for interview, then accept and activate her membership once the interview is complete.',
    steps: [
      { type: 'tool', toolName: 'memberships_review', args: { networkId: 'network-conscious', limit: 5 } },
      { type: 'tool', toolName: 'applications_list', args: { networkId: 'network-conscious', statuses: ['submitted'], limit: 5 } },
      { type: 'tool', toolName: 'applications_transition', args: { applicationId: 'application-1', status: 'interview_scheduled', notes: 'Booked fit check', intake: { bookingUrl: 'https://cal.example.test/fit-check', bookedAt: '2026-03-14T10:00:00Z' } } },
      { type: 'tool', toolName: 'applications_transition', args: { applicationId: 'application-1', status: 'accepted', notes: 'Interview complete and accepted', membershipId: 'membership-1', activateMembership: true, activationReason: 'Interview passed and owner approved', intake: { completedAt: '2026-03-14T10:30:00Z' } } },
      { type: 'text', text: 'Lina looks clean all the way through. I reviewed the queue, scheduled the interview, then accepted the application and activated the linked membership.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /activated the linked membership/);
      assert.equal(callLog.some((entry) => entry.startsWith('listMembershipReviews:')), true);
      assert.equal(callLog.some((entry) => entry.startsWith('listApplications:')), true);
      assert.equal(callLog.filter((entry) => entry.startsWith('transitionApplication:')).length, 2);
      assert.equal(callLog.some((entry) => entry.includes('"activateMembership":true')), true);
    },
  },
  {
    name: 'member search',
    prompt: 'Find me a backend/AI builder in my network.',
    steps: [
      { type: 'tool', toolName: 'session_describe', args: {} },
      { type: 'tool', toolName: 'members_search', args: { query: 'backend AI builder', limit: 3 } },
      { type: 'text', text: 'Ava Builder looks like the best fit.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /Ava Builder/);
      assert.equal(callLog.some((entry) => entry.startsWith('searchMembers:')), true);
    },
  },
  {
    name: 'profile read + update',
    prompt: 'Show my profile then set my tagline to Hetzner-native AI operator.',
    steps: [
      { type: 'tool', toolName: 'profile_get', args: {} },
      { type: 'tool', toolName: 'profile_update', args: { tagline: 'Hetzner-native AI operator' } },
      { type: 'text', text: 'Done — your profile tagline is now Hetzner-native AI operator.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /Hetzner-native AI operator/);
      assert.equal(callLog.some((entry) => entry.startsWith('getMemberProfile:')), true);
      assert.equal(callLog.some((entry) => entry.includes('updateOwnProfile:')), true);
    },
  },
  {
    name: 'message inbox + read + send',
    prompt: 'Check unread DMs, read the latest thread, and reply with a concrete time.',
    steps: [
      { type: 'tool', toolName: 'messages_inbox', args: { unreadOnly: true, limit: 5 } },
      { type: 'tool', toolName: 'messages_read', args: { threadId: 'thread-1', limit: 10 } },
      { type: 'tool', toolName: 'messages_send', args: { recipientMemberId: 'member-2', networkId: 'network-conscious', messageText: 'Perfect — let us do 15:00 UTC tomorrow.' } },
      { type: 'text', text: 'Inbox checked, thread read, and reply sent to Ava.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /reply sent/);
      assert.equal(callLog.some((entry) => entry.startsWith('listDirectMessageInbox:')), true);
      assert.equal(callLog.some((entry) => entry.startsWith('readDirectMessageThread:')), true);
      assert.equal(callLog.some((entry) => entry.startsWith('sendDirectMessage:')), true);
    },
  },
  {
    name: 'event retrieval + create',
    prompt: 'Check whether we already have a Hetzner operator event, then create one for Saturday at 15:00 UTC if needed.',
    steps: [
      { type: 'tool', toolName: 'events_list', args: { query: 'Hetzner operator', limit: 5 } },
      { type: 'tool', toolName: 'events_create', args: { networkId: 'network-conscious', title: 'Hetzner operator session', summary: 'Review rollout plan', body: 'Short sync for infra assumptions and next steps', startsAt: '2026-03-14T15:00:00Z', endsAt: '2026-03-14T15:30:00Z', timezone: 'UTC', capacity: 6 } },
      { type: 'text', text: 'Checked the existing Hetzner operator events and created the next session for Saturday at 15:00 UTC.' },
    ],
    assert: ({ text, callLog }) => {
      assert.match(text, /created the next session/);
      assert.equal(callLog.some((entry) => entry.startsWith('listEvents:')), true);
      assert.equal(callLog.some((entry) => entry.includes('"query":"Hetzner operator"')), true);
      assert.equal(callLog.some((entry) => entry.startsWith('createEvent:')), true);
    },
  },
];

export async function runAiSmoke(): Promise<SmokeRunResult> {
  const scenarios: SmokeRunResult['scenarios'] = [];

  for (const scenario of smokeScenarios) {
    const callLog: string[] = [];
    const repository = makeRepository(callLog);
    const result = await generateClawClubChatText({
      runtime: {
        repository,
        bearerToken: 'cc_live_test',
      },
      messages: [{ role: 'user', content: scenario.prompt }],
      model: makeScriptedModel(scenario.steps),
      maxSteps: scenario.steps.length,
    });

    scenario.assert({ text: result.text, callLog });
    scenarios.push({ name: scenario.name, text: result.text, callLog });
  }

  return { scenarios };
}

async function main() {
  const result = await runAiSmoke();
  for (const scenario of result.scenarios) {
    console.log(`ok - ${scenario.name}`);
    console.log(`  text: ${scenario.text}`);
    console.log(`  calls: ${scenario.callLog.length === 0 ? '(tool layer only)' : scenario.callLog.join(' | ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
