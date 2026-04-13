import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

const joinStub = {
  memberToken: 'cc_live_member_abc',
  clubId: 'club-1',
  membershipId: 'membership-1',
  proof: {
    kind: 'pow' as const,
    challengeId: 'c1',
    difficulty: 7,
    expiresAt: '2026-04-03T00:00:00Z',
    maxAttempts: 5,
  },
  club: {
    name: 'Alpha Club',
    summary: 'A test club',
    ownerName: 'Owner One',
    admissionPolicy: 'Tell us your name and city.',
    priceUsd: null,
  },
};

test('clubs.join returns a PoW challenge bound to a club for anonymous callers', async () => {
  let capturedInput: any = null;
  const repository = makeRepository({
    async joinClub(input) {
      capturedInput = input;
      return joinStub;
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'clubs.join',
    payload: { clubSlug: 'alpha', email: 'Jane@Example.COM ' },
  });

  assert.equal(result.action, 'clubs.join');
  assert.equal(result.data.memberToken, 'cc_live_member_abc');
  assert.equal(result.data.clubId, 'club-1');
  assert.equal(result.data.membershipId, 'membership-1');
  assert.equal(result.data.proof.challengeId, 'c1');
  assert.equal(result.data.proof.difficulty, 7);
  assert.equal(result.data.club.admissionPolicy, 'Tell us your name and city.');
  assert.equal(capturedInput.actorMemberId, null);
  assert.equal(capturedInput.clubSlug, 'alpha');
  assert.equal(capturedInput.email, 'jane@example.com');
  assert.equal(capturedInput.invitationCode, undefined);
});

test('clubs.join rejects missing clubSlug', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository() });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'clubs.join',
      payload: { email: 'jane@example.com' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('clubs.join rejects invalid email', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository() });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'clubs.join',
      payload: { clubSlug: 'alpha', email: 'not-an-email' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /email/i);
      return true;
    },
  );
});

test('clubs.join rejects non-ASCII email addresses', async () => {
  const dispatcher = buildDispatcher({ repository: makeRepository() });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'clubs.join',
      payload: { clubSlug: 'alpha', email: 'jóse@example.com' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /ASCII/i);
      return true;
    },
  );
});

test('clubs.applications.submit forwards all fields to repository', async () => {
  let capturedInput: any = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async submitClubApplication(input) {
      capturedInput = input;
      return {
        status: 'submitted' as const,
        membershipId: 'membership-1',
        applicationSubmittedAt: '2026-04-03T00:00:00Z',
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.submit',
    payload: {
      membershipId: 'membership-1',
      nonce: '123',
      name: '  Jane Doe  ',
      socials: '  @janedoe on twitter  ',
      application: '  Love the community  ',
    },
  });

  assert.equal(result.action, 'clubs.applications.submit');
  assert.equal(result.data.status, 'submitted');
  assert.equal(result.data.membershipId, 'membership-1');
  assert.equal(capturedInput.actorMemberId, 'member-1');
  assert.equal(capturedInput.membershipId, 'membership-1');
  assert.equal(capturedInput.nonce, '123');
  assert.equal(capturedInput.name, 'Jane Doe');
  assert.equal(capturedInput.socials, '@janedoe on twitter');
  assert.equal(capturedInput.application, 'Love the community');
});

test('clubs.applications.submit returns needs_revision from repository', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async submitClubApplication() {
      return { status: 'needs_revision' as const, feedback: 'Missing city.', attemptsRemaining: 3 };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.submit',
    payload: {
      membershipId: 'membership-1',
      nonce: '123',
      name: 'Jane Doe',
      socials: '@jane',
      application: 'test',
    },
  });

  assert.equal(result.data.status, 'needs_revision');
  assert.equal(result.data.feedback, 'Missing city.');
  assert.equal(result.data.attemptsRemaining, 3);
});

test('clubs.applications.submit returns attempts_exhausted from repository', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async submitClubApplication() {
      return { status: 'attempts_exhausted' as const, message: 'All attempts used.' };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.submit',
    payload: {
      membershipId: 'membership-1',
      nonce: '123',
      name: 'Jane Doe',
      socials: '@jane',
      application: 'test',
    },
  });

  assert.equal(result.data.status, 'attempts_exhausted');
  assert.equal(result.data.message, 'All attempts used.');
});

test('clubs.applications.submit rejects missing socials', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'clubs.applications.submit',
      payload: {
        membershipId: 'membership-1',
        nonce: '123',
        name: 'Jane Doe',
        socials: '',
        application: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('clubs.applications.submit rejects missing application', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'clubs.applications.submit',
      payload: {
        membershipId: 'membership-1',
        nonce: '123',
        name: 'Jane Doe',
        socials: '@jane',
        application: '',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('clubs.applications.submit accepts application up to 4000 characters', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async submitClubApplication() {
      return { status: 'submitted' as const, membershipId: 'membership-1', applicationSubmittedAt: '2026-04-03T00:00:00Z' };
    },
  });

  const dispatcher = buildDispatcher({ repository });

  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.submit',
    payload: {
      membershipId: 'membership-1',
      nonce: '123',
      name: 'Jane Doe',
      socials: '@jane',
      application: 'x'.repeat(4000),
    },
  });
  assert.equal(result.data.status, 'submitted');

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'clubs.applications.submit',
      payload: {
        membershipId: 'membership-1',
        nonce: '123',
        name: 'Jane Doe',
        socials: '@jane',
        application: 'x'.repeat(4001),
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('clubs.applications.submit rejects name and socials exceeding 500 characters', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
  });

  const dispatcher = buildDispatcher({ repository });
  const longString = 'x'.repeat(501);

  for (const field of ['name', 'socials'] as const) {
    const payload: Record<string, string> = {
      membershipId: 'membership-1',
      nonce: '123',
      name: 'Jane Doe',
      socials: '@jane',
      application: 'test',
    };
    payload[field] = longString;

    await assert.rejects(
      () => dispatcher.dispatch({
        bearerToken: 'test-token',
        action: 'clubs.applications.submit',
        payload,
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        return true;
      },
      `expected ${field} to be rejected when > 500 chars`,
    );
  }
});
