import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ qualityGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('clubs.join authenticated cross-apply', () => {
  it('reuses the existing member identity and returns a PoW challenge for the target club', async () => {
    const sourceOwner = await h.seedOwner('cross-source-club', 'Cross Source Club');
    const targetOwner = await h.seedOwner('cross-target-club', 'Cross Target Club');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Ada Cross', 'ada-cross');

    const joinBody = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      email: 'ada.cross@example.com',
    });

    assert.equal(joinBody.action, 'clubs.join');
    const join = joinBody.data as Record<string, unknown>;
    assert.equal(join.memberToken, null);
    assert.equal(join.clubId, targetOwner.club.id);
    assert.equal((join.proof as Record<string, unknown>).kind, 'pow');

    const application = await h.apiOk(member.token, 'clubs.applications.get', {
      membershipId: join.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.state, 'applying');
    assert.equal(summary.submissionPath, 'cross_apply');
    assert.equal(summary.applicationEmail, 'ada.cross@example.com');
  });

  it('requires email on the first authenticated join when the member has no stored contact email', async () => {
    const sourceOwner = await h.seedOwner('cross-email-source', 'Cross Email Source');
    const targetOwner = await h.seedOwner('cross-email-target', 'Cross Email Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'No Email', 'no-email');

    const err = await h.apiErr(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'email_required_for_first_join');
  });

  it('is idempotent for an existing non-terminal target membership and does not issue a new token', async () => {
    const sourceOwner = await h.seedOwner('cross-replay-source', 'Cross Replay Source');
    const targetOwner = await h.seedOwner('cross-replay-target', 'Cross Replay Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Replay Riley', 'replay-riley');

    const first = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      email: 'replay.riley@example.com',
    });
    const second = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
    });

    assert.equal((first.data as Record<string, unknown>).membershipId, (second.data as Record<string, unknown>).membershipId);
    assert.equal((first.data as Record<string, unknown>).memberToken, null);
    assert.equal((second.data as Record<string, unknown>).memberToken, null);
    assert.equal(((second.data as Record<string, unknown>).proof as Record<string, unknown>).kind, 'pow');
  });

  it('accepts invitation-backed cross-apply through the same join action', async () => {
    const sourceOwner = await h.seedOwner('cross-inv-source', 'Cross Invite Source');
    const targetOwner = await h.seedOwner('cross-inv-target', 'Cross Invite Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Invitation Iris', 'invitation-iris');

    const issued = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Invitation Iris',
      candidateEmail: 'iris@example.com',
      reason: 'Strong prior collaborator',
    });
    const invitationCode = (issued.data as Record<string, unknown>).invitationCode as string;

    const joinBody = await h.apiOk(member.token, 'clubs.join', {
      clubSlug: targetOwner.club.slug,
      email: 'iris@example.com',
      invitationCode,
    });

    const join = joinBody.data as Record<string, unknown>;
    assert.equal(join.memberToken, null);
    assert.equal((join.proof as Record<string, unknown>).kind, 'none');

    const application = await h.apiOk(member.token, 'clubs.applications.get', {
      membershipId: join.membershipId as string,
    });
    const summary = (application.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(summary.submissionPath, 'invitation');
    assert.equal(summary.state, 'applying');
  });
});
