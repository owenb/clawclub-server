import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../src/dispatch.ts';
import type { AdmissionSummary } from '../src/contract.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

const sampleAdmission: AdmissionSummary = {
  admissionId: 'admission-1',
  clubId: 'club-1',
  applicant: {
    memberId: null,
    publicName: 'Jane Doe',
    handle: null,
    email: 'jane@example.com',
  },
  sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
  membershipId: null,
  origin: 'member_sponsored',
  intake: {
    kind: 'other',
    price: { amount: null, currency: null },
    bookingUrl: null,
    bookedAt: null,
    completedAt: null,
  },
  state: {
    status: 'submitted',
    notes: 'Sponsored admission created by member',
    versionNo: 1,
    createdAt: '2026-04-02T00:00:00Z',
    createdByMemberId: 'member-1',
  },
  admissionDetails: { socials: '@janedoe' },
  metadata: {},
  createdAt: '2026-04-02T00:00:00Z',
};

test('admissions.sponsor creates a sponsorship for an outsider', async () => {
  let capturedInput: any = null;
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async createAdmissionSponsorship(input) {
      capturedInput = input;
      return sampleAdmission;
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'admissions.sponsor',
    payload: {
      clubId: 'club-1',
      name: 'Jane Doe',
      email: 'Jane@Example.com',
      socials: '@janedoe',
      reason: 'Excellent engineer, built production systems at scale',
    },
  });

  assert.equal(result.action, 'admissions.sponsor');
  assert.equal(result.data.admission.admissionId, 'admission-1');
  assert.equal(capturedInput.candidateName, 'Jane Doe');
  assert.equal(capturedInput.candidateEmail, 'jane@example.com');
  assert.equal(capturedInput.reason, 'Excellent engineer, built production systems at scale');
});

test('admissions.sponsor rejects single-word name', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'admissions.sponsor',
      payload: { clubId: 'club-1', name: 'Jane', email: 'j@x.com', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /full name/);
      return true;
    },
  );
});

test('admissions.sponsor rejects invalid email', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'admissions.sponsor',
      payload: { clubId: 'club-1', name: 'Jane Doe', email: 'nope', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /email/);
      return true;
    },
  );
});

test('admissions.sponsor rejects reason exceeding 500 characters', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'admissions.sponsor',
      payload: { clubId: 'club-1', name: 'Jane Doe', email: 'j@x.com', socials: '@j', reason: 'x'.repeat(501) },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /500 character/);
      return true;
    },
  );
});

test('admissions.sponsor rejects club outside actor scope', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'admissions.sponsor',
      payload: { clubId: 'club-999', name: 'Jane Doe', email: 'j@x.com', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test('admissions.list returns admissions for accessible clubs', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async listAdmissions() { return [sampleAdmission]; },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'admissions.list',
  });

  assert.equal(result.action, 'admissions.list');
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].applicant.publicName, 'Jane Doe');
});
