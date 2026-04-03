import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { makeRepository } from './fixtures.ts';

const challengeStub = {
  challengeId: 'c1',
  difficulty: 7,
  expiresAt: '2026-04-03T00:00:00Z',
  clubs: [{ slug: 'alpha', name: 'Alpha Club', summary: 'A test club' }],
};

test('admissions.challenge returns a PoW challenge and public club list', async () => {
  const repository = {
    ...makeRepository(),
    async createAdmissionChallenge() { return challengeStub; },
  };

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: null,
    action: 'admissions.challenge',
  });

  assert.equal(result.data.challengeId, 'c1');
  assert.equal(result.data.difficulty, 7);
  assert.equal(result.data.clubs.length, 1);
  assert.equal(result.data.clubs[0].slug, 'alpha');
});

test('admissions.apply rejects single-word name', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        clubSlug: 'alpha', name: 'Jane',
        email: 'j@example.com', socials: '@jane', reason: 'I want to join',
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
    async solveAdmissionChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        clubSlug: 'alpha', name: 'Jane Doe',
        email: 'not-an-email', socials: '@jane', reason: 'I want to join',
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
    async solveAdmissionChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        clubSlug: 'alpha', name: 'Jane Doe',
        email: 'j@example.com', socials: '', reason: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('admissions.apply rejects missing reason', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'admissions.apply',
      payload: {
        challengeId: 'c1', nonce: '123',
        clubSlug: 'alpha', name: 'Jane Doe',
        email: 'j@example.com', socials: '@jane', reason: '',
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
      return { success: true };
    },
  };

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: null,
    action: 'admissions.apply',
    payload: {
      challengeId: 'c1', nonce: '123',
      clubSlug: 'alpha', name: '  Jane   Doe  ',
      email: 'Jane@Example.COM', socials: '@janedoe on twitter', reason: 'Love the community',
    },
  });

  assert.equal(result.data.message, 'Admission submitted. The club owner will review your request.');
  assert.equal(capturedInput.name, 'Jane Doe');
  assert.equal(capturedInput.email, 'jane@example.com');
  assert.equal(capturedInput.socials, '@janedoe on twitter');
  assert.equal(capturedInput.reason, 'Love the community');
  assert.equal(capturedInput.clubSlug, 'alpha');
});

test('admissions.apply rejects fields exceeding 500 characters', async () => {
  const repository = {
    ...makeRepository(),
    async solveAdmissionChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  const longString = 'x'.repeat(501);

  for (const field of ['name', 'email', 'socials', 'reason', 'clubSlug']) {
    const payload: Record<string, string> = {
      challengeId: 'c1', nonce: '123',
      clubSlug: 'alpha', name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', reason: 'test',
    };
    payload[field] = field === 'name' ? `${'x'.repeat(250)} ${'y'.repeat(250)}` : longString;

    await assert.rejects(
      () => app.handleAction({
        bearerToken: null,
        action: 'admissions.apply',
        payload,
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /500 characters/);
        return true;
      },
      `expected ${field} to be rejected when > 500 chars`,
    );
  }
});
