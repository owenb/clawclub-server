import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { findPowNonce, prepareAccountRegistration } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

beforeEach(() => {
  h.__resetRateLimitForTests();
});

function challengeData(body: Record<string, unknown>): {
  challengeBlob: string;
  challengeId: string;
  difficulty: number;
  expiresAt: string;
} {
  const data = body.data as Record<string, unknown>;
  return data.challenge as {
    challengeBlob: string;
    challengeId: string;
    difficulty: number;
    expiresAt: string;
  };
}

async function submitInvitedRegistration(input: {
  invitationCode: string;
  discoverEmail: string;
  submitEmail?: string;
  clientKey: string;
  name?: string;
}): Promise<Record<string, unknown>> {
  const challenge = await prepareAccountRegistration(h, `${input.clientKey}-discover`, {
    invitationCode: input.invitationCode,
    email: input.discoverEmail,
  });
  const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
  return h.apiOk(null, 'accounts.register', {
    mode: 'submit',
    clientKey: input.clientKey,
    name: input.name ?? 'Invited Registrant',
    email: input.submitEmail ?? input.discoverEmail,
    challengeBlob: challenge.challengeBlob,
    nonce,
    invitationCode: input.invitationCode,
  });
}

async function submitInvitedRegistrationError(input: {
  invitationCode: string;
  discoverEmail: string;
  submitEmail?: string;
  clientKey: string;
  expectedCode: string;
}): Promise<{ status: number; code: string; message: string }> {
  const challenge = await prepareAccountRegistration(h, `${input.clientKey}-discover`, {
    invitationCode: input.invitationCode,
    email: input.discoverEmail,
  });
  const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
  return h.apiErr(null, 'accounts.register', {
    mode: 'submit',
    clientKey: input.clientKey,
    name: 'Invited Registrant',
    email: input.submitEmail ?? input.discoverEmail,
    challengeBlob: challenge.challengeBlob,
    nonce,
    invitationCode: input.invitationCode,
  }, input.expectedCode);
}

function tamperChallengePayload(
  challengeBlob: string,
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
): string {
  const [payloadPart, signaturePart] = challengeBlob.split('.');
  assert.ok(payloadPart);
  assert.ok(signaturePart);
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
  const nextPayload = mutate(payload);
  return `${Buffer.from(JSON.stringify(nextPayload), 'utf8').toString('base64url')}.${signaturePart}`;
}

describe('accounts.register invited proof-of-work', () => {
  it('uses cold difficulty without invitation context and invited difficulty with code plus email', async () => {
    const cold = challengeData(await h.apiOk(null, 'accounts.register', { mode: 'discover' }));
    assert.equal(cold.difficulty, 3);

    const invited = challengeData(await h.apiOk(null, 'accounts.register', {
      mode: 'discover',
      invitationCode: 'ABCD-2345',
      email: 'candidate@example.com',
    }));
    assert.equal(invited.difficulty, 2);
  });

  it('rejects invitationCode/email pairing mistakes and oversized codes at discover', async () => {
    const codeOnly = await h.apiErr(null, 'accounts.register', {
      mode: 'discover',
      invitationCode: 'ABCD-2345',
    }, 'invalid_input');
    assert.equal(codeOnly.status, 400);

    const emailOnly = await h.apiErr(null, 'accounts.register', {
      mode: 'discover',
      email: 'candidate@example.com',
    }, 'invalid_input');
    assert.equal(emailOnly.status, 400);

    const oversized = await h.apiErr(null, 'accounts.register', {
      mode: 'discover',
      invitationCode: 'A'.repeat(65),
      email: 'candidate@example.com',
    }, 'invalid_input');
    assert.equal(oversized.status, 400);
  });

  it('registers with a valid invite, records provenance, and does not consume the invite', async () => {
    const owner = await h.seedOwner('register-invited-happy', 'Register Invited Happy');
    const invitation = await h.seedInvitation(
      owner.club.id,
      owner.id,
      'jane.invited@example.com',
      { candidateName: 'Jane Invited' },
    );

    const body = await submitInvitedRegistration({
      invitationCode: invitation.code,
      discoverEmail: 'Jane.Invited@Example.com',
      clientKey: 'invited-register-happy',
      name: 'Jane Invited',
    });

    const data = body.data as Record<string, unknown>;
    assert.equal(data.phase, 'registered');
    const member = data.member as Record<string, unknown>;
    const [row] = await h.sql<{ registered_via_invite_request_id: string | null }>(
      `select registered_via_invite_request_id
         from members
        where id = $1`,
      [String(member.memberId)],
    );
    assert.equal(row?.registered_via_invite_request_id, invitation.id);

    const [inviteRow] = await h.sql<{ used_at: string | null }>(
      `select used_at::text as used_at
         from invite_requests
        where id = $1`,
      [invitation.id],
    );
    assert.equal(inviteRow?.used_at, null);
  });

  it('allows lower-case invite codes because MAC binding and lookup canonicalize consistently', async () => {
    const owner = await h.seedOwner('register-invited-lower', 'Register Invited Lower');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'lower.invited@example.com');

    const body = await submitInvitedRegistration({
      invitationCode: invitation.code.toLowerCase(),
      discoverEmail: 'lower.invited@example.com',
      clientKey: 'invited-register-lower',
      name: 'Lower Invited',
    });

    assert.equal((body.data as Record<string, unknown>).phase, 'registered');
  });

  it('rejects missing, changed, or unbound submit invitation codes as invalid_challenge', async () => {
    const owner = await h.seedOwner('register-invited-structural', 'Register Invited Structural');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'structural.invited@example.com');
    const challenge = await prepareAccountRegistration(h, 'invited-structural-discover', {
      invitationCode: invitation.code,
      email: 'structural.invited@example.com',
    });
    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);

    const missing = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'invited-structural-missing',
      name: 'Structural Missing',
      email: 'structural.invited@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
    }, 'invalid_challenge');
    assert.equal(missing.status, 422);

    const changed = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'invited-structural-changed',
      name: 'Structural Changed',
      email: 'structural.invited@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
      invitationCode: 'ZZZZ-9999',
    }, 'invalid_challenge');
    assert.equal(changed.status, 422);

    const cold = await prepareAccountRegistration(h, 'invited-structural-cold');
    const coldNonce = findPowNonce(cold.challengeId, cold.difficulty);
    const unbound = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'invited-structural-unbound',
      name: 'Structural Unbound',
      email: 'structural-unbound@example.com',
      challengeBlob: cold.challengeBlob,
      nonce: coldNonce,
      invitationCode: invitation.code,
    }, 'invalid_challenge');
    assert.equal(unbound.status, 422);
  });

  it('rejects submit email changes before invitation business checks', async () => {
    const owner = await h.seedOwner('register-invited-email-binding', 'Register Invited Email Binding');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'email.binding@example.com');

    const err = await submitInvitedRegistrationError({
      invitationCode: invitation.code,
      discoverEmail: 'email.binding@example.com',
      submitEmail: 'different.email@example.com',
      clientKey: 'invited-email-binding',
      expectedCode: 'invalid_challenge',
    });
    assert.equal(err.status, 422);
  });

  it('reports invitation business failures only after the bound code/email challenge is solved', async () => {
    const owner = await h.seedOwner('register-invited-business', 'Register Invited Business');
    const now = Date.now();
    const revoked = await h.seedInvitation(owner.club.id, owner.id, 'revoked.invited@example.com', {
      revokedAt: new Date(now - 60_000).toISOString(),
    });
    const expired = await h.seedInvitation(owner.club.id, owner.id, 'expired.invited@example.com', {
      expiresAt: new Date(now - 60_000).toISOString(),
    });
    const used = await h.seedInvitation(owner.club.id, owner.id, 'used.invited@example.com', {
      usedAt: new Date(now - 60_000).toISOString(),
    });
    const withdrawn = await h.seedInvitation(owner.club.id, owner.id, 'withdrawn.invited@example.com', {
      supportWithdrawnAt: new Date(now - 60_000).toISOString(),
    });

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: 'ZZZZ-9999',
      discoverEmail: 'missing.invited@example.com',
      clientKey: 'invited-missing',
      expectedCode: 'invitation_invalid',
    })).status, 404);

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: 'not-a-code',
      discoverEmail: 'malformed.invited@example.com',
      clientKey: 'invited-malformed',
      expectedCode: 'invitation_invalid',
    })).status, 404);

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: revoked.code,
      discoverEmail: 'revoked.invited@example.com',
      clientKey: 'invited-revoked',
      expectedCode: 'invitation_revoked',
    })).status, 409);

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: expired.code,
      discoverEmail: 'expired.invited@example.com',
      clientKey: 'invited-expired',
      expectedCode: 'invitation_expired',
    })).status, 409);

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: used.code,
      discoverEmail: 'used.invited@example.com',
      clientKey: 'invited-used',
      expectedCode: 'invitation_used',
    })).status, 409);

    assert.equal((await submitInvitedRegistrationError({
      invitationCode: withdrawn.code,
      discoverEmail: 'withdrawn.invited@example.com',
      clientKey: 'invited-withdrawn',
      expectedCode: 'invitation_support_withdrawn',
    })).status, 409);
  });

  it('rejects code-backed registration when the bound email does not match the invitation candidate email', async () => {
    const owner = await h.seedOwner('register-invited-email-mismatch', 'Register Invited Email Mismatch');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'sponsor.chose@example.com');

    const err = await submitInvitedRegistrationError({
      invitationCode: invitation.code,
      discoverEmail: 'registrant.used@example.com',
      clientKey: 'invited-business-email-mismatch',
      expectedCode: 'email_does_not_match_invite',
    });
    assert.equal(err.status, 409);
  });

  it('treats notification-delivery invitations as invalid for code-backed registration', async () => {
    const owner = await h.seedOwner('register-invited-notification', 'Register Invited Notification');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'notification.invited@example.com', {
      deliveryKind: 'notification',
      code: 'WXYZ-9876',
    });

    const err = await submitInvitedRegistrationError({
      invitationCode: invitation.code,
      discoverEmail: 'notification.invited@example.com',
      clientKey: 'invited-notification',
      expectedCode: 'invitation_invalid',
    });
    assert.equal(err.status, 404);
  });

  it('rejects tampering with the invite-code MAC inside the signed challenge blob', async () => {
    const owner = await h.seedOwner('register-invited-tamper', 'Register Invited Tamper');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'tamper.invited@example.com');
    const challenge = await prepareAccountRegistration(h, 'invited-tamper-discover', {
      invitationCode: invitation.code,
      email: 'tamper.invited@example.com',
    });
    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
    const tamperedBlob = tamperChallengePayload(challenge.challengeBlob, (payload) => ({
      ...payload,
      inviteCodeMac: 'A'.repeat(43),
    }));

    const err = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'invited-tamper',
      name: 'Tamper Invited',
      email: 'tamper.invited@example.com',
      challengeBlob: tamperedBlob,
      nonce,
      invitationCode: invitation.code,
    }, 'invalid_challenge');
    assert.equal(err.status, 422);
  });

  it('includes invitationCode in anonymous registration idempotency intent', async () => {
    const owner = await h.seedOwner('register-invited-idempotency', 'Register Invited Idempotency');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'idempotent.invited@example.com');
    const challenge = await prepareAccountRegistration(h, 'invited-idempotency-discover', {
      invitationCode: invitation.code,
      email: 'idempotent.invited@example.com',
    });
    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
    const request = {
      mode: 'submit',
      clientKey: 'invited-idempotency',
      name: 'Idempotent Invited',
      email: 'idempotent.invited@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
      invitationCode: invitation.code,
    };

    const first = await h.apiOk(null, 'accounts.register', request);
    assert.equal((first.data as Record<string, unknown>).phase, 'registered');

    const replay = await h.apiOk(null, 'accounts.register', request);
    assert.equal((replay.data as Record<string, unknown>).phase, 'registration_already_completed');
    assert.equal('credentials' in (replay.data as Record<string, unknown>), false);

    const conflict = await h.apiErr(null, 'accounts.register', {
      ...request,
      invitationCode: 'ZZZZ-9999',
    }, 'client_key_conflict');
    assert.equal(conflict.status, 409);
  });

  it('leaves the invitation redeemable after invited registration', async () => {
    const owner = await h.seedOwner('register-invited-redeem-after', 'Register Invited Redeem After');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'redeem.after@example.com', {
      candidateName: 'Redeem After',
    });
    const registered = await submitInvitedRegistration({
      invitationCode: invitation.code,
      discoverEmail: 'redeem.after@example.com',
      clientKey: 'invited-redeem-after-register',
      name: 'Redeem After',
    });
    const credentials = ((registered.data as Record<string, unknown>).credentials as Record<string, unknown>);

    const redeemed = await h.apiOk(String(credentials.memberBearer), 'invitations.redeem', {
      code: invitation.code,
      draft: {
        name: 'Redeem After',
        socials: '@redeemafter',
        application: 'I am redeeming the invitation after account registration.',
      },
      clientKey: 'invited-redeem-after-redeem',
    });
    const application = (redeemed.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(application.submissionPath, 'invitation');
  });
});
