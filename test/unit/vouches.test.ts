import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import { AppError } from '../../src/contract.ts';
import type { MembershipVouchSummary, Repository } from '../../src/contract.ts';
import { passthroughGate } from './fixtures.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

const sampleVouch: MembershipVouchSummary = {
  edgeId: 'edge-1',
  fromMember: { memberId: 'member-1', publicName: 'Member One' },
  reason: 'Built the event system and it has not gone down once',
  metadata: {},
  createdAt: '2026-04-02T00:00:00Z',
  createdByMemberId: 'member-1',
};

test('vouches.create creates a vouch for another member', async () => {
  let capturedInput: any = null;
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async createVouch(input) {
      capturedInput = input;
      return sampleVouch;
    },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'vouches.create',
    payload: { clubId: 'club-1', memberId: 'member-2', reason: 'Excellent engineer, shipped the API in a week' },
  });

  assert.equal(result.action, 'vouches.create');
  assert.equal(result.data.vouch.edgeId, 'edge-1');
  assert.equal(capturedInput.actorMemberId, 'member-1');
  assert.equal(capturedInput.targetMemberId, 'member-2');
  assert.equal(capturedInput.reason, 'Excellent engineer, shipped the API in a week');
});

test('vouches.create rejects self-vouch at app layer', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-1', memberId: 'member-1', reason: 'I vouch for myself' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'self_vouch');
      return true;
    },
  );
});

test('vouches.create rejects duplicate vouch (23505 unique violation)', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async createVouch() {
      const error = new Error('unique violation') as any;
      error.code = '23505';
      throw error;
    },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-1', memberId: 'member-2', reason: 'Solid contributor' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'duplicate_vouch');
      return true;
    },
  );
});

test('vouches.create rejects missing reason', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-1', memberId: 'member-2' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'invalid_input');
      return true;
    },
  );
});

test('vouches.create rejects reason exceeding 500 characters', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-1', memberId: 'member-2', reason: 'x'.repeat(501) },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /500 character/);
      return true;
    },
  );
});

test('vouches.create returns 404 when target is not in club', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async createVouch() { return null; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-1', memberId: 'member-99', reason: 'Great person' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('vouches.list returns vouches for a member', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async listVouches() { return { results: [sampleVouch], hasMore: false, nextCursor: null }; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'vouches.list',
    payload: { memberId: 'member-2', clubId: 'club-1' },
  });

  assert.equal(result.action, 'vouches.list');
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].edgeId, 'edge-1');
  assert.equal(result.data.memberId, 'member-2');
});

test('vouches.create rejects club outside actor scope', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'vouches.create',
      payload: { clubId: 'club-999', memberId: 'member-2', reason: 'Good member' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'forbidden');
      return true;
    },
  );
});
