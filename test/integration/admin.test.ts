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

// ── Superadmin Platform Actions ──────────────────────────────────────────────

describe('clubs.list', () => {
  it('superadmin sees all clubs', async () => {
    const admin = await h.seedSuperadmin('Admin User', 'admin-clubs-list');
    await h.seedOwner('list-club-a', 'List Club A');
    await h.seedOwner('list-club-b', 'List Club B');

    const result = await h.apiOk(admin.token, 'clubs.list', {});
    const clubs = result.data as Record<string, unknown>;
    assert.ok(Array.isArray(clubs.clubs));
    const clubList = clubs.clubs as Array<Record<string, unknown>>;
    const slugs = clubList.map((c) => c.slug);
    assert.ok(slugs.includes('list-club-a'));
    assert.ok(slugs.includes('list-club-b'));
  });
});

describe('clubs.create', () => {
  it('creates club with owner; owner appears correctly', async () => {
    const admin = await h.seedSuperadmin('Admin Creator', 'admin-clubs-create');
    const owner = await h.seedMember('New Owner', 'new-owner-create');

    const result = await h.apiOk(admin.token, 'clubs.create', {
      slug: 'created-club',
      name: 'Created Club',
      ownerMemberId: owner.id,
      summary: 'A freshly created club',
    });

    const data = result.data as Record<string, unknown>;
    const club = data.club as Record<string, unknown>;
    assert.equal(club.slug, 'created-club');
    assert.equal(club.name, 'Created Club');
    const clubOwner = club.owner as Record<string, unknown>;
    assert.equal(clubOwner.memberId, owner.id);
    assert.equal(clubOwner.publicName, 'New Owner');
  });
});

describe('clubs.archive', () => {
  it('archives a club', async () => {
    const admin = await h.seedSuperadmin('Admin Archiver', 'admin-clubs-archive');
    const { club } = await h.seedOwner('to-archive-club', 'To Archive Club');

    const result = await h.apiOk(admin.token, 'clubs.archive', { clubId: club.id });
    const data = result.data as Record<string, unknown>;
    const archived = data.club as Record<string, unknown>;
    assert.equal(archived.clubId, club.id);
    assert.ok(archived.archivedAt !== null, 'archivedAt should be set after archiving');
  });
});

describe('clubs.assignOwner', () => {
  it('reassigns ownership; new owner can use owner APIs', async () => {
    const admin = await h.seedSuperadmin('Admin Reassigner', 'admin-clubs-assign');
    const { club } = await h.seedOwner('reassign-club', 'Reassign Club');
    const newOwner = await h.seedMember('New Club Owner', 'new-club-owner-assign');

    // Reassign
    const result = await h.apiOk(admin.token, 'clubs.assignOwner', {
      clubId: club.id,
      ownerMemberId: newOwner.id,
    });
    const data = result.data as Record<string, unknown>;
    const updatedClub = data.club as Record<string, unknown>;
    const updatedOwner = updatedClub.owner as Record<string, unknown>;
    assert.equal(updatedOwner.memberId, newOwner.id);
  });

  // Known P1 bug: clubs.assignOwner writes club_owner_versions but doesn't
  // demote the old owner's club_memberships.role. The old owner retains owner
  // API access until the membership role is also updated.
  it.todo('old owner loses owner-only API access after reassignment');
});

describe('platform authorization', () => {
  it('non-superadmin cannot use superadmin actions', async () => {
    const regularMember = await h.seedMember('Regular Joe', 'regular-joe-authz');
    const err = await h.apiErr(regularMember.token, 'clubs.list', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

// ── Admin Dashboard Actions ──────────────────────────────────────────────────

describe('admin.overview', () => {
  it('returns platform stats', async () => {
    const admin = await h.seedSuperadmin('Admin Overview', 'admin-overview-test');

    const result = await h.apiOk(admin.token, 'admin.overview', {});
    const data = result.data as Record<string, unknown>;
    const overview = data.overview as Record<string, unknown>;
    assert.ok(typeof overview.totalMembers === 'number');
    assert.ok(typeof overview.totalClubs === 'number');
    assert.ok(typeof overview.totalEntities === 'number');
    assert.ok(typeof overview.totalMessages === 'number');
    assert.ok(Array.isArray(overview.recentMembers));
    assert.ok(overview.totalMembers >= 1, 'at least the admin member exists');
  });
});

describe('admin.members.list', () => {
  it('lists members', async () => {
    const admin = await h.seedSuperadmin('Admin List Members', 'admin-list-members');
    await h.seedMember('Listed Member A', 'listed-member-a');
    await h.seedMember('Listed Member B', 'listed-member-b');

    const result = await h.apiOk(admin.token, 'admin.members.list', { limit: 20, offset: 0 });
    const data = result.data as Record<string, unknown>;
    const members = data.members as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(members));
    assert.ok(members.length >= 2);
    assert.ok(members.every((m) => typeof m.memberId === 'string'));
    assert.ok(members.every((m) => typeof m.publicName === 'string'));
  });
});

describe('admin.members.get', () => {
  it('gets member detail', async () => {
    const admin = await h.seedSuperadmin('Admin Get Member', 'admin-get-member');
    const target = await h.seedMember('Detail Member', 'detail-member-target');

    const result = await h.apiOk(admin.token, 'admin.members.get', { memberId: target.id });
    const data = result.data as Record<string, unknown>;
    const member = data.member as Record<string, unknown>;
    assert.equal(member.memberId, target.id);
    assert.equal(member.publicName, 'Detail Member');
    assert.ok(Array.isArray(member.memberships));
    assert.ok(typeof member.tokenCount === 'number');
  });
});

describe('admin.clubs.stats', () => {
  it('gets club stats', async () => {
    const admin = await h.seedSuperadmin('Admin Stats', 'admin-clubs-stats');
    const ownerCtx = await h.seedOwner('stats-club', 'Stats Club');
    await h.seedClubMember(ownerCtx.club.id, 'Stats Member', 'stats-club-member', { sponsorId: ownerCtx.id });

    const result = await h.apiOk(admin.token, 'admin.clubs.stats', { clubId: ownerCtx.club.id });
    const data = result.data as Record<string, unknown>;
    const stats = data.stats as Record<string, unknown>;
    assert.equal(stats.clubId, ownerCtx.club.id);
    assert.equal(stats.slug, 'stats-club');
    assert.ok(typeof stats.entityCount === 'number');
    assert.ok(typeof stats.messageCount === 'number');
    assert.ok(stats.memberCounts !== null && typeof stats.memberCounts === 'object');
  });
});

describe('admin.messages.threads', () => {
  it('lists threads', async () => {
    const admin = await h.seedSuperadmin('Admin Threads', 'admin-msg-threads');
    const ownerCtx = await h.seedOwner('threads-club', 'Threads Club');
    const member = await h.seedClubMember(ownerCtx.club.id, 'Thread Sender', 'thread-sender', { sponsorId: ownerCtx.id });

    // Create a DM thread
    await h.apiOk(member.token, 'messages.send', {
      clubId: ownerCtx.club.id,
      recipientMemberId: ownerCtx.id,
      messageText: 'Hello threads test!',
    });

    const result = await h.apiOk(admin.token, 'admin.messages.threads', {
      clubId: ownerCtx.club.id,
      limit: 10,
    });
    const data = result.data as Record<string, unknown>;
    const threads = data.threads as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(threads));
    assert.ok(threads.length >= 1);
    assert.ok(threads.every((t) => typeof t.threadId === 'string'));
  });
});

describe('admin.messages.read', () => {
  it('reads a thread', async () => {
    const admin = await h.seedSuperadmin('Admin Read Thread', 'admin-msg-read');
    const ownerCtx = await h.seedOwner('read-thread-club', 'Read Thread Club');
    const member = await h.seedClubMember(ownerCtx.club.id, 'Thread Reader Sender', 'thread-read-sender', { sponsorId: ownerCtx.id });

    // Create a DM thread
    const sendResult = await h.apiOk(member.token, 'messages.send', {
      clubId: ownerCtx.club.id,
      recipientMemberId: ownerCtx.id,
      messageText: 'A message in a readable thread',
    });
    const sendData = sendResult.data as Record<string, unknown>;
    const msg = sendData.message as Record<string, unknown>;
    const threadId = msg.threadId as string;

    const result = await h.apiOk(admin.token, 'admin.messages.read', { threadId });
    const data = result.data as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.equal(thread.threadId, threadId);
    const messages = data.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages));
    assert.ok(messages.length >= 1);
    assert.ok(messages.some((m) => m.messageText === 'A message in a readable thread'));
  });
});

describe('admin.tokens.list', () => {
  it('lists tokens for a member', async () => {
    const admin = await h.seedSuperadmin('Admin Token List', 'admin-tokens-list');
    const member = await h.seedMember('Token Listed Member', 'token-listed-member');
    // The seeded member already has one token from seedMember

    const result = await h.apiOk(admin.token, 'admin.tokens.list', { memberId: member.id });
    const data = result.data as Record<string, unknown>;
    const tokens = data.tokens as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => typeof t.tokenId === 'string'));
    assert.ok(tokens.every((t) => t.memberId === member.id));
  });
});

describe('admin.tokens.revoke', () => {
  it('revokes a token for any member', async () => {
    const admin = await h.seedSuperadmin('Admin Revoke Token', 'admin-tokens-revoke');
    const member = await h.seedMember('Revoke Target Member', 'revoke-target-member');

    // Fetch the member's tokens to get a tokenId
    const listResult = await h.apiOk(admin.token, 'admin.tokens.list', { memberId: member.id });
    const listData = listResult.data as Record<string, unknown>;
    const tokens = listData.tokens as Array<Record<string, unknown>>;
    const tokenId = tokens[0]?.tokenId as string;
    assert.ok(tokenId, 'member should have at least one token');

    const result = await h.apiOk(admin.token, 'admin.tokens.revoke', {
      memberId: member.id,
      tokenId,
    });
    const data = result.data as Record<string, unknown>;
    const revokedToken = data.token as Record<string, unknown>;
    assert.equal(revokedToken.tokenId, tokenId);
    assert.ok(revokedToken.revokedAt !== null, 'revokedAt should be set');
  });
});

describe('admin.diagnostics.health', () => {
  it('returns diagnostics', async () => {
    const admin = await h.seedSuperadmin('Admin Diag', 'admin-diag-health');

    const result = await h.apiOk(admin.token, 'admin.diagnostics.health', {});
    const data = result.data as Record<string, unknown>;
    const diagnostics = data.diagnostics as Record<string, unknown>;
    assert.ok(typeof diagnostics.migrationCount === 'number');
    assert.ok(diagnostics.migrationCount >= 1);
    assert.ok(typeof diagnostics.memberCount === 'number');
    assert.ok(typeof diagnostics.clubCount === 'number');
    assert.ok(typeof diagnostics.tablesWithRls === 'number');
    assert.ok(typeof diagnostics.totalAppTables === 'number');
    assert.ok(typeof diagnostics.databaseSize === 'string');
  });
});

// ── Token Lifecycle ──────────────────────────────────────────────────────────

describe('tokens.list', () => {
  it('member sees their own tokens', async () => {
    const member = await h.seedMember('Token Lister', 'token-lister-member');

    const result = await h.apiOk(member.token, 'tokens.list', {});
    const data = result.data as Record<string, unknown>;
    const tokens = data.tokens as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => t.memberId === member.id));
  });
});

describe('tokens.create', () => {
  it('member creates new token; new token works', async () => {
    const member = await h.seedMember('Token Creator', 'token-creator-member');

    const createResult = await h.apiOk(member.token, 'tokens.create', { label: 'my-new-token' });
    const data = createResult.data as Record<string, unknown>;
    const tokenSummary = data.token as Record<string, unknown>;
    const newBearerToken = data.bearerToken as string;

    assert.ok(typeof newBearerToken === 'string' && newBearerToken.length > 0);
    assert.equal(tokenSummary.label, 'my-new-token');
    assert.equal(tokenSummary.memberId, member.id);

    // Verify the new token actually works
    const sessionResult = await h.apiOk(newBearerToken, 'session.describe', {});
    assert.ok(sessionResult.ok !== false, 'new token should authenticate successfully');
    const actor = sessionResult.actor as Record<string, unknown>;
    const actorMember = actor.member as Record<string, unknown>;
    assert.equal(actorMember.id, member.id);
  });
});

describe('tokens.revoke', () => {
  it('member revokes token; revoked token stops working', async () => {
    const member = await h.seedMember('Token Revoker', 'token-revoker-member');

    // Create a second token to revoke
    const createResult = await h.apiOk(member.token, 'tokens.create', { label: 'to-revoke' });
    const data = createResult.data as Record<string, unknown>;
    const tokenSummary = data.token as Record<string, unknown>;
    const tokenToRevoke = data.bearerToken as string;
    const tokenId = tokenSummary.tokenId as string;

    // Confirm it works before revocation
    await h.apiOk(tokenToRevoke, 'session.describe', {});

    // Revoke it
    const revokeResult = await h.apiOk(member.token, 'tokens.revoke', { tokenId });
    const revokeData = revokeResult.data as Record<string, unknown>;
    const revokedToken = revokeData.token as Record<string, unknown>;
    assert.equal(revokedToken.tokenId, tokenId);
    assert.ok(revokedToken.revokedAt !== null, 'revokedAt should be set after revocation');

    // Token should now be rejected — any authenticated action should return an error
    const { status } = await h.api(tokenToRevoke, 'session.describe', {});
    assert.equal(status, 401, 'revoked token should no longer be accepted');
  });
});

// ── Quotas ───────────────────────────────────────────────────────────────────

describe('quotas.status', () => {
  it('returns quota info', async () => {
    const ownerCtx = await h.seedOwner('quota-club', 'Quota Club');

    const result = await h.apiOk(ownerCtx.token, 'quotas.status', {});
    const data = result.data as Record<string, unknown>;
    const quotas = data.quotas as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(quotas));
    // Each quota entry should have the expected shape
    for (const quota of quotas) {
      assert.ok(typeof quota.action === 'string');
      assert.ok(typeof quota.clubId === 'string');
      assert.ok(typeof quota.maxPerDay === 'number');
      assert.ok(typeof quota.usedToday === 'number');
      assert.ok(typeof quota.remaining === 'number');
    }
  });
});
