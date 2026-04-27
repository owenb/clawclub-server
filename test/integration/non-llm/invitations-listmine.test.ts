import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

type ApiResult = Awaited<ReturnType<TestHarness['api']>>;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('invitations.list', () => {
  it('returns readable codes and raises invitation_already_open on same-tuple reissue', async () => {
    const sponsor = await h.seedOwner('invite-recovery-club', 'Invite Recovery Club');

    const first = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Nina Example',
      candidateEmail: 'nina@example.com',
      reason: 'I have worked closely with Nina on moderation workflows and she would contribute practical operator judgment.',
      clientKey: 'invite-recovery-1',
    });
    const firstInvitation = (first.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const code = String(firstInvitation.code ?? '');
    assert.match(code, /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
    assert.deepEqual(Object.keys(first.data as Record<string, unknown>).sort(), ['invitation', 'messages']);

    const { status, body } = await h.api(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Nina Example',
      candidateEmail: 'nina@example.com',
      reason: 'I have worked closely with Nina on moderation workflows and she would contribute practical operator judgment.',
      clientKey: 'invite-recovery-2',
    });
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invitation_already_open');
    const details = error.details as Record<string, unknown>;
    const secondInvitation = details.invitation as Record<string, unknown>;
    assert.equal(secondInvitation.invitationId, firstInvitation.invitationId);
    assert.equal(secondInvitation.code, code);

    const listed = await h.apiOk(sponsor.token, 'invitations.list', {
      clubId: sponsor.club.id,
    });
    const invitations = ((listed.data as Record<string, unknown>).results as Array<Record<string, unknown>>);
    const listedInvitation = invitations.find((invitation) => invitation.invitationId === firstInvitation.invitationId);
    assert.equal(listedInvitation?.code, code);
    const actor = listed.actor as Record<string, unknown>;
    const requestScope = actor.requestScope as Record<string, unknown>;
    assert.deepEqual(requestScope.activeClubIds, [sponsor.club.id]);
  });

  it('rejects unknown or inaccessible club filters before listing', async () => {
    const sponsor = await h.seedOwner('invite-scope-source', 'Invite Scope Source');
    const other = await h.seedOwner('invite-scope-other', 'Invite Scope Other');

    const unknown = await h.apiErr(sponsor.token, 'invitations.list', {
      clubId: 'unknown-club',
    });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.code, 'forbidden_scope');

    const foreign = await h.apiErr(sponsor.token, 'invitations.list', {
      clubId: other.club.id,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.code, 'forbidden_scope');
  });

  it('rejects invitation issue on archived clubs before creating a row', async () => {
    const admin = await h.seedSuperadmin('Invite Archived Admin');
    const sponsor = await h.seedOwner('invite-archived-club', 'Invite Archived Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', {
      clientKey: 'invite-archived-club-archive',
      clubId: sponsor.club.id,
    });

    const err = await h.apiErr(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Archived Candidate',
      candidateEmail: 'archived-candidate@example.com',
      reason: 'This candidate has helped with repeated operator workflows and community moderation.',
      clientKey: 'invite-archived-club-issue',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_scope');

    const rows = await h.sql<{ count: string }>(
      `select count(*)::text as count from invite_requests where club_id = $1`,
      [sponsor.club.id],
    );
    assert.equal(rows[0]?.count, '0');
  });

  it('replays the original success for same clientKey and same payload', async () => {
    const sponsor = await h.seedOwner('invite-replay-club', 'Invite Replay Club');
    const request = {
      clubId: sponsor.club.id,
      candidateName: 'Riley Replay',
      candidateEmail: 'riley-replay@example.com',
      reason: 'I know Riley through repeated moderation and operations work and they would fit the club well.',
      clientKey: 'invite-replay-1',
    };

    const first = await h.apiOk(sponsor.token, 'invitations.issue', request);
    const second = await h.apiOk(sponsor.token, 'invitations.issue', request);

    assert.deepEqual(second.data, first.data);
  });

  it('clientKey is scoped to the sponsor, not global across actors', async () => {
    const firstSponsor = await h.seedOwner('invite-actor-scope-a', 'Invite Actor Scope A');
    const secondSponsor = await h.seedOwner('invite-actor-scope-b', 'Invite Actor Scope B');
    const clientKey = 'shared-invitation-sponsor-key';

    const first = await h.apiOk(firstSponsor.token, 'invitations.issue', {
      clubId: firstSponsor.club.id,
      candidateName: 'Actor Scope One',
      candidateEmail: 'actor-scope-one@example.com',
      reason: 'This candidate has helped with repeated operator workflows and community moderation.',
      clientKey,
    });
    const second = await h.apiOk(secondSponsor.token, 'invitations.issue', {
      clubId: secondSponsor.club.id,
      candidateName: 'Actor Scope Two',
      candidateEmail: 'actor-scope-two@example.com',
      reason: 'This candidate has helped with repeated operator workflows and community moderation.',
      clientKey,
    });

    const firstInvitation = (first.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const secondInvitation = (second.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.notEqual(firstInvitation.invitationId, secondInvitation.invitationId);
    assert.equal(firstInvitation.clubId, firstSponsor.club.id);
    assert.equal(secondInvitation.clubId, secondSponsor.club.id);
  });

  it('settles concurrent same-tuple issue attempts to one success and one invitation_already_open conflict', async () => {
    const sponsor = await h.seedOwner('invite-race-club', 'Invite Race Club');

    const results = await Promise.all([
      h.api(sponsor.token, 'invitations.issue', {
        clubId: sponsor.club.id,
        candidateName: 'Avery Concurrent',
        candidateEmail: 'avery-concurrent@example.com',
        reason: 'Avery has repeatedly helped with club operations and moderation workflows.',
        clientKey: 'invite-race-1',
      }),
      h.api(sponsor.token, 'invitations.issue', {
        clubId: sponsor.club.id,
        candidateName: 'Avery Concurrent',
        candidateEmail: 'avery-concurrent@example.com',
        reason: 'Avery has repeatedly helped with club operations and moderation workflows.',
        clientKey: 'invite-race-2',
      }),
    ]) as [ApiResult, ApiResult];

    assert.deepEqual(
      results.map((result) => result.status).sort((left, right) => left - right),
      [200, 409],
    );

    const success = results.find((result) => result.status === 200);
    const conflict = results.find((result) => result.status === 409);
    assert.ok(success);
    assert.ok(conflict);
    assert.equal(success.body.ok, true);
    assert.equal(conflict.body.ok, false);

    const successInvitation = ((success.body.data as Record<string, unknown>).invitation as Record<string, unknown>);
    const conflictError = conflict.body.error as Record<string, unknown>;
    assert.equal(conflictError.code, 'invitation_already_open');
    const conflictInvitation = (((conflictError.details as Record<string, unknown>).invitation) as Record<string, unknown>);
    assert.equal(conflictInvitation.invitationId, successInvitation.invitationId);
    assert.equal(conflictInvitation.code, successInvitation.code);
  });

  it('enforces one open sponsor invitation per normalized candidate email across target modes', async () => {
    const sponsor = await h.seedOwner('invite-unified-candidate-index', 'Invite Unified Candidate Index');
    const candidate = await h.seedMember('Unified Invite Candidate', 'unified-invite-candidate@example.com');
    await h.sql(
      `insert into invite_requests (
         club_id,
         sponsor_member_id,
         candidate_name,
         candidate_email,
         reason,
         delivery_kind,
         target_source,
         expires_at
       )
       values ($1, $2, 'Unified Invite Candidate', 'UNIFIED-INVITE-CANDIDATE@example.com', 'Seed external invite.', 'code', 'email', now() + interval '30 days')`,
      [sponsor.club.id, sponsor.id],
    );

    await assert.rejects(
      () => h.sql(
        `insert into invite_requests (
           club_id,
           sponsor_member_id,
           candidate_name,
           candidate_email,
           candidate_member_id,
           reason,
           delivery_kind,
           target_source,
           expires_at
         )
         values ($1, $2, 'Unified Invite Candidate', 'unified-invite-candidate@example.com', $3, 'Seed in-app invite.', 'notification', 'member_id', now() + interval '30 days')`,
        [sponsor.club.id, sponsor.id, candidate.id],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23505');
        assert.equal((error as { constraint?: string }).constraint, 'invite_requests_open_per_sponsor_candidate_idx');
        return true;
      },
    );
  });

  it('returns quotaState that matches live sponsor-slot occupancy', async () => {
    const sponsor = await h.seedOwner('invite-quota-club', 'Invite Quota Club');

    const openInvitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'open@quota.test');

    const liveInvitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'live@quota.test', {
      usedAt: new Date().toISOString(),
    });
    const liveApplicant = await h.seedMember('Live Invite Applicant');
    await h.seedApplication(sponsor.club.id, liveApplicant.id, {
      phase: 'awaiting_review',
      submissionPath: 'invitation',
      invitationId: liveInvitation.id,
      sponsorId: sponsor.id,
    });

    const terminalInvitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'terminal@quota.test', {
      usedAt: new Date().toISOString(),
    });
    const terminalApplicant = await h.seedMember('Terminal Invite Applicant');
    await h.seedApplication(sponsor.club.id, terminalApplicant.id, {
      phase: 'declined',
      submissionPath: 'invitation',
      invitationId: terminalInvitation.id,
      sponsorId: sponsor.id,
      decidedAt: new Date().toISOString(),
    });

    const revokedInvitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'revoked@quota.test', {
      revokedAt: new Date().toISOString(),
    });

    const body = await h.apiOk(sponsor.token, 'invitations.list', {
      clubId: sponsor.club.id,
    });
    const invitations = ((body.data as Record<string, unknown>).results as Array<Record<string, unknown>>);
    const byId = new Map(invitations.map((invitation) => [invitation.invitationId as string, invitation]));

    assert.equal(byId.get(openInvitation.id)?.status, 'open');
    assert.equal(byId.get(openInvitation.id)?.quotaState, 'counted');

    assert.equal(byId.get(liveInvitation.id)?.status, 'used');
    assert.equal(byId.get(liveInvitation.id)?.quotaState, 'counted');

    assert.equal(byId.get(terminalInvitation.id)?.status, 'used');
    assert.equal(byId.get(terminalInvitation.id)?.quotaState, 'free');

    assert.equal(byId.get(revokedInvitation.id)?.status, 'revoked');
    assert.equal(byId.get(revokedInvitation.id)?.quotaState, 'free');
    assert.match(String(byId.get(openInvitation.id)?.code ?? ''), /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
  });

  it('redacts code when a clubadmin revokes another sponsor invitation but preserves it for sponsor self-revoke', async () => {
    const owner = await h.seedOwner('invite-revoke-redact', 'Invite Revoke Redact');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Sponsor Member');

    const sponsorIssue = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Other Candidate',
      candidateEmail: 'other-candidate@example.com',
      reason: 'I know this candidate through careful moderation work and they would fit the club well.',
      clientKey: 'invite-redact-1',
    });
    const sponsorInvitation = (sponsorIssue.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const redacted = await h.apiOk(owner.token, 'invitations.revoke', {
      invitationId: sponsorInvitation.invitationId,
    });
    assert.equal(((redacted.data as Record<string, unknown>).invitation as Record<string, unknown>).code, null);

    const selfIssue = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Self Candidate',
      candidateEmail: 'self-candidate@example.com',
      reason: 'I know this candidate through careful moderation work and they would fit the club well.',
      clientKey: 'invite-redact-2',
    });
    const selfInvitation = (selfIssue.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const selfRevoked = await h.apiOk(sponsor.token, 'invitations.revoke', {
      invitationId: selfInvitation.invitationId,
    });
    assert.match(
      String(((selfRevoked.data as Record<string, unknown>).invitation as Record<string, unknown>).code ?? ''),
      /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/,
    );
  });

  it('redeem uses the same invalid_invitation_code message for revoked and garbage codes', async () => {
    const sponsor = await h.seedOwner('invite-redeem-oracle', 'Invite Redeem Oracle');
    const candidate = await h.seedMember('Redeem Oracle Candidate', 'redeem-oracle@example.com');
    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Redeem Oracle Candidate',
      candidateEmail: 'external-redeem-oracle@example.com',
      reason: 'This candidate has helped with careful community operations and moderation.',
      clientKey: 'invite-redeem-oracle-issue',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const code = String(invitation.code);
    await h.apiOk(sponsor.token, 'invitations.revoke', {
      invitationId: String(invitation.invitationId),
    });

    const revoked = await h.apiErr(candidate.token, 'invitations.redeem', {
      code,
      draft: {
        name: 'Redeem Oracle Candidate',
        socials: '@redeemoracle',
        application: 'I can contribute practical community operations experience.',
      },
      clientKey: 'invite-redeem-oracle-revoked',
    });
    const garbage = await h.apiErr(candidate.token, 'invitations.redeem', {
      code: 'NOPE-NOPE',
      draft: {
        name: 'Redeem Oracle Candidate',
        socials: '@redeemoracle',
        application: 'I can contribute practical community operations experience.',
      },
      clientKey: 'invite-redeem-oracle-garbage',
    });

    assert.equal(revoked.code, 'invalid_invitation_code');
    assert.equal(garbage.code, 'invalid_invitation_code');
    assert.equal(revoked.message, garbage.message);
  });

  it('revoke-then-revoke returns invitation_already_revoked with canonical invitation details', async () => {
    const sponsor = await h.seedOwner('invite-revoke-conflict', 'Invite Revoke Conflict');
    const invitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'already-revoked@example.com', {
      candidateName: 'Already Revoked',
      reason: 'Invitation used for revoke conflict coverage.',
    });

    await h.apiOk(sponsor.token, 'invitations.revoke', { invitationId: invitation.id });
    const second = await h.api(sponsor.token, 'invitations.revoke', { invitationId: invitation.id });

    assert.equal(second.status, 409);
    assert.equal(second.body.ok, false);
    const error = second.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invitation_already_revoked');
    const details = error.details as Record<string, unknown>;
    const current = details.invitation as Record<string, unknown>;
    assert.equal(current.invitationId, invitation.id);
    assert.equal(current.status, 'revoked');
  });

  it('revoke on an expired invitation returns invitation_already_expired', async () => {
    const sponsor = await h.seedOwner('invite-expired-conflict', 'Invite Expired Conflict');
    const invitation = await h.seedInvitation(sponsor.club.id, sponsor.id, 'already-expired@example.com', {
      candidateName: 'Already Expired',
      reason: 'Invitation used for expired conflict coverage.',
      expiresAt: '2020-01-01T00:00:00Z',
    });

    const result = await h.api(sponsor.token, 'invitations.revoke', { invitationId: invitation.id });

    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    const error = result.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invitation_already_expired');
    const details = error.details as Record<string, unknown>;
    const current = details.invitation as Record<string, unknown>;
    assert.equal(current.invitationId, invitation.id);
    assert.equal(current.status, 'expired');
  });
});

describe('invitations.issue existing-member delivery', () => {
  it('accepts candidateMemberId, notifies the existing member, and still requires apply', async () => {
    const sponsor = await h.seedOwner('invite-existing-member-club', 'Invite Existing Member Club');
    const candidate = await h.seedMember('Existing Member Candidate', 'existing-member-candidate@example.com');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateMemberId: candidate.id,
      reason: 'We have worked together on careful moderation and I want them to join this new club through the normal application route.',
      clientKey: 'invite-existing-member-1',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.equal(invitation.candidateName, candidate.publicName);
    assert.equal(invitation.candidateEmail, 'existing-member-candidate@example.com');
    assert.equal(invitation.candidateMemberId, candidate.id);
    assert.equal(invitation.deliveryKind, 'notification');
    assert.equal(invitation.code, null);

    const updates = await h.apiOk(candidate.token, 'updates.list', {
      notifications: { limit: 20 },
      inbox: { unreadOnly: false, limit: 20 },
    });
    const notifications = ((updates.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const received = notifications.find((row) => row.topic === 'invitation.received');
    assert.ok(received, 'existing registered member should receive an invitation.received notification');
    assert.equal(received?.clubId ?? null, null);
    const payload = (received?.payload ?? {}) as Record<string, unknown>;
    assert.equal(payload.invitationId, invitation.invitationId);
    assert.equal('code' in payload, false);
    assert.equal(payload.deliveryKind, 'notification');
    assert.equal(payload.candidateMemberId, candidate.id);
    assert.equal(((payload.club ?? {}) as Record<string, unknown>).clubId, sponsor.club.id);
    assert.equal((((payload.next ?? {}) as Record<string, unknown>).action), 'clubs.apply');

    const refs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [received?.notificationId],
    );
    assert.deepEqual(refs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: sponsor.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: sponsor.club.id },
      { ref_role: 'subject', ref_kind: 'invitation', ref_id: String(invitation.invitationId) },
      { ref_role: 'target', ref_kind: 'member', ref_id: candidate.id },
    ]);

    const sessionBefore = await h.apiOk(candidate.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(sessionBefore)
        .some((membership) => membership.clubId === sponsor.club.id),
      false,
      'the notification should not grant membership by itself',
    );

    const applied = await h.apiOk(candidate.token, 'clubs.apply', {
      clubSlug: sponsor.club.slug,
      invitationId: String(payload.invitationId),
      draft: {
        name: candidate.publicName,
        socials: '@existingmembercandidate',
        application: 'I want to join this club and I have answered the admission policy in the normal application flow.',
      },
      clientKey: 'invite-existing-member-apply-1',
    });
    const application = ((applied.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(application.submissionPath, 'invitation');
    assert.equal(application.phase, 'awaiting_review');
    assert.deepEqual(application.invitation, {
      invitationId: invitation.invitationId,
      inviteMode: 'internal',
    });

    const sessionAfter = await h.apiOk(candidate.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(sessionAfter)
        .some((membership) => membership.clubId === sponsor.club.id),
      false,
      'applying through an in-app invite should only create an application; admission still requires admin acceptance',
    );
  });

  it('rejects inviting a member with an active applicant block', async () => {
    const sponsor = await h.seedOwner('invite-blocked-target-club', 'Invite Blocked Target Club');
    const candidate = await h.seedMember('Invite Blocked Candidate', 'invite-blocked-candidate@example.com');
    await h.sql(
      `insert into club_applicant_blocks (
         club_id,
         member_id,
         block_kind,
         expires_at,
         source,
         reason
       )
       values ($1, $2, 'declined', now() + interval '7 days', 'test_active', 'Active invitation block')`,
      [sponsor.club.id, candidate.id],
    );

    const err = await h.apiErr(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateMemberId: candidate.id,
      reason: 'I know this member well, but the active application policy block should prevent this invitation.',
      clientKey: 'invite-blocked-target-1',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'application_blocked');
  });

  it('delivers the same in-app notification when an email invite targets an existing registered member', async () => {
    const sponsor = await h.seedOwner('invite-existing-email-club', 'Invite Existing Email Club');
    const candidate = await h.seedMember('Email Matched Candidate', 'email-matched-candidate@example.com');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateName: 'Email Matched Candidate',
      candidateEmail: 'EMAIL-MATCHED-CANDIDATE@EXAMPLE.COM',
      reason: 'This existing network member should get an in-app heads-up and still apply normally.',
      clientKey: 'invite-existing-email-1',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.equal(invitation.candidateName, 'Email Matched Candidate');
    assert.equal(invitation.candidateEmail, 'email-matched-candidate@example.com');
    assert.equal(invitation.candidateMemberId, null);
    assert.equal(invitation.deliveryKind, 'notification');
    assert.equal(invitation.code, null);

    const updates = await h.apiOk(candidate.token, 'updates.list', {
      notifications: { limit: 20 },
      inbox: { unreadOnly: false, limit: 20 },
    });
    const notifications = ((updates.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const received = notifications.find((row) => (
      row.topic === 'invitation.received'
      && ((row.payload ?? {}) as Record<string, unknown>).invitationId === invitation.invitationId
    ));
    assert.ok(received, 'matching a registered email should also fan out invitation.received');
    const payload = (received?.payload ?? {}) as Record<string, unknown>;
    assert.equal('code' in payload, false);
    assert.equal(payload.deliveryKind, 'notification');
    assert.equal(((payload.sponsor ?? {}) as Record<string, unknown>).memberId, sponsor.id);
    assert.equal(payload.candidateMemberId, candidate.id);
  });

  it('does not reveal the resolved existing-member identity when the sponsor addressed the invite by email', async () => {
    const sponsor = await h.seedOwner('invite-email-privacy-club', 'Invite Email Privacy Club');
    await h.seedMember('Hidden Name Candidate', 'hidden-name-candidate@example.com');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateEmail: 'HIDDEN-NAME-CANDIDATE@EXAMPLE.COM',
      reason: 'This existing network member should receive a private in-app heads-up and still apply normally.',
      clientKey: 'invite-email-privacy-1',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.equal(invitation.candidateName, 'hidden-name-candidate@example.com');
    assert.equal(invitation.candidateEmail, 'hidden-name-candidate@example.com');
    assert.equal(invitation.candidateMemberId, null);
    assert.equal(invitation.deliveryKind, 'notification');
  });

  it('requires candidateName when candidateEmail does not resolve to an existing member', async () => {
    const sponsor = await h.seedOwner('invite-name-required-club', 'Invite Name Required Club');

    const err = await h.apiErr(sponsor.token, 'invitations.issue', {
      clubId: sponsor.club.id,
      candidateEmail: 'new-external-invitee@example.com',
      reason: 'I know this person well and want to invite them.',
      clientKey: 'invite-name-required-1',
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'candidate_name_required');
  });

  it('only lets the original sponsor withdraw support after a live application exists', async () => {
    const owner = await h.seedOwner('invite-withdraw-auth-club', 'Invite Withdraw Auth Club');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Invite Sponsor');
    const candidate = await h.seedMember('Invite Withdraw Candidate', 'invite-withdraw-candidate@example.com');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateMemberId: candidate.id,
      reason: 'I know this member well and want them to apply normally.',
      clientKey: 'invite-withdraw-auth-issue-1',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;

    await h.apiOk(candidate.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      invitationId: String(invitation.invitationId),
      draft: {
        name: candidate.publicName,
        socials: '@invitewithdrawcandidate',
        application: 'I am applying through the normal admission flow.',
      },
      clientKey: 'invite-withdraw-auth-apply-1',
    });

    const adminErr = await h.apiErr(owner.token, 'invitations.revoke', {
      invitationId: invitation.invitationId,
    });
    assert.equal(adminErr.status, 403);
    assert.equal(adminErr.code, 'forbidden_scope');

    const sponsorWithdraw = await h.apiOk(sponsor.token, 'invitations.revoke', {
      invitationId: invitation.invitationId,
    });
    const withdrawnInvitation = (sponsorWithdraw.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.equal(withdrawnInvitation.status, 'used');
    assert.equal(withdrawnInvitation.quotaState, 'free');
  });
});
