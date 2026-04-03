import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getHarness } from './setup.ts';
import type { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await getHarness();
}, { timeout: 30_000 });

// ── helpers ──────────────────────────────────────────────────────────────────

function activeMemberships(sessionBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const actor = sessionBody.actor as Record<string, unknown>;
  return (actor.activeMemberships ?? []) as Array<Record<string, unknown>>;
}

function admission(responseBody: Record<string, unknown>): Record<string, unknown> {
  return (responseBody.data as Record<string, unknown>).admission as Record<string, unknown>;
}

function admissionList(responseBody: Record<string, unknown>): Array<Record<string, unknown>> {
  return (responseBody.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
}

/**
 * Insert a self-applied outsider admission directly via SQL, bypassing the cold-application
 * PoW flow (difficulty 7 is intentionally expensive and impractical in tests).
 */
async function seedOutsiderAdmission(
  clubId: string,
  opts: { name: string; email: string },
): Promise<string> {
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into app.admissions (club_id, origin, applicant_email, applicant_name, admission_details)
        values ($1, 'self_applied', $2, $3, '{"socials":"@outsider","reason":"I love this club"}'::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into app.admission_versions (admission_id, status, notes, version_no, created_by_member_id)
        select admission_id, 'submitted', 'Seeded outsider admission', 1, null
        from ins
      )
      select admission_id from ins
    `,
    [clubId, opts.email, opts.name],
  );
  const admissionId = rows[0]?.admission_id;
  assert.ok(admissionId, 'seedOutsiderAdmission: failed to insert admission row');
  return admissionId;
}

/**
 * Insert an owner-nominated existing-member admission directly via SQL.
 *
 * NOTE: admissions.nominate via the API has a known P0 bug — the CTE that inserts both
 * the admission row and its initial version in one statement fails with an RLS violation
 * on admission_versions. PostgreSQL evaluates the admission_versions WITH CHECK by querying
 * app.admissions, but the CTE-inserted admission row is not visible to that sub-query at
 * check time, causing the policy to reject the insert.
 *
 * Use this SQL helper as the workaround in tests until the bug is fixed.
 */
async function seedNominatedAdmission(
  clubId: string,
  applicantMemberId: string,
  sponsorMemberId: string | null = null,
): Promise<string> {
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into app.admissions (club_id, applicant_member_id, sponsor_member_id, origin, metadata)
        values ($1, $2, $3, 'owner_nominated', '{}'::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into app.admission_versions (admission_id, status, version_no, created_by_member_id)
        select admission_id, 'submitted', 1, $2
        from ins
      )
      select admission_id from ins
    `,
    [clubId, applicantMemberId, sponsorMemberId],
  );
  const admissionId = rows[0]?.admission_id;
  assert.ok(admissionId, 'seedNominatedAdmission: failed to insert admission row');
  return admissionId;
}

/**
 * Insert a member-sponsored outsider admission directly via SQL.
 *
 * NOTE: admissions.sponsor via the API has a known P0 bug. After inserting the admission row
 * (using withActorContext as the sponsoring member), the code inserts into admission_versions.
 * The RLS policy for admission_versions requires actor_is_club_owner — but the sponsoring
 * member is NOT an owner, so no policy allows the insert. The action always returns 500.
 *
 * Use this SQL helper as the workaround in tests until the bug is fixed.
 */
async function seedSponsoredAdmission(
  clubId: string,
  sponsorMemberId: string,
  opts: { name: string; email: string; socials: string; reason: string },
): Promise<string> {
  const admissionDetails = JSON.stringify({ socials: opts.socials, reason: opts.reason });
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into app.admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details)
        values ($1, $2, 'member_sponsored', $3, $4, $5::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into app.admission_versions (admission_id, status, notes, version_no, created_by_member_id)
        select admission_id, 'submitted', 'Sponsored admission created by member', 1, $2
        from ins
      )
      select admission_id from ins
    `,
    [clubId, sponsorMemberId, opts.email, opts.name, admissionDetails],
  );
  const admissionId = rows[0]?.admission_id;
  assert.ok(admissionId, 'seedSponsoredAdmission: failed to insert admission row');
  return admissionId;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 1: owner-manages outsider admission → full acceptance', () => {
  it('owner lists outsider admission, walks through all statuses, accepts, issues access', async () => {
    const owner = await h.seedOwner('outsider-club', 'Outsider Club');

    // Seed an outsider admission directly (bypasses PoW)
    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Jane Outsider',
      email: 'jane.outsider@example.com',
    });

    // Owner lists admissions — should appear
    const listBody = await h.apiOk(owner.token, 'admissions.list', { clubId: owner.club.id });
    const listed = admissionList(listBody);
    const found = listed.find((a) => a.admissionId === admissionId);
    assert.ok(found, 'Outsider admission should appear in admissions.list');
    assert.equal((found.state as Record<string, unknown>).status, 'submitted');
    assert.equal(found.origin, 'self_applied');
    assert.equal(
      (found.applicant as Record<string, unknown>).memberId,
      null,
      'Outsider has no memberId yet',
    );

    // Transition: submitted → interview_scheduled
    const afterScheduled = await h.apiOk(owner.token, 'admissions.transition', {
      admissionId,
      status: 'interview_scheduled',
      notes: 'Interview booked for next Tuesday',
    });
    assert.equal(admission(afterScheduled).admissionId, admissionId);
    assert.equal(
      (admission(afterScheduled).state as Record<string, unknown>).status,
      'interview_scheduled',
    );

    // Transition: interview_scheduled → interview_completed
    const afterCompleted = await h.apiOk(owner.token, 'admissions.transition', {
      admissionId,
      status: 'interview_completed',
      notes: 'Great chat',
    });
    assert.equal(
      (admission(afterCompleted).state as Record<string, unknown>).status,
      'interview_completed',
    );

    // Transition: interview_completed → accepted
    // On acceptance the system creates a member + membership automatically
    const afterAccepted = await h.apiOk(owner.token, 'admissions.transition', {
      admissionId,
      status: 'accepted',
      notes: 'Welcome!',
    });
    const acceptedAdmission = admission(afterAccepted);
    assert.equal((acceptedAdmission.state as Record<string, unknown>).status, 'accepted');
    const linkedMemberId = (acceptedAdmission.applicant as Record<string, unknown>).memberId;
    assert.ok(linkedMemberId, 'Accepted outsider admission should have a linked memberId');
    assert.ok(
      acceptedAdmission.membershipId,
      'Accepted outsider admission should have a linked membershipId',
    );

    // Owner issues access — returns a bearer token
    const accessBody = await h.apiOk(owner.token, 'admissions.issueAccess', { admissionId });
    const accessData = accessBody.data as Record<string, unknown>;
    assert.ok(
      typeof accessData.bearerToken === 'string' && accessData.bearerToken.length > 0,
      'bearerToken should be a non-empty string',
    );

    // That token works: session.describe shows the club
    const sessionBody = await h.apiOk(accessData.bearerToken as string, 'session.describe', {});
    const hasClub = activeMemberships(sessionBody).some((m) => m.clubId === owner.club.id);
    assert.equal(hasClub, true, 'New member token should show the club in session.describe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 2: owner-nominated existing member', () => {
  /**
   * KNOWN P0 BUG: admissions.nominate via the API fails with 500 (RLS violation on
   * admission_versions). The CTE that inserts both the admission row and its first version in
   * one statement is rejected because the RLS WITH CHECK on admission_versions queries
   * app.admissions — but at check time, the CTE-inserted admission row is not visible to that
   * sub-query. This test documents the current broken behaviour.
   *
   * Workaround: use seedNominatedAdmission() in other tests.
   */
  it('admissions.nominate returns 500 due to P0 RLS bug in CTE insert (known bug)', async () => {
    const owner = await h.seedOwner('nominate-bug-club', 'Nominate Bug Club');
    const applicant = await h.seedMember('Bug Applicant', 'bug-applicant');

    const err = await h.apiErr(owner.token, 'admissions.nominate', {
      clubId: owner.club.id,
      applicantMemberId: applicant.id,
      initialStatus: 'submitted',
    });
    assert.equal(err.status, 500);
    assert.equal(err.code, 'internal_error');
  });

  it('nominated member gains club access after acceptance', async () => {
    const owner = await h.seedOwner('nominate-club', 'Nominate Club');
    const applicant = await h.seedMember('Bob Applicant', 'bob-applicant');

    // Seed admission via SQL (workaround for P0 bug in admissions.nominate)
    const admissionId = await seedNominatedAdmission(owner.club.id, applicant.id);

    // Verify it appears in admissions.list
    const listBody = await h.apiOk(owner.token, 'admissions.list', { clubId: owner.club.id });
    const found = admissionList(listBody).find((a) => a.admissionId === admissionId);
    assert.ok(found, 'Nominated admission should appear in admissions.list');
    assert.equal(found.origin, 'owner_nominated');
    assert.equal((found.applicant as Record<string, unknown>).memberId, applicant.id);
    assert.equal((found.state as Record<string, unknown>).status, 'submitted');

    // Member should NOT have access yet
    const sessionBefore = await h.apiOk(applicant.token, 'session.describe', {});
    assert.equal(
      activeMemberships(sessionBefore).some((m) => m.clubId === owner.club.id),
      false,
      'Applicant should not have club access before acceptance',
    );

    // Owner transitions to accepted — should create a membership automatically
    const afterAccepted = await h.apiOk(owner.token, 'admissions.transition', {
      admissionId,
      status: 'accepted',
    });
    const acceptedAdmission = admission(afterAccepted);
    assert.equal((acceptedAdmission.state as Record<string, unknown>).status, 'accepted');
    assert.ok(
      acceptedAdmission.membershipId,
      'Accepted nominated admission should have a linked membershipId',
    );
    assert.equal(
      (acceptedAdmission.applicant as Record<string, unknown>).memberId,
      applicant.id,
      'applicant memberId should remain unchanged after acceptance',
    );

    // Member should now have club access
    const sessionAfter = await h.apiOk(applicant.token, 'session.describe', {});
    assert.equal(
      activeMemberships(sessionAfter).some((m) => m.clubId === owner.club.id),
      true,
      'Applicant should have club access after acceptance',
    );
  });

  /**
   * KNOWN P0 BUG: issueAccess for an already-existing member admission currently SUCCEEDS
   * (returns a new bearer token) rather than returning a clear error or being a no-op. This
   * means the same existing member can be issued multiple separate bearer tokens via the
   * admissions flow — unintended behaviour. The test documents the current reality.
   */
  it('issueAccess succeeds for existing-member admission (P0 bug: should reject or be idempotent)', async () => {
    const owner = await h.seedOwner('nominate-issue-club', 'Nominate Issue Club');
    const applicant = await h.seedMember('Carol Issue', 'carol-issue');

    const admissionId = await seedNominatedAdmission(owner.club.id, applicant.id);
    await h.apiOk(owner.token, 'admissions.transition', { admissionId, status: 'accepted' });

    // issueAccess currently returns a new bearer token for the existing member.
    // This is the documented P0 bug — it should either:
    //   a) return a 4xx (e.g. member already has access, no fresh token needed), or
    //   b) be clearly idempotent (return the same token each time).
    // For now, we assert it succeeds and the returned token grants club access.
    const accessBody = await h.apiOk(owner.token, 'admissions.issueAccess', { admissionId });
    const accessData = accessBody.data as Record<string, unknown>;
    assert.ok(
      typeof accessData.bearerToken === 'string' && accessData.bearerToken.length > 0,
      'issueAccess returns a bearer token even for existing-member admissions (P0 bug)',
    );

    const sessionBody = await h.apiOk(accessData.bearerToken as string, 'session.describe', {});
    assert.equal(
      activeMemberships(sessionBody).some((m) => m.clubId === owner.club.id),
      true,
      'The issued token grants access to the club',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 3: member-sponsored outsider admission', () => {
  /**
   * KNOWN P0 BUG: admissions.sponsor via the API fails with 500 (RLS violation on
   * admission_versions). After inserting the admission row (using withActorContext as the
   * sponsoring member), the code inserts into admission_versions. However, the only non-cold
   * INSERT policy on admission_versions requires actor_is_club_owner — but the sponsor is not
   * an owner. No policy allows a regular club member to insert into admission_versions.
   *
   * This test documents the current broken behaviour.
   * Workaround: use seedSponsoredAdmission() in other tests.
   */
  it('admissions.sponsor returns 500 due to P0 RLS gap on admission_versions (known bug)', async () => {
    const owner = await h.seedOwner('sponsor-bug-club', 'Sponsor Bug Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Bug Sponsor', 'bug-sponsor', {
      sponsorId: owner.id,
    });

    const err = await h.apiErr(sponsor.token, 'admissions.sponsor', {
      clubId: owner.club.id,
      name: 'Bug Outsider',
      email: 'bug.outsider@example.com',
      socials: '@bug',
      reason: 'Testing the bug',
    });
    assert.equal(err.status, 500);
    assert.equal(err.code, 'internal_error');
  });

  it('owner sees sponsored admission, accepts it, and can issue access', async () => {
    const owner = await h.seedOwner('sponsor-club', 'Sponsor Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Dave Sponsor', 'dave-sponsor', {
      sponsorId: owner.id,
    });

    // Seed a sponsored admission via SQL (workaround for admissions.sponsor RLS bug)
    const admissionId = await seedSponsoredAdmission(owner.club.id, sponsor.id, {
      name: 'Eve Outsider',
      email: 'eve.outsider@example.com',
      socials: '@eve_outsider',
      reason: 'She would be a great fit',
    });

    // Owner sees it in admissions.list
    const listBody = await h.apiOk(owner.token, 'admissions.list', { clubId: owner.club.id });
    const found = admissionList(listBody).find((a) => a.admissionId === admissionId);
    assert.ok(found, 'Sponsored admission should appear in owner admissions.list');
    assert.equal(found.origin, 'member_sponsored');
    assert.equal((found.state as Record<string, unknown>).status, 'submitted');
    assert.equal((found.sponsor as Record<string, unknown>).memberId, sponsor.id);

    // Owner accepts
    const afterAccepted = await h.apiOk(owner.token, 'admissions.transition', {
      admissionId,
      status: 'accepted',
    });
    const acceptedAdmission = admission(afterAccepted);
    assert.equal((acceptedAdmission.state as Record<string, unknown>).status, 'accepted');
    const linkedMemberId = (acceptedAdmission.applicant as Record<string, unknown>).memberId;
    assert.ok(linkedMemberId, 'Accepted sponsored admission should have a linked memberId');
    assert.ok(
      acceptedAdmission.membershipId,
      'Accepted sponsored admission should have a linked membershipId',
    );

    // Owner issues access
    const accessBody = await h.apiOk(owner.token, 'admissions.issueAccess', { admissionId });
    const accessData = accessBody.data as Record<string, unknown>;
    assert.ok(
      typeof accessData.bearerToken === 'string' && accessData.bearerToken.length > 0,
      'bearerToken should be a non-empty string',
    );

    // Token works — session.describe shows the club
    const sessionBody = await h.apiOk(accessData.bearerToken as string, 'session.describe', {});
    assert.equal(
      activeMemberships(sessionBody).some((m) => m.clubId === owner.club.id),
      true,
      'Issued token should grant access to the club',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 4: admissions.list shows unified view', () => {
  it('nominated, sponsored, and self-applied admissions all appear in list', async () => {
    const owner = await h.seedOwner('unified-list-club', 'Unified List Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Frank Sponsor', 'frank-sponsor', {
      sponsorId: owner.id,
    });
    const nominee = await h.seedMember('Grace Nominee', 'grace-nominee');

    // Create all three admission types via SQL (workaround for P0 bugs in nominate/sponsor actions)
    const nominatedId = await seedNominatedAdmission(owner.club.id, nominee.id);
    const sponsoredId = await seedSponsoredAdmission(owner.club.id, sponsor.id, {
      name: 'Hank Outsider',
      email: 'hank.outsider@example.com',
      socials: '@hank',
      reason: 'Good energy',
    });
    const outsiderId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Isla Cold',
      email: 'isla.cold@example.com',
    });

    // admissions.list should include all three
    const listBody = await h.apiOk(owner.token, 'admissions.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const ids = admissionList(listBody).map((a) => a.admissionId as string);

    assert.ok(ids.includes(nominatedId), 'Nominated admission should be in list');
    assert.ok(ids.includes(sponsoredId), 'Sponsored admission should be in list');
    assert.ok(ids.includes(outsiderId), 'Self-applied outsider admission should be in list');

    // Filtering by status works
    const submittedBody = await h.apiOk(owner.token, 'admissions.list', {
      clubId: owner.club.id,
      statuses: ['submitted'],
      limit: 20,
    });
    const submittedIds = admissionList(submittedBody).map((a) => a.admissionId as string);
    assert.ok(submittedIds.includes(nominatedId), 'Nominated (submitted) in submitted filter');
    assert.ok(submittedIds.includes(sponsoredId), 'Sponsored (submitted) in submitted filter');
    assert.ok(submittedIds.includes(outsiderId), 'Self-applied (submitted) in submitted filter');

    // draft filter returns empty (none are drafts in this club)
    const draftBody = await h.apiOk(owner.token, 'admissions.list', {
      clubId: owner.club.id,
      statuses: ['draft'],
      limit: 20,
    });
    const draftIds = admissionList(draftBody).map((a) => a.admissionId as string);
    assert.ok(!draftIds.includes(nominatedId), 'Nominated (submitted) not in draft filter');
    assert.ok(!draftIds.includes(sponsoredId), 'Sponsored (submitted) not in draft filter');
    assert.ok(!draftIds.includes(outsiderId), 'Self-applied (submitted) not in draft filter');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 5: non-owner cannot use owner admission actions', () => {
  it('regular member cannot call admissions.list', async () => {
    const owner = await h.seedOwner('auth-adm-club', 'Auth Admission Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Ivan Regular', 'ivan-regular', {
      sponsorId: owner.id,
    });

    const err = await h.apiErr(regularMember.token, 'admissions.list', {
      clubId: owner.club.id,
    });
    assert.equal(err.status, 403, `Expected 403 from non-owner admissions.list, got ${err.status}: ${err.code}`);
    assert.equal(err.code, 'forbidden');
  });

  it('regular member cannot transition admissions (gets 404 — not in owner scope)', async () => {
    const owner = await h.seedOwner('auth-trans-club', 'Auth Transition Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Lena Regular', 'lena-regular', {
      sponsorId: owner.id,
    });

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Mike Outsider',
      email: 'mike.outsider@example.com',
    });

    // The transition handler checks owner scope and returns 404 when admission is not
    // found within the actor's owned clubs.
    const err = await h.apiErr(regularMember.token, 'admissions.transition', {
      admissionId,
      status: 'accepted',
    });
    assert.ok(
      err.status === 404 || err.status === 403,
      `Expected 403 or 404 from non-owner admissions.transition, got ${err.status}: ${err.code}`,
    );
  });

  it('regular member cannot call admissions.issueAccess', async () => {
    const owner = await h.seedOwner('auth-access-club', 'Auth Access Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Nina Regular', 'nina-regular', {
      sponsorId: owner.id,
    });

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Oscar Outsider',
      email: 'oscar.outsider@example.com',
    });

    const err = await h.apiErr(regularMember.token, 'admissions.issueAccess', { admissionId });
    assert.equal(err.status, 403, `Expected 403 from non-owner admissions.issueAccess, got ${err.status}: ${err.code}`);
    assert.equal(err.code, 'forbidden');
  });

  it('request without bearer token gets 400 invalid_input', async () => {
    // The app layer calls requireNonEmptyString on the bearer token before any auth
    // check, so a missing/null token returns 400 invalid_input rather than 401.
    const owner = await h.seedOwner('auth-unauth-club', 'Auth Unauth Club');

    const err = await h.apiErr(null, 'admissions.list', { clubId: owner.club.id });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });
});
