import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('anonymous clubs.join', () => {
  it('requires email for a first anonymous join', async () => {
    const owner = await h.seedOwner('join-email-required', 'Join Email Required');

    const err = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'contact_email_required');
  });

  it('creates a fresh anonymous membership on each retry for the same clubSlug + email pair', async () => {
    const owner = await h.seedOwner('join-replay-club', 'Join Replay Club');

    const first = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'replay@example.com',
    });
    const second = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'replay@example.com',
    });

    const firstData = first.data as Record<string, unknown>;
    const secondData = second.data as Record<string, unknown>;
    assert.equal(firstData.clubId, owner.club.id);
    assert.equal((firstData.proof as Record<string, unknown>).kind, 'pow');
    assert.equal((secondData.proof as Record<string, unknown>).kind, 'pow');
    assert.notEqual(firstData.membershipId, secondData.membershipId);
    assert.notEqual(firstData.memberToken, secondData.memberToken);

    const firstApplication = await h.apiOk(firstData.memberToken as string, 'clubs.applications.get', {
      membershipId: firstData.membershipId as string,
    });
    assert.equal((firstApplication.data as Record<string, any>).application.state, 'applying');
  });
});

describe('invitation lifecycle', () => {
  it('issue -> listMine -> revoke updates invitation status cleanly', async () => {
    const owner = await h.seedOwner('invite-revoke-club', 'Invite Revoke Club');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Invite Sponsor');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Candidate One',
      candidateEmail: 'candidate-one@example.com',
      reason: 'Strong systems operator',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.equal(invitation.status, 'open');

    const listed = await h.apiOk(sponsor.token, 'invitations.listMine', {
      clubId: owner.club.id,
      status: 'open',
    });
    const openInvitations = (listed.data as Record<string, unknown>).invitations as Array<Record<string, unknown>>;
    assert.ok(openInvitations.some((item) => item.invitationId === invitation.invitationId));

    const revoked = await h.apiOk(sponsor.token, 'invitations.revoke', {
      invitationId: invitation.invitationId,
    });
    assert.equal(((revoked.data as Record<string, unknown>).invitation as Record<string, unknown>).status, 'revoked');

    const after = await h.apiOk(sponsor.token, 'invitations.listMine', {
      clubId: owner.club.id,
      status: 'revoked',
    });
    const revokedInvitations = (after.data as Record<string, unknown>).invitations as Array<Record<string, unknown>>;
    assert.ok(revokedInvitations.some((item) => item.invitationId === invitation.invitationId));
  });

  it('enforces the 3-per-30-days cap under parallel issuance for different emails', async () => {
    const owner = await h.seedOwner('invite-cap-parallel', 'Invite Cap Parallel');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Parallel Sponsor');

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        h.api(sponsor.token, 'invitations.issue', {
          clubId: owner.club.id,
          candidateName: `Candidate ${i}`,
          candidateEmail: `cap-candidate-${i}@example.com`,
          reason: 'parallel-cap-test',
        }),
      ),
    );

    const okCount = results.filter((result) => result.status === 200 && result.body.ok).length;
    const quotaErrCount = results.filter((result) => {
      if (result.status !== 429 || result.body.ok) return false;
      const err = result.body.error as { code?: string } | undefined;
      return err?.code === 'invitation_quota_exceeded';
    }).length;

    assert.equal(okCount, 3, 'expected exactly 3 issuance calls to succeed');
    assert.equal(quotaErrCount, 2, 'expected exactly 2 issuance calls to hit the cap');

    const liveCount = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from invitations
       where club_id = $1
         and sponsor_member_id = $2
         and revoked_at is null
         and used_at is null
         and expired_at is null`,
      [owner.club.id, sponsor.id],
    );
    assert.equal(Number(liveCount[0]?.count ?? 0), 3, 'expected exactly 3 live invitation rows after the burst');
  });

  it('anonymous invitation redemption skips PoW once and rejects retries with the used invitation', async () => {
    const owner = await h.seedOwner('invite-redeem-club', 'Invite Redeem Club');

    const issued = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Invited Candidate',
      candidateEmail: 'invited@example.com',
      reason: 'Trusted collaborator',
    });
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;
    const invitationId = (((issued.data as Record<string, unknown>).invitation) as Record<string, unknown>).invitationId as string;

    const firstJoin = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'invited@example.com',
      invitationCode,
    });
    const secondJoin = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'invited@example.com',
      invitationCode,
    }, 'invalid_invitation_code');

    const firstData = firstJoin.data as Record<string, unknown>;
    assert.equal((firstData.proof as Record<string, unknown>).kind, 'none');
    assert.equal(secondJoin.status, 400);

    const application = await h.apiOk(firstData.memberToken as string, 'clubs.applications.get', {
      membershipId: firstData.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.submissionPath, 'invitation');
    assert.equal(summary.state, 'applying');

    const used = await h.apiOk(owner.token, 'invitations.listMine', {
      clubId: owner.club.id,
      status: 'used',
    });
    const usedInvitations = (used.data as Record<string, unknown>).invitations as Array<Record<string, unknown>>;
    assert.ok(usedInvitations.some((item) => item.invitationId === invitationId));
  });

  it('revoked invitations cannot be redeemed', async () => {
    const owner = await h.seedOwner('invite-revoked-join', 'Invite Revoked Join');

    const issued = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Blocked Candidate',
      candidateEmail: 'blocked@example.com',
      reason: 'Initial invite',
    });
    const invitationId = (((issued.data as Record<string, unknown>).invitation) as Record<string, unknown>).invitationId as string;
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;

    await h.apiOk(owner.token, 'invitations.revoke', { invitationId });

    const err = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'blocked@example.com',
      invitationCode,
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_invitation_code');
  });

  it('sponsor losing club access auto-revokes open invitations', async () => {
    const owner = await h.seedOwner('invite-autorevoke-club', 'Invite Auto Revoke Club');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Auto Sponsor');

    const issued = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Auto Revoked Candidate',
      candidateEmail: 'auto-revoked@example.com',
      reason: 'Should close when sponsor loses access',
    });
    const invitation = (issued.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: sponsor.membership.id,
      status: 'removed',
      reason: 'sponsor left the club',
    });

    const listed = await h.apiOk(sponsor.token, 'invitations.listMine', {
      clubId: owner.club.id,
      status: 'revoked',
    });
    const revokedInvitations = (listed.data as Record<string, unknown>).invitations as Array<Record<string, unknown>>;
    assert.ok(revokedInvitations.some((item) => item.invitationId === invitation.invitationId));

    const err = await h.apiErr(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'auto-revoked@example.com',
      invitationCode,
    });
    assert.equal(err.code, 'invalid_invitation_code');
  });
});
