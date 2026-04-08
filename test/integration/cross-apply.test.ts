import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

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
 * Seed a cross-applied admission directly via SQL, bypassing the PoW + LLM gate.
 * Sets applicant_member_id at creation time (the defining trait of cross-apply).
 */
async function seedCrossApplyAdmission(
  clubId: string,
  memberId: string,
  opts: { name: string; email: string },
): Promise<string> {
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into admissions (club_id, origin, applicant_member_id, applicant_email, applicant_name, admission_details)
        values ($1, 'self_applied', $2, $3, $4, '{"socials":"@cross","application":"I want to join"}'::jsonb)
        returning id as admission_id
      ),
      ver as (
        insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
        select admission_id, 'submitted', 'Cross-applied by existing network member', 1, $2
        from ins
      )
      select admission_id from ins
    `,
    [clubId, memberId, opts.email, opts.name],
  );
  const admissionId = rows[0]?.admission_id;
  assert.ok(admissionId, 'seedCrossApplyAdmission: failed to insert admission row');
  return admissionId;
}

/** Add an email to a member's private_contacts (harness seedMember doesn't do this). */
async function seedEmail(memberId: string, email: string): Promise<void> {
  await h.sql(
    `insert into member_private_contacts (member_id, email) values ($1, $2) on conflict (member_id) do update set email = $2`,
    [memberId, email],
  );
}

/** Set admission_policy on a club by inserting a new club_version (trigger syncs to clubs). */
async function setAdmissionPolicy(clubId: string, policy: string): Promise<void> {
  await h.sql(
    `insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
     select c.id, c.owner_member_id, c.name, c.summary, $2,
            coalesce((select max(version_no) from club_versions where club_id = $1), 0) + 1,
            c.owner_member_id
     from clubs c where c.id = $1`,
    [clubId, policy],
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('cross-apply journey 1: existing member accepted to new club', () => {
  it('admin accepts cross-apply admission, member gets club access', async () => {
    // Club A: member already belongs here
    const ownerA = await h.seedOwner('cross-club-a', 'Cross Club A');
    const member = await h.seedClubMember(ownerA.club.id, 'Ada Cross', 'ada-cross', {
      sponsorId: ownerA.id,
    });

    // Club B: target club to cross-apply into
    const ownerB = await h.seedOwner('cross-club-b', 'Cross Club B');

    // Seed the cross-apply admission
    const admissionId = await seedCrossApplyAdmission(ownerB.club.id, member.id, {
      name: 'Ada Cross',
      email: 'ada@example.com',
    });

    // Club B owner sees it
    const listBody = await h.apiOk(ownerB.token, 'clubadmin.admissions.list', { clubId: ownerB.club.id });
    const found = admissionList(listBody).find((a) => a.admissionId === admissionId);
    assert.ok(found, 'Cross-apply admission should appear in admissions.list');
    assert.equal(found.origin, 'self_applied');
    assert.equal(
      (found.applicant as Record<string, unknown>).memberId,
      member.id,
      'Cross-apply admission should have applicant_member_id set at submission',
    );

    // Owner B accepts — should NOT create a new member, just a membership
    const afterAccepted = await h.apiOk(ownerB.token, 'clubadmin.admissions.setStatus', {
      clubId: ownerB.club.id,
      admissionId,
      status: 'accepted',
      notes: 'Welcome from Club A!',
    });
    const accepted = admission(afterAccepted);
    assert.equal((accepted.state as Record<string, unknown>).status, 'accepted');
    assert.equal(
      (accepted.applicant as Record<string, unknown>).memberId,
      member.id,
      'Same member_id preserved (no new member created)',
    );
    assert.ok(accepted.membershipId, 'Accepted cross-apply should have membershipId');

    // Member can see Club B in session.getContext
    const sessionBody = await h.apiOk(member.token, 'session.getContext', {});
    const hasClubB = activeMemberships(sessionBody).some((m) => m.clubId === ownerB.club.id);
    assert.equal(hasClubB, true, 'Cross-applied member should now see Club B in session');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cross-apply journey 2: guards and validation', () => {
  it('admissions.crossClub.requestChallenge requires at least one active membership', async () => {
    // Member with no memberships
    const loner = await h.seedMember('Lonely Loner', 'lonely-loner');
    await seedEmail(loner.id, 'loner@example.com');

    const targetOwner = await h.seedOwner('guard-club-1', 'Guard Club 1');
    await setAdmissionPolicy(targetOwner.club.id, 'Tell us why you want to join.');

    const err = await h.apiErr(loner.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'guard-club-1',
    });
    assert.equal(err.code, 'no_active_membership');
  });

  it('admissions.crossClub.requestChallenge rejects if already a member of target club', async () => {
    const owner = await h.seedOwner('guard-club-2', 'Guard Club 2');
    await setAdmissionPolicy(owner.club.id, 'Tell us why you want to join.');
    const member = await h.seedClubMember(owner.club.id, 'Already Member', 'already-member', {
      sponsorId: owner.id,
    });
    await seedEmail(member.id, 'already@example.com');

    const err = await h.apiErr(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'guard-club-2',
    });
    assert.equal(err.code, 'membership_exists');
  });

  it('admissions.crossClub.requestChallenge rejects if profile has no email', async () => {
    const ownerA = await h.seedOwner('guard-club-3a', 'Guard Club 3A');
    const ownerB = await h.seedOwner('guard-club-3b', 'Guard Club 3B');
    await setAdmissionPolicy(ownerB.club.id, 'Tell us why you want to join.');

    const member = await h.seedClubMember(ownerA.club.id, 'No Email', 'no-email', {
      sponsorId: ownerA.id,
    });
    // Deliberately not seeding email

    const err = await h.apiErr(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'guard-club-3b',
    });
    assert.equal(err.code, 'incomplete_profile');
  });

  it('admissions.crossClub.requestChallenge rejects if pending admission exists in target club', async () => {
    const ownerA = await h.seedOwner('guard-club-4a', 'Guard Club 4A');
    const ownerB = await h.seedOwner('guard-club-4b', 'Guard Club 4B');
    await setAdmissionPolicy(ownerB.club.id, 'Tell us why you want to join.');

    const member = await h.seedClubMember(ownerA.club.id, 'Dupe Applicant', 'dupe-applicant', {
      sponsorId: ownerA.id,
    });
    await seedEmail(member.id, 'dupe@example.com');

    // Seed a pending admission
    await seedCrossApplyAdmission(ownerB.club.id, member.id, {
      name: 'Dupe Applicant',
      email: 'dupe@example.com',
    });

    const err = await h.apiErr(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'guard-club-4b',
    });
    assert.equal(err.code, 'admission_pending');
  });

  it('admissions.crossClub.requestChallenge rejects when 3 pending cross-applications exist', async () => {
    const homeOwner = await h.seedOwner('cap-home', 'Cap Home');
    const member = await h.seedClubMember(homeOwner.club.id, 'Cap Test', 'cap-test', {
      sponsorId: homeOwner.id,
    });
    await seedEmail(member.id, 'cap@example.com');

    // Seed 3 pending cross-apply admissions to different clubs
    for (let i = 1; i <= 3; i++) {
      const targetOwner = await h.seedOwner(`cap-target-${i}`, `Cap Target ${i}`);
      await seedCrossApplyAdmission(targetOwner.club.id, member.id, {
        name: 'Cap Test',
        email: 'cap@example.com',
      });
    }

    // 4th should fail
    const targetOwner4 = await h.seedOwner('cap-target-4', 'Cap Target 4');
    await setAdmissionPolicy(targetOwner4.club.id, 'Tell us why you want to join.');

    const err = await h.apiErr(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'cap-target-4',
    });
    assert.equal(err.code, 'too_many_pending');
  });

  it('admissions.crossClub.submitApplication rejects if challenge is bound to a different member', async () => {
    const ownerA = await h.seedOwner('bind-club-a', 'Bind Club A');
    const ownerB = await h.seedOwner('bind-club-b', 'Bind Club B');
    await setAdmissionPolicy(ownerB.club.id, 'Tell us about yourself.');

    const member1 = await h.seedClubMember(ownerA.club.id, 'Bind One', 'bind-one', { sponsorId: ownerA.id });
    const member2 = await h.seedClubMember(ownerA.club.id, 'Bind Two', 'bind-two', { sponsorId: ownerA.id });
    await seedEmail(member1.id, 'bind1@example.com');
    await seedEmail(member2.id, 'bind2@example.com');

    // Member1 gets a challenge
    const challengeBody = await h.apiOk(member1.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'bind-club-b',
    });
    const challengeId = (challengeBody.data as Record<string, unknown>).challengeId as string;
    assert.ok(challengeId, 'Challenge should be created');

    // Member2 tries to use it — should fail
    const err = await h.apiErr(member2.token, 'admissions.crossClub.submitApplication', {
      challengeId,
      nonce: '0',
      socials: '@bind2',
      application: 'I want to join',
    });
    assert.equal(err.code, 'challenge_not_yours');
  });

  it('unauthenticated request to crossChallenge gets rejected', async () => {
    const owner = await h.seedOwner('unauth-cross-club', 'Unauth Cross Club');
    await setAdmissionPolicy(owner.club.id, 'Tell us why.');

    const err = await h.apiErr(null, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'unauth-cross-club',
    });
    assert.equal(err.status, 401);
  });

  it('cold path rejects member-bound (cross) challenges', async () => {
    const ownerA = await h.seedOwner('cold-reject-a', 'Cold Reject A');
    const ownerB = await h.seedOwner('cold-reject-b', 'Cold Reject B');
    await setAdmissionPolicy(ownerB.club.id, 'Tell us about yourself.');

    const member = await h.seedClubMember(ownerA.club.id, 'Cold Sneaker', 'cold-sneaker', {
      sponsorId: ownerA.id,
    });
    await seedEmail(member.id, 'sneaker@example.com');

    // Get a cross-apply challenge (difficulty 5, bound to member)
    const challengeBody = await h.apiOk(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'cold-reject-b',
    });
    const challengeId = (challengeBody.data as Record<string, unknown>).challengeId as string;

    // Try to redeem it through the cold path — should fail
    const err = await h.apiErr(null, 'admissions.public.submitApplication', {
      challengeId,
      nonce: '0',
      name: 'Cold Sneaker',
      email: 'sneaker@example.com',
      socials: '@sneaker',
      application: 'Trying to bypass cross-apply',
    });
    assert.equal(err.code, 'challenge_not_cold');
  });

  it('cross-apply solve re-checks eligibility (membership revoked after challenge minted)', async () => {
    const ownerA = await h.seedOwner('recheck-a', 'Recheck A');
    const ownerB = await h.seedOwner('recheck-b', 'Recheck B');
    await setAdmissionPolicy(ownerB.club.id, 'Tell us about yourself.');

    const member = await h.seedClubMember(ownerA.club.id, 'Revoked Member', 'revoked-member', {
      sponsorId: ownerA.id,
    });
    await seedEmail(member.id, 'revoked@example.com');

    // Get a cross-apply challenge while still active
    const challengeBody = await h.apiOk(member.token, 'admissions.crossClub.requestChallenge', {
      clubSlug: 'recheck-b',
    });
    const challengeId = (challengeBody.data as Record<string, unknown>).challengeId as string;

    // Revoke their membership (simulate admin action)
    await h.sql(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       select m.id, 'revoked', 'test revocation',
              (select coalesce(max(version_no), 0) + 1 from club_membership_state_versions where membership_id = m.id),
              $2
       from club_memberships m where m.club_id = $1 and m.member_id = $3`,
      [ownerA.club.id, ownerA.id, member.id],
    );

    // Try to solve — should fail because no active membership remains
    const err = await h.apiErr(member.token, 'admissions.crossClub.submitApplication', {
      challengeId,
      nonce: '0',
      socials: '@revoked',
      application: 'I want to join',
    });
    assert.equal(err.code, 'no_active_membership');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cross-apply journey 3: shows in unified admin list', () => {
  it('cross-apply admission appears alongside cold and sponsored admissions', async () => {
    const ownerA = await h.seedOwner('unified-club-a', 'Unified Club A');
    const member = await h.seedClubMember(ownerA.club.id, 'Unity Member', 'unity-member', {
      sponsorId: ownerA.id,
    });

    const ownerB = await h.seedOwner('unified-club-b', 'Unified Club B');

    // Seed a cold outsider admission
    const coldId = (await h.sql<{ admission_id: string }>(
      `with ins as (
         insert into admissions (club_id, origin, applicant_email, applicant_name, admission_details)
         values ($1, 'self_applied', 'cold@example.com', 'Cold Outsider', '{"socials":"@cold"}'::jsonb)
         returning id as admission_id
       ),
       ver as (
         insert into admission_versions (admission_id, status, notes, version_no)
         select admission_id, 'submitted', 'Cold apply', 1 from ins
       )
       select admission_id from ins`,
      [ownerB.club.id],
    ))[0]!.admission_id;

    // Seed a cross-apply admission
    const crossId = await seedCrossApplyAdmission(ownerB.club.id, member.id, {
      name: 'Unity Member',
      email: 'unity@example.com',
    });

    // Owner B lists — both should appear
    const listBody = await h.apiOk(ownerB.token, 'clubadmin.admissions.list', {
      clubId: ownerB.club.id,
      limit: 20,
    });
    const ids = admissionList(listBody).map((a) => a.admissionId as string);
    assert.ok(ids.includes(coldId), 'Cold admission should appear');
    assert.ok(ids.includes(crossId), 'Cross-apply admission should appear');

    // The cross-apply one has applicant_member_id set
    const crossAdm = admissionList(listBody).find((a) => a.admissionId === crossId);
    assert.ok(crossAdm);
    assert.equal(
      (crossAdm.applicant as Record<string, unknown>).memberId,
      member.id,
      'Admin can see the existing member_id on cross-apply',
    );

    // The cold one does not
    const coldAdm = admissionList(listBody).find((a) => a.admissionId === coldId);
    assert.ok(coldAdm);
    assert.equal(
      (coldAdm.applicant as Record<string, unknown>).memberId,
      null,
      'Cold admission has no member_id',
    );
  });
});
