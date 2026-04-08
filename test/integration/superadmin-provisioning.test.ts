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

// ── superadmin.members.createWithAccessToken ───────────────────────────────

describe('superadmin.members.createWithAccessTokenWithAccessToken', () => {
  it('creates a member with bearer token', async () => {
    const admin = await h.seedSuperadmin('Provisioner', 'provisioner');
    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'New Person',
    });
    const data = result.data as { member: { memberId: string; publicName: string; handle: string }; bearerToken: string };

    assert.ok(data.member.memberId, 'should return memberId');
    assert.equal(data.member.publicName, 'New Person');
    assert.ok(data.member.handle, 'should have auto-generated handle');
    assert.ok(data.bearerToken.startsWith('cc_live_'), 'should return cc_live_ token');
  });

  it('created member can authenticate and call session.getContext', async () => {
    const admin = await h.seedSuperadmin('Provisioner2', 'provisioner2');
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Auth Test Member',
    });
    const data = createResult.data as { member: { memberId: string }; bearerToken: string };

    // Use the new token to authenticate
    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    const actor = session.actor as { member: { id: string; publicName: string } };
    assert.equal(actor.member.id, data.member.memberId);
    assert.equal(actor.member.publicName, 'Auth Test Member');
  });

  it('created member has no club memberships', async () => {
    const admin = await h.seedSuperadmin('Provisioner3', 'provisioner3');
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'No Club Member',
    });
    const data = createResult.data as { bearerToken: string };

    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    const actor = session.actor as { activeMemberships: unknown[] };
    assert.equal(actor.activeMemberships.length, 0);
  });

  it('accepts optional handle', async () => {
    const admin = await h.seedSuperadmin('Provisioner4', 'provisioner4');
    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Handle Person',
      handle: 'custom-handle-xyz',
    });
    const data = result.data as { member: { handle: string } };
    assert.equal(data.member.handle, 'custom-handle-xyz');
  });

  it('accepts optional email', async () => {
    const admin = await h.seedSuperadmin('Provisioner5', 'provisioner5');
    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Email Person',
      email: 'test@example.com',
    });
    const data = result.data as { member: { memberId: string } };

    // Verify email stored in private_contacts
    const rows = await h.sql<{ email: string }>(
      `select email from member_private_contacts where member_id = $1`,
      [data.member.memberId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.email, 'test@example.com');
  });

  it('rejects duplicate handle', async () => {
    const admin = await h.seedSuperadmin('Provisioner6', 'provisioner6');
    await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'First',
      handle: 'unique-dup-handle',
    });
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Second',
      handle: 'unique-dup-handle',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'handle_conflict');
  });

  it('rejects invalid handle format', async () => {
    const admin = await h.seedSuperadmin('Provisioner-hv', 'provisioner-hv');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Bad Handle',
      handle: 'Bad Handle',
    });
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /handle/i);
  });

  it('rejects handle with uppercase', async () => {
    const admin = await h.seedSuperadmin('Provisioner-hv2', 'provisioner-hv2');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Upper',
      handle: 'UpperCase',
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects invalid email', async () => {
    const admin = await h.seedSuperadmin('Provisioner-ev', 'provisioner-ev');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Bad Email',
      email: 'not-an-email',
    });
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /email/i);
  });

  it('rejects email without TLD', async () => {
    const admin = await h.seedSuperadmin('Provisioner-ev2', 'provisioner-ev2');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'No TLD',
      email: 'user@localhost',
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects empty publicName', async () => {
    const admin = await h.seedSuperadmin('Provisioner7', 'provisioner7');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: '   ',
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('non-superadmin cannot create members', async () => {
    const owner = await h.seedOwner('prov-club', 'ProvClub');
    const err = await h.apiErr(owner.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Unauthorized',
    });
    assert.equal(err.status, 403);
  });
});

// ── superadmin.memberships.create ───────────────────────────

describe('superadmin.memberships.create', () => {
  it('adds a member to a club as regular member', async () => {
    const admin = await h.seedSuperadmin('MsAdmin', 'ms-admin');
    const owner = await h.seedOwner('ms-club', 'MsClub');

    // Create a fresh member
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Club Joiner',
    });
    const memberId = (createResult.data as any).member.memberId;

    // Add to club
    const result = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
    });
    const ms = (result.data as any).membership;
    assert.equal(ms.clubId, owner.club.id);
    assert.equal(ms.member.memberId, memberId);
    assert.equal(ms.role, 'member');
    assert.equal(ms.state.status, 'active');
    assert.equal(ms.isOwner, false);
    // Sponsor should default to club owner
    assert.equal(ms.sponsor.memberId, owner.id);
  });

  it('adds a member as clubadmin', async () => {
    const admin = await h.seedSuperadmin('MsAdmin2', 'ms-admin2');
    const owner = await h.seedOwner('ms-club2', 'MsClub2');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'New Admin',
    });
    const memberId = (createResult.data as any).member.memberId;

    const result = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      role: 'clubadmin',
    });
    const ms = (result.data as any).membership;
    assert.equal(ms.role, 'clubadmin');
    // Clubadmin has null sponsor
    assert.equal(ms.sponsor, null);
  });

  it('member can interact with club after being added', async () => {
    const admin = await h.seedSuperadmin('MsAdmin3', 'ms-admin3');
    const owner = await h.seedOwner('ms-club3', 'MsClub3');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Interactive Member',
    });
    const { memberId } = (createResult.data as any).member;
    const memberToken = (createResult.data as any).bearerToken;

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
    });

    // The new member should see the club in their session
    const session = await h.apiOk(memberToken, 'session.getContext', {});
    const memberships = (session.actor as any).activeMemberships as any[];
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].slug, 'ms-club3');
  });

  it('accepts explicit sponsorMemberId', async () => {
    const admin = await h.seedSuperadmin('MsAdmin4', 'ms-admin4');
    const owner = await h.seedOwner('ms-club4', 'MsClub4');

    // Seed a sponsor who is a member of the club
    const sponsor = await h.seedClubMember(owner.club.id, 'The Sponsor', 'the-sponsor', { sponsorId: owner.id });

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Sponsored Member',
    });
    const memberId = (createResult.data as any).member.memberId;

    const result = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorMemberId: sponsor.id,
    });
    const ms = (result.data as any).membership;
    assert.equal(ms.sponsor.memberId, sponsor.id);
  });

  it('rejects non-existent sponsor', async () => {
    const admin = await h.seedSuperadmin('MsAdminSp1', 'ms-admin-sp1');
    const owner = await h.seedOwner('ms-club-sp1', 'MsClubSp1');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Ghost Sponsor Target',
    });
    const memberId = (createResult.data as any).member.memberId;

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorMemberId: 'xxxxxxxxxxxx',
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects cross-club sponsor', async () => {
    const admin = await h.seedSuperadmin('MsAdminSp2', 'ms-admin-sp2');
    const ownerA = await h.seedOwner('ms-club-sp2a', 'MsClubSp2A');
    const ownerB = await h.seedOwner('ms-club-sp2b', 'MsClubSp2B');

    // Seed a member only in club B
    const crossSponsor = await h.seedClubMember(ownerB.club.id, 'Cross Sponsor', 'cross-sponsor', { sponsorId: ownerB.id });

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Cross Target',
    });
    const memberId = (createResult.data as any).member.memberId;

    // Try to use club B's member as sponsor in club A
    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: ownerA.club.id,
      memberId,
      sponsorMemberId: crossSponsor.id,
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects superadmin self-sponsoring into a club they are not in', async () => {
    const admin = await h.seedSuperadmin('MsAdminSelf', 'ms-admin-self');
    const owner = await h.seedOwner('ms-club-self', 'MsClubSelf');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Self Sponsor Target',
    });
    const memberId = (createResult.data as any).member.memberId;

    // The superadmin is NOT a member of this club — sponsorMemberId = admin.id should fail
    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorMemberId: admin.id,
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects adding to non-existent club', async () => {
    const admin = await h.seedSuperadmin('MsAdmin5', 'ms-admin5');
    const member = await h.seedMember('Orphan', 'orphan-member');

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: 'xxxxxxxxxxxx',
      memberId: member.id,
    });
    assert.equal(err.code, 'not_found');
  });

  it('rejects adding non-existent member', async () => {
    const admin = await h.seedSuperadmin('MsAdmin6', 'ms-admin6');
    const owner = await h.seedOwner('ms-club6', 'MsClub6');

    const result = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: 'xxxxxxxxxxxx',
    });
    assert.equal(result.code, 'not_found');
  });

  it('rejects duplicate membership', async () => {
    const admin = await h.seedSuperadmin('MsAdmin7', 'ms-admin7');
    const owner = await h.seedOwner('ms-club7', 'MsClub7');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Double Joiner',
    });
    const memberId = (createResult.data as any).member.memberId;

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
    });

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
    });
    assert.equal(err.code, 'membership_exists');
  });

  it('non-superadmin cannot create memberships', async () => {
    const owner = await h.seedOwner('ms-club8', 'MsClub8');
    const member = await h.seedMember('Regular', 'regular-member');

    const err = await h.apiErr(owner.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    assert.equal(err.status, 403);
  });

  it('supports invited initial status', async () => {
    const admin = await h.seedSuperadmin('MsAdmin9', 'ms-admin9');
    const owner = await h.seedOwner('ms-club9', 'MsClub9');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Invited Member',
    });
    const memberId = (createResult.data as any).member.memberId;

    const result = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      initialStatus: 'invited',
    });
    const ms = (result.data as any).membership;
    assert.equal(ms.state.status, 'invited');
  });
});

// ── superadmin.clubs.create owner membership fix ────────────

describe('superadmin.clubs.create owner membership', () => {
  it('creates owner membership automatically when creating a club', async () => {
    const admin = await h.seedSuperadmin('ClubCreator', 'club-creator');

    // Create a member to be the owner
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'New Owner',
    });
    const ownerData = (createResult.data as any);
    const ownerId = ownerData.member.memberId;
    const ownerToken = ownerData.bearerToken;

    // Create a club with that owner
    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'auto-ms-club',
      name: 'Auto Membership Club',
      summary: 'Test club for owner membership auto-creation',
      ownerMemberId: ownerId,
    });
    const club = (clubResult.data as any).club;

    // Owner should immediately see the club in their session
    const session = await h.apiOk(ownerToken, 'session.getContext', {});
    const memberships = (session.actor as any).activeMemberships as any[];
    assert.equal(memberships.length, 1, 'owner should have 1 club membership');
    assert.equal(memberships[0].slug, 'auto-ms-club');
    assert.equal(memberships[0].role, 'clubadmin');
    assert.equal(memberships[0].isOwner, true);
  });

  it('owner can perform club admin actions immediately after club creation', async () => {
    const admin = await h.seedSuperadmin('ClubCreator2', 'club-creator2');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'Active Owner',
    });
    const ownerId = (createResult.data as any).member.memberId;
    const ownerToken = (createResult.data as any).bearerToken;

    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'admin-ready-club',
      name: 'Admin Ready Club',
      summary: 'Owner should be able to admin immediately',
      ownerMemberId: ownerId,
    });
    const club = (clubResult.data as any).club;

    // Owner should be able to list memberships (clubadmin action)
    const msResult = await h.apiOk(ownerToken, 'clubadmin.memberships.list', {
      clubId: club.clubId,
    });
    const results = (msResult.data as any).results as any[];
    assert.equal(results.length, 1, 'should see their own membership');
    assert.equal(results[0].member.memberId, ownerId);
  });
});

// ── Full provisioning workflow ──────────────────────────────

describe('full superadmin provisioning workflow', () => {
  it('create member → create club → create membership (end-to-end)', async () => {
    const admin = await h.seedSuperadmin('E2EAdmin', 'e2e-admin');

    // 1. Create the owner
    const ownerResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'E2E Owner',
      email: 'owner@e2e.test',
    });
    const ownerId = (ownerResult.data as any).member.memberId;

    // 2. Create the club
    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'e2e-club',
      name: 'E2E Club',
      summary: 'End-to-end test club',
      ownerMemberId: ownerId,
    });
    const clubId = (clubResult.data as any).club.clubId;

    // 3. Create a regular member
    const memberResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessTokenWithAccessToken', {
      publicName: 'E2E Member',
    });
    const memberId = (memberResult.data as any).member.memberId;
    const memberToken = (memberResult.data as any).bearerToken;

    // 4. Add member to club
    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId,
      memberId,
    });

    // 5. Verify: member sees the club
    const session = await h.apiOk(memberToken, 'session.getContext', {});
    const memberships = (session.actor as any).activeMemberships as any[];
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].slug, 'e2e-club');
    assert.equal(memberships[0].role, 'member');

    // 6. Verify: admin sees both members
    const adminOverview = await h.apiOk(admin.token, 'superadmin.members.list', { limit: 100 });
    const allMembers = (adminOverview.data as any).members as any[];
    const memberIds = allMembers.map((m: any) => m.memberId);
    assert.ok(memberIds.includes(ownerId), 'owner should appear in members list');
    assert.ok(memberIds.includes(memberId), 'member should appear in members list');
  });
});
