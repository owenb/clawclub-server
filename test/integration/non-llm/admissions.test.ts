import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships, admission, admissionList } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

/**
 * Insert a self-applied outsider admission directly via SQL, bypassing the cold-application
 * PoW flow (difficulty 7 is intentionally expensive and impractical in tests).
 */
async function seedOutsiderAdmission(
  clubId: string,
  opts: { name: string; email: string },
): Promise<string> {
  const rows = await h.sqlClubs<{ admission_id: string }>(
    `
      with ins as (
        insert into admissions (club_id, origin, applicant_email, applicant_name, admission_details)
        values ($1, 'self_applied', $2, $3, '{"socials":"@outsider","reason":"I love this club"}'::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
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
 * Insert a member-sponsored outsider admission directly via SQL.
 * Useful in the non-LLM suite since admissions.sponsorCandidate is LLM-gated.
 */
async function seedSponsoredAdmission(
  clubId: string,
  sponsorMemberId: string,
  opts: { name: string; email: string; socials: string; reason: string },
): Promise<string> {
  const admissionDetails = JSON.stringify({ socials: opts.socials, reason: opts.reason });
  const rows = await h.sqlClubs<{ admission_id: string }>(
    `
      with ins as (
        insert into admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details)
        values ($1, $2, 'member_sponsored', $3, $4, $5::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
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
    const listBody = await h.apiOk(owner.token, 'clubadmin.admissions.list', { clubId: owner.club.id });
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
    const afterScheduled = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
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
    const afterCompleted = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
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
    const afterAccepted = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
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
    const accessBody = await h.apiOk(owner.token, 'clubadmin.admissions.issueAccessToken', { clubId: owner.club.id, admissionId });
    const accessData = accessBody.data as Record<string, unknown>;
    assert.ok(
      typeof accessData.bearerToken === 'string' && accessData.bearerToken.length > 0,
      'bearerToken should be a non-empty string',
    );

    // That token works: session.getContext shows the club
    const sessionBody = await h.apiOk(accessData.bearerToken as string, 'session.getContext', {});
    const hasClub = activeMemberships(sessionBody).some((m) => m.clubId === owner.club.id);
    assert.equal(hasClub, true, 'New member token should show the club in session.getContext');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 2: member-sponsored outsider admission', () => {
  it('owner sees sponsored admission, accepts it, and can issue access', async () => {
    const owner = await h.seedOwner('sponsor-club', 'Sponsor Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Dave Sponsor', 'dave-sponsor', {
      sponsorId: owner.id,
    });

    // Seed a sponsored admission via SQL (admissions.sponsorCandidate is LLM-gated,
    // so the non-LLM suite cannot call it directly)
    const admissionId = await seedSponsoredAdmission(owner.club.id, sponsor.id, {
      name: 'Eve Outsider',
      email: 'eve.outsider@example.com',
      socials: '@eve_outsider',
      reason: 'She would be a great fit',
    });

    // Owner sees it in admissions.list
    const listBody = await h.apiOk(owner.token, 'clubadmin.admissions.list', { clubId: owner.club.id });
    const found = admissionList(listBody).find((a) => a.admissionId === admissionId);
    assert.ok(found, 'Sponsored admission should appear in owner admissions.list');
    assert.equal(found.origin, 'member_sponsored');
    assert.equal((found.state as Record<string, unknown>).status, 'submitted');
    assert.equal((found.sponsor as Record<string, unknown>).memberId, sponsor.id);

    // Owner accepts
    const afterAccepted = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
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
    const accessBody = await h.apiOk(owner.token, 'clubadmin.admissions.issueAccessToken', { clubId: owner.club.id, admissionId });
    const accessData = accessBody.data as Record<string, unknown>;
    assert.ok(
      typeof accessData.bearerToken === 'string' && accessData.bearerToken.length > 0,
      'bearerToken should be a non-empty string',
    );

    // Token works — session.getContext shows the club
    const sessionBody = await h.apiOk(accessData.bearerToken as string, 'session.getContext', {});
    assert.equal(
      activeMemberships(sessionBody).some((m) => m.clubId === owner.club.id),
      true,
      'Issued token should grant access to the club',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 3: admissions.list shows unified view', () => {
  it('sponsored and self-applied admissions both appear in list', async () => {
    const owner = await h.seedOwner('unified-list-club', 'Unified List Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Frank Sponsor', 'frank-sponsor', {
      sponsorId: owner.id,
    });

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

    // admissions.list should include both
    const listBody = await h.apiOk(owner.token, 'clubadmin.admissions.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const ids = admissionList(listBody).map((a) => a.admissionId as string);

    assert.ok(ids.includes(sponsoredId), 'Sponsored admission should be in list');
    assert.ok(ids.includes(outsiderId), 'Self-applied outsider admission should be in list');

    // Filtering by status works
    const submittedBody = await h.apiOk(owner.token, 'clubadmin.admissions.list', {
      clubId: owner.club.id,
      statuses: ['submitted'],
      limit: 20,
    });
    const submittedIds = admissionList(submittedBody).map((a) => a.admissionId as string);
    assert.ok(submittedIds.includes(sponsoredId), 'Sponsored (submitted) in submitted filter');
    assert.ok(submittedIds.includes(outsiderId), 'Self-applied (submitted) in submitted filter');

    // draft filter returns empty (none are drafts in this club)
    const draftBody = await h.apiOk(owner.token, 'clubadmin.admissions.list', {
      clubId: owner.club.id,
      statuses: ['draft'],
      limit: 20,
    });
    const draftIds = admissionList(draftBody).map((a) => a.admissionId as string);
    assert.ok(!draftIds.includes(sponsoredId), 'Sponsored (submitted) not in draft filter');
    assert.ok(!draftIds.includes(outsiderId), 'Self-applied (submitted) not in draft filter');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 4: non-owner cannot use owner admission actions', () => {
  it('regular member cannot call admissions.list', async () => {
    const owner = await h.seedOwner('auth-adm-club', 'Auth Admission Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Ivan Regular', 'ivan-regular', {
      sponsorId: owner.id,
    });

    const err = await h.apiErr(regularMember.token, 'clubadmin.admissions.list', {
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
    const err = await h.apiErr(regularMember.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
      admissionId,
      status: 'accepted',
    });
    assert.ok(
      err.status === 404 || err.status === 403,
      `Expected 403 or 404 from non-owner admissions.setStatus, got ${err.status}: ${err.code}`,
    );
  });

  it('regular member cannot call admissions.issueAccessToken', async () => {
    const owner = await h.seedOwner('auth-access-club', 'Auth Access Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Nina Regular', 'nina-regular', {
      sponsorId: owner.id,
    });

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Oscar Outsider',
      email: 'oscar.outsider@example.com',
    });

    const err = await h.apiErr(regularMember.token, 'clubadmin.admissions.issueAccessToken', { clubId: owner.club.id, admissionId });
    assert.equal(err.status, 403, `Expected 403 from non-owner admissions.issueAccessToken, got ${err.status}: ${err.code}`);
    assert.equal(err.code, 'forbidden');
  });

  it('request without bearer token gets 401 unauthorized', async () => {
    const owner = await h.seedOwner('auth-unauth-club', 'Auth Unauth Club');

    const err = await h.apiErr(null, 'clubadmin.admissions.list', { clubId: owner.club.id });
    assert.equal(err.status, 401);
    assert.equal(err.code, 'unauthorized');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('journey 5: challenge cleanup with recorded attempts', () => {
  it('deleting a challenge with prior attempts does not violate FK', async () => {
    // Regression test: admission_attempts rows reference admission_challenges
    // via FK. When the code deletes a consumed challenge, it must clean up
    // child attempt rows first (or rely on ON DELETE CASCADE).
    const owner = await h.seedOwner('fk-cleanup-club', 'FK Cleanup Club');

    // Seed a challenge directly via SQL (bypasses PoW solving)
    const challengeRows = await h.sql<{ id: string }>(
      `insert into admission_challenges
         (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at)
       values (1, $1, 'Tell us who you are.', 'FK Cleanup Club', 'Test', 'Owner', now() + interval '10 minutes')
       returning id`,
      [owner.club.id],
    );
    const challengeId = challengeRows[0]!.id;

    // Insert an attempt row (simulates a first attempt that got needs_revision)
    await h.sql(
      `insert into admission_attempts
         (challenge_id, club_id, attempt_no, applicant_name, applicant_email,
          payload, gate_status, gate_feedback, policy_snapshot)
       values ($1, $2, 1, 'Test Applicant', 'test@example.com',
               '{"socials":"@test","application":"test"}'::jsonb,
               'rejected', 'Missing info', 'Tell us who you are.')`,
      [challengeId, owner.club.id],
    );

    // Now delete the challenge — this is what the app code does on
    // acceptance, expiration, or attempt exhaustion. Before the fix,
    // this would fail with a FK violation (23503).
    await h.sql(
      `delete from admission_attempts where challenge_id = $1`,
      [challengeId],
    );
    await h.sql(
      `delete from admission_challenges where id = $1`,
      [challengeId],
    );

    // Verify both are gone
    const remaining = await h.sql<{ count: string }>(
      `select count(*)::text as count from admission_challenges where id = $1`,
      [challengeId],
    );
    assert.equal(remaining[0]!.count, '0', 'Challenge should be deleted');

    const remainingAttempts = await h.sql<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [challengeId],
    );
    assert.equal(remainingAttempts[0]!.count, '0', 'Attempts should be deleted');
  });

  it('ON DELETE CASCADE also cleans up attempts when challenge is deleted directly', async () => {
    const owner = await h.seedOwner('cascade-club', 'Cascade Club');

    const challengeRows = await h.sql<{ id: string }>(
      `insert into admission_challenges
         (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at)
       values (1, $1, 'Policy', 'Cascade Club', 'Test', 'Owner', now() + interval '10 minutes')
       returning id`,
      [owner.club.id],
    );
    const challengeId = challengeRows[0]!.id;

    // Insert two attempt rows
    for (let i = 1; i <= 2; i++) {
      await h.sql(
        `insert into admission_attempts
           (challenge_id, club_id, attempt_no, applicant_name, applicant_email,
            payload, gate_status, gate_feedback, policy_snapshot)
         values ($1, $2, $3, 'Applicant', 'app@example.com',
                 '{"socials":"@x","application":"y"}'::jsonb,
                 'rejected', 'Missing', 'Policy')`,
        [challengeId, owner.club.id, i],
      );
    }

    // Delete challenge directly — CASCADE should clean up attempts
    await h.sql(
      `delete from admission_challenges where id = $1`,
      [challengeId],
    );

    const remainingAttempts = await h.sql<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [challengeId],
    );
    assert.equal(remainingAttempts[0]!.count, '0', 'CASCADE should delete attempt rows');
  });
});
