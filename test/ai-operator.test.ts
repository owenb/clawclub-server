import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV1 } from 'ai/test';
import { runClawClubOperatorTurn } from '../src/ai-operator.ts';
import type { Repository } from '../src/app.ts';
import { makeAuthResult as makeBaseAuthResult, makeRepository as makeBaseRepository } from './fixtures.ts';

function makeAuthResult() {
  return makeBaseAuthResult({
    memberId: 'member-1',
    handle: 'owen',
    publicName: 'Owen',
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
  });
}

function makeRepository(): Repository {
  return makeBaseRepository({
    async authenticateBearerToken(token) { return token === 'cc_live_test' ? makeAuthResult() : null; },
    async listMembershipReviews() {
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
  });
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
