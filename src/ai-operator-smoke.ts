import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1FunctionToolCall } from '@ai-sdk/provider';
import { MockLanguageModelV1 } from 'ai/test';
import { runClawClubOperatorTurn } from './ai-operator.ts';
import type { AuthResult, MembershipReviewSummary, Repository } from './app.ts';

export type OperatorSmokeResult = {
  text: string;
  callLog: string[];
};

function makeAuthResult(): AuthResult {
  return {
    actor: {
      member: { id: 'member-1', handle: 'owen', publicName: 'Owen' },
      globalRoles: [],
      memberships: [{
        membershipId: 'membership-1',
        networkId: 'network-conscious',
        slug: 'conscious-engineers',
        name: 'Conscious Engineers',
        summary: 'Private member network',
        manifestoMarkdown: null,
        role: 'owner',
        status: 'active',
        sponsorMemberId: null,
        joinedAt: '2026-03-12T00:00:00Z',
      }],
    },
    requestScope: { requestedNetworkId: null, activeNetworkIds: ['network-conscious'] },
    sharedContext: { pendingDeliveries: [] },
  };
}

function makeMembershipReview(): MembershipReviewSummary {
  return {
    membershipId: 'membership-2',
    networkId: 'network-conscious',
    member: { memberId: 'member-2', publicName: 'Lina Vector', handle: 'lina' },
    sponsor: { memberId: 'member-1', publicName: 'Owen', handle: 'owen' },
    role: 'member',
    state: { status: 'pending_review', reason: 'Strong fit', versionNo: 1, createdAt: '2026-03-13T10:00:00Z', createdByMemberId: 'member-1' },
    joinedAt: '2026-03-13T10:00:00Z',
    acceptedCovenantAt: null,
    metadata: {},
    sponsorStats: { activeSponsoredCount: 1, sponsoredThisMonthCount: 1 },
    vouches: [],
  };
}

function makeRepository(callLog: string[]): Repository {
  return {
    async authenticateBearerToken(token) { return token === 'cc_live_test' ? makeAuthResult() : null; },
    async listMemberships() { return []; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews(input) {
      callLog.push(`listMembershipReviews:${JSON.stringify(input)}`);
      return [makeMembershipReview()];
    },
    async listApplications() { return []; },
    async createApplication() { return null; },
    async transitionApplication() { return null; },
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
  };
}

function makeToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): LanguageModelV1FunctionToolCall {
  return { toolCallType: 'function', toolCallId, toolName, args: JSON.stringify(args) };
}

function makeScriptedModel(): LanguageModelV1 {
  let index = 0;
  const steps = [
    { type: 'tool', toolName: 'memberships_review', args: { networkId: 'network-conscious', limit: 5 } },
    { type: 'text', text: 'I checked the pending admissions queue. Lina Vector is the only member waiting and looks ready for review.' },
  ] as const;

  return new MockLanguageModelV1({
    modelId: 'mock-operator-smoke',
    doGenerate: async (options: LanguageModelV1CallOptions) => {
      const step = steps[index++];
      if (!step) throw new Error('Script exhausted');
      if (step.type === 'tool') {
        return {
          finishReason: 'tool-calls',
          usage: { promptTokens: 1, completionTokens: 1 },
          rawCall: { rawPrompt: options.prompt, rawSettings: {} },
          toolCalls: [makeToolCall(`tool-call-${index}`, step.toolName, step.args)],
        };
      }
      return {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        text: step.text,
      };
    },
    doStream: async () => { throw new Error('streaming smoke not implemented'); },
  });
}

export async function runOperatorSmoke(): Promise<OperatorSmokeResult> {
  const callLog: string[] = [];
  const result = await runClawClubOperatorTurn({
    runtime: { repository: makeRepository(callLog), bearerToken: 'cc_live_test' },
    system: 'You are a careful ClawClub operator.',
    prompt: 'Review the admissions queue and summarize what needs action.',
    model: makeScriptedModel() as any,
    maxSteps: 4,
  });

  assert.match(result.text, /Lina Vector/);
  assert.equal(callLog.some((entry) => entry.startsWith('listMembershipReviews:')), true);

  return { text: result.text, callLog };
}

async function main() {
  const result = await runOperatorSmoke();
  console.log('ok - operator chat runner');
  console.log(`  text: ${result.text}`);
  console.log(`  calls: ${result.callLog.join(' | ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
