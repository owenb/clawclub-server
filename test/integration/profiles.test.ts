import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getHarness } from './setup.ts';
import type { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await getHarness();
}, { timeout: 30_000 });

// ── Profiles ──────────────────────────────────────────────────────────────────

describe('Profiles', () => {
  it('profile.get with no memberId returns own profile', async () => {
    const alice = await h.seedOwner('profiles-own', 'ProfilesOwnClub');

    const result = await h.apiOk(alice.token, 'profile.get', {});
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, alice.id);
    assert.ok(profile.displayName);
  });

  it('profile.get with another shared-club member ID returns their profile', async () => {
    const owner = await h.seedOwner('profiles-shared', 'ProfilesSharedClub');
    const bob = await h.seedClubMember(owner.club.id, 'Bob Shared', 'bob-shared', { sponsorId: owner.id });

    const result = await h.apiOk(bob.token, 'profile.get', { memberId: owner.id });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, owner.id);
  });

  it('profile.update changes own profile fields', async () => {
    const carol = await h.seedOwner('profiles-update', 'ProfilesUpdateClub');

    const result = await h.apiOk(carol.token, 'profile.update', {
      displayName: 'Carol Updated',
      tagline: 'Building great things',
      summary: 'Experienced engineer focused on systems',
      whatIDo: 'Ship reliable software',
      knownFor: 'Zero-downtime deployments',
    });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.displayName, 'Carol Updated');
    assert.equal(profile.tagline, 'Building great things');
    assert.equal(profile.summary, 'Experienced engineer focused on systems');
    assert.equal(profile.whatIDo, 'Ship reliable software');
    assert.equal(profile.knownFor, 'Zero-downtime deployments');
  });

  it('updated profile is visible to shared-club members', async () => {
    const owner = await h.seedOwner('profiles-visibility', 'ProfilesVisibilityClub');
    const dave = await h.seedClubMember(owner.club.id, 'Dave Viewer', 'dave-viewer', { sponsorId: owner.id });

    await h.apiOk(owner.token, 'profile.update', {
      tagline: 'Visible to club members',
    });

    const result = await h.apiOk(dave.token, 'profile.get', { memberId: owner.id });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, owner.id);
    assert.equal(profile.tagline, 'Visible to club members');
  });

  it('non-shared-club member cannot see profile', async () => {
    const clubA = await h.seedOwner('profiles-club-a', 'ProfilesClubA');
    const clubB = await h.seedOwner('profiles-club-b', 'ProfilesClubB');

    // clubB owner has no shared club with clubA owner
    const err = await h.apiErr(clubB.token, 'profile.get', { memberId: clubA.id });

    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});

// ── Members Search & List ─────────────────────────────────────────────────────

describe('Members Search & List', () => {
  it('members.search finds members by name in shared clubs', async () => {
    const owner = await h.seedOwner('search-club', 'SearchClub');
    await h.seedClubMember(owner.club.id, 'Findable Person', 'findable-person', { sponsorId: owner.id });

    const result = await h.apiOk(owner.token, 'members.search', { query: 'Findable' });
    const data = result.data as Record<string, unknown>;
    const members = data.results as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(members));
    const found = members.find((m) => m.publicName === 'Findable Person');
    assert.ok(found, 'Expected to find member by name');
  });

  it('members.list returns club members', async () => {
    const owner = await h.seedOwner('list-club', 'ListClub');
    const member1 = await h.seedClubMember(owner.club.id, 'List Member One', 'list-member-one', { sponsorId: owner.id });
    const member2 = await h.seedClubMember(owner.club.id, 'List Member Two', 'list-member-two', { sponsorId: owner.id });

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
    const memberX = await h.seedClubMember(clubX.club.id, 'Only In X', 'only-in-x', { sponsorId: clubX.id });

    // memberX belongs only to clubX; should not see clubY owner via members.list on clubY
    const err = await h.apiErr(memberX.token, 'members.list', { clubId: clubY.club.id });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

// ── Vouching ──────────────────────────────────────────────────────────────────

describe('Vouching', () => {
  it('vouches.create — member vouches for another shared-club member', async () => {
    const owner = await h.seedOwner('vouch-club', 'VouchClub');
    const voter = await h.seedClubMember(owner.club.id, 'Vouch Voter', 'vouch-voter', { sponsorId: owner.id });

    const result = await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'Outstanding club organiser with years of experience',
    });
    const data = result.data as Record<string, unknown>;
    const vouch = data.vouch as Record<string, unknown>;

    assert.ok(vouch.edgeId, 'vouch should have an edgeId');
    assert.equal((vouch.fromMember as Record<string, unknown>).memberId, voter.id);
    assert.equal(vouch.reason, 'Outstanding club organiser with years of experience');
  });

  it('vouches.list — vouch is visible', async () => {
    const owner = await h.seedOwner('vouch-list-club', 'VouchListClub');
    const voter = await h.seedClubMember(owner.club.id, 'Vouch Lister', 'vouch-lister', { sponsorId: owner.id });

    await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'A reliable and inspiring leader',
    });

    const result = await h.apiOk(voter.token, 'vouches.list', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const data = result.data as Record<string, unknown>;
    const vouches = data.results as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(vouches));
    assert.ok(vouches.length >= 1);
    const found = vouches.find(
      (v) => (v.fromMember as Record<string, unknown>).memberId === voter.id,
    );
    assert.ok(found, 'vouch from voter should appear in list');
  });

  it('self-vouch is rejected', async () => {
    const owner = await h.seedOwner('vouch-self-club', 'VouchSelfClub');

    const err = await h.apiErr(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'I am great',
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'self_vouch');
  });

  it('duplicate vouch is rejected', async () => {
    const owner = await h.seedOwner('vouch-dup-club', 'VouchDupClub');
    const voter = await h.seedClubMember(owner.club.id, 'Dup Voter', 'dup-voter', { sponsorId: owner.id });

    await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'First vouch — legitimate',
    });

    const err = await h.apiErr(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'Second vouch — should be rejected',
    }, 'duplicate_vouch');

    assert.equal(err.status, 409);
    assert.equal(err.code, 'duplicate_vouch');
  });

  it('cannot vouch for member not in a shared club', async () => {
    const clubA = await h.seedOwner('vouch-a-club', 'VouchAClub');
    const clubB = await h.seedOwner('vouch-b-club', 'VouchBClub');

    // clubA owner uses a clubId that is not in their scope (clubB.club.id) — forbidden
    const err = await h.apiErr(clubA.token, 'vouches.create', {
      clubId: clubB.club.id,
      memberId: clubB.id,
      reason: 'Trying to vouch in a club I do not belong to',
    });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});
