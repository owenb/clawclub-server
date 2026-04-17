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

describe('clubs.join authenticated cross-apply', () => {
  it('reuses the existing member identity without requiring email or PoW', async () => {
    const sourceOwner = await h.seedOwner('cross-source-club', 'Cross Source Club');
    const targetOwner = await h.seedOwner('cross-target-club', 'Cross Target Club');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Ada Cross');

    const joinBody = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });

    assert.equal(joinBody.action, 'clubs.join');
    const join = joinBody.data as Record<string, unknown>;
    assert.equal(join.memberToken, null);
    assert.equal(join.clubId, targetOwner.club.id);
    assert.equal('proof' in join, false);

    const application = await h.apiOk(member.token, 'clubs.applications.get', {
      membershipId: join.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.state, 'applying');
    assert.equal(summary.submissionPath, 'cross_apply');
    assert.equal(summary.applicationEmail, `${member.id}@test.clawclub.local`);
  });

  it('rejects authenticated callers that still try to pass email', async () => {
    const sourceOwner = await h.seedOwner('cross-email-source', 'Cross Email Source');
    const targetOwner = await h.seedOwner('cross-email-target', 'Cross Email Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'No Email');

    const err = await h.apiErr(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      email: 'no.email@example.com',
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'invalid_input');
  });

  it('uses the stored placeholder contact email for superadmin-created members on authenticated cross-apply', async () => {
    const admin = await h.seedSuperadmin('Cross Apply Provisioner');
    const sourceOwner = await h.seedOwner('cross-backfill-source', 'Cross Backfill Source');
    const targetOwner = await h.seedOwner('cross-backfill-target', 'Cross Backfill Target');

    const created = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Placeholder Pat',
    });
    const data = created.data as {
      member: { memberId: string };
      bearerToken: string;
    };

    const [contact] = await h.sql<{ email: string | null }>(
      `select email from member_private_contacts where member_id = $1`,
      [data.member.memberId],
    );
    assert.equal(contact?.email, `${data.member.memberId}@backfill.clawclub.local`);

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: sourceOwner.club.id,
      memberId: data.member.memberId,
    });

    const joinBody = await h.apiOk(data.bearerToken, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });

    assert.equal(joinBody.action, 'clubs.join');
    const join = joinBody.data as Record<string, unknown>;
    assert.equal(join.memberToken, null);
    assert.equal(join.clubId, targetOwner.club.id);
    assert.equal('proof' in join, false);

    const application = await h.apiOk(data.bearerToken, 'clubs.applications.get', {
      membershipId: join.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.state, 'applying');
    assert.equal(summary.submissionPath, 'cross_apply');
    assert.equal(summary.applicationEmail, `${data.member.memberId}@backfill.clawclub.local`);
  });

  it('is idempotent for an existing non-terminal target membership and does not issue a new token', async () => {
    const sourceOwner = await h.seedOwner('cross-replay-source', 'Cross Replay Source');
    const targetOwner = await h.seedOwner('cross-replay-target', 'Cross Replay Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Replay Riley');

    const first = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });
    const second = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });

    assert.equal((first.data as Record<string, unknown>).membershipId, (second.data as Record<string, unknown>).membershipId);
    assert.equal((first.data as Record<string, unknown>).memberToken, null);
    assert.equal((second.data as Record<string, unknown>).memberToken, null);
    assert.equal('proof' in (second.data as Record<string, unknown>), false);
  });

  it('accepts invitation-backed cross-apply through the same join action', async () => {
    const sourceOwner = await h.seedOwner('cross-inv-source', 'Cross Invite Source');
    const targetOwner = await h.seedOwner('cross-inv-target', 'Cross Invite Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Invitation Iris');

    const issued = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Invitation Iris',
      candidateEmail: `${member.id}@test.clawclub.local`,
      reason: 'Strong prior collaborator',
    });
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;

    const joinBody = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      invitationCode,
    });

    const join = joinBody.data as Record<string, unknown>;
    assert.equal(join.memberToken, null);
    assert.equal('proof' in join, false);

    const application = await h.apiOk(member.token, 'clubs.applications.get', {
      membershipId: join.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.submissionPath, 'invitation');
    assert.equal(summary.state, 'applying');
  });
});
