import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';
import { DEFAULT_CONFIG_V1 } from '../../../src/config/index.ts';

let h: TestHarness;

type ApiResult = Awaited<ReturnType<TestHarness['api']>>;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function assertApplicationInFlightDetails(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as Record<string, unknown>;
  assert.equal(error.code, 'application_in_flight');
  const details = error.details as Record<string, unknown>;
  assert.ok(details.application, 'application_in_flight should include the canonical application state');
  assert.ok(details.workflow, 'application_in_flight should include the workflow guidance');
  assert.ok(details.next, 'application_in_flight should include the next directive');
  assert.ok(Array.isArray(details.roadmap), 'application_in_flight should include the roadmap');
  return details;
}

function assertApplicationNotMutableDetails(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as Record<string, unknown>;
  assert.equal(error.code, 'application_not_mutable');
  const details = error.details as Record<string, unknown>;
  assert.ok(details.application, 'application_not_mutable should include the canonical application state');
  assert.ok(details.workflow, 'application_not_mutable should include the workflow guidance');
  assert.ok('next' in details, 'application_not_mutable should include the next directive field even when it is null');
  return details;
}

async function withInsertDelay(run: () => Promise<void>): Promise<void> {
  const functionName = 'test_delay_club_applications_insert';
  const triggerName = `${functionName}_trigger`;
  await h.sql(
    `create or replace function ${functionName}() returns trigger
     language plpgsql
     as $$
     begin
       perform pg_sleep(0.2);
       return new;
     end;
     $$;`,
  );
  await h.sql(`drop trigger if exists ${triggerName} on club_applications`);
  await h.sql(
    `create trigger ${triggerName}
     before insert on club_applications
     for each row
     execute function ${functionName}()`,
  );

  try {
    await run();
  } finally {
    await h.sql(`drop trigger if exists ${triggerName} on club_applications`);
    await h.sql(`drop function if exists ${functionName}()`);
  }
}

async function countAdmissionLlmReservations(memberId: string): Promise<number> {
  const rows = await h.sql<{ count: number }>(
    `select count(*)::int as count
     from ai_llm_quota_reservations
     where member_id = $1
       and action_name = 'clubs.apply'`,
    [memberId],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('clubs.applications.list', () => {
  it('returns only queued-or-active applications by default and keeps revision_required opt-in', async () => {
    const applicant = await h.seedMember('Applicant One');
    const otherApplicant = await h.seedMember('Applicant Two');
    const ownerA = await h.seedOwner('applications-self-a', 'Applications Self A');
    const ownerB = await h.seedOwner('applications-self-b', 'Applications Self B');

    const awaitingReview = await h.seedApplication(ownerA.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Applicant One',
      draftSocials: '@applicantone',
      draftApplication: 'Application A',
    });
    const revisionRequired = await h.seedApplication(ownerB.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: 'Applicant One',
      draftSocials: '@applicantone',
      draftApplication: 'Application B',
    });
    await h.seedApplication(ownerA.club.id, applicant.id, {
      phase: 'declined',
      draftName: 'Applicant One',
      draftSocials: '@applicantone',
      draftApplication: 'Application C',
      decidedAt: '2026-04-03T00:00:00Z',
      decidedByMemberId: ownerA.id,
    });
    await h.seedApplication(ownerA.club.id, otherApplicant.id, {
      phase: 'awaiting_review',
      draftName: 'Applicant Two',
      draftSocials: '@applicanttwo',
      draftApplication: 'Other application',
    });

    const response = await h.apiOk(applicant.token, 'clubs.applications.list', {});
    const data = response.data as Record<string, unknown>;
    const applications = data.results as Array<Record<string, unknown>>;

    assert.equal(applications.length, 1);
    assert.deepEqual(
      applications.map((application) => application.application.applicationId),
      [awaitingReview.id],
    );

    const filtered = await h.apiOk(applicant.token, 'clubs.applications.list', {
      phases: ['awaiting_review', 'revision_required'],
    });
    const filteredData = filtered.data as Record<string, unknown>;
    const filteredApplications = filteredData.results as Array<Record<string, unknown>>;
    assert.equal(filteredApplications.length, 2);
    assert.deepEqual(
      filteredApplications.map((application) => application.application.applicationId).sort(),
      [awaitingReview.id, revisionRequired.id].sort(),
    );
    assert.deepEqual(data.phases, null);
  });

  it('supports explicit phase filters and pagination cursor', async () => {
    const applicant = await h.seedMember('Applicant Filter');
    const ownerA = await h.seedOwner('applications-filter-a', 'Applications Filter A');
    const ownerB = await h.seedOwner('applications-filter-b', 'Applications Filter B');

    const older = await h.seedApplication(ownerA.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: 'Applicant Filter',
      draftSocials: '@filter',
      draftApplication: 'Older application',
      createdAt: '2026-04-01T10:00:00Z',
      submittedAt: '2026-04-01T10:00:00Z',
    });
    const newer = await h.seedApplication(ownerB.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Applicant Filter',
      draftSocials: '@filter',
      draftApplication: 'Newer application',
      createdAt: '2026-04-02T10:00:00Z',
      submittedAt: '2026-04-02T10:00:00Z',
    });

    const firstPage = await h.apiOk(applicant.token, 'clubs.applications.list', {
      phases: ['awaiting_review', 'revision_required'],
      limit: 1,
    });
    const firstData = firstPage.data as Record<string, unknown>;
    const firstResults = firstData.results as Array<Record<string, unknown>>;
    assert.equal(firstResults.length, 1);
    assert.equal(((firstResults[0]!.application as Record<string, unknown>).applicationId), newer.id);
    assert.equal(firstData.hasMore, true);

    const secondPage = await h.apiOk(applicant.token, 'clubs.applications.list', {
      phases: ['awaiting_review', 'revision_required'],
      limit: 1,
      cursor: firstData.nextCursor,
    });
    const secondData = secondPage.data as Record<string, unknown>;
    const secondResults = secondData.results as Array<Record<string, unknown>>;
    assert.equal(secondResults.length, 1);
    assert.equal(((secondResults[0]!.application as Record<string, unknown>).applicationId), older.id);
    assert.equal(secondData.hasMore, false);
  });
});

describe('clubs.applications.get', () => {
  it('returns one owned application and hides unrelated rows', async () => {
    const applicant = await h.seedMember('Application Reader');
    const otherApplicant = await h.seedMember('Application Other');
    const owner = await h.seedOwner('applications-get-club', 'Applications Get Club');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'reader@example.com', {
      candidateName: 'Application Reader',
    });

    const ownApplication = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      submissionPath: 'invitation',
      sponsorId: owner.id,
      invitationId: invitation.id,
      draftName: 'Application Reader',
      draftSocials: '@reader',
      draftApplication: 'Reader application',
    });
    const otherApplication = await h.seedApplication(owner.club.id, otherApplicant.id, {
      phase: 'awaiting_review',
      draftName: 'Application Other',
      draftSocials: '@other',
      draftApplication: 'Other application',
    });

    const body = await h.apiOk(applicant.token, 'clubs.applications.get', {
      applicationId: ownApplication.id,
    });
    const applicationState = body.data as Record<string, unknown>;
    const application = applicationState.application as Record<string, unknown>;
    const draft = applicationState.draft as Record<string, unknown>;
    const invitationMeta = application.invitation as Record<string, unknown>;

    assert.equal(application.applicationId, ownApplication.id);
    assert.equal(application.submissionPath, 'invitation');
    assert.deepEqual(invitationMeta, {
      invitationId: invitation.id,
      inviteMode: 'external',
    });
    assert.equal('inviteReasonSnapshot' in invitationMeta, false);
    assert.equal('sponsorshipStillOpen' in invitationMeta, false);
    assert.equal(draft.application, 'Reader application');

    const err = await h.apiErr(applicant.token, 'clubs.applications.get', {
      applicationId: otherApplication.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'application_not_found');
  });
});

describe('clubs.applications.withdraw', () => {
  it('returns canonical terminal-state details when the applicant tries to withdraw an already-terminal application', async () => {
    const owner = await h.seedOwner('applications-withdraw-terminal-club', 'Applications Withdraw Terminal Club');
    const applicant = await h.seedMember('Withdraw Terminal Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'declined',
      draftName: 'Withdraw Terminal Applicant',
      draftSocials: '@withdrawterminal',
      draftApplication: 'Already resolved application.',
      decidedAt: '2026-04-03T00:00:00Z',
      decidedByMemberId: owner.id,
    });

    const { status, body } = await h.api(applicant.token, 'clubs.applications.withdraw', {
      applicationId: application.id,
      clientKey: 'applications-withdraw-terminal-1',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);

    const details = assertApplicationNotMutableDetails(body);
    const applicationData = details.application as Record<string, unknown>;
    const workflow = details.workflow as Record<string, unknown>;

    assert.equal(applicationData.phase, 'declined');
    assert.equal(workflow.awaitingActor, 'none');
    assert.equal(workflow.currentlySubmittedToAdmins, false);
    assert.equal(typeof workflow.submittedToAdminsAt, 'string');
    assert.equal(workflow.applicantMustActNow, false);
    assert.equal(workflow.canApplicantRevise, false);
    assert.equal(details.next, null);
  });
});

describe('clubs.apply', () => {
  it('returns application_in_flight with canonical details when the member reapplies with a new draft', async () => {
    const owner = await h.seedOwner('applications-resume-club', 'Applications Resume Club');
    const applicant = await h.seedMember('Resume Applicant');

    const first = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Resume Applicant',
        socials: '@resume',
        application: 'Original draft that should remain canonical.',
      },
      clientKey: 'applications-resume-1',
    });
    const { status, body } = await h.api(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Resume Applicant',
        socials: '@resume',
        application: 'Competing second draft that should not overwrite the first.',
      },
      clientKey: 'applications-resume-2',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const firstData = first.data as Record<string, unknown>;
    const firstApplication = firstData.application as Record<string, unknown>;
    const firstWorkflow = firstData.workflow as Record<string, unknown>;
    const details = assertApplicationInFlightDetails(body);
    const secondApplication = details.application as Record<string, unknown>;
    const secondDraft = details.draft as Record<string, unknown>;
    const workflow = details.workflow as Record<string, unknown>;
    const next = details.next as Record<string, unknown>;

    assert.equal(secondApplication.applicationId, firstApplication.applicationId);
    assert.equal(secondApplication.phase, 'awaiting_review');
    assert.equal(firstWorkflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof firstWorkflow.submittedToAdminsAt, 'string');
    assert.equal(firstWorkflow.applicantMustActNow, false);
    assert.equal(firstWorkflow.canApplicantRevise, false);
    assert.equal(firstWorkflow.awaitingActor, 'clubadmins');
    assert.equal(secondDraft.application, 'Original draft that should remain canonical.');
    assert.equal(workflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof workflow.submittedToAdminsAt, 'string');
    assert.equal(workflow.applicantMustActNow, false);
    assert.equal(workflow.canApplicantRevise, false);
    assert.equal(workflow.awaitingActor, 'clubadmins');
    assert.equal(next.action, 'updates.list');
  });

  it('returns draft-only workflow guidance when the existing in-flight application is revision_required', async () => {
    const owner = await h.seedOwner('applications-revision-guidance-club', 'Applications Revision Guidance Club');
    const applicant = await h.seedMember('Revision Guidance Applicant');

    await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: 'Revision Guidance Applicant',
      draftSocials: '@revisionguidance',
      draftApplication: 'Saved draft still missing required policy details.',
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Please explain why this club now.', missingItems: ['why_now'] },
    });

    const { status, body } = await h.api(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Revision Guidance Applicant',
        socials: '@revisionguidance',
        application: 'Competing draft that must not replace the saved one.',
      },
      clientKey: 'applications-revision-guidance-1',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);

    const details = assertApplicationInFlightDetails(body);
    const application = details.application as Record<string, unknown>;
    const workflow = details.workflow as Record<string, unknown>;
    const next = details.next as Record<string, unknown>;
    const messages = details.messages as Record<string, unknown>;

    assert.equal(application.phase, 'revision_required');
    assert.equal(workflow.currentlySubmittedToAdmins, false);
    assert.equal(workflow.submittedToAdminsAt, null);
    assert.equal(workflow.applicantMustActNow, true);
    assert.equal(workflow.canApplicantRevise, true);
    assert.equal(workflow.awaitingActor, 'applicant');
    assert.equal(next.action, 'clubs.applications.revise');
    assert.match(String(messages.summary), /NOT been submitted to club admins yet/i);
  });

  it('replays the original success for same clientKey and same payload', async () => {
    const owner = await h.seedOwner('applications-replay-club', 'Applications Replay Club');
    const applicant = await h.seedMember('Replay Applicant');
    const request = {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Replay Applicant',
        socials: '@replay',
        application: 'Replay-safe application draft.',
      },
      clientKey: 'applications-replay-1',
    };

    const first = await h.apiOk(applicant.token, 'clubs.apply', request);
    const second = await h.apiOk(applicant.token, 'clubs.apply', request);

    const firstData = first.data as Record<string, unknown>;
    const secondData = second.data as Record<string, unknown>;
    assert.deepEqual(secondData, firstData);
  });

  it('same clientKey with divergent apply payload returns client_key_conflict', async () => {
    const owner = await h.seedOwner('applications-client-key-conflict-club', 'Applications Client Key Conflict Club');
    const applicant = await h.seedMember('Apply ClientKey Conflict Applicant');
    const clientKey = 'applications-apply-client-key-conflict';

    await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Apply ClientKey Conflict Applicant',
        socials: '@applyconflict',
        application: 'Original application draft for the idempotency conflict path.',
      },
      clientKey,
    });

    const err = await h.apiErr(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Apply ClientKey Conflict Applicant',
        socials: '@applyconflict',
        application: 'Divergent application draft should not replay or overwrite.',
      },
      clientKey,
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('concurrent same-clientKey retries replay without duplicate admission LLM reservations', async () => {
    const owner = await h.seedMember('Applications Barrier Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: 'applications-barrier-club-create-1',
      slug: 'applications-barrier-club',
      name: 'Applications Barrier Club',
      summary: 'A club used to verify admission idempotency barrier placement.',
      admissionPolicy: 'Tell us what you have built recently and link one concrete example.',
    });
    const club = (created.data as Record<string, unknown>).club as Record<string, unknown>;
    const applicant = await h.seedMember('Applications Barrier Applicant');
    const request = {
      clubSlug: String(club.slug),
      draft: {
        name: 'Applications Barrier Applicant',
        socials: '@barrier',
        application: 'I recently shipped a useful project and can share concrete notes with the club.',
      },
      clientKey: 'applications-barrier-apply-1',
    };
    const before = await countAdmissionLlmReservations(applicant.id);

    await withInsertDelay(async () => {
      const [first, second] = await Promise.all([
        h.apiOk(applicant.token, 'clubs.apply', request),
        h.apiOk(applicant.token, 'clubs.apply', request),
      ]);
      assert.deepEqual(second.data, first.data);
    });

    const after = await countAdmissionLlmReservations(applicant.id);
    assert.equal(after - before, 2, 'exact in-flight replay should reuse the original profile/gate reservations');
  });

  it('allows a fresh application after the earlier live application terminates', async () => {
    const owner = await h.seedOwner('applications-retry-after-withdraw', 'Applications Retry After Withdraw');
    const applicant = await h.seedMember('Retry After Withdraw Applicant');

    const first = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Retry After Withdraw Applicant',
        socials: '@retryafterwithdraw',
        application: 'First application draft.',
      },
      clientKey: 'applications-retry-withdraw-1',
    });
    const firstApplication = ((first.data as Record<string, unknown>).application as Record<string, unknown>);

    await h.apiOk(applicant.token, 'clubs.applications.withdraw', {
      applicationId: firstApplication.applicationId,
      clientKey: 'applications-retry-withdraw-2',
    });

    const second = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Retry After Withdraw Applicant',
        socials: '@retryafterwithdraw',
        application: 'Second application draft after withdrawal.',
      },
      clientKey: 'applications-retry-withdraw-3',
    });

    const secondData = second.data as Record<string, unknown>;
    const secondApplication = secondData.application as Record<string, unknown>;
    const secondDraft = secondData.draft as Record<string, unknown>;

    assert.notEqual(secondApplication.applicationId, firstApplication.applicationId);
    assert.equal(secondApplication.phase, 'awaiting_review');
    assert.equal(secondDraft.application, 'Second application draft after withdrawal.');
  });

  it('lets a cancelled member reapply and only regain access after admin acceptance', async () => {
    const owner = await h.seedOwner('applications-cancelled-rejoin', 'Applications Cancelled Rejoin');
    const applicant = await h.seedMember('Cancelled Rejoin Applicant');
    const originalMembership = await h.seedCompedMembership(owner.club.id, applicant.id);

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: applicant.id,
      patch: {
        status: 'cancelled',
        reason: 'Pause this membership pending a fresh application.',
      },
    });

    const applied = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: applicant.publicName,
        socials: '@cancelledrejoin',
        application: 'I want to return to this club through the normal review flow.',
      },
      clientKey: 'applications-cancelled-rejoin-1',
    });
    const application = ((applied.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(application.submissionPath, 'cold');
    assert.equal(application.phase, 'awaiting_review');

    const sessionBefore = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(sessionBefore).some((membership) => membership.clubId === owner.club.id),
      false,
      'applying after cancellation must not restore access before review',
    );

    const accepted = await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.applicationId as string,
      decision: 'accept',
      adminNote: 'Reviewed reactivation through the normal application path.',
      clientKey: 'applications-cancelled-rejoin-accept-1',
    });
    const acceptedApplication = ((accepted.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(acceptedApplication.phase, 'active');
    assert.equal(acceptedApplication.activatedMembershipId, originalMembership.id);

    const sessionAfter = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(sessionAfter).some((membership) => membership.clubId === owner.club.id),
      true,
      'reviewed acceptance should reactivate the cancelled membership',
    );
  });

  it('settles concurrent duplicate apply attempts to one success and one application_in_flight conflict', async () => {
    const owner = await h.seedOwner('applications-race-club', 'Applications Race Club');
    const applicant = await h.seedMember('Concurrent Apply Applicant');

    await withInsertDelay(async () => {
      const results = await Promise.all([
        h.api(applicant.token, 'clubs.apply', {
          clubSlug: owner.club.slug,
          draft: {
            name: 'Concurrent Apply Applicant',
            socials: '@concurrentapply',
            application: 'Concurrent draft path A.',
          },
          clientKey: 'applications-race-1',
        }),
        h.api(applicant.token, 'clubs.apply', {
          clubSlug: owner.club.slug,
          draft: {
            name: 'Concurrent Apply Applicant',
            socials: '@concurrentapply',
            application: 'Concurrent draft path B.',
          },
          clientKey: 'applications-race-2',
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

      const successApplication = ((success.body.data as Record<string, unknown>).application as Record<string, unknown>);
      const details = assertApplicationInFlightDetails(conflict.body);
      const conflictApplication = details.application as Record<string, unknown>;

      assert.equal(conflictApplication.applicationId, successApplication.applicationId);
      assert.ok(
        ['Concurrent draft path A.', 'Concurrent draft path B.'].includes(
          String((details.draft as Record<string, unknown>).application),
        ),
      );
    });
  });

  it('blocks a fresh application while a temporary decline block is active', async () => {
    const owner = await h.seedOwner('applications-decline-block-club', 'Applications Decline Block Club');
    const applicant = await h.seedMember('Decline Block Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Decline Block Applicant',
      draftSocials: '@declineblock',
      draftApplication: 'Please review and decline this application.',
    });

    await h.apiOk(owner.token, 'clubadmin.applications.decide', {
      clubId: owner.club.id,
      applicationId: application.id,
      decision: 'decline',
      adminNote: 'Try again later after more context.',
      clientKey: 'applications-decline-block-decide-1',
    });

    const [block] = await h.sql<{
      block_kind: string;
      expires_at: string | null;
      source: string | null;
      reason: string | null;
    }>(
      `select block_kind::text as block_kind,
              expires_at::text as expires_at,
              source,
              reason
         from club_applicant_blocks
        where club_id = $1
          and member_id = $2`,
      [owner.club.id, applicant.id],
    );
    assert.equal(block?.block_kind, 'declined');
    assert.ok(block?.expires_at, 'decline blocks should be temporary by default');
    assert.equal(block?.source, 'application_decision');
    assert.equal(block?.reason, 'Try again later after more context.');

    const err = await h.apiErr(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Decline Block Applicant',
        socials: '@declineblock',
        application: 'Immediate reapply should be blocked by the temporary policy row.',
      },
      clientKey: 'applications-decline-block-apply-1',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'application_blocked');
  });

  it('ignores expired temporary decline blocks', async () => {
    const owner = await h.seedOwner('applications-expired-decline-block', 'Applications Expired Decline Block');
    const applicant = await h.seedMember('Expired Decline Applicant');
    await h.sql(
      `insert into club_applicant_blocks (
         club_id,
         member_id,
         block_kind,
         expires_at,
         source,
         reason
       )
       values ($1, $2, 'declined', now() - interval '1 day', 'test_expired', 'Expired test block')`,
      [owner.club.id, applicant.id],
    );

    const applied = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Expired Decline Applicant',
        socials: '@expireddecline',
        application: 'The old temporary decline block has expired, so this can enter review.',
      },
      clientKey: 'applications-expired-decline-block-apply-1',
    });
    const application = (applied.data as Record<string, unknown>).application as Record<string, unknown>;
    assert.equal(application.phase, 'awaiting_review');
  });

  it('does not write decline blocks when the instance config disables them', async () => {
    const local = await TestHarness.start({
      llmGate: passthroughGate,
      config: {
        ...DEFAULT_CONFIG_V1,
        policy: {
          ...DEFAULT_CONFIG_V1.policy,
          applicationBlocks: { postDeclineDays: 0 },
        },
      },
    });
    try {
      const owner = await local.seedOwner('applications-decline-block-disabled', 'Applications Decline Block Disabled');
      const applicant = await local.seedMember('Decline Block Disabled Applicant');
      const application = await local.seedApplication(owner.club.id, applicant.id, {
        phase: 'awaiting_review',
        draftName: 'Decline Block Disabled Applicant',
        draftSocials: '@declineblockdisabled',
        draftApplication: 'Please decline this while decline blocks are disabled.',
      });

      await local.apiOk(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision: 'decline',
        clientKey: 'applications-decline-block-disabled-decide-1',
      });

      const [count] = await local.sql<{ count: number }>(
        `select count(*)::int as count
           from club_applicant_blocks
          where club_id = $1
            and member_id = $2`,
        [owner.club.id, applicant.id],
      );
      assert.equal(count?.count, 0);

      const reapplied = await local.apiOk(applicant.token, 'clubs.apply', {
        clubSlug: owner.club.slug,
        draft: {
          name: 'Decline Block Disabled Applicant',
          socials: '@declineblockdisabled',
          application: 'The instance has disabled post-decline blocks, so this fresh application can enter review.',
        },
        clientKey: 'applications-decline-block-disabled-apply-1',
      });
      const reappliedApplication = (reapplied.data as Record<string, unknown>).application as Record<string, unknown>;
      assert.equal(reappliedApplication.phase, 'awaiting_review');
    } finally {
      await local.stop();
    }
  });

  it('returns member_already_active with membership details for active members', async () => {
    const owner = await h.seedOwner('applications-active-member-club', 'Applications Active Member Club');
    const member = await h.seedCompedMember(owner.club.id, 'Already Active Member');

    const { status, body } = await h.api(member.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'Already Active Member',
        socials: '@active',
        application: 'This should fail because the member already has access.',
      },
      clientKey: 'applications-active-member-1',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'member_already_active');
    const details = error.details as Record<string, unknown>;
    const membership = details.membership as Record<string, unknown>;
    assert.equal(membership.clubId, owner.club.id);
    assert.equal(membership.memberId, member.id);
    assert.equal(membership.status, 'active');
  });
});

describe('clubs.applications.revise', () => {
  it('returns the canonical queued state when the applicant tries to revise an awaiting_review application', async () => {
    const owner = await h.seedOwner('applications-revise-immutable-club', 'Applications Revise Immutable Club');
    const applicant = await h.seedMember('Immutable Revise Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      draftName: 'Immutable Revise Applicant',
      draftSocials: '@immutablerevise',
      draftApplication: 'Already submitted draft.',
    });

    const { status, body } = await h.api(applicant.token, 'clubs.applications.revise', {
      applicationId: application.id,
      draft: {
        name: 'Immutable Revise Applicant',
        socials: '@immutablerevise',
        application: 'Attempted replacement draft.',
      },
      clientKey: 'applications-revise-immutable-1',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);

    const details = assertApplicationNotMutableDetails(body);
    const applicationData = details.application as Record<string, unknown>;
    const workflow = details.workflow as Record<string, unknown>;
    const next = details.next as Record<string, unknown>;
    const messages = details.messages as Record<string, unknown>;

    assert.equal(applicationData.phase, 'awaiting_review');
    assert.equal(workflow.currentlySubmittedToAdmins, true);
    assert.equal(typeof workflow.submittedToAdminsAt, 'string');
    assert.equal(workflow.applicantMustActNow, false);
    assert.equal(workflow.canApplicantRevise, false);
    assert.equal(workflow.awaitingActor, 'clubadmins');
    assert.equal(next.action, 'updates.list');
    assert.match(String(messages.summary), /HAS been submitted to club admins/i);
  });

  it('only lets admin acceptance win after a revision has returned the application to awaiting_review', async () => {
    const owner = await h.seedOwner('applications-revise-race-club', 'Applications Revise Race Club');
    const applicant = await h.seedMember('Concurrent Revise Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
      draftName: 'Concurrent Revise Applicant',
      draftSocials: '@reviserace',
      draftApplication: 'Draft that may race with acceptance.',
      gateVerdict: 'needs_revision',
      gateFeedback: { message: 'Add more specifics.', missingItems: ['specifics'] },
    });

    const [revise, accept] = await Promise.all([
      h.api(applicant.token, 'clubs.applications.revise', {
        applicationId: application.id,
        draft: {
          name: 'Concurrent Revise Applicant',
          socials: '@reviserace',
          application: 'Revised draft that races the admin acceptance.',
        },
        clientKey: 'applications-revise-race-1',
      }),
      h.api(owner.token, 'clubadmin.applications.decide', {
        clubId: owner.club.id,
        applicationId: application.id,
        decision: 'accept',
        adminNote: 'Accept through the race.',
        clientKey: 'applications-revise-race-accept',
      }),
    ]);

    assert.equal(revise.status, 200);
    assert.equal(revise.body.ok, true);
    assert.ok([200, 409].includes(accept.status));
    if (accept.status === 409) {
      assert.equal((accept.body.error as Record<string, unknown>).code, 'application_not_mutable');
    } else {
      assert.equal(accept.body.ok, true);
    }

    const finalState = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      applicationId: application.id,
    });
    const finalApplication = ((finalState.data as Record<string, unknown>).application as Record<string, unknown>);

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    if (accept.status === 200) {
      assert.equal(finalApplication.phase, 'active');
      assert.ok(finalApplication.activatedMembershipId, 'accepted application should keep its activation link');
      assert.equal(
        activeMemberships(session).some((row) => row.clubId === owner.club.id),
        true,
        'acceptance should only grant access after the revision has returned the application to awaiting_review',
      );
    } else {
      assert.equal(finalApplication.phase, 'awaiting_review');
      assert.equal(finalApplication.activatedMembershipId, null);
      assert.equal(
        activeMemberships(session).some((row) => row.clubId === owner.club.id),
        false,
        'a pre-queue acceptance attempt must not grant access',
      );
    }
  });
});

describe('invitations.redeem', () => {
  it('allows redeeming an invitation when the account email differs from the invited email', async () => {
    const owner = await h.seedOwner('applications-redeem-email-club', 'Applications Redeem Email Club');
    const candidate = await h.seedMember('Redeem Email Applicant', 'actual-account@applications.test');

    const issue = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Redeem Email Applicant',
      candidateEmail: 'external-invited-address@applications.test',
      reason: 'Known contributor with strong context for the club.',
      clientKey: 'redeem-email-issue-1',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;

    const redeemed = await h.apiOk(candidate.token, 'invitations.redeem', {
      code: String(invitation.code),
      draft: {
        name: 'Redeem Email Applicant',
        socials: '@redeememail',
        application: 'Redeeming this invitation from a different account email.',
      },
      clientKey: 'redeem-email-1',
    });

    const application = ((redeemed.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(application.submissionPath, 'invitation');

    const [row] = await h.sql<{ used_at: string | null }>(
      'select used_at::text as used_at from invite_requests where id = $1',
      [String(invitation.invitationId)],
    );
    assert.ok(row?.used_at, 'redeeming should still consume the invitation');
  });

  it('collapses already-active membership failures into invalid_invitation_code', async () => {
    const owner = await h.seedOwner('applications-redeem-active-club', 'Applications Redeem Active Club');
    const member = await h.seedCompedMember(owner.club.id, 'Redeem Already Active', 'redeem-active@applications.test');

    const issue = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'External Redeem Active',
      candidateEmail: 'external-redeem-active@applications.test',
      reason: 'A real invitation code that should remain opaque to existing members.',
      clientKey: 'redeem-active-issue-1',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;

    const err = await h.apiErr(member.token, 'invitations.redeem', {
      code: String(invitation.code),
      draft: {
        name: member.publicName,
        socials: '@redeemactive',
        application: 'I already belong to this club, so this code should not reveal itself.',
      },
      clientKey: 'redeem-active-1',
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'invalid_invitation_code');
  });

  it('returns application_in_flight with canonical details after the invitation has already been redeemed once', async () => {
    const owner = await h.seedOwner('applications-redeem-resume-club', 'Applications Redeem Resume Club');
    const candidate = await h.seedMember('Redeem Resume Applicant', 'redeem-resume@applications.test');

    const issue = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Redeem Resume Applicant',
      candidateEmail: 'external-redeem-resume@applications.test',
      reason: 'Known contributor with strong context for the club.',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;

    const first = await h.apiOk(candidate.token, 'invitations.redeem', {
      code: String(invitation.code),
      draft: {
        name: 'Redeem Resume Applicant',
        socials: '@redeemresume',
        application: 'Original invitation redemption draft.',
      },
      clientKey: 'redeem-resume-1',
    });
    const { status, body } = await h.api(candidate.token, 'invitations.redeem', {
      code: String(invitation.code),
      draft: {
        name: 'Redeem Resume Applicant',
        socials: '@redeemresume',
        application: 'Second redemption draft should not overwrite the first.',
      },
      clientKey: 'redeem-resume-2',
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const firstData = first.data as Record<string, unknown>;
    const firstApplication = firstData.application as Record<string, unknown>;
    const details = assertApplicationInFlightDetails(body);
    const secondApplication = details.application as Record<string, unknown>;
    const secondDraft = details.draft as Record<string, unknown>;
    const next = details.next as Record<string, unknown>;

    assert.equal(secondApplication.applicationId, firstApplication.applicationId);
    assert.equal(secondApplication.submissionPath, 'invitation');
    assert.equal(secondDraft.application, 'Original invitation redemption draft.');
    assert.equal(next.action, 'updates.list');
  });

  it('replays the original redemption for same clientKey and same payload', async () => {
    const owner = await h.seedOwner('applications-redeem-replay-club', 'Applications Redeem Replay Club');
    const candidate = await h.seedMember('Redeem Replay Applicant', 'redeem-replay@applications.test');

    const issue = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Redeem Replay Applicant',
      candidateEmail: 'external-redeem-replay@applications.test',
      reason: 'Known contributor with strong context for replay coverage.',
      clientKey: 'redeem-replay-issue-1',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const request = {
      code: String(invitation.code),
      draft: {
        name: 'Redeem Replay Applicant',
        socials: '@redeemreplay',
        application: 'Replay-safe invitation redemption draft.',
      },
      clientKey: 'redeem-replay-1',
    };

    const first = await h.apiOk(candidate.token, 'invitations.redeem', request);
    const second = await h.apiOk(candidate.token, 'invitations.redeem', request);

    assert.deepEqual(second.data, first.data);
  });

  it('settles concurrent duplicate invitation redemption attempts to one success and one application_in_flight conflict', async () => {
    const owner = await h.seedOwner('applications-redeem-race-club', 'Applications Redeem Race Club');
    const candidate = await h.seedMember('Redeem Race Applicant', 'redeem-race@applications.test');

    const issue = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Redeem Race Applicant',
      candidateEmail: 'external-redeem-race@applications.test',
      reason: 'Known contributor with strong context for concurrent redemption coverage.',
      clientKey: 'redeem-race-issue-1',
    });
    const invitation = (issue.data as Record<string, unknown>).invitation as Record<string, unknown>;

    await withInsertDelay(async () => {
      const results = await Promise.all([
        h.api(candidate.token, 'invitations.redeem', {
          code: String(invitation.code),
          draft: {
            name: 'Redeem Race Applicant',
            socials: '@redeemrace',
            application: 'Concurrent redemption draft A.',
          },
          clientKey: 'redeem-race-1',
        }),
        h.api(candidate.token, 'invitations.redeem', {
          code: String(invitation.code),
          draft: {
            name: 'Redeem Race Applicant',
            socials: '@redeemrace',
            application: 'Concurrent redemption draft B.',
          },
          clientKey: 'redeem-race-2',
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

      const successApplication = ((success.body.data as Record<string, unknown>).application as Record<string, unknown>);
      const details = assertApplicationInFlightDetails(conflict.body);
      const conflictApplication = details.application as Record<string, unknown>;

      assert.equal(conflictApplication.applicationId, successApplication.applicationId);
      assert.ok(
        ['Concurrent redemption draft A.', 'Concurrent redemption draft B.'].includes(
          String((details.draft as Record<string, unknown>).application),
        ),
      );
    });
  });
});
