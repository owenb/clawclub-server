import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestHarness } from '../harness.ts';

const TEST_DIFFICULTY = '1';
const COLD_DIFFICULTY_ENV = 'CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY';
const CROSS_DIFFICULTY_ENV = 'CLAWCLUB_TEST_CROSS_APPLICATION_DIFFICULTY';

let h: TestHarness;
let previousColdDifficulty: string | undefined;
let previousCrossDifficulty: string | undefined;

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

function findTrailingNonce(challengeId: string, difficulty: number): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 100_000; nonce++) {
    const candidate = String(nonce);
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');
    if (hash.endsWith(zeros)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find trailing nonce for difficulty ${difficulty}`);
}

async function getCurrentClubProfile(memberId: string, clubId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql<Record<string, unknown>>(
    `select id, member_id, club_id, summary, tagline, what_i_do, known_for, services_summary,
            website_url, links, generation_source, version_no
     from current_member_club_profiles
     where member_id = $1 and club_id = $2`,
    [memberId, clubId],
  );
  assert.equal(rows.length, 1, 'expected one current club profile');
  return rows[0]!;
}

async function getMemberIdForMembership(membershipId: string): Promise<string> {
  const rows = await h.sql<{ member_id: string }>(
    `select member_id
     from club_memberships
     where id = $1`,
    [membershipId],
  );
  assert.equal(rows.length, 1, 'expected one membership row');
  return rows[0]!.member_id;
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

async function readGeneratedProfileDraft(membershipId: string): Promise<Record<string, unknown> | null> {
  const rows = await h.sql<{ generated_profile_draft: Record<string, unknown> | null }>(
    `select generated_profile_draft
     from club_memberships
     where id = $1`,
    [membershipId],
  );
  return rows[0]?.generated_profile_draft ?? null;
}

async function joinAndSubmitCold(input: {
  clubSlug: string;
  email: string;
  name: string;
  socials: string;
  application: string;
}): Promise<{ memberToken: string; membershipId: string }> {
  const joinBody = await h.apiOk(null, 'clubs.join', {
    clubSlug: input.clubSlug,
    email: input.email,
  });
  const join = joinBody.data as Record<string, unknown>;
  const proof = join.proof as Record<string, unknown>;
  const nonce = findTrailingNonce(proof.challengeId as string, proof.difficulty as number);
  const memberToken = join.memberToken as string;
  const membershipId = join.membershipId as string;

  const submitBody = await h.apiOk(memberToken, 'clubs.applications.submit', {
    membershipId,
    nonce,
    name: input.name,
    socials: input.socials,
    application: input.application,
  });
  assert.equal((submitBody.data as Record<string, unknown>).status, 'submitted');
  return { memberToken, membershipId };
}

async function joinAndSubmitCrossApply(input: {
  actorToken: string;
  clubSlug: string;
  email: string;
  name: string;
  socials: string;
  application: string;
}): Promise<{ membershipId: string }> {
  const joinBody = await h.apiOk(input.actorToken, 'clubs.join', {
    clubSlug: input.clubSlug,
    email: input.email,
  });
  const join = joinBody.data as Record<string, unknown>;
  const proof = join.proof as Record<string, unknown>;
  const nonce = findTrailingNonce(proof.challengeId as string, proof.difficulty as number);
  const membershipId = join.membershipId as string;

  const submitBody = await h.apiOk(input.actorToken, 'clubs.applications.submit', {
    membershipId,
    nonce,
    name: input.name,
    socials: input.socials,
    application: input.application,
  });
  assert.equal((submitBody.data as Record<string, unknown>).status, 'submitted');
  return { membershipId };
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  previousCrossDifficulty = process.env[CROSS_DIFFICULTY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_DIFFICULTY;
  process.env[CROSS_DIFFICULTY_ENV] = TEST_DIFFICULTY;
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
  if (previousColdDifficulty === undefined) {
    delete process.env[COLD_DIFFICULTY_ENV];
  } else {
    process.env[COLD_DIFFICULTY_ENV] = previousColdDifficulty;
  }
  if (previousCrossDifficulty === undefined) {
    delete process.env[CROSS_DIFFICULTY_ENV];
  } else {
    process.env[CROSS_DIFFICULTY_ENV] = previousCrossDifficulty;
  }
}, { timeout: 15_000 });

describe('application profile generation (LLM)', () => {
  it('cold acceptance generates a club profile, strips private contact info, and exposes it via profile.list', async () => {
    const owner = await h.seedOwner('llm-profile-gen-1', 'LLM Profile Gen 1');
    await setAdmissionPolicy(
      owner.club.id,
      [
        'Please answer these questions directly:',
        '1. What is your professional specialty?',
        '2. What work do you do in that specialty?',
        '3. Share one public website or link we can use on your profile.',
      ].join('\n'),
    );

    const { memberToken, membershipId } = await joinAndSubmitCold({
      clubSlug: owner.club.slug,
      email: 'alicia.trainer@example.com',
      name: 'Alicia Trainer',
      socials: 'https://instagram.com/alicia.trainer',
      application: [
        '1. My professional specialty is dog training and canine behaviour work.',
        '2. I have spent 10 years training rescue dogs, running workshops for anxious owners, and publishing case notes from that work.',
        '3. Public website: https://dogtrainer.example.com. Private contact: alicia.private@example.com.',
      ].join('\n'),
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId,
      status: 'active',
      reason: 'Approved after review.',
    });

    const memberId = await getMemberIdForMembership(membershipId);
    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const summary = String(currentProfile.summary ?? '');
    const websiteUrl = currentProfile.website_url as string | null;
    const flattened = JSON.stringify(currentProfile);

    assert.equal(currentProfile.generation_source, 'application_generated');
    assert.ok(summary.length > 0, 'summary should be non-empty');
    assert.ok(!flattened.includes('alicia.private@example.com'), 'private email must not leak into generated profile');
    assert.equal(websiteUrl, 'https://dogtrainer.example.com');

    const listBody = await h.apiOk(memberToken, 'profile.list', {});
    const envelope = listBody.data as Record<string, unknown>;
    const profiles = envelope.profiles as Array<Record<string, unknown>>;
    assert.equal(envelope.memberId, memberId);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.summary, currentProfile.summary);
  });

  it('sparse but valid application text still produces a profile row without leaking private contact info', async () => {
    const owner = await h.seedOwner('llm-profile-gen-2', 'LLM Profile Gen 2');
    await setAdmissionPolicy(
      owner.club.id,
      'Please answer this directly in one sentence: How do you contribute to the community?',
    );

    const { membershipId } = await joinAndSubmitCold({
      clubSlug: owner.club.slug,
      email: 'sparse@example.com',
      name: 'Sparse Applicant',
      socials: '@sparse',
      application: 'How do you contribute to the community? I contribute to the community by organizing dog-walk meetups in Bristol and helping new members get oriented.',
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId,
      status: 'active',
    });

    const memberId = await getMemberIdForMembership(membershipId);
    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    const flattened = JSON.stringify(currentProfile);

    assert.equal(currentProfile.generation_source, 'application_generated');
    assert.ok(!flattened.includes('sparse@example.com'));
    assert.ok('summary' in currentProfile, 'profile row should exist even for sparse input');
  });

  it('cross-apply generates a new club-specific profile without mutating the old club profile', async () => {
    const ownerA = await h.seedOwner('llm-cross-profile-a', 'LLM Cross Profile A');
    const ownerB = await h.seedOwner('llm-cross-profile-b', 'LLM Cross Profile B');
    await setAdmissionPolicy(
      ownerB.club.id,
      [
        'Please answer these questions directly:',
        '1. What role do you play in cat rescue or feline community work?',
        '2. What concrete work do you do there?',
      ].join('\n'),
    );

    const member = await h.seedCompedMember(ownerA.club.id, 'Ada MultiClub');

    await h.sql(
      `insert into member_club_profile_versions (
         membership_id, member_id, club_id, version_no, tagline, summary, created_by_member_id, generation_source
       ) values ($1, $2, $3, 2, 'Dog trainer', 'Dog-club profile about rescue dogs and canine behaviour.', $2, 'manual')`,
      [member.membership.id, member.id, ownerA.club.id],
    );

    const { membershipId } = await joinAndSubmitCrossApply({
      actorToken: member.token,
      clubSlug: ownerB.club.slug,
      email: 'ada.multiclub@example.com',
      name: 'Ada MultiClub',
      socials: 'https://instagram.com/adacats',
      application: [
        '1. My role is cat-rescue logistics lead and volunteer mentor.',
        '2. I run weekend foster coordination in South London and mentor volunteers on intake triage and adoption handoffs.',
      ].join('\n'),
    });

    await h.apiOk(ownerB.token, 'clubadmin.memberships.setStatus', {
      clubId: ownerB.club.id,
      membershipId,
      status: 'active',
      reason: 'Strong fit for CatClub.',
    });

    const oldClubProfile = await getCurrentClubProfile(member.id, ownerA.club.id);
    const newClubProfile = await getCurrentClubProfile(member.id, ownerB.club.id);
    const memberRow = await h.sql<{ display_name: string }>(
      `select display_name from members where id = $1`,
      [member.id],
    );

    assert.equal(oldClubProfile.summary, 'Dog-club profile about rescue dogs and canine behaviour.');
    assert.equal(newClubProfile.generation_source, 'application_generated');
    assert.notEqual(newClubProfile.summary, oldClubProfile.summary);
    assert.equal(memberRow[0]?.display_name, 'Ada MultiClub');
  });

  it('stores the generated draft on the membership before acceptance and materializes it on first active transition', async () => {
    const owner = await h.seedOwner('llm-profile-draft-club', 'LLM Profile Draft Club');
    await setAdmissionPolicy(
      owner.club.id,
      [
        'Please answer these questions directly:',
        '1. What operational work do you run?',
        '2. What community systems do you operate?',
      ].join('\n'),
    );

    const { membershipId } = await joinAndSubmitCold({
      clubSlug: owner.club.slug,
      email: 'drafty@example.com',
      name: 'Drafty Operator',
      socials: '@drafty',
      application: [
        '1. I run volunteer onboarding, event logistics, and member support operations.',
        '2. I operate the onboarding and support systems for a local builders network.',
      ].join('\n'),
    });

    const memberId = await getMemberIdForMembership(membershipId);
    const draftBeforeAcceptance = await readGeneratedProfileDraft(membershipId);
    assert.ok(draftBeforeAcceptance, 'generated_profile_draft should be present after submit');
    assert.equal(await countProfileVersions(memberId, owner.club.id), 0, 'profile versions should not exist before acceptance');

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId,
      status: 'active',
      reason: 'Accepted after review.',
    });

    assert.equal(await countProfileVersions(memberId, owner.club.id), 1, 'acceptance should materialize the first club profile version');
    const currentProfile = await getCurrentClubProfile(memberId, owner.club.id);
    assert.equal(currentProfile.generation_source, 'application_generated');
  });
});
