import test from 'node:test';
import assert from 'node:assert/strict';
import type { InvitationSummary } from '../../src/contract.ts';
import { buildDispatcher } from '../../src/dispatch.ts';
import { makeAuthResult, makeRepository, passthroughGate } from './fixtures.ts';

const sampleInvitation: InvitationSummary = {
  invitationId: 'invitation-1',
  clubId: 'club-1',
  candidateName: 'Jane Doe',
  candidateEmail: 'jane@example.com',
  sponsor: {
    memberId: 'member-1',
    publicName: 'Member One',
    handle: 'member-one',
  },
  reason: 'Excellent engineer, built production systems at scale',
  status: 'open',
  expiresAt: '2026-05-02T00:00:00Z',
  createdAt: '2026-04-02T00:00:00Z',
};

test('invitations.issue creates an invitation for a specific candidate', async () => {
  let capturedInput: any = null;
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async issueInvitation(input) {
      capturedInput = input;
      return {
        invitation: sampleInvitation,
        invitationCode: 'cc_inv_invitation-1_secret',
      };
    },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.issue',
    payload: {
      clubId: 'club-1',
      candidateName: 'Jane Doe',
      candidateEmail: 'Jane@Example.com',
      reason: 'Excellent engineer, built production systems at scale',
    },
  });

  assert.equal(result.action, 'invitations.issue');
  assert.equal(result.data.invitation.invitationId, 'invitation-1');
  assert.equal(result.data.invitationCode, 'cc_inv_invitation-1_secret');
  assert.equal(capturedInput.clubId, 'club-1');
  assert.equal(capturedInput.candidateName, 'Jane Doe');
  assert.equal(capturedInput.candidateEmail, 'jane@example.com');
  assert.equal(capturedInput.reason, 'Excellent engineer, built production systems at scale');
});

test('invitations.issue rejects single-word name', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'invitations.issue',
      payload: { clubId: 'club-1', candidateName: 'Jane', candidateEmail: 'j@x.com', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /full name/i);
      return true;
    },
  );
});

test('invitations.issue rejects invalid email', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'invitations.issue',
      payload: { clubId: 'club-1', candidateName: 'Jane Doe', candidateEmail: 'nope', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /email/i);
      return true;
    },
  );
});

test('invitations.issue rejects non-ASCII email', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'invitations.issue',
      payload: { clubId: 'club-1', candidateName: 'Jane Doe', candidateEmail: 'jóse@example.com', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /ASCII/i);
      return true;
    },
  );
});

test('invitations.issue rejects clubs outside the caller access scope before running the gate', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async issueInvitation() { return null; },
  });

  const dispatcher = buildDispatcher({ repository, qualityGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'invitations.issue',
      payload: { clubId: 'club-999', candidateName: 'Jane Doe', candidateEmail: 'j@x.com', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'forbidden');
      return true;
    },
  );
});

test('invitations.listMine returns invitations for the authenticated member', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async listIssuedInvitations() { return [sampleInvitation]; },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.listMine',
    payload: { clubId: 'club-1', status: 'open' },
  });

  assert.equal(result.action, 'invitations.listMine');
  assert.equal(result.data.invitations.length, 1);
  assert.equal(result.data.invitations[0].candidateName, 'Jane Doe');
});

test('invitations.revoke returns the revoked invitation', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async revokeInvitation() {
      return { ...sampleInvitation, status: 'revoked' as const };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.revoke',
    payload: { invitationId: 'invitation-1' },
  });

  assert.equal(result.action, 'invitations.revoke');
  assert.equal(result.data.invitation.invitationId, 'invitation-1');
  assert.equal(result.data.invitation.status, 'revoked');
});
