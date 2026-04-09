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
  it('members.searchByFullText finds members by name in shared clubs', async () => {
    const owner = await h.seedOwner('search-club', 'SearchClub');
    await h.seedClubMember(owner.club.id, 'Findable Person', 'findable-person', { sponsorId: owner.id });

    const result = await h.apiOk(owner.token, 'members.searchByFullText', { query: 'Findable' });
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
