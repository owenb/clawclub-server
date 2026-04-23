import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships, getActivity, getNotifications } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('clubadmin applications', () => {
  it('lists queued applications by default and keeps revision_required opt-in', async () => {
    const owner = await h.seedOwner('applications-admin-club', 'Applications Admin Club');
    const reviewApplicant = await h.seedMember('Admin Flow Applicant');
    const reviseApplicant = await h.seedMember('Revision Flow Applicant');
    const application = await h.seedApplication(owner.club.id, reviewApplicant.id, {
      phase: 'awaiting_review',
      draftName: 'Admin Flow Applicant',
      draftSocials: '@adminflow',
      draftApplication: 'Ready for review.',
    });
    const revisionRequired = await h.seedApplication(owner.club.id, reviseApplicant.id, {
      phase: 'revision_required',
      draftName: 'Revision Flow Applicant',
      draftSocials: '@revisionflow',
      draftApplication: 'Needs another pass.',
    });

    const listBody = await h.apiOk(owner.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const listData = listBody.data as Record<string, unknown>;
    const results = listData.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    assert.deepEqual(
      new Set(results.map((row) => row.applicationId)),
      new Set([application.id]),
    );
    assert.deepEqual(listData.phases, null);

    const filteredBody = await h.apiOk(owner.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
      phases: ['awaiting_review', 'revision_required'],
      limit: 20,
    });
    const filteredData = filteredBody.data as Record<string, unknown>;
    const filteredResults = filteredData.results as Array<Record<string, unknown>>;
    assert.equal(filteredResults.length, 2);
    assert.deepEqual(
      new Set(filteredResults.map((row) => row.applicationId)),
      new Set([application.id, revisionRequired.id]),
    );

    const getBody = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      applicationId: application.id,
    });
    const applicationData = ((getBody.data as Record<string, unknown>).application ?? {}) as Record<string, unknown>;
    assert.equal(applicationData.applicationId, application.id);
    assert.equal(applicationData.phase, 'awaiting_review');
  });

  it('shows the frozen sponsor reason and withdrawn support state to admins', async () => {
    const owner = await h.seedOwner('applications-admin-sponsored', 'Applications Admin Sponsored');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Admin Invite Sponsor');
    const applicant = await h.seedMember('Admin Invite Applicant', 'admin-invite-applicant@example.com');

    const issue = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateMemberId: applicant.id,
      reason: 'I have worked with this member closely and want admins to see this endorsement even if I later withdraw support.',
      clientKey: 'applications-admin-sponsored-issue-1',
    });
    const invitation = ((issue.data as Record<string, unknown>).invitation as Record<string, unknown>);

    const applied = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      invitationId: invitation.invitationId as string,
      draft: {
        name: applicant.publicName,
        socials: '@admininviteapplicant',
        application: 'I am applying through the normal invited flow.',
      },
      clientKey: 'applications-admin-sponsored-apply-1',
    });
    const application = ((applied.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(application.phase, 'awaiting_review');

    await h.apiOk(sponsor.token, 'invitations.revoke', {
      invitationId: invitation.invitationId,
    });

    const getBody = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      applicationId: application.applicationId as string,
    });
    const applicationData = ((getBody.data as Record<string, unknown>).application ?? {}) as Record<string, unknown>;
    const invitationMeta = (applicationData.invitation ?? {}) as Record<string, unknown>;

    assert.equal(applicationData.sponsorId, sponsor.id);
    assert.equal(applicationData.sponsorName, sponsor.publicName);
    assert.deepEqual(invitationMeta, {
      invitationId: invitation.invitationId,
      inviteMode: 'internal',
      inviteReasonSnapshot: 'I have worked with this member closely and want admins to see this endorsement even if I later withdraw support.',
      sponsorshipStillOpen: false,
    });
  });

  it('does not let admins decide revision_required applications before they re-enter the queue', async () => {
    const owner = await h.seedOwner('applications-revision-guard-club', 'Applications Revision Guard Club');
    for (const decision of ['accept', 'decline', 'ban'] as const) {
      const applicant = await h.seedMember(`Revision Guard Applicant ${decision}`);
      const application = await h.seedApplication(owner.club.id, applicant.id, {
        phase: 'revision_required',
        submissionPath: 'cold',
        draftName: `Revision Guard Applicant ${decision}`,
        draftSocials: '@revisionguard',
        draftApplication: `Missing details for review before ${decision}.`,
        gateVerdict: 'needs_revision',
        gateFeedback: { message: 'Add more detail.', missingItems: ['detail'] },
      });

      const { status, body } = await h.api(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision,
        adminNote: `This ${decision} should be rejected until the applicant revises.`,
        clientKey: `revision-guard-${decision}`,
      });
      assert.equal(status, 409);
      assert.equal(body.ok, false);
      const error = body.error as Record<string, unknown>;
      assert.equal(error.code, 'application_not_mutable');
      assert.equal(((error.details as Record<string, unknown>).application as Record<string, unknown>).phase, 'revision_required');
      const session = await h.apiOk(applicant.token, 'session.getContext', {});
      assert.equal(
        activeMemberships(session).some((row) => row.clubId === owner.club.id),
        false,
        'revision_required applications must not grant access before returning to awaiting_review',
      );
    }
  });

  it('accept creates the membership, activates access, and surfaces welcome notification via updates.list', async () => {
    const owner = await h.seedOwner('applications-accept-club', 'Applications Accept Club');
    const applicant = await h.seedMember('Accepted Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Accepted Applicant',
      draftSocials: '@accepted',
      draftApplication: 'Please accept me.',
    });

    const decide = await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'accept',
      adminNote: 'Looks good.',
      clientKey: 'accept-1',
    });
    const state = ((decide.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(state.phase, 'active');
    assert.equal(state.applicantMemberId, applicant.id);
    assert.equal('membership' in state, false);
    const admin = state.admin as Record<string, unknown>;
    assert.equal(admin.note, 'Looks good.');

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    const membership = activeMemberships(session).find((row) => row.clubId === owner.club.id);
    assert.equal(
      Boolean(membership),
      true,
      'accepted applicant should gain club access immediately',
    );
    assert.equal(state.activatedMembershipId, membership?.membershipId);

    const updates = await h.getUpdates(applicant.token, {});
    const notifications = (((updates.body.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>);
    const accepted = notifications.find((notification) => notification.topic === 'application.accepted');
    assert.ok(accepted, 'applicant should see application.accepted on updates.list');
    const payload = (accepted?.payload ?? {}) as Record<string, unknown>;
    assert.equal('admin' in payload, false);
    const decidedByAdmin = (payload.decidedByAdmin ?? {}) as Record<string, unknown>;
    assert.equal(decidedByAdmin.memberId, owner.id);
    assert.equal(decidedByAdmin.publicName, owner.publicName);

    const refs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [accepted?.notificationId],
    );
    assert.deepEqual(refs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: owner.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'application', ref_id: application.id },
      { ref_role: 'target', ref_kind: 'membership', ref_id: String(membership?.membershipId) },
    ]);
  });

  it('auto-acknowledges pending-application notifications for all clubadmins once a decision succeeds', async () => {
    const owner = await h.seedOwner('applications-auto-ack-club', 'Applications Auto Ack Club');
    const extraAdmin = await h.seedMember('Auto Ack Clubadmin');
    await h.seedClubMembership(owner.club.id, extraAdmin.id, { role: 'clubadmin', status: 'active' });

    for (const decision of ['accept', 'decline', 'ban'] as const) {
      const applicant = await h.seedMember(`Auto Ack Applicant ${decision}`);
      const application = await h.seedApplication(owner.club.id, applicant.id, {
        phase: 'awaiting_review',
        draftName: `Auto Ack Applicant ${decision}`,
        draftSocials: '@autoack',
        draftApplication: `Application that should auto-ack the pending ping on ${decision}.`,
      });

      for (const admin of [owner, extraAdmin]) {
        await h.sqlClubs(
          `insert into member_notifications (club_id, recipient_member_id, topic, payload)
           values ($1, $2, 'clubadmin.application_pending', $3::jsonb)`,
          [
            owner.club.id,
            admin.id,
            JSON.stringify({
              applicationId: application.id,
              clubId: owner.club.id,
              clubName: owner.club.name,
              applicantName: `Auto Ack Applicant ${decision}`,
              submissionPath: 'cold',
              previousPhase: null,
              submittedAt: '2026-04-03T00:00:00Z',
            }),
          ],
        );
      }

      await h.apiOk(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision,
        clientKey: `applications-auto-ack-${decision}`,
      });

      for (const admin of [owner, extraAdmin]) {
        const notifications = getNotifications((await h.getNotifications(admin.token, { limit: 20 })).body);
        assert.equal(
          notifications.results.some((item) => item.topic === 'clubadmin.application_pending'
            && ((item.payload as Record<string, unknown>).applicationId === application.id)),
          false,
          `pending notification should disappear for ${admin.publicName} after ${decision}`,
        );
      }

      const rows = await h.sqlClubs<{ acknowledged_at: string | null }>(
        `select acknowledged_at::text as acknowledged_at
         from member_notifications
         where club_id = $1
           and topic = 'clubadmin.application_pending'
           and payload->>'applicationId' = $2
         order by recipient_member_id asc`,
        [owner.club.id, application.id],
      );
      assert.equal(rows.length, 2);
      assert.equal(rows.every((row) => typeof row.acknowledged_at === 'string'), true);
    }
  });

  it('accept emits a membership.activated activity row that only admins can see', async () => {
    const owner = await h.seedOwner('applications-activity-club', 'Applications Activity Club');
    const member = await h.seedCompedMember(owner.club.id, 'Activity Viewer');
    const applicant = await h.seedMember('Activity Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Activity Applicant',
      draftSocials: '@activityapplicant',
      draftApplication: 'Please accept me for the activity test.',
    });

    const adminCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;
    const memberCursor = getActivity((await h.getActivity(member.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'accept',
      clientKey: 'applications-activity-accept',
    });

    const adminActivity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: adminCursor,
    })).body);
    const activated = adminActivity.results.filter((row) => row.topic === 'membership.activated');
    assert.equal(activated.length, 1);
    assert.equal((activated[0]?.payload as Record<string, unknown>).publicName, applicant.publicName);
    assert.equal(activated[0]?.audience, 'clubadmins');
    assert.equal(activated[0]?.contentId, null);
    assert.equal(
      ((activated[0]?.createdByMember ?? {}) as Record<string, unknown>).memberId,
      owner.id,
    );

    const memberActivity = getActivity((await h.getActivity(member.token, {
      clubId: owner.club.id,
      after: memberCursor,
    })).body);
    assert.equal(
      memberActivity.results.some((row) => row.topic === 'membership.activated'),
      false,
      'plain members must not see admin-audience activation rows',
    );
  });

  it('decline and ban do not emit membership.activated activity rows', async () => {
    const owner = await h.seedOwner('applications-no-activity-club', 'Applications No Activity Club');
    const declineApplicant = await h.seedMember('Decline Activity Applicant');
    const banApplicant = await h.seedMember('Ban Activity Applicant');
    const declineApplication = await h.seedApplication(owner.club.id, declineApplicant.id, {
      phase: 'awaiting_review',
      draftName: 'Decline Activity Applicant',
      draftSocials: '@declineactivity',
      draftApplication: 'Please decline me.',
    });
    const banApplication = await h.seedApplication(owner.club.id, banApplicant.id, {
      phase: 'awaiting_review',
      draftName: 'Ban Activity Applicant',
      draftSocials: '@banactivity',
      draftApplication: 'Please ban me.',
    });

    const adminCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: declineApplication.id,
      decision: 'decline',
      clientKey: 'applications-activity-decline',
    });
    await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: banApplication.id,
      decision: 'ban',
      clientKey: 'applications-activity-ban',
    });

    const adminActivity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: adminCursor,
    })).body);
    assert.equal(
      adminActivity.results.some((row) => row.topic === 'membership.activated'),
      false,
    );
  });

  it('rejects accept when the club is already at its member cap', async () => {
    const admin = await h.seedSuperadmin('Applications Cap Admin');
    const owner = await h.seedOwner('applications-cap-club', 'Applications Cap Club');
    const applicant = await h.seedMember('Capped Applicant');

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: 'applications-cap-1',
      clubId: owner.club.id,
      usesFreeAllowance: false,
      memberCap: 1,
    });

    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Capped Applicant',
      draftSocials: '@capped',
      draftApplication: 'Please accept me into the already-full club.',
    });

    const err = await h.apiErr(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'accept',
      adminNote: 'No room left.',
      clientKey: 'applications-cap-accept',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'member_cap_reached');

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((row) => row.clubId === owner.club.id),
      false,
      'capped acceptance must not create access',
    );
  });

  it('cannot decide an application that belongs to a different club', async () => {
    const ownerA = await h.seedOwner('applications-decide-a', 'Applications Decide A');
    const ownerB = await h.seedOwner('applications-decide-b', 'Applications Decide B');
    const applicant = await h.seedMember('Cross Club Applicant');
    const application = await h.seedApplication(ownerB.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Cross Club Applicant',
      draftSocials: '@crossclub',
      draftApplication: 'Please review me in club B.',
    });

    const err = await h.apiErr(ownerA.token, 'clubadmin.applications.decide', {
      clubId: ownerA.club.id,
      applicationId: application.id,
      decision: 'accept',
      adminNote: 'Wrong club.',
      clientKey: 'cross-club-decide',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'application_not_found');

    const getBody = await h.apiOk(ownerB.token, 'clubadmin.applications.get', {
      clubId: ownerB.club.id,
      applicationId: application.id,
    });
    const applicationData = ((getBody.data as Record<string, unknown>).application ?? {}) as Record<string, unknown>;
    assert.equal(applicationData.phase, 'awaiting_review');

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((row) => row.clubId === ownerB.club.id),
      false,
      'wrong-club admin decision must not create access',
    );
  });

  it('ban writes a persistent applicant block for the member and club', async () => {
    const owner = await h.seedOwner('applications-ban-club', 'Applications Ban Club');
    const applicant = await h.seedMember('Banned Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Banned Applicant',
      draftSocials: '@banned',
      draftApplication: 'Please accept me.',
    });

    const decide = await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'ban',
      adminNote: 'Do not reapply.',
      clientKey: 'ban-1',
    });
    const state = ((decide.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(state.phase, 'banned');

    const [block] = await h.sql<{ block_kind: string; reason: string | null }>(
      `select block_kind::text as block_kind, reason
         from club_applicant_blocks
        where club_id = $1
          and member_id = $2`,
      [owner.club.id, applicant.id],
    );
    assert.equal(block?.block_kind, 'banned');
    assert.equal(block?.reason, 'Do not reapply.');
  });

  it('returns application_already_decided with canonical application details after a prior decision', async () => {
    const owner = await h.seedOwner('applications-already-decided-club', 'Applications Already Decided Club');
    const applicant = await h.seedMember('Already Decided Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Already Decided Applicant',
      draftSocials: '@decided',
      draftApplication: 'Please review me once.',
    });

    await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'decline',
      adminNote: 'First admin decision.',
      clientKey: 'applications-decided-1',
    });

    const { status, body } = await h.api(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'accept',
      adminNote: 'Second admin should lose.',
      clientKey: 'applications-decided-2',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'application_already_decided');
    const details = error.details as Record<string, unknown>;
    const decided = details.application as Record<string, unknown>;
    assert.equal(decided.applicationId, application.id);
    assert.equal(decided.phase, 'declined');
    const admin = decided.admin as Record<string, unknown>;
    assert.equal(admin.note, 'First admin decision.');
  });

  it('serializes concurrent admin decisions on the same application', async () => {
    const owner = await h.seedOwner('applications-decide-race-club', 'Applications Decide Race Club');
    const applicant = await h.seedMember('Concurrent Decide Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Concurrent Decide Applicant',
      draftSocials: '@deciderace',
      draftApplication: 'Please make one decision.',
    });

    const [accept, decline] = await Promise.all([
      h.api(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision: 'accept',
        adminNote: 'Accept path won.',
        clientKey: 'applications-race-accept',
      }),
      h.api(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision: 'decline',
        adminNote: 'Decline path won.',
        clientKey: 'applications-race-decline',
      }),
    ]);

    const responses = [accept, decline];
    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [200, 409],
    );

    const winner = responses.find((response) => response.status === 200)!;
    const loser = responses.find((response) => response.status === 409)!;
    assert.equal(winner.body.ok, true);
    assert.equal(loser.body.ok, false);

    const winningApplication = ((winner.body.data as Record<string, unknown>).application as Record<string, unknown>);
    const losingError = loser.body.error as Record<string, unknown>;
    assert.equal(losingError.code, 'application_already_decided');
    const losingApplication = ((losingError.details as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(losingApplication.applicationId, application.id);
    assert.equal(losingApplication.phase, winningApplication.phase);

    const finalState = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      applicationId: application.id,
    });
    const finalApplication = ((finalState.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(finalApplication.phase, winningApplication.phase);

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    const hasMembership = activeMemberships(session).some((row) => row.clubId === owner.club.id);
    assert.equal(hasMembership, winningApplication.phase === 'active');
  });

  it('removing an active member writes a block and revokes access immediately', async () => {
    const owner = await h.seedOwner('applications-remove-club', 'Applications Remove Club');
    const member = await h.seedCompedMember(owner.club.id, 'Removed Member');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'removed', reason: 'Removed for testing.' },
    });

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((row) => row.clubId === owner.club.id),
      false,
      'removed memberships must disappear from accessible club scope immediately',
    );

    const [block] = await h.sql<{ block_kind: string; reason: string | null }>(
      `select block_kind::text as block_kind, reason
         from club_applicant_blocks
        where club_id = $1
          and member_id = $2`,
      [owner.club.id, member.id],
    );
    assert.equal(block?.block_kind, 'removed');
    assert.equal(block?.reason, 'Removed for testing.');
  });
});
