import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV1 } from 'ai/test';
import { runClawClubOperatorTurn } from '../src/ai-operator.ts';
import type { AuthResult, Repository } from '../src/app.ts';

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
        summary: 'Private network',
        manifestoMarkdown: null,
        role: 'owner',
        status: 'active',
        sponsorMemberId: null,
        joinedAt: '2026-03-12T00:00:00Z',
      }],
    },
    requestScope: { requestedNetworkId: null, activeNetworkIds: ['network-conscious'] },
    sharedContext: { pendingUpdates: [] },
  };
}

function makeRepository(): Repository {
  return {
    async authenticateBearerToken(token) { return token === 'cc_live_test' ? makeAuthResult() : null; },
    async listMemberships() { return []; },
    async createMembership() { return null; },
    async transitionMembershipState() { return null; },
    async listMembershipReviews(input) {
      return [{
        membershipId: 'membership-2',
        networkId: 'network-conscious',
        member: { memberId: 'member-2', publicName: 'Lina', handle: 'lina' },
        sponsor: { memberId: 'member-1', publicName: 'Owen', handle: 'owen' },
        role: 'member',
        state: { status: 'pending_review', reason: 'Strong fit', versionNo: 1, createdAt: '2026-03-13T10:00:00Z', createdByMemberId: 'member-1' },
        joinedAt: '2026-03-13T10:00:00Z',
        acceptedCovenantAt: null,
        metadata: { source: 'operator' },
        sponsorStats: { activeSponsoredCount: 1, sponsoredThisMonthCount: 1 },
        vouches: [],
      }];
    },
    async listApplications() { return []; },
    async createApplication() { return null; },
    async transitionApplication() { return null; },
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
    async sendDirectMessage() { return null; },
    async listDirectMessageThreads() { return []; },
    async listDirectMessageInbox() { return []; },
    async readDirectMessageThread() { return null; },
  };
}

test('runClawClubOperatorTurn runs a realistic operator flow on top of curated tools', async () => {
  const model = new MockLanguageModelV1({
    modelId: 'mock-operator',
    doGenerate: async () => ({
      finishReason: 'tool-calls',
      usage: { promptTokens: 1, completionTokens: 1 },
      rawCall: { rawPrompt: [], rawSettings: {} },
      toolCalls: [{ toolCallType: 'function', toolCallId: 'tool-1', toolName: 'memberships_review', args: JSON.stringify({ networkId: 'network-conscious', limit: 5 }) }],
    }),
    doStream: async () => { throw new Error('unused'); },
  });

  let calls = 0;
  const scriptedModel = {
    ...model,
    async doGenerate(options: any) {
      calls += 1;
      if (calls === 1) {
        return {
          finishReason: 'tool-calls',
          usage: { promptTokens: 1, completionTokens: 1 },
          rawCall: { rawPrompt: options.prompt, rawSettings: {} },
          toolCalls: [{ toolCallType: 'function', toolCallId: 'tool-1', toolName: 'memberships_review', args: JSON.stringify({ networkId: 'network-conscious', limit: 5 }) }],
        };
      }
      return {
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        text: 'I checked the pending review queue. Lina is ready for the next admissions step.',
      };
    },
  };

  const result = await runClawClubOperatorTurn({
    runtime: { repository: makeRepository(), bearerToken: 'cc_live_test' },
    prompt: 'Review pending admissions and tell me what needs action.',
    system: 'You are a careful operator.',
    context: [{ role: 'user', content: 'Focus on admissions only.' }],
    model: scriptedModel as any,
    maxSteps: 4,
  });

  assert.equal(result.prompt, 'Review pending admissions and tell me what needs action.');
  assert.match(result.text, /Lina/);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], { role: 'user', content: 'Focus on admissions only.' });
});

test('runClawClubOperatorTurn rejects an empty prompt', async () => {
  await assert.rejects(
    () => runClawClubOperatorTurn({
      runtime: { repository: makeRepository(), bearerToken: 'cc_live_test' },
      prompt: '   ',
    }),
    /prompt is required/,
  );
});
