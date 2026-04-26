import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('member profiles', () => {
  it('members.get returns the actor profile inside one club', async () => {
    const alice = await h.seedOwner('profiles-own', 'ProfilesOwnClub');

    const result = await h.apiOk(alice.token, 'members.get', {
      clubId: alice.club.id,
      memberId: alice.id,
    });
    const data = result.data as Record<string, unknown>;
    const member = data.member as Record<string, unknown>;

    assert.equal((data.club as Record<string, unknown>).clubId, alice.club.id);
    assert.equal(member.memberId, alice.id);
    assert.equal(member.role, 'clubadmin');
  });

  it('members.get returns another shared-club member profile', async () => {
    const owner = await h.seedOwner('profiles-shared', 'ProfilesSharedClub');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Shared');

    const result = await h.apiOk(bob.token, 'members.get', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const member = (result.data as Record<string, unknown>).member as Record<string, unknown>;

    assert.equal(member.memberId, owner.id);
    assert.equal(member.publicName, owner.publicName);
  });

  it('members.updateProfile only changes the targeted club profile', async () => {
    const owner = await h.seedOwner('profiles-diverge-a', 'ProfilesDivergeA');
    const secondClub = await h.seedClub('profiles-diverge-b', 'ProfilesDivergeB', owner.id);

    await h.apiOk(owner.token, 'members.updateProfile', {
      clubId: owner.club.id,
      tagline: 'Dog-club tagline',
      summary: 'Working mainly on dog training and rescue support.',
    });

    await h.apiOk(owner.token, 'members.updateProfile', {
      clubId: secondClub.id,
      tagline: 'Cat-club tagline',
      summary: 'Working mainly on cat fostering and adoption logistics.',
    });

    const first = await h.apiOk(owner.token, 'members.get', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const second = await h.apiOk(owner.token, 'members.get', {
      clubId: secondClub.id,
      memberId: owner.id,
    });

    const firstMember = (first.data as Record<string, unknown>).member as Record<string, unknown>;
    const secondMember = (second.data as Record<string, unknown>).member as Record<string, unknown>;

    assert.equal(firstMember.tagline, 'Dog-club tagline');
    assert.equal(firstMember.summary, 'Working mainly on dog training and rescue support.');
    assert.equal(secondMember.tagline, 'Cat-club tagline');
    assert.equal(secondMember.summary, 'Working mainly on cat fostering and adoption logistics.');
  });

  it('accounts.updateIdentity changes displayName globally across clubs', async () => {
    const owner = await h.seedOwner('profiles-identity-a', 'ProfilesIdentityA');
    const secondClub = await h.seedClub('profiles-identity-b', 'ProfilesIdentityB', owner.id);

    const result = await h.apiOk(owner.token, 'accounts.updateIdentity', {
      clientKey: randomUUID(),
      displayName: 'Renamed Owner',
    });
    const identity = result.data as Record<string, unknown>;
    assert.equal(identity.displayName, 'Renamed Owner');

    const first = await h.apiOk(owner.token, 'members.get', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const second = await h.apiOk(owner.token, 'members.get', {
      clubId: secondClub.id,
      memberId: owner.id,
    });

    assert.equal(((first.data as Record<string, unknown>).member as Record<string, unknown>).displayName, 'Renamed Owner');
    assert.equal(((second.data as Record<string, unknown>).member as Record<string, unknown>).displayName, 'Renamed Owner');
  });

  it('accounts.updateIdentity works for a zero-membership member', async () => {
    const loner = await h.seedMember('No Clubs Yet');

    const result = await h.apiOk(loner.token, 'accounts.updateIdentity', {
      clientKey: randomUUID(),
      displayName: 'Solo Operator',
    });
    const identity = result.data as Record<string, unknown>;

    assert.equal(identity.memberId, loner.id);
    assert.equal(identity.displayName, 'Solo Operator');
  });

  it('accounts.updateIdentity rejects a displayName longer than 500 characters', async () => {
    const owner = await h.seedOwner('profiles-identity-toolong', 'ProfilesIdentityTooLong');
    const tooLong = 'a'.repeat(501);

    const err = await h.apiErr(owner.token, 'accounts.updateIdentity', {
      clientKey: randomUUID(),
      displayName: tooLong,
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('accounts.updateIdentity rejects null bytes in displayName', async () => {
    const owner = await h.seedOwner('profiles-identity-nullbyte', 'ProfilesIdentityNullByte');

    const err = await h.apiErr(owner.token, 'accounts.updateIdentity', {
      clientKey: randomUUID(),
      displayName: 'Clean\u0000Name',
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.updateProfile rejects non-http websiteUrl schemes', async () => {
    const owner = await h.seedOwner('profiles-url-scheme', 'ProfilesUrlScheme');

    const err = await h.apiErr(owner.token, 'members.updateProfile', {
      clubId: owner.club.id,
      websiteUrl: 'javascript:alert(1)',
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.updateProfile rejects non-http link URLs', async () => {
    const owner = await h.seedOwner('profiles-link-scheme', 'ProfilesLinkScheme');

    const err = await h.apiErr(owner.token, 'members.updateProfile', {
      clubId: owner.club.id,
      links: [{ url: 'file:///etc/passwd', label: 'bad' }],
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('members.get rejects clubs outside the actor scope', async () => {
    const clubA = await h.seedOwner('profiles-club-a', 'ProfilesClubA');
    const clubB = await h.seedOwner('profiles-club-b', 'ProfilesClubB');

    const err = await h.apiErr(clubB.token, 'members.get', {
      clubId: clubA.club.id,
      memberId: clubA.id,
    });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_scope');
  });
});

describe('members search & list', () => {
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

  it('members.searchByFullText treats LIKE metacharacters literally', async () => {
    const owner = await h.seedOwner('search-like-literal', 'SearchLikeLiteralClub');
    const literal = await h.seedCompedMember(owner.club.id, 'Find%Literal_User');
    await h.seedCompedMember(owner.club.id, 'FindXLiteralAUser');

    const result = await h.apiOk(owner.token, 'members.searchByFullText', {
      query: 'Find%Literal_User',
      clubId: owner.club.id,
    });
    const members = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;

    assert.ok(members.some((m) => m.memberId === literal.id));
    assert.ok(!members.some((m) => m.publicName === 'FindXLiteralAUser'));
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

    const err = await h.apiErr(clubX.token, 'members.list', { clubId: clubY.club.id });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_scope');
  });
});
