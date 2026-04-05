import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../src/dispatch.ts';
import { makeRepository } from './fixtures.ts';

const challengeStub = {
  challengeId: 'c1',
  difficulty: 7,
  expiresAt: '2026-04-03T00:00:00Z',
  maxAttempts: 5,
  club: { slug: 'alpha', name: 'Alpha Club', summary: 'A test club', ownerName: 'Owner One', admissionPolicy: 'Tell us your name and city.' },
};

test('admissions.challenge returns a PoW challenge bound to a club', async () => {
  const repository = {
    ...makeRepository(),
    async createAdmissionChallenge() { return challengeStub; },
  };

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'admissions.challenge',
    payload: { clubSlug: 'alpha' },
  });

  assert.equal(result.data.challengeId, 'c1');
  assert.equal(result.data.difficulty, 7);
  assert.equal(result.data.maxAttempts, 5);
  assert.equal(result.data.club.slug, 'alpha');
  assert.equal(result.data.club.admissionPolicy, 'Tell us your name and city.');
  assert.equal(result.data.club.ownerEmail, undefined);
});

test('admissions.challenge rejects missing clubSlug', async () => {
  const repository = {
    ...makeRepository(),
    async createAdmissionChallenge() { return challengeStub; },
  };

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.challenge',
      payload: {},
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('admissions.apply rejects single-word name', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { status: 'accepted' as const, message: 'ok' }; },
  };

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        name: 'Jane',
        email: 'j@example.com', socials: '@jane', application: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /full name/);
      return true;
    },
  );
});

test('admissions.apply rejects invalid email', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { status: 'accepted' as const, message: 'ok' }; },
  };

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        name: 'Jane Doe',
        email: 'not-an-email', socials: '@jane', application: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /email/);
      return true;
    },
  );
});

test('admissions.apply rejects missing socials', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { status: 'accepted' as const, message: 'ok' }; },
  };

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        name: 'Jane Doe',
        email: 'j@example.com', socials: '', application: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('admissions.apply rejects missing application', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { status: 'accepted' as const, message: 'ok' }; },
  };

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        name: 'Jane Doe',
        email: 'j@example.com', socials: '@jane', application: '',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('admissions.apply forwards all fields to repository', async () => {
  let capturedInput: any = null;
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge(input: any) {
      capturedInput = input;
      return { status: 'accepted' as const, message: 'Submitted.' };
    },
  };

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'admissions.apply',
    payload: {
      challengeId: 'c1', nonce: '123',
      name: '  Jane   Doe  ',
      email: 'Jane@Example.COM', socials: '@janedoe on twitter', application: 'Love the community',
    },
  });

  assert.equal(result.data.status, 'accepted');
  assert.equal(result.data.message, 'Submitted.');
  assert.equal(capturedInput.name, 'Jane Doe');
  assert.equal(capturedInput.email, 'jane@example.com');
  assert.equal(capturedInput.socials, '@janedoe on twitter');
  assert.equal(capturedInput.application, 'Love the community');
  // No clubSlug — challenge carries the binding
  assert.equal(capturedInput.clubSlug, undefined);
});

test('admissions.apply returns needs_revision from repository', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() {
      return { status: 'needs_revision' as const, feedback: 'Missing city.', attemptsRemaining: 3 };
    },
  };

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'admissions.apply',
    payload: {
      challengeId: 'c1', nonce: '123',
      name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', application: 'test',
    },
  });

  assert.equal(result.data.status, 'needs_revision');
  assert.equal(result.data.feedback, 'Missing city.');
  assert.equal(result.data.attemptsRemaining, 3);
});

test('admissions.apply returns attempts_exhausted from repository', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() {
      return { status: 'attempts_exhausted' as const, message: 'All attempts used.' };
    },
  };

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'admissions.apply',
    payload: {
      challengeId: 'c1', nonce: '123',
      name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', application: 'test',
    },
  });

  assert.equal(result.data.status, 'attempts_exhausted');
});

test('admissions.apply accepts application up to 4000 characters', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() {
      return { status: 'accepted' as const, message: 'ok' };
    },
  };

  const dispatcher = buildDispatcher({ repository });

  // 4000 chars should succeed
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'admissions.apply',
    payload: {
      challengeId: 'c1', nonce: '123',
      name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', application: 'x'.repeat(4000),
    },
  });
  assert.equal(result.data.status, 'accepted');

  // 4001 chars should fail
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        name: 'Jane Doe',
        email: 'j@example.com', socials: '@jane', application: 'x'.repeat(4001),
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('admissions.apply rejects name, email, socials exceeding 500 characters', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { status: 'accepted' as const, message: 'ok' }; },
  };

  const dispatcher = buildDispatcher({ repository });
  const longString = 'x'.repeat(501);

  for (const field of ['name', 'email', 'socials']) {
    const payload: Record<string, string> = {
      challengeId: 'c1', nonce: '123',
      name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', application: 'test',
    };
    payload[field] = field === 'name' ? `${'x'.repeat(250)} ${'y'.repeat(250)}` : longString;

    await assert.rejects(
      () => dispatcher.dispatch({
        bearerToken: null,
        action: 'admissions.apply',
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
