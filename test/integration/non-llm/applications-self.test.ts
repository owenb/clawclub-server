import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('clubs.applications.list', () => {
  it('returns only the actor’s own applications across clubs', async () => {
    const applicant = await h.seedMember('Applicant One');
    const otherApplicant = await h.seedMember('Applicant Two');
    const ownerA = await h.seedOwner('applications-self-a', 'Applications Self A');
    const ownerB = await h.seedOwner('applications-self-b', 'Applications Self B');

    const applicationA = await h.seedPendingMembership(ownerA.club.id, applicant.id, {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'applicant-one@example.com',
      applicationName: 'Applicant One',
      applicationText: 'Application A',
      applicationSocials: '@applicantone',
    });
    const applicationB = await h.seedPendingMembership(ownerB.club.id, applicant.id, {
      status: 'payment_pending',
      submissionPath: 'cross_apply',
      proofKind: 'none',
      applicationEmail: 'applicant-one@example.com',
      applicationName: 'Applicant One',
      applicationText: 'Application B',
      applicationSocials: '@applicantone',
    });
    await h.seedPendingMembership(ownerA.club.id, otherApplicant.id, {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'applicant-two@example.com',
      applicationName: 'Applicant Two',
      applicationText: 'Other application',
      applicationSocials: '@applicanttwo',
    });

    const response = await h.apiOk(applicant.token, 'clubs.applications.list', {});
    const applications = (response.data as Record<string, unknown>).applications as Array<Record<string, unknown>>;

    assert.equal(applications.length, 2);
    assert.deepEqual(
      applications.map((application) => application.clubId).sort(),
      [ownerA.club.id, ownerB.club.id].sort(),
    );

    const submitted = applications.find((application) => application.membershipId === applicationA.id);
    const paymentPending = applications.find((application) => application.membershipId === applicationB.id);
    assert.ok(submitted);
    assert.ok(paymentPending);
    assert.equal(submitted?.state, 'submitted');
    assert.equal(submitted?.applicationText, 'Application A');
    assert.equal((submitted?.billing as Record<string, unknown>).required, false);
    assert.equal(paymentPending?.state, 'payment_pending');
    assert.equal((paymentPending?.billing as Record<string, unknown>).membershipState, 'payment_pending');
    assert.equal((paymentPending?.billing as Record<string, unknown>).accessible, false);
  });

  it('supports club and state filters', async () => {
    const applicant = await h.seedMember('Applicant Filter');
    const ownerA = await h.seedOwner('applications-filter-a', 'Applications Filter A');
    const ownerB = await h.seedOwner('applications-filter-b', 'Applications Filter B');

    await h.seedPendingMembership(ownerA.club.id, applicant.id, {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'filter@example.com',
      applicationName: 'Applicant Filter',
      applicationText: 'Application A',
      applicationSocials: '@filter',
    });
    const filtered = await h.seedPendingMembership(ownerB.club.id, applicant.id, {
      status: 'payment_pending',
      submissionPath: 'cross_apply',
      proofKind: 'none',
      applicationEmail: 'filter@example.com',
      applicationName: 'Applicant Filter',
      applicationText: 'Application B',
      applicationSocials: '@filter',
    });

    const response = await h.apiOk(applicant.token, 'clubs.applications.list', {
      clubId: ownerB.club.id,
      status: ['payment_pending'],
    });
    const applications = (response.data as Record<string, unknown>).applications as Array<Record<string, unknown>>;

    assert.equal(applications.length, 1);
    assert.equal(applications[0]?.membershipId, filtered.id);
    assert.equal(applications[0]?.clubId, ownerB.club.id);
    assert.equal(applications[0]?.applicationText, 'Application B');
  });
});

describe('clubs.applications.get', () => {
  it('returns one owned application and hides unrelated memberships', async () => {
    const applicant = await h.seedMember('Application Reader');
    const otherApplicant = await h.seedMember('Application Other');
    const owner = await h.seedOwner('applications-get-club', 'Applications Get Club');

    const ownApplication = await h.seedPendingMembership(owner.club.id, applicant.id, {
      status: 'submitted',
      submissionPath: 'invitation',
      proofKind: 'invitation',
      applicationEmail: 'reader@example.com',
      applicationName: 'Application Reader',
      applicationText: 'Reader application',
      applicationSocials: '@reader',
      sponsorMemberId: owner.id,
      invitationId: (await h.seedInvitation(owner.club.id, owner.id, 'reader@example.com', {
        candidateName: 'Application Reader',
      })).id,
    });
    const otherApplication = await h.seedPendingMembership(owner.club.id, otherApplicant.id, {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'other@example.com',
      applicationName: 'Application Other',
      applicationText: 'Other application',
      applicationSocials: '@other',
    });

    const body = await h.apiOk(applicant.token, 'clubs.applications.get', {
      membershipId: ownApplication.id,
    });
    const application = (body.data as Record<string, unknown>).application as Record<string, unknown>;

    assert.equal(application.membershipId, ownApplication.id);
    assert.equal(application.state, 'submitted');
    assert.equal(application.submissionPath, 'invitation');
    assert.equal(application.applicationEmail, 'reader@example.com');

    const err = await h.apiErr(applicant.token, 'clubs.applications.get', {
      membershipId: otherApplication.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});
