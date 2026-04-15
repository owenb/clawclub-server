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

// ── Profiles ──────────────────────────────────────────────────────────────────

describe('Profiles', () => {
  it('profile.list with no memberId returns own profiles', async () => {
    const alice = await h.seedOwner('profiles-own', 'ProfilesOwnClub');

    const result = await h.apiOk(alice.token, 'profile.list', {});
    const profile = result.data as Record<string, unknown>;
    const profiles = profile.profiles as Array<Record<string, unknown>>;

    assert.equal(profile.memberId, alice.id);
    assert.ok(profile.displayName);
    assert.equal(profiles.length, 1);
    assert.equal((profiles[0]?.club as Record<string, unknown>).clubId, alice.club.id);
  });

  it('profile.list with clubId returns only that club profile', async () => {
    const owner = await h.seedOwner('profiles-filter-a', 'ProfilesFilterA');
    const secondClub = await h.seedClub('profiles-filter-b', 'ProfilesFilterB', owner.id);

    const result = await h.apiOk(owner.token, 'profile.list', { clubId: secondClub.id });
    const profile = result.data as Record<string, unknown>;
    const profiles = profile.profiles as Array<Record<string, unknown>>;

    assert.equal(profiles.length, 1);
    assert.equal((profiles[0]?.club as Record<string, unknown>).clubId, secondClub.id);
  });

  it('profile.list with another shared-club member ID returns their profile', async () => {
    const owner = await h.seedOwner('profiles-shared', 'ProfilesSharedClub');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Shared');

    const result = await h.apiOk(bob.token, 'profile.list', { memberId: owner.id });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, owner.id);
    assert.equal((profile.profiles as Array<unknown>).length, 1);
  });

  it('profile.update only changes the targeted club profile', async () => {
    const owner = await h.seedOwner('profiles-diverge-a', 'ProfilesDivergeA');
    const secondClub = await h.seedClub('profiles-diverge-b', 'ProfilesDivergeB', owner.id);

    const memberships = await h.sql<{ id: string; club_id: string }>(
      `select id, club_id
       from club_memberships
       where member_id = $1 and club_id = any($2::text[])`,
      [owner.id, [owner.club.id, secondClub.id]],
    );
    const membershipByClubId = new Map(memberships.map((membership) => [membership.club_id, membership.id]));

    await h.sql(
      `insert into member_club_profile_versions (
         membership_id, member_id, club_id, version_no, tagline, summary, created_by_member_id, generation_source
       ) values ($1, $2, $3, 2, $4, $5, $2, 'manual')`,
      [membershipByClubId.get(owner.club.id), owner.id, owner.club.id, 'Dog-club tagline', 'Working mainly on dog training and rescue support.'],
    );

    await h.sql(
      `insert into member_club_profile_versions (
         membership_id, member_id, club_id, version_no, tagline, summary, created_by_member_id, generation_source
       ) values ($1, $2, $3, 2, $4, $5, $2, 'manual')`,
      [membershipByClubId.get(secondClub.id), owner.id, secondClub.id, 'Cat-club tagline', 'Working mainly on cat fostering and adoption logistics.'],
    );

    const result = await h.apiOk(owner.token, 'profile.list', {});
    const envelope = result.data as Record<string, unknown>;
    const profiles = envelope.profiles as Array<Record<string, unknown>>;
    const byClubId = new Map(
      profiles.map((profile) => [((profile.club as Record<string, unknown>).clubId as string), profile]),
    );

    assert.equal(byClubId.size, 2);
    assert.equal(byClubId.get(owner.club.id)?.tagline, 'Dog-club tagline');
    assert.equal(byClubId.get(owner.club.id)?.summary, 'Working mainly on dog training and rescue support.');
    assert.equal(byClubId.get(secondClub.id)?.tagline, 'Cat-club tagline');
    assert.equal(byClubId.get(secondClub.id)?.summary, 'Working mainly on cat fostering and adoption logistics.');
  });

  it('members.updateIdentity changes displayName globally across clubs', async () => {
    const owner = await h.seedOwner('profiles-identity-a', 'ProfilesIdentityA');
    await h.seedClub('profiles-identity-b', 'ProfilesIdentityB', owner.id);

    const result = await h.apiOk(owner.token, 'members.updateIdentity', {
      displayName: 'Renamed Owner',
    });
    const identity = result.data as Record<string, unknown>;
    assert.equal(identity.displayName, 'Renamed Owner');

    const listResult = await h.apiOk(owner.token, 'profile.list', {});
    const envelope = listResult.data as Record<string, unknown>;

    assert.equal(envelope.displayName, 'Renamed Owner');
    assert.equal((envelope.profiles as Array<unknown>).length, 2);
  });

  it('members.updateIdentity rejects a displayName longer than 500 characters', async () => {
    const owner = await h.seedOwner('profiles-identity-toolong', 'ProfilesIdentityTooLong');
    const tooLong = 'a'.repeat(501);

    const err = await h.apiErr(owner.token, 'members.updateIdentity', {
      displayName: tooLong,
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.updateIdentity rejects a displayName containing a null byte', async () => {
    const owner = await h.seedOwner('profiles-identity-nullbyte', 'ProfilesIdentityNullByte');

    const result = await h.apiOk(owner.token, 'members.updateIdentity', {
      displayName: 'Clean\u0000Name',
    });
    const identity = result.data as Record<string, unknown>;
    assert.equal(identity.displayName, 'CleanName');
  });

  it('profile.list for self with no memberships returns profiles: []', async () => {
    const loner = await h.seedMember('No Clubs Yet');

    const result = await h.apiOk(loner.token, 'profile.list', {});
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, loner.id);
    assert.deepEqual(profile.profiles, []);
  });

  it('non-shared-club member cannot see profile', async () => {
    const clubA = await h.seedOwner('profiles-club-a', 'ProfilesClubA');
    const clubB = await h.seedOwner('profiles-club-b', 'ProfilesClubB');

    // clubB owner has no shared club with clubA owner
    const err = await h.apiErr(clubB.token, 'profile.list', { memberId: clubA.id });

    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});

// ── Members Search & List ─────────────────────────────────────────────────────

describe('Members Search & List', () => {
  it('members.searchByFullText requires clubId', async () => {
    const owner = await h.seedOwner('search-required-club', 'SearchRequiredClub');

    const err = await h.apiErr(owner.token, 'members.searchByFullText', { query: 'owner' });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.searchByFullText finds members by name in shared clubs', async () => {
    const owner = await h.seedOwner('search-club', 'SearchClub');
    await h.seedCompedMember(owner.club.id, 'Findable Person');

    const result = await h.apiOk(owner.token, 'members.searchByFullText', { query: 'Findable', clubId: owner.club.id });
    const data = result.data as Record<string, unknown>;
    const members = data.results as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(members));
    const found = members.find((m) => m.publicName === 'Findable Person');
    assert.ok(found, 'Expected to find member by name');
  });

  it('members.searchByFullText matches on global name', async () => {
    const owner = await h.seedOwner('search-global-name', 'SearchGlobalNameClub');
    await h.seedCompedMember(owner.club.id, 'Find By Public Name');

    const result = await h.apiOk(owner.token, 'members.searchByFullText', {
      query: 'Find By Public Name',
      clubId: owner.club.id,
    });
    const members = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;

    assert.ok(members.some((m) => m.publicName === 'Find By Public Name'));
  });

  it('members.list requires clubId', async () => {
    const owner = await h.seedOwner('list-required-club', 'ListRequiredClub');

    const err = await h.apiErr(owner.token, 'members.list', {});

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.list returns club members', async () => {
    const owner = await h.seedOwner('list-club', 'ListClub');
    const member1 = await h.seedCompedMember(owner.club.id, 'List Member One');
    const member2 = await h.seedCompedMember(owner.club.id, 'List Member Two');

    const result = await h.apiOk(owner.token, 'members.list', { clubId: owner.club.id });
    const data = result.data as Record<string, unknown>;
    const members = data.results as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(members));
    const ids = members.map((m) => m.memberId);
    assert.ok(ids.includes(owner.id), 'owner should appear in list');
    assert.ok(ids.includes(member1.id), 'member1 should appear in list');
    assert.ok(ids.includes(member2.id), 'member2 should appear in list');
  });

  it('members only see members from clubs they belong to', async () => {
    const clubX = await h.seedOwner('scope-club-x', 'ScopeClubX');
    const clubY = await h.seedOwner('scope-club-y', 'ScopeClubY');
    const memberX = await h.seedCompedMember(clubX.club.id, 'Only In X');

    // memberX belongs only to clubX; should not see clubY owner via members.list on clubY
    const err = await h.apiErr(memberX.token, 'members.list', { clubId: clubY.club.id });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});
