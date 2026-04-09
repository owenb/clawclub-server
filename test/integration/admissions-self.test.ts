import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function seedAdmission(input: {
  clubId: string;
  memberId: string;
  applicantName: string;
  applicantEmail: string;
  application: string;
  statuses: Array<'submitted' | 'accepted'>;
}): Promise<string> {
  const admissionRows = await h.sql<{ id: string }>(
    `insert into admissions (club_id, origin, applicant_member_id, applicant_email, applicant_name, admission_details)
     values ($1, 'self_applied', $2, $3, $4, $5::jsonb)
     returning id`,
    [
      input.clubId,
      input.memberId,
      input.applicantEmail,
      input.applicantName,
      JSON.stringify({ socials: '@example', application: input.application }),
    ],
  );
  const admissionId = admissionRows[0]!.id;

  let versionNo = 1;
  for (const status of input.statuses) {
    await h.sql(
      `insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id, created_at)
       values ($1, $2::application_status, $3, $4, $5, now() - (($6::text || ' days')::interval))`,
      [
        admissionId,
        status,
        status === 'accepted' ? 'Accepted after interview' : 'Submitted by member',
        versionNo,
        input.memberId,
        input.statuses.length - versionNo,
      ],
    );
    versionNo += 1;
  }

  return admissionId;
}

describe('admissions.getMine', () => {
  it('returns only the actor’s own member-safe admission records', async () => {
    const sourceOwner = await h.seedOwner('admissions-self-source', 'Admissions Source Club');
    const actor = await h.seedClubMember(sourceOwner.club.id, 'Applicant One', 'applicant-one', { sponsorId: sourceOwner.id });
    const other = await h.seedClubMember(sourceOwner.club.id, 'Applicant Two', 'applicant-two', { sponsorId: sourceOwner.id });

    const targetA = await h.seedClub('admissions-target-a', 'Admissions Target A', sourceOwner.id);
    const targetB = await h.seedClub('admissions-target-b', 'Admissions Target B', sourceOwner.id);

    const actorApplication = `I want to join because I care about thoughtful operators.\n\nGifts I bring:\n- Code reviews\n- Hiring process design`;
    await seedAdmission({
      clubId: targetA.id,
      memberId: actor.id,
      applicantName: actor.publicName,
      applicantEmail: 'actor@example.com',
      application: actorApplication,
      statuses: ['submitted', 'accepted'],
    });
    await seedAdmission({
      clubId: targetB.id,
      memberId: actor.id,
      applicantName: actor.publicName,
      applicantEmail: 'actor@example.com',
      application: 'A second application with a different gift set.',
      statuses: ['submitted'],
    });
    await seedAdmission({
      clubId: targetA.id,
      memberId: other.id,
      applicantName: other.publicName,
      applicantEmail: 'other@example.com',
      application: 'This belongs to someone else.',
      statuses: ['submitted'],
    });

    const response = await h.apiOk(actor.token, 'admissions.getMine', {});
    const admissions = (response.data as Record<string, unknown>).admissions as Array<Record<string, unknown>>;

    assert.equal(admissions.length, 2);
    assert.deepEqual(
      admissions.map((admission) => admission.clubId).sort(),
      [targetA.id, targetB.id].sort(),
    );

    const accepted = admissions.find((admission) => admission.clubId === targetA.id);
    assert.ok(accepted);
    assert.equal(accepted!.clubSlug, targetA.slug);
    assert.equal(accepted!.clubName, targetA.name);
    assert.equal(accepted!.status, 'accepted');
    assert.equal(accepted!.applicationText, actorApplication);
    assert.equal(typeof accepted!.submittedAt, 'string');
    assert.equal(typeof accepted!.acceptedAt, 'string');

    assert.equal('notes' in accepted!, false);
    assert.equal('metadata' in accepted!, false);
    assert.equal('sponsor' in accepted!, false);
    assert.equal('intake' in accepted!, false);
    assert.equal('membershipId' in accepted!, false);
    assert.equal('admissionDetails' in accepted!, false);
  });

  it('filters by clubId', async () => {
    const sourceOwner = await h.seedOwner('admissions-self-filter-source', 'Admissions Filter Source');
    const actor = await h.seedClubMember(sourceOwner.club.id, 'Applicant Filter', 'applicant-filter', { sponsorId: sourceOwner.id });

    const targetA = await h.seedClub('admissions-filter-a', 'Admissions Filter A', sourceOwner.id);
    const targetB = await h.seedClub('admissions-filter-b', 'Admissions Filter B', sourceOwner.id);

    await seedAdmission({
      clubId: targetA.id,
      memberId: actor.id,
      applicantName: actor.publicName,
      applicantEmail: 'filter@example.com',
      application: 'Application A',
      statuses: ['submitted'],
    });
    await seedAdmission({
      clubId: targetB.id,
      memberId: actor.id,
      applicantName: actor.publicName,
      applicantEmail: 'filter@example.com',
      application: 'Application B',
      statuses: ['submitted'],
    });

    const response = await h.apiOk(actor.token, 'admissions.getMine', {
      clubId: targetB.id,
    });
    const admissions = (response.data as Record<string, unknown>).admissions as Array<Record<string, unknown>>;

    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].clubId, targetB.id);
    assert.equal(admissions[0].applicationText, 'Application B');
  });
});
