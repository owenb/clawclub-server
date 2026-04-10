import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { admission } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

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

async function seedOutsiderAdmission(
  clubId: string,
  opts: { name: string; email: string; application: string; socials: string },
): Promise<string> {
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into admissions (club_id, origin, applicant_email, applicant_name, admission_details)
        values ($1, 'self_applied', $2, $3, jsonb_build_object('socials', $4::text, 'application', $5::text))
        returning id as admission_id
      ),
      ver as (
        insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
        select admission_id, 'submitted', 'Seeded outsider admission', 1, null
        from ins
      )
      select admission_id from ins
    `,
    [clubId, opts.email, opts.name, opts.socials, opts.application],
  );
  return rows[0]!.admission_id;
}

async function seedCrossApplyAdmission(
  clubId: string,
  memberId: string,
  opts: { name: string; email: string; application: string; socials: string },
): Promise<string> {
  const rows = await h.sql<{ admission_id: string }>(
    `
      with ins as (
        insert into admissions (club_id, origin, applicant_member_id, applicant_email, applicant_name, admission_details)
        values ($1, 'self_applied', $2, $3, $4, jsonb_build_object('socials', $5::text, 'application', $6::text))
        returning id as admission_id
      ),
      ver as (
        insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
        select admission_id, 'submitted', 'Seeded cross admission', 1, $2
        from ins
      )
      select admission_id from ins
    `,
    [clubId, memberId, opts.email, opts.name, opts.socials, opts.application],
  );
  return rows[0]!.admission_id;
}

async function seedEmail(memberId: string, email: string): Promise<void> {
  await h.sql(
    `insert into member_private_contacts (member_id, email)
     values ($1, $2)
     on conflict (member_id) do update set email = excluded.email`,
    [memberId, email],
  );
}

async function getCurrentClubProfile(memberId: string, clubId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql<Record<string, unknown>>(
    `select id, member_id, club_id, summary, tagline, what_i_do, known_for, services_summary,
            website_url, links, profile, generation_source, version_no
     from current_member_club_profiles
     where member_id = $1 and club_id = $2`,
    [memberId, clubId],
  );
  assert.equal(rows.length, 1, 'expected one current club profile');
  return rows[0]!;
}

async function getMembershipId(memberId: string, clubId: string): Promise<string> {
  const rows = await h.sql<{ id: string }>(
    `select id
     from club_memberships
     where member_id = $1 and club_id = $2
     limit 1`,
    [memberId, clubId],
  );
  assert.equal(rows.length, 1, 'expected one membership');
  return rows[0]!.id;
}

async function countAcceptedVersions(admissionId: string): Promise<number> {
  const rows = await h.sql<{ count: string }>(
    `select count(*)::text as count
     from admission_versions
     where admission_id = $1 and status = 'accepted'`,
    [admissionId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countProfileVersions(memberId: string, clubId: string): Promise<number> {
  const rows = await h.sql<{ count: string }>(
    `select count(*)::text as count
     from member_club_profile_versions
     where member_id = $1 and club_id = $2`,
    [memberId, clubId],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('admission profile generation (LLM)', () => {
  it('acceptance generates a club profile, strips private contact info, and exposes it via profile.list', async () => {
    const owner = await h.seedOwner('llm-profile-gen-1', 'LLM Profile Gen 1');
    await setAdmissionPolicy(owner.club.id, 'We admit experienced dog trainers and canine behavior specialists.');

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Alicia Trainer',
      email: 'alicia.trainer@example.com',
      socials: 'https://instagram.com/alicia.trainer',
      application: 'I am a professional dog trainer with 10 years of experience specialising in rescue-dog behavioural work. I run workshops for anxious owners and publish case notes at https://dogtrainer.example.com. Reach me at alicia.private@example.com.',
    });

    const acceptedBody = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
      admissionId,
      status: 'accepted',
      notes: 'Approved after interview.',
    });
    const accepted = admission(acceptedBody);
    const memberId = (accepted.applicant as Record<string, unknown>).memberId as string;
    assert.ok(memberId);

    const accessBody = await h.apiOk(owner.token, 'clubadmin.admissions.issueAccessToken', {
      clubId: owner.club.id,
      admissionId,
    });
    const bearerToken = (accessBody.data as Record<string, unknown>).bearerToken as string;

    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const summary = String(currentProfile.summary ?? '');
    const websiteUrl = currentProfile.website_url as string | null;
    const flattened = JSON.stringify(currentProfile);

    assert.equal(currentProfile.generation_source, 'admission_generated');
    assert.ok(summary.length > 0, 'summary should be non-empty');
    assert.ok(!flattened.includes('alicia.private@example.com'), 'private email must not leak into generated profile');
    assert.equal(websiteUrl, 'https://dogtrainer.example.com');

    const listBody = await h.apiOk(bearerToken, 'profile.list', {});
    const envelope = listBody.data as Record<string, unknown>;
    const profiles = envelope.profiles as Array<Record<string, unknown>>;
    assert.equal(envelope.memberId, memberId);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.summary, currentProfile.summary);
  });

  it('minimal admission text still produces a profile row without leaking private contact info', async () => {
    const owner = await h.seedOwner('llm-profile-gen-2', 'LLM Profile Gen 2');
    await setAdmissionPolicy(owner.club.id, 'Tell us how you contribute.');

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Sparse Applicant',
      email: 'sparse@example.com',
      socials: '',
      application: 'hi',
    });

    const acceptedBody = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
      admissionId,
      status: 'accepted',
    });
    const accepted = admission(acceptedBody);
    const memberId = (accepted.applicant as Record<string, unknown>).memberId as string;

    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const flattened = JSON.stringify(currentProfile);

    assert.equal(currentProfile.generation_source, 'admission_generated');
    assert.ok(!flattened.includes('sparse@example.com'));
    assert.ok('summary' in currentProfile, 'profile row should exist even for sparse input');
  });

  it('cross-apply generates a new club-specific profile without mutating the old club profile', async () => {
    const ownerA = await h.seedOwner('llm-cross-profile-a', 'LLM Cross Profile A');
    const ownerB = await h.seedOwner('llm-cross-profile-b', 'LLM Cross Profile B');
    await setAdmissionPolicy(ownerB.club.id, 'We admit cat-rescue operators and feline community builders.');

    const member = await h.seedClubMember(ownerA.club.id, 'Ada MultiClub', 'ada-multiclub', { sponsorId: ownerA.id });
    await seedEmail(member.id, 'ada.multiclub@example.com');
    const ownerAMembershipId = await getMembershipId(member.id, ownerA.club.id);

    await h.sql(
      `insert into member_club_profile_versions (
         membership_id, member_id, club_id, version_no, tagline, summary, created_by_member_id, generation_source
       ) values ($1, $2, $3, 2, 'Dog trainer', 'Dog-club profile about rescue dogs and canine behaviour.', $2, 'manual')`,
      [ownerAMembershipId, member.id, ownerA.club.id],
    );

    const admissionId = await seedCrossApplyAdmission(ownerB.club.id, member.id, {
      name: 'Ada MultiClub',
      email: 'ada.multiclub@example.com',
      socials: 'https://instagram.com/adacats',
      application: 'I run weekend cat-rescue logistics and foster coordination in South London. I also mentor volunteers on intake triage and adoption handoffs.',
    });

    await h.apiOk(ownerB.token, 'clubadmin.admissions.setStatus', {
      clubId: ownerB.club.id,
      admissionId,
      status: 'accepted',
      notes: 'Strong fit for CatClub.',
    });

    const oldClubProfile = await getCurrentClubProfile(member.id, ownerA.club.id);
    const newClubProfile = await getCurrentClubProfile(member.id, ownerB.club.id);
    const memberRow = await h.sql<{ display_name: string; handle: string }>(
      `select display_name, handle from members where id = $1`,
      [member.id],
    );
    const generatedSignals = [
      newClubProfile.tagline,
      newClubProfile.summary,
      newClubProfile.what_i_do,
      newClubProfile.known_for,
      newClubProfile.services_summary,
      newClubProfile.website_url,
      ...(Array.isArray(newClubProfile.links) ? newClubProfile.links : []),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    assert.equal(oldClubProfile.summary, 'Dog-club profile about rescue dogs and canine behaviour.');
    assert.equal(newClubProfile.generation_source, 'admission_generated');
    assert.notEqual(newClubProfile.summary, oldClubProfile.summary);
    assert.ok(generatedSignals.length > 0, 'expected generated club profile content');
    assert.equal(memberRow[0]?.display_name, 'Ada MultiClub');
    assert.equal(memberRow[0]?.handle, 'ada-multiclub');
  });

  it('retrying an already-accepted admission is a no-op and does not duplicate acceptance or profile versions', async () => {
    const owner = await h.seedOwner('llm-profile-gen-retry', 'LLM Profile Gen Retry');

    const admissionId = await seedOutsiderAdmission(owner.club.id, {
      name: 'Retry Person',
      email: 'retry.person@example.com',
      socials: 'https://example.com/retry-person',
      application: 'I run a small studio that helps community teams design better member onboarding and retention systems.',
    });

    const acceptedBody = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
      admissionId,
      status: 'accepted',
      notes: 'Accepted once.',
    });
    const accepted = admission(acceptedBody);
    const memberId = (accepted.applicant as Record<string, unknown>).memberId as string;
    const beforeRetryProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const beforeRetryVersionCount = await countProfileVersions(memberId, owner.club.id);

    const retryBody = await h.apiOk(owner.token, 'clubadmin.admissions.setStatus', {
      clubId: owner.club.id,
      admissionId,
      status: 'accepted',
      notes: 'Retry accepted after missing profile.',
    });
    const retried = admission(retryBody);
    const retriedMemberId = (retried.applicant as Record<string, unknown>).memberId as string;
    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const afterRetryVersionCount = await countProfileVersions(memberId, owner.club.id);

    assert.equal(retriedMemberId, memberId);
    assert.equal(await countAcceptedVersions(admissionId), 1);
    assert.equal(currentProfile.generation_source, 'admission_generated');
    assert.equal(currentProfile.id, beforeRetryProfile.id);
    assert.equal(afterRetryVersionCount, beforeRetryVersionCount);
  });
});
