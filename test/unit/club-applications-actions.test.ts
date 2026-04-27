import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import { AppError } from '../../src/repository.ts';
import { encodeCursor } from '../../src/schemas/fields.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

test('accounts.register discover forwards the anonymous discover request and returns proof_required', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async registerAccount(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        phase: 'proof_required' as const,
        challenge: {
          challengeBlob: 'payload.signature',
          challengeId: 'challenge-1',
          hashInput: '${challengeId}:${nonce}',
          hashDigest: 'sha256-hex',
          successCondition: 'trailing_hex_zeroes',
          difficultyUnit: 'hex_nibbles',
          difficulty: 7,
          expiresAt: '2026-04-03T00:00:00Z',
        },
        next: {
          action: 'accounts.register',
          requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
          reason: 'Solve the PoW challenge and submit registration.',
        },
        messages: {
          summary: 'Registration challenge ready.',
          details: 'Solve the challenge and submit the signed proof.',
        },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'accounts.register',
    payload: {
      mode: 'discover',
    },
  });

  assert.deepEqual(capturedInput, {
    mode: 'discover',
    clientIp: null,
  });
  assert.equal(result.action, 'accounts.register');
  assert.equal(result.data.phase, 'proof_required');
  assert.equal('actor' in result, false);
});

test('accounts.register submit normalizes fields and returns the bearer once', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async registerAccount(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        phase: 'registered' as const,
        member: {
          memberId: 'member-9',
          publicName: 'Jane Doe',
          email: 'jane@example.com',
          registeredAt: '2026-04-03T00:00:00Z',
        },
        credentials: {
          kind: 'member_bearer' as const,
          memberBearer: 'clawclub_member_token',
          guidance: 'Save this token.',
        },
        next: {
          action: 'updates.list',
          reason: 'Registration succeeded.',
        },
        applicationLimits: {
          inFlightCount: 0,
          maxInFlight: 3,
        },
        messages: {
          summary: 'Registered.',
          details: 'Poll updates.list for next steps.',
        },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: null,
    action: 'accounts.register',
    payload: {
      mode: 'submit',
      clientKey: 'register-submit-1',
      name: '  Jane Doe  ',
      email: 'Jane@Example.COM ',
      challengeBlob: 'payload.signature',
      nonce: '42',
    },
  });

  assert.deepEqual(capturedInput, {
    mode: 'submit',
    clientKey: 'register-submit-1',
    name: 'Jane Doe',
    email: 'jane@example.com',
    challengeBlob: 'payload.signature',
    nonce: '42',
    clientIp: null,
  });
  assert.equal(result.action, 'accounts.register');
  assert.equal(result.data.phase, 'registered');
  assert.equal(result.data.credentials.memberBearer, 'clawclub_member_token');
  assert.equal(result.data.next.action, 'updates.list');
  assert.equal('actor' in result, false);
});

test('accounts.updateContactEmail normalizes email and uses the authenticated member', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async updateContactEmail(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        member: {
          memberId: 'member-1',
          publicName: 'Member One',
          email: 'member.one@example.com',
        },
        messages: {
          summary: 'Email updated.',
          details: 'Admins will now use this address for out-of-band contact.',
        },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'accounts.updateContactEmail',
    payload: {
      newEmail: ' Member.One@Example.com ',
      clientKey: 'email-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    newEmail: 'member.one@example.com',
    clientKey: 'email-1',
  });
  assert.equal(result.actor.member.id, 'member-1');
  assert.equal(result.data.member.email, 'member.one@example.com');
});

test('clubs.apply forwards the authenticated member and submitted payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async applyToClub(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-2',
          clubSlug: 'beta',
          clubName: 'Beta Club',
          clubSummary: 'A second club',
          admissionPolicy: 'Tell us why you fit.',
          submissionPath: 'cold' as const,
          sponsorName: null,
          phase: 'awaiting_review' as const,
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@janedoe',
          application: 'Love the community',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
          applicationId: 'application-1',
        },
        roadmap: [],
        feedback: null,
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.apply',
    payload: {
      clubSlug: 'beta',
      draft: {
        name: '  Jane Doe  ',
        socials: '  @janedoe  ',
        application: '  Love the community  ',
      },
      clientKey: 'apply-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    clubSlug: 'beta',
    draft: {
      name: 'Jane Doe',
      socials: '@janedoe',
      application: 'Love the community',
    },
    clientKey: 'apply-1',
  });
  assert.equal(result.action, 'clubs.apply');
  assert.equal(result.data.application.phase, 'awaiting_review');
  assert.equal(result.data.next.action, 'updates.list');
  assert.equal(result.actor.member.id, 'member-1');
});

test('invitations.redeem forwards the authenticated member and invitation payload', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async redeemInvitationApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-9',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'First club',
          admissionPolicy: 'Be kind.',
          submissionPath: 'invitation' as const,
          sponsorName: 'Sponsor One',
          phase: 'awaiting_review' as const,
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@janedoe',
          application: 'Excited to join.',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
          applicationId: 'application-9',
        },
        roadmap: [],
        feedback: null,
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.redeem',
    payload: {
      code: '7DK4-M9Q2',
      draft: {
        name: 'Jane Doe',
        socials: '@janedoe',
        application: 'Excited to join.',
      },
      clientKey: 'redeem-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    code: '7DK4-M9Q2',
    draft: {
      name: 'Jane Doe',
      socials: '@janedoe',
      application: 'Excited to join.',
    },
    clientKey: 'redeem-1',
  });
  assert.equal(result.action, 'invitations.redeem');
  assert.equal(result.data.application.submissionPath, 'invitation');
  assert.equal(result.data.next.action, 'updates.list');
});

test('clubs.applications.revise forwards the authenticated member and replacement draft', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async reviseClubApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'First club',
          admissionPolicy: 'Be kind.',
          submissionPath: 'cold' as const,
          sponsorName: null,
          phase: 'awaiting_review' as const,
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: null,
        },
        draft: {
          name: 'Jane Doe',
          socials: '@janedoe',
          application: 'Expanded and clearer.',
        },
        next: {
          action: 'updates.list',
          reason: 'Queued for review.',
          applicationId: 'application-1',
        },
        roadmap: [],
        feedback: null,
        applicationLimits: { inFlightCount: 1, maxInFlight: 3 },
        messages: { summary: 'Queued.', details: 'Awaiting review.' },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.revise',
    payload: {
      applicationId: 'application-1',
      draft: {
        name: 'Jane Doe',
        socials: '@janedoe',
        application: 'Expanded and clearer.',
      },
      clientKey: 'revise-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    applicationId: 'application-1',
    draft: {
      name: 'Jane Doe',
      socials: '@janedoe',
      application: 'Expanded and clearer.',
    },
    clientKey: 'revise-1',
  });
  assert.equal(result.action, 'clubs.applications.revise');
  assert.equal(result.data.application.phase, 'awaiting_review');
});

test('clubs.applications.get rejects applications outside the authenticated member ownership', async () => {
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async getMemberApplicationById() { return null; },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'clubs.applications.get',
      payload: { applicationId: 'application-missing' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'application_not_found');
      return true;
    },
  );
});

test('clubs.applications.list forwards phases and cursor to the repository', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async listMemberApplications(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        results: [],
        hasMore: false,
        nextCursor: null,
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.list',
    payload: {
      phases: ['awaiting_review', 'revision_required'],
      limit: 5,
      cursor: encodeCursor(['2026-04-03T00:00:00Z', 'application-1']),
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    phases: ['awaiting_review', 'revision_required'],
    limit: 5,
    cursor: {
      submittedAt: '2026-04-03T00:00:00Z',
      applicationId: 'application-1',
    },
  });
  assert.equal(result.action, 'clubs.applications.list');
  assert.deepEqual(result.data.results, []);
  assert.equal(result.data.limit, 5);
});

test('clubs.applications.withdraw forwards the authenticated member and returns the terminal state', async () => {
  let capturedInput: Record<string, unknown> | null = null;
  const repository = makeRepository({
    async authenticateBearerToken() { return makeAuthResult(); },
    async withdrawClubApplication(input) {
      capturedInput = input as Record<string, unknown>;
      return {
        application: {
          applicationId: 'application-1',
          clubId: 'club-1',
          clubSlug: 'alpha',
          clubName: 'Alpha Club',
          clubSummary: 'First club',
          admissionPolicy: 'Be kind.',
          submissionPath: 'cold' as const,
          sponsorName: null,
          phase: 'withdrawn' as const,
          submittedAt: '2026-04-03T00:00:00Z',
          decidedAt: '2026-04-04T00:00:00Z',
        },
        draft: {
          name: 'Jane Doe',
          socials: '@janedoe',
          application: 'No longer pursuing this.',
        },
        next: null,
        roadmap: [],
        feedback: null,
        applicationLimits: { inFlightCount: 0, maxInFlight: 3 },
        messages: { summary: 'Withdrawn.', details: 'The application is closed.' },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'clubs.applications.withdraw',
    payload: {
      applicationId: 'application-1',
      clientKey: 'withdraw-1',
    },
  });

  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    applicationId: 'application-1',
    clientKey: 'withdraw-1',
  });
  assert.equal(result.action, 'clubs.applications.withdraw');
  assert.equal(result.data.application.phase, 'withdrawn');
  assert.equal(result.data.next, null);
});
