import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import type { SponsorshipSummary } from '../src/app-contract.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

const sampleSponsorship: SponsorshipSummary = {
  sponsorshipId: 'sp-1',
  networkId: 'network-1',
  sponsor: { memberId: 'member-1', publicName: 'Member One', handle: 'member-one' },
  candidateName: 'Jane Doe',
  candidateEmail: 'jane@example.com',
  candidateDetails: { socials: '@janedoe' },
  reason: 'Excellent engineer, built production systems at scale',
  createdAt: '2026-04-02T00:00:00Z',
};

test('sponsorships.create creates a sponsorship for an outsider', async () => {
  let capturedInput: any = null;
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async createSponsorship(input) {
      capturedInput = input;
      return sampleSponsorship;
    },
  });

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: 'test-token',
    action: 'sponsorships.create',
    payload: {
      networkId: 'network-1',
      name: 'Jane Doe',
      email: 'Jane@Example.com',
      socials: '@janedoe',
      reason: 'Excellent engineer, built production systems at scale',
    },
  });

  assert.equal(result.action, 'sponsorships.create');
  assert.equal(result.data.sponsorship.sponsorshipId, 'sp-1');
  assert.equal(capturedInput.candidateName, 'Jane Doe');
  assert.equal(capturedInput.candidateEmail, 'jane@example.com');
  assert.equal(capturedInput.reason, 'Excellent engineer, built production systems at scale');
});

test('sponsorships.create rejects single-word name', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'test-token',
      action: 'sponsorships.create',
      payload: { networkId: 'network-1', name: 'Jane', email: 'j@x.com', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /full name/);
      return true;
    },
  );
});

test('sponsorships.create rejects invalid email', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'test-token',
      action: 'sponsorships.create',
      payload: { networkId: 'network-1', name: 'Jane Doe', email: 'nope', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /email/);
      return true;
    },
  );
});

test('sponsorships.create rejects reason exceeding 500 characters', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'test-token',
      action: 'sponsorships.create',
      payload: { networkId: 'network-1', name: 'Jane Doe', email: 'j@x.com', socials: '@j', reason: 'x'.repeat(501) },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /500 characters/);
      return true;
    },
  );
});

test('sponsorships.create rejects network outside actor scope', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const app = buildApp({ repository });
  await assert.rejects(
    () => app.handleAction({
      bearerToken: 'test-token',
      action: 'sponsorships.create',
      payload: { networkId: 'network-999', name: 'Jane Doe', email: 'j@x.com', socials: '@j', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test('sponsorships.list returns sponsorships for accessible networks', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async listSponsorships() { return [sampleSponsorship]; },
  });

  const app = buildApp({ repository });
  const result: any = await app.handleAction({
    bearerToken: 'test-token',
    action: 'sponsorships.list',
  });

  assert.equal(result.action, 'sponsorships.list');
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].candidateName, 'Jane Doe');
});
