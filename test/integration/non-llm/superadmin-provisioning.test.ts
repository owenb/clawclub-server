import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;
let provisionEmailCounter = 0;

function provisionEmail(label: string): string {
  provisionEmailCounter += 1;
  const local = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'member';
  return `${local}-${provisionEmailCounter}@provisioning.test`;
}

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── superadmin.members.createWithAccessToken ───────────────────────────────

describe('superadmin.members.createWithAccessToken', () => {
  it('creates a member with bearer token', async () => {
    const admin = await h.seedSuperadmin('Provisioner');
    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'New Person',
      email: provisionEmail('New Person'),
    });
    const data = result.data as {
      member: { memberId: string; publicName: string };
      token: { tokenId: string; memberId: string; bearerToken: string };
    };

    assert.ok(data.member.memberId, 'should return memberId');
    assert.equal(data.member.publicName, 'New Person');
    assert.ok(data.token.tokenId, 'should return tokenId');
    assert.equal(data.token.memberId, data.member.memberId);
    assert.ok(data.token.bearerToken.startsWith('clawclub_'), 'should return clawclub_ token');
  });

  it('created member can authenticate and call session.getContext', async () => {
    const admin = await h.seedSuperadmin('Provisioner2');
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Auth Test Member',
      email: provisionEmail('Auth Test Member'),
    });
    const data = createResult.data as { member: { memberId: string }; token: { bearerToken: string } };

    // Use the new token to authenticate
    const session = await h.apiOk(data.token.bearerToken, 'session.getContext', {});
    const actor = session.actor as { member: { id: string; publicName: string } };
    assert.equal(actor.member.id, data.member.memberId);
    assert.equal(actor.member.publicName, 'Auth Test Member');
  });

  it('created member can authenticate with the legacy cc_live_ prefix', async () => {
    const admin = await h.seedSuperadmin('Provisioner2b');
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Legacy Prefix Member',
      email: provisionEmail('Legacy Prefix Member'),
    });
    const data = createResult.data as { member: { memberId: string }; token: { bearerToken: string } };
    const legacyToken = data.token.bearerToken.replace(/^clawclub_/, 'cc_live_');

    const session = await h.apiOk(legacyToken, 'session.getContext', {});
    const actor = session.actor as { member: { id: string; publicName: string } };
    assert.equal(actor.member.id, data.member.memberId);
    assert.equal(actor.member.publicName, 'Legacy Prefix Member');
  });

  it('created member has no club memberships', async () => {
    const admin = await h.seedSuperadmin('Provisioner3');
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'No Club Member',
      email: provisionEmail('No Club Member'),
    });
    const data = createResult.data as { token: { bearerToken: string } };

    const session = await h.apiOk(data.token.bearerToken, 'session.getContext', {});
    const actor = session.actor as { activeMemberships: unknown[] };
    assert.equal(actor.activeMemberships.length, 0);
  });

  it('normalizes required email', async () => {
    const admin = await h.seedSuperadmin('Provisioner5');
    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Email Person',
      email: ' Test@Example.com ',
    });
    const data = result.data as { member: { memberId: string } };

    // Verify email stored on members
    const rows = await h.sql<{ email: string }>(
      `select email from members where id = $1`,
      [data.member.memberId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.email, 'test@example.com');
  });

  it('rejects duplicate email case-insensitively', async () => {
    const admin = await h.seedSuperadmin('Provisioner-dup-email');
    await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Existing Email Person',
      email: 'duplicate-superadmin@example.com',
    });

    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Duplicate Email Person',
      email: ' Duplicate-Superadmin@Example.com ',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'email_already_registered');
  });

  it('rejects invalid email', async () => {
    const admin = await h.seedSuperadmin('Provisioner-ev');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Bad Email',
      email: 'not-an-email',
    });
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /email/i);
  });

  it('rejects email without TLD', async () => {
    const admin = await h.seedSuperadmin('Provisioner-ev2');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'No TLD',
      email: 'user@localhost',
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects null email', async () => {
    const admin = await h.seedSuperadmin('Provisioner-null-email');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Null Email',
      email: null,
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects empty publicName', async () => {
    const admin = await h.seedSuperadmin('Provisioner7');
    const err = await h.apiErr(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: '   ',
      email: provisionEmail('empty public name'),
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('non-superadmin cannot create members', async () => {
    const owner = await h.seedOwner('prov-club', 'ProvClub');
    const err = await h.apiErr(owner.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Unauthorized',
      email: provisionEmail('Unauthorized'),
    });
    assert.equal(err.status, 403);
  });
});

// ── superadmin.memberships.create ───────────────────────────

describe('superadmin.memberships.create', () => {
  it('adds a member to a club as regular member', async () => {
    const admin = await h.seedSuperadmin('MsAdmin');
    const owner = await h.seedOwner('ms-club', 'MsClub');

    // Create a fresh member
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Club Joiner',
      email: provisionEmail('Club Joiner'),
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
    assert.equal(ms.version.status, 'active');
    assert.equal(ms.isOwner, false);
    assert.equal(ms.sponsor, null, 'direct superadmin adds should not synthesize a sponsor');
  });

  it('adds a member as clubadmin', async () => {
    const admin = await h.seedSuperadmin('MsAdmin2');
    const owner = await h.seedOwner('ms-club2', 'MsClub2');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'New Admin',
      email: provisionEmail('New Admin'),
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
    const admin = await h.seedSuperadmin('MsAdmin3');
    const owner = await h.seedOwner('ms-club3', 'MsClub3');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Interactive Member',
      email: provisionEmail('Interactive Member'),
    });
    const { memberId } = (createResult.data as any).member;
    const memberToken = (createResult.data as any).token.bearerToken;

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

  it('accepts explicit sponsorId', async () => {
    const admin = await h.seedSuperadmin('MsAdmin4');
    const owner = await h.seedOwner('ms-club4', 'MsClub4');

    // Seed a sponsor who is a member of the club
    const sponsor = await h.seedCompedMember(owner.club.id, 'The Sponsor');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Sponsored Member',
      email: provisionEmail('Sponsored Member'),
    });
    const memberId = (createResult.data as any).member.memberId;

    const result = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorId: sponsor.id,
    });
    const ms = (result.data as any).membership;
    assert.equal(ms.sponsor.memberId, sponsor.id);
  });

  it('rejects non-existent sponsor', async () => {
    const admin = await h.seedSuperadmin('MsAdminSp1');
    const owner = await h.seedOwner('ms-club-sp1', 'MsClubSp1');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Ghost Sponsor Target',
      email: provisionEmail('Ghost Sponsor Target'),
    });
    const memberId = (createResult.data as any).member.memberId;

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorId: 'xxxxxxxxxxxx',
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects cross-club sponsor', async () => {
    const admin = await h.seedSuperadmin('MsAdminSp2');
    const ownerA = await h.seedOwner('ms-club-sp2a', 'MsClubSp2A');
    const ownerB = await h.seedOwner('ms-club-sp2b', 'MsClubSp2B');

    // Seed a member only in club B
    const crossSponsor = await h.seedCompedMember(ownerB.club.id, 'Cross Sponsor');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Cross Target',
      email: provisionEmail('Cross Target'),
    });
    const memberId = (createResult.data as any).member.memberId;

    // Try to use club B's member as sponsor in club A
    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: ownerA.club.id,
      memberId,
      sponsorId: crossSponsor.id,
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects superadmin self-sponsoring into a club they are not in', async () => {
    const admin = await h.seedSuperadmin('MsAdminSelf');
    const owner = await h.seedOwner('ms-club-self', 'MsClubSelf');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Self Sponsor Target',
      email: provisionEmail('Self Sponsor Target'),
    });
    const memberId = (createResult.data as any).member.memberId;

    // The superadmin is NOT a member of this club — sponsorId = admin.id should fail
    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      sponsorId: admin.id,
    });
    assert.equal(err.code, 'sponsor_not_found');
  });

  it('rejects adding to non-existent club', async () => {
    const admin = await h.seedSuperadmin('MsAdmin5');
    const member = await h.seedMember('Orphan');

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: 'xxxxxxxxxxxx',
      memberId: member.id,
    });
    assert.equal(err.code, 'club_not_found');
  });

  it('rejects adding non-existent member', async () => {
    const admin = await h.seedSuperadmin('MsAdmin6');
    const owner = await h.seedOwner('ms-club6', 'MsClub6');

    const result = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: 'xxxxxxxxxxxx',
    });
    assert.equal(result.code, 'member_not_found');
  });

  it('rejects duplicate membership', async () => {
    const admin = await h.seedSuperadmin('MsAdmin7');
    const owner = await h.seedOwner('ms-club7', 'MsClub7');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Double Joiner',
      email: provisionEmail('Double Joiner'),
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
    const member = await h.seedMember('Regular');

    const err = await h.apiErr(owner.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    assert.equal(err.status, 403);
  });

  it('rejects legacy non-active initial statuses', async () => {
    const admin = await h.seedSuperadmin('MsAdmin9');
    const owner = await h.seedOwner('ms-club9', 'MsClub9');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Submitted Member',
      email: provisionEmail('Submitted Member'),
    });
    const memberId = (createResult.data as any).member.memberId;

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId: owner.club.id,
      memberId,
      initialStatus: 'submitted',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });
});

// ── superadmin.clubs.create owner membership fix ────────────

describe('superadmin.clubs.create owner membership', () => {
  it('creates owner membership automatically when creating a club', async () => {
    const admin = await h.seedSuperadmin('ClubCreator');

    // Create a member to be the owner
    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'New Owner',
      email: provisionEmail('New Owner'),
    });
    const ownerData = (createResult.data as any);
    const ownerId = ownerData.member.memberId;
    const ownerToken = ownerData.token.bearerToken;

    // Create a club with that owner
    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
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
    const admin = await h.seedSuperadmin('ClubCreator2');

    const createResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Active Owner',
      email: provisionEmail('Active Owner'),
    });
    const ownerId = (createResult.data as any).member.memberId;
    const ownerToken = (createResult.data as any).token.bearerToken;

    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'admin-ready-club',
      name: 'Admin Ready Club',
      summary: 'Owner should be able to admin immediately',
      ownerMemberId: ownerId,
    });
    const club = (clubResult.data as any).club;

    // Owner should be able to list members (clubadmin action)
    const msResult = await h.apiOk(ownerToken, 'clubadmin.members.list', {
      clubId: club.clubId,
    });
    const results = (msResult.data as any).results as any[];
    assert.equal(results.length, 1, 'should see their own membership');
    assert.equal(results[0].memberId, ownerId);
  });
});

// ── Full provisioning workflow ──────────────────────────────

describe('full superadmin provisioning workflow', () => {
  it('create member → create club → create membership (end-to-end)', async () => {
    const admin = await h.seedSuperadmin('E2EAdmin');

    // 1. Create the owner
    const ownerResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'E2E Owner',
      email: 'owner@e2e.test',
    });
    const ownerId = (ownerResult.data as any).member.memberId;

    // 2. Create the club
    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'e2e-club',
      name: 'E2E Club',
      summary: 'End-to-end test club',
      ownerMemberId: ownerId,
    });
    const clubId = (clubResult.data as any).club.clubId;

    // 3. Create a regular member
    const memberResult = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'E2E Member',
      email: provisionEmail('E2E Member'),
    });
    const memberId = (memberResult.data as any).member.memberId;
    const memberToken = (memberResult.data as any).token.bearerToken;

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
    const memberIds = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const adminOverview = await h.apiOk(admin.token, 'superadmin.members.list', { limit: 20, cursor });
      const data = adminOverview.data as { results: Array<{ memberId: string }>; nextCursor: string | null };
      for (const row of data.results) {
        memberIds.add(row.memberId);
      }
      cursor = data.nextCursor;
      if (!cursor || (memberIds.has(ownerId) && memberIds.has(memberId))) break;
    }
    assert.ok(memberIds.has(ownerId), 'owner should appear in members list');
    assert.ok(memberIds.has(memberId), 'member should appear in members list');
  });
});

// ── superadmin.accessTokens.create ───────────────────────────────
//
// Security-critical action: mints a fresh bearer token for an existing
// active member. Every test in this block verifies a single invariant.
// Do not remove any of these — each one locks in a specific part of the
// threat model.

describe('superadmin.accessTokens.create', () => {
  it('superadmin can mint a token for an existing member and the token authenticates as that member WITHOUT inheriting the minter\'s global roles', async () => {
    const admin = await h.seedSuperadmin('TokenMinter');
    const target = await h.seedMember('Target Human');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as {
      tokenId: string;
      memberId: string;
      label: string | null;
      metadata: Record<string, unknown>;
      bearerToken: string;
    };

    assert.equal(data.memberId, target.id, 'minted token must belong to the target member, not the minter');
    assert.notEqual(data.memberId, admin.id, 'minted token must NOT belong to the superadmin');
    assert.ok(data.bearerToken.startsWith('clawclub_'), 'plaintext bearer token must be returned');
    assert.notEqual(data.bearerToken, admin.token, 'minted token must be distinct from the minting superadmin token');
    assert.notEqual(data.bearerToken, target.id, 'bearer token must not be the member id');

    // The critical security assertion: use the minted token in a real HTTP call
    // and verify it authenticates as the target member, not the minter.
    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    const actor = session.actor as {
      member: { id: string; publicName: string };
      globalRoles: string[];
    };
    assert.equal(actor.member.id, target.id, 'minted token must authenticate as the target member');
    assert.equal(actor.member.publicName, 'Target Human');

    // The P0 finding from the second-agent review: the happy path must also
    // lock down the negative case that the minted token does NOT inherit the
    // minter's superadmin role. A future regression where the minted token
    // authenticates as the target but accidentally carries the minter's
    // global roles would be catastrophic, and without this assertion it
    // would pass CI.
    assert.deepEqual(actor.globalRoles, [], 'minted token must NOT inherit the minter\'s superadmin role');
    assert.ok(!actor.globalRoles.includes('superadmin'), 'minted token must not have the superadmin global role');
  });

  it('sanity: the same assertion holds when the target is a regular member already in a club', async () => {
    // Redundant with the happy path above, but using a member that already has
    // a membership row verifies that inheriting "real" memberships doesn't
    // leak global role inheritance. Locks the invariant from a second angle.
    const admin = await h.seedSuperadmin('RoleIsolationAdmin');
    const owner = await h.seedOwner('role-isolation-club', 'RoleIsolationClub');
    const target = await h.seedCompedMember(owner.club.id, 'Regular Member');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as { bearerToken: string };

    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    const actor = session.actor as { member: { id: string }; globalRoles: string[] };
    assert.equal(actor.member.id, target.id);
    assert.deepEqual(actor.globalRoles, [], 'target was not a superadmin, so the minted token must not carry the superadmin role');
  });

  it('minted token metadata records the acting superadmin, mintedAt, and mintedVia for audit', async () => {
    const admin = await h.seedSuperadmin('AuditMinter');
    const target = await h.seedMember('Audit Target');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      reason: 'integration test audit trail',
    });
    const data = result.data as { metadata: Record<string, unknown> };
    const metadata = data.metadata;

    assert.equal(metadata.mintedBy, admin.id, 'metadata.mintedBy must equal the superadmin member id');
    assert.equal(metadata.mintedVia, 'superadmin.accessTokens.create', 'metadata.mintedVia must identify the action');
    assert.ok(typeof metadata.mintedAt === 'string' && (metadata.mintedAt as string).length > 0, 'mintedAt must be a non-empty ISO string');
    assert.equal(metadata.reason, 'integration test audit trail', 'reason must be captured in metadata');
  });

  it('default label is "admin-minted" when none is provided', async () => {
    const admin = await h.seedSuperadmin('LabelMinter1');
    const target = await h.seedMember('Default Label Target');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as { label: string | null };
    assert.equal(data.label, 'admin-minted');
  });

  it('custom label is honoured', async () => {
    const admin = await h.seedSuperadmin('LabelMinter2');
    const target = await h.seedMember('Custom Label Target');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      label: 'recovery after lost device',
    });
    const data = result.data as { label: string | null };
    assert.equal(data.label, 'recovery after lost device');
  });

  it('target member keeps their existing tokens — minting is additive, not replacing', async () => {
    const admin = await h.seedSuperadmin('AdditiveMinter');
    const target = await h.seedMember('Additive Target');

    // target already has the token from seedMember
    const originalToken = target.token;

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as { bearerToken: string };
    const mintedToken = data.bearerToken;

    assert.notEqual(mintedToken, originalToken, 'minted token must differ from the original');

    // Both tokens authenticate as the same member
    const originalSession = await h.apiOk(originalToken, 'session.getContext', {});
    const mintedSession = await h.apiOk(mintedToken, 'session.getContext', {});
    assert.equal(
      (originalSession.actor as any).member.id,
      (mintedSession.actor as any).member.id,
      'both tokens must authenticate as the same member',
    );
  });

  it('minted token inherits the real club access of the target member', async () => {
    const admin = await h.seedSuperadmin('ScopeMinter');
    const owner = await h.seedOwner('scope-club', 'ScopeClub');
    const target = await h.seedCompedMember(owner.club.id, 'Scoped Human');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as { bearerToken: string };

    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    const memberships = (session.actor as any).activeMemberships as any[];
    assert.equal(memberships.length, 1, 'target was a member of one club, minted token should see that club');
    assert.equal(memberships[0].clubId, owner.club.id);
    assert.equal(memberships[0].slug, 'scope-club');
    assert.equal(memberships[0].role, 'member');
  });

  it('non-superadmin (regular member) cannot call the action', async () => {
    const member = await h.seedMember('Not A Superadmin');
    const target = await h.seedMember('Protected Human');

    const err = await h.apiErr(member.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('non-superadmin (club owner / clubadmin) cannot call the action', async () => {
    const owner = await h.seedOwner('no-mint-club', 'NoMintClub');
    const target = await h.seedCompedMember(owner.club.id, 'Victim Human');

    const err = await h.apiErr(owner.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    assert.equal(err.status, 403, 'club owners must not be able to mint tokens for their members');
    assert.equal(err.code, 'forbidden_role');
  });

  it('unauthenticated call is rejected with 401', async () => {
    const target = await h.seedMember('Anonymous Target');

    const err = await h.apiErr(null, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    assert.equal(err.status, 401);
  });

  it('nonexistent memberId returns 404 not_found', async () => {
    const admin = await h.seedSuperadmin('NotFoundMinter');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: 'xxxxxxxxxxxx',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('missing memberId returns invalid_input', async () => {
    const admin = await h.seedSuperadmin('ValidationMinter');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {});
    assert.equal(err.code, 'invalid_input');
  });

  it('empty-string memberId returns invalid_input', async () => {
    const admin = await h.seedSuperadmin('EmptyMinter');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: '   ',
    });
    assert.equal(err.code, 'invalid_input');
  });

  it('minting for a suspended member returns 404 (suspended members cannot authenticate)', async () => {
    const admin = await h.seedSuperadmin('SuspendedMinter');
    const target = await h.seedMember('Will Be Suspended');

    // Suspend the member directly at the DB level — there is no public API for this
    // yet, but the invariant we're locking is: readActor filters on state='active',
    // so even a minted token for a suspended member couldn't authenticate.
    await h.sql(`update members set state = 'suspended' where id = $1`, [target.id]);

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    assert.equal(err.status, 404, 'minting for a non-active member must fail with not_found');
    assert.equal(err.code, 'member_not_found');
  });

  it('bypasses the per-member 10-token self-service quota', async () => {
    const admin = await h.seedSuperadmin('QuotaMinter');
    const target = await h.seedMember('Quota Target');

    // target already has 1 token from seedMember. Create 9 more via the self-service
    // path using the target's own token. That brings them to MAX_ACTIVE_TOKENS.
    for (let i = 0; i < 9; i++) {
      await h.apiOk(target.token, 'accessTokens.create', { label: `saturation-${i}` });
    }

    // Self-service should now reject (quota exceeded)
    const selfErr = await h.apiErr(target.token, 'accessTokens.create', { label: 'overflow' });
    assert.equal(selfErr.status, 429);
    assert.equal(selfErr.code, 'quota_exceeded');

    // But the superadmin path MUST still succeed — this is the recovery guarantee.
    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      label: 'admin bypass for recovery',
    });
    const data = result.data as { bearerToken: string };
    assert.ok(data.bearerToken.startsWith('clawclub_'), 'admin mint must succeed even when member is at self-service cap');

    // And that new token must actually work
    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    assert.equal((session.actor as any).member.id, target.id);
  });

  // ── Input validation edges (second-agent review P3 findings) ──

  it('malformed expiresAt returns 400 invalid_input (not a 500 from Postgres)', async () => {
    const admin = await h.seedSuperadmin('ExpiresAtMinter');
    const target = await h.seedMember('ExpiresAt Target');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      expiresAt: 'not-an-iso-date',
    });
    assert.equal(err.status, 400, 'malformed ISO string must fail validation, not fall through to Postgres');
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /ISO 8601|expiresAt/i);
  });

  it('well-formed ISO expiresAt is accepted and stored on the token', async () => {
    const admin = await h.seedSuperadmin('ValidExpiresAtMinter');
    const target = await h.seedMember('Valid ExpiresAt Target');

    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      expiresAt: expiry,
    });
    const data = result.data as { expiresAt: string | null; bearerToken: string };
    assert.ok(data.expiresAt, 'expiresAt must be persisted on the returned token summary');

    // And the token should still authenticate right now (it hasn't expired yet)
    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    assert.equal((session.actor as any).member.id, target.id);
  });

  it('date-only expiresAt (ISO 8601 date form) is accepted', async () => {
    const admin = await h.seedSuperadmin('DateOnlyMinter');
    const target = await h.seedMember('Date Only Target');
    const dateOnly = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      expiresAt: dateOnly,
    });
    const data = result.data as { expiresAt: string | null };
    assert.ok(data.expiresAt, 'date-only ISO 8601 must be accepted');
  });

  it('past expiresAt returns invalid_input', async () => {
    const admin = await h.seedSuperadmin('PastExpiresAtMinter');
    const target = await h.seedMember('Past ExpiresAt Target');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('oversized memberId (>64 chars) returns invalid_input, not 404', async () => {
    const admin = await h.seedSuperadmin('OversizeMinter');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: 'x'.repeat(1024),
    });
    assert.equal(err.status, 400, 'oversized memberId must fail validation at the parse layer');
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /memberId|at most 64/i);
  });

  it('memberId at exactly 64 characters is accepted through validation (and returns 404 for unknown id)', async () => {
    // A 64-char string is within the limit but won't correspond to a real member,
    // so we expect the handler to reach the existence check and return 404. This
    // proves the 64-char boundary is inclusive at the parse layer.
    const admin = await h.seedSuperadmin('BoundaryMinter');

    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.create', {
      memberId: 'a'.repeat(64),
    });
    assert.equal(err.status, 404, '64-char memberId must pass validation and reach the existence check');
    assert.equal(err.code, 'member_not_found');
  });
});
