import test from 'node:test';
import assert from 'node:assert/strict';
import type { InvitationSummary } from '../../src/repository.ts';
import { issueInvitation } from '../../src/clubs/unified.ts';
import { buildDispatcher } from '../../src/dispatch.ts';
import { makeAuthResult, makeRepository, passthroughGate } from './fixtures.ts';

const sampleInvitation: InvitationSummary = {
  invitationId: 'invitation-1',
  clubId: 'club-1',
  candidateName: 'Jane Doe',
  candidateEmail: 'jane@example.com',
  candidateMemberId: null,
  deliveryKind: 'code',
  code: '7DK4-M9Q2',
  sponsor: {
    memberId: 'member-1',
    publicName: 'Member One',
  },
  reason: 'Excellent engineer, built production systems at scale',
  status: 'open',
  quotaState: 'counted',
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
      };
    },
  });

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
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
  assert.equal(result.data.invitation.code, '7DK4-M9Q2');
  assert.match(result.data.messages.summary, /share this invitation code/i);
  assert.equal(capturedInput.clubId, 'club-1');
  assert.deepEqual(capturedInput.target, {
    kind: 'external_email',
    email: 'jane@example.com',
    nameHint: 'Jane Doe',
    source: 'email',
    sponsorLabel: 'Jane Doe',
  });
  assert.equal(capturedInput.reason, 'Excellent engineer, built production systems at scale');
});

test('invitations.issue targets an existing registered member by member id', async () => {
  let capturedInput: any = null;
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async issueInvitation(input) {
      capturedInput = input;
      return {
        invitation: {
          ...sampleInvitation,
          candidateMemberId: 'member-99',
          deliveryKind: 'notification',
          code: null,
        },
      };
    },
  });

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.issue',
    payload: {
      clubId: 'club-1',
      candidateMemberId: 'member-99',
      reason: 'Existing network member with strong moderation judgment.',
    },
  });

  assert.equal(result.action, 'invitations.issue');
  assert.equal(result.data.invitation.invitationId, 'invitation-1');
  assert.match(result.data.messages.summary, /notified in-app/i);
  assert.deepEqual(capturedInput, {
    actorMemberId: 'member-1',
    idempotencyActorContext: 'member:member-1:invitations.issue',
    idempotencyRequestValue: {
      actorMemberId: 'member-1',
      clubId: 'club-1',
      candidateMemberId: 'member-99',
      reason: 'Existing network member with strong moderation judgment.',
      clientKey: null,
    },
    clubId: 'club-1',
    reason: 'Existing network member with strong moderation judgment.',
    clientKey: null,
    target: {
      kind: 'member',
      memberId: 'member-99',
      publicName: 'Existing Member',
      email: 'existing@example.com',
      source: 'member_id',
      sponsorLabel: 'Existing Member',
    },
  });
});

test('invitations.issue rejects single-word name', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
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

test('clubs.apply rejects single-word draft name through the shared person-name field', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
  });

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'clubs.apply',
      payload: {
        clubSlug: 'club-1',
        draft: {
          name: 'Jane',
          socials: '',
          application: 'I want to join.',
        },
        clientKey: 'single-name-apply',
      },
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

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
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

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
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

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });
  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-token',
      action: 'invitations.issue',
      payload: { clubId: 'club-999', candidateName: 'Jane Doe', candidateEmail: 'j@x.com', reason: 'test' },
    }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'forbidden_scope');
      return true;
    },
  );
});

test('invitations.list returns invitations for the authenticated member', async () => {
  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async listIssuedInvitations() {
      return { results: [sampleInvitation], hasMore: false, nextCursor: null };
    },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'invitations.list',
    payload: { clubId: 'club-1', status: 'open' },
  });

  assert.equal(result.action, 'invitations.list');
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].candidateName, 'Jane Doe');
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

test('issueInvitation retries after a code collision on insert', async () => {
  let insertAttempts = 0;
  const client = {
    async query(sql: string) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('from accessible_club_memberships')) {
        return { rows: [{ ok: true }] };
      }
      if (sql.includes('select public_name from members')) {
        return { rows: [{ public_name: 'Member One' }] };
      }
      if (sql.includes("select pg_advisory_xact_lock(hashtext('invitation_issue:'")) {
        return { rows: [] };
      }
      if (sql === 'savepoint invite_request_insert_attempt' || sql === 'release savepoint invite_request_insert_attempt' || sql === 'rollback to savepoint invite_request_insert_attempt') {
        return { rows: [] };
      }
      if (sql.includes('set expired_at = now()')) {
        return { rows: [] };
      }
      if (sql.includes('from invite_requests ir') && sql.includes('candidate_email_normalized = $4')) {
        return { rows: [] };
      }
      if (sql.includes('with open_invitations as')) {
        return { rows: [{ count: '0' }] };
      }
      if (sql.includes('insert into invite_requests')) {
        insertAttempts += 1;
        if (insertAttempts === 1 && sql.includes("delivery_kind")) {
          // The collision happens on the code insert, after the request row exists.
          return {
            rows: [{
              invitation_id: 'invitation-1',
              club_id: 'club-1',
              sponsor_member_id: 'member-1',
              sponsor_public_name: 'Member One',
              candidate_name: 'Jane Doe',
              candidate_email: 'jane@example.com',
              candidate_email_normalized: 'jane@example.com',
              candidate_member_id: null,
              target_source: 'email',
              reason: 'Excellent engineer, built production systems at scale',
              delivery_kind: 'code',
              code: null,
              expires_at: '2026-05-02T00:00:00Z',
              expired_at: null,
              used_at: null,
              used_membership_id: null,
              revoked_at: null,
              support_withdrawn_at: null,
              created_at: '2026-04-02T00:00:00Z',
            }],
          };
        }
        return {
          rows: [{
            invitation_id: 'invitation-1',
            club_id: 'club-1',
            sponsor_member_id: 'member-1',
            sponsor_public_name: 'Member One',
            candidate_name: 'Jane Doe',
            candidate_email: 'jane@example.com',
            candidate_email_normalized: 'jane@example.com',
            candidate_member_id: null,
            target_source: 'email',
            reason: 'Excellent engineer, built production systems at scale',
            delivery_kind: 'code',
            code: null,
            expires_at: '2026-05-02T00:00:00Z',
            expired_at: null,
            used_at: null,
            used_membership_id: null,
            revoked_at: null,
            support_withdrawn_at: null,
            created_at: '2026-04-02T00:00:00Z',
          }],
        };
      }
      if (sql.includes('insert into invite_codes')) {
        if (insertAttempts === 1) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
            constraint: 'invite_codes_code_unique',
          });
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected query in issueInvitation retry test: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  const result = await issueInvitation(pool as any, {
    actorMemberId: 'member-1',
    clubId: 'club-1',
    reason: 'Excellent engineer, built production systems at scale',
    target: {
      kind: 'external_email',
      email: 'jane@example.com',
      nameHint: 'Jane Doe',
      source: 'email',
      sponsorLabel: 'Jane Doe',
    },
  });

  assert.equal(insertAttempts, 2);
  assert.match(String(result?.invitation.code), /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
});
