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

test('applications.challenge returns a PoW challenge and public network list', async () => {
  const repository = {
    ...makeRepository(),
    async createColdApplicationChallenge() { return challengeStub; },
  };

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: null,
    action: 'applications.challenge',
  });

  assert.equal(result.data.challengeId, 'c1');
  assert.equal(result.data.difficulty, 7);
  assert.equal(result.data.clubs.length, 1);
  assert.equal(result.data.clubs[0].slug, 'alpha');
});

test('applications.solve rejects single-word name', async () => {
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'applications.solve',
      payload: {
        challengeId: 'c1', nonce: '123',
        networkSlug: 'alpha', name: 'Jane',
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

test('applications.solve rejects invalid email', async () => {
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'applications.solve',
      payload: {
        challengeId: 'c1', nonce: '123',
        networkSlug: 'alpha', name: 'Jane Doe',
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

test('applications.solve rejects missing socials', async () => {
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'applications.solve',
      payload: {
        challengeId: 'c1', nonce: '123',
        networkSlug: 'alpha', name: 'Jane Doe',
        email: 'j@example.com', socials: '', reason: 'I want to join',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('applications.solve rejects missing reason', async () => {
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: null,
      action: 'applications.solve',
      payload: {
        challengeId: 'c1', nonce: '123',
        networkSlug: 'alpha', name: 'Jane Doe',
        email: 'j@example.com', socials: '@jane', reason: '',
      },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('applications.solve forwards all fields to repository', async () => {
  let capturedInput: any = null;
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge(input: any) {
      capturedInput = input;
      return { success: true };
    },
  };

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: null,
    action: 'applications.solve',
    payload: {
      challengeId: 'c1', nonce: '123',
      networkSlug: 'alpha', name: '  Jane   Doe  ',
      email: 'Jane@Example.COM', socials: '@janedoe on twitter', reason: 'Love the community',
    },
  });

  assert.equal(result.data.message, 'Application submitted. Watch your email — you will hear back soon.');
  assert.equal(capturedInput.name, 'Jane Doe');
  assert.equal(capturedInput.email, 'jane@example.com');
  assert.equal(capturedInput.socials, '@janedoe on twitter');
  assert.equal(capturedInput.reason, 'Love the community');
  assert.equal(capturedInput.networkSlug, 'alpha');
});

test('applications.solve rejects fields exceeding 500 characters', async () => {
  const repository = {
    ...makeRepository(),
    async solveColdApplicationChallenge() { return { success: true }; },
  };

  const app = buildApp({ repository });
  const longString = 'x'.repeat(501);

  for (const field of ['name', 'email', 'socials', 'reason', 'networkSlug']) {
    const payload: Record<string, string> = {
      challengeId: 'c1', nonce: '123',
      networkSlug: 'alpha', name: 'Jane Doe',
      email: 'j@example.com', socials: '@jane', reason: 'test',
    };
    payload[field] = field === 'name' ? `${'x'.repeat(250)} ${'y'.repeat(250)}` : longString;

    await assert.rejects(
      () => app.handleAction({
        bearerToken: null,
        action: 'applications.solve',
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
