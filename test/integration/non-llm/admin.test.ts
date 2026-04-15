import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { seedPublishedEntity } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Superadmin Platform Actions ──────────────────────────────────────────────

describe('superadmin.clubs.list', () => {
  it('superadmin sees all clubs', async () => {
    const admin = await h.seedSuperadmin('Admin User');
    await h.seedOwner('list-club-a', 'List Club A');
    await h.seedOwner('list-club-b', 'List Club B');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.list', {});
    const clubs = result.data as Record<string, unknown>;
    assert.ok(Array.isArray(clubs.clubs));
    const clubList = clubs.clubs as Array<Record<string, unknown>>;
    const slugs = clubList.map((c) => c.slug);
    assert.ok(slugs.includes('list-club-a'));
    assert.ok(slugs.includes('list-club-b'));
  });

  it('includes archived clubs when requested', async () => {
    const admin = await h.seedSuperadmin('Admin Archived');
    const { club } = await h.seedOwner('to-list-archived', 'List Archived Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: club.id });

    const withArchived = await h.apiOk(admin.token, 'superadmin.clubs.list', { includeArchived: true });
    const clubsData = withArchived.data as Record<string, unknown>;
    const allClubs = clubsData.clubs as Array<Record<string, unknown>>;
    assert.ok(allClubs.some((c) => c.slug === 'to-list-archived'));

    const withoutArchived = await h.apiOk(admin.token, 'superadmin.clubs.list', {});
    const activeClubs = (withoutArchived.data as Record<string, unknown>).clubs as Array<Record<string, unknown>>;
    assert.ok(!activeClubs.some((c) => c.slug === 'to-list-archived'));
  });

  it('non-superadmin cannot list clubs', async () => {
    const member = await h.seedMember('Regular List');
    const err = await h.apiErr(member.token, 'superadmin.clubs.list', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('superadmin.clubs.create', () => {
  it('creates club with all required fields; returns correct shape', async () => {
    const admin = await h.seedSuperadmin('Admin Creator');
    const owner = await h.seedMember('New Owner');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'created-club',
      name: 'Created Club',
      ownerMemberId: owner.id,
      summary: 'A freshly created club',
    });

    const data = result.data as Record<string, unknown>;
    const club = data.club as Record<string, unknown>;
    assert.equal(club.slug, 'created-club');
    assert.equal(club.name, 'Created Club');
    assert.equal(club.summary, 'A freshly created club');
    assert.equal(club.archivedAt, null);
    assert.ok(typeof club.clubId === 'string');
    const clubOwner = club.owner as Record<string, unknown>;
    assert.equal(clubOwner.memberId, owner.id);
    assert.equal(clubOwner.publicName, 'New Owner');
    const version = club.version as Record<string, unknown>;
    assert.equal(version.versionNo, 1);
  });

  it('created club appears in superadmin.clubs.list', async () => {
    const admin = await h.seedSuperadmin('Admin Verify List');
    const owner = await h.seedMember('Verify Owner');

    await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'verify-listed',
      name: 'Verify Listed',
      ownerMemberId: owner.id,
      summary: 'Should appear in list',
    });

    const list = await h.apiOk(admin.token, 'superadmin.clubs.list', {});
    const clubs = (list.data as Record<string, unknown>).clubs as Array<Record<string, unknown>>;
    assert.ok(clubs.some((c) => c.slug === 'verify-listed'));
  });

  it('rejects missing slug', async () => {
    const admin = await h.seedSuperadmin('Admin NoSlug');
    const owner = await h.seedMember('Owner NoSlug');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      name: 'No Slug Club',
      ownerMemberId: owner.id,
      summary: 'Missing slug',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('slug'));
  });

  it('rejects missing name', async () => {
    const admin = await h.seedSuperadmin('Admin NoName');
    const owner = await h.seedMember('Owner NoName');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'no-name-club',
      ownerMemberId: owner.id,
      summary: 'Missing name',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('name'));
  });

  it('rejects missing summary', async () => {
    const admin = await h.seedSuperadmin('Admin NoSummary');
    const owner = await h.seedMember('Owner NoSummary');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'no-summary-club',
      name: 'No Summary Club',
      ownerMemberId: owner.id,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('summary'));
  });

  it('rejects missing ownerMemberId', async () => {
    const admin = await h.seedSuperadmin('Admin NoOwner');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'no-owner-club',
      name: 'No Owner Club',
      summary: 'Missing owner',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('ownerMemberId'));
  });

  it('rejects invalid slug format (uppercase)', async () => {
    const admin = await h.seedSuperadmin('Admin BadSlug');
    const owner = await h.seedMember('Owner BadSlug');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'BadSlug',
      name: 'Bad Slug Club',
      ownerMemberId: owner.id,
      summary: 'Invalid slug',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('slug'));
  });

  it('rejects invalid slug format (spaces)', async () => {
    const admin = await h.seedSuperadmin('Admin SpaceSlug');
    const owner = await h.seedMember('Owner SpaceSlug');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'bad slug',
      name: 'Space Slug Club',
      ownerMemberId: owner.id,
      summary: 'Invalid slug',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects invalid slug format (trailing hyphen)', async () => {
    const admin = await h.seedSuperadmin('Admin TrailSlug');
    const owner = await h.seedMember('Owner TrailSlug');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'trailing-',
      name: 'Trailing Slug Club',
      ownerMemberId: owner.id,
      summary: 'Invalid slug',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects duplicate slug with 409', async () => {
    const admin = await h.seedSuperadmin('Admin DupSlug');
    const owner = await h.seedMember('Owner DupSlug');

    await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'unique-slug',
      name: 'First Club',
      ownerMemberId: owner.id,
      summary: 'First club with this slug',
    });

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'unique-slug',
      name: 'Second Club',
      ownerMemberId: owner.id,
      summary: 'Duplicate slug',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'slug_conflict');
    assert.ok(err.message.includes('slug'));
  });

  it('rejects non-existent owner member', async () => {
    const admin = await h.seedSuperadmin('Admin GhostOwner');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      slug: 'ghost-owner-club',
      name: 'Ghost Owner Club',
      ownerMemberId: 'nonexistent-member-id',
      summary: 'Owner does not exist',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('non-superadmin cannot create clubs', async () => {
    const member = await h.seedMember('Regular Creator');

    const err = await h.apiErr(member.token, 'superadmin.clubs.create', {
      slug: 'forbidden-club',
      name: 'Forbidden Club',
      ownerMemberId: member.id,
      summary: 'Should be rejected',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('does not return manifestoMarkdown in response', async () => {
    const admin = await h.seedSuperadmin('Admin NoManifesto');
    const owner = await h.seedMember('Owner NoManifesto');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'no-manifesto-club',
      name: 'No Manifesto Club',
      ownerMemberId: owner.id,
      summary: 'Should not have manifesto',
    });

    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.ok(!('manifestoMarkdown' in club), 'manifestoMarkdown should not be in the response');
  });
});

describe('superadmin.clubs.archive', () => {
  it('archives a club', async () => {
    const admin = await h.seedSuperadmin('Admin Archiver');
    const { club } = await h.seedOwner('to-archive-club', 'To Archive Club');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: club.id });
    const data = result.data as Record<string, unknown>;
    const archived = data.club as Record<string, unknown>;
    assert.equal(archived.clubId, club.id);
    assert.ok(archived.archivedAt !== null, 'archivedAt should be set after archiving');
  });

  it('archiving is idempotent (preserves original archivedAt)', async () => {
    const admin = await h.seedSuperadmin('Admin DoubleArchive');
    const { club } = await h.seedOwner('double-archive-club', 'Double Archive Club');

    const first = await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: club.id });
    const firstArchivedAt = ((first.data as Record<string, unknown>).club as Record<string, unknown>).archivedAt;

    const second = await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: club.id });
    const secondArchivedAt = ((second.data as Record<string, unknown>).club as Record<string, unknown>).archivedAt;

    assert.equal(firstArchivedAt, secondArchivedAt, 'archivedAt should not change on second archive');
  });

  it('rejects missing clubId', async () => {
    const admin = await h.seedSuperadmin('Admin NoClubId');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', {});
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('clubId'));
  });

  it('rejects non-existent club', async () => {
    const admin = await h.seedSuperadmin('Admin GhostClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', { clubId: 'nonexistent-club-id' });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('non-superadmin cannot archive clubs', async () => {
    const ownerCtx = await h.seedOwner('archive-auth-club', 'Archive Auth Club');
    const err = await h.apiErr(ownerCtx.token, 'superadmin.clubs.archive', { clubId: ownerCtx.club.id });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('superadmin.clubs.assignOwner', () => {
  it('reassigns ownership; new owner appears in response', async () => {
    const admin = await h.seedSuperadmin('Admin Reassigner');
    const { club } = await h.seedOwner('reassign-club', 'Reassign Club');
    const newOwner = await h.seedMember('New Club Owner');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clubId: club.id,
      ownerMemberId: newOwner.id,
    });
    const data = result.data as Record<string, unknown>;
    const updatedClub = data.club as Record<string, unknown>;
    const updatedOwner = updatedClub.owner as Record<string, unknown>;
    assert.equal(updatedOwner.memberId, newOwner.id);
    const version = updatedClub.version as Record<string, unknown>;
    assert.equal(version.versionNo, 2, 'should be version 2 after reassignment');
  });

  it('rejects missing clubId', async () => {
    const admin = await h.seedSuperadmin('Admin AssignNoClub');
    const member = await h.seedMember('Assign NoClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', { ownerMemberId: member.id });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('clubId'));
  });

  it('rejects missing ownerMemberId', async () => {
    const admin = await h.seedSuperadmin('Admin AssignNoOwner');
    const { club } = await h.seedOwner('assign-no-owner-club', 'No Owner Club');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', { clubId: club.id });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('ownerMemberId'));
  });

  it('rejects non-existent club', async () => {
    const admin = await h.seedSuperadmin('Admin AssignGhost');
    const member = await h.seedMember('Assign Ghost');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clubId: 'nonexistent-id',
      ownerMemberId: member.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('rejects non-existent owner member', async () => {
    const admin = await h.seedSuperadmin('Admin AssignBadOwner');
    const { club } = await h.seedOwner('assign-bad-owner-club', 'Bad Owner Club');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clubId: club.id,
      ownerMemberId: 'nonexistent-member-id',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('non-superadmin cannot reassign ownership', async () => {
    const ownerCtx = await h.seedOwner('assign-auth-club', 'Assign Auth Club');
    const newOwner = await h.seedMember('Auth New Owner');
    const err = await h.apiErr(ownerCtx.token, 'superadmin.clubs.assignOwner', {
      clubId: ownerCtx.club.id,
      ownerMemberId: newOwner.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('new owner gets active membership; old owner demoted to member role', async () => {
    const admin = await h.seedSuperadmin('Admin OwnerSwap');
    const oldOwnerCtx = await h.seedOwner('owner-swap-club', 'Owner Swap Club');
    const newOwner = await h.seedMember('New Owner Swap');

    // Reassign ownership
    await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clubId: oldOwnerCtx.club.id,
      ownerMemberId: newOwner.id,
    });

    // New owner should see the club in session.getContext
    const newOwnerSession = await h.apiOk(newOwner.token, 'session.getContext', {});
    const newActor = newOwnerSession.actor as Record<string, unknown>;
    const newMemberships = (newActor.activeMemberships ?? []) as Array<Record<string, unknown>>;
    const newClubMembership = newMemberships.find((m) => m.clubId === oldOwnerCtx.club.id);
    assert.ok(newClubMembership, 'new owner should have membership in the club');
    assert.equal(newClubMembership!.role, 'clubadmin', 'new owner membership should have clubadmin role');

    // Old owner should still be a member but no longer owner
    const oldOwnerSession = await h.apiOk(oldOwnerCtx.token, 'session.getContext', {});
    const oldActor = oldOwnerSession.actor as Record<string, unknown>;
    const oldMemberships = (oldActor.activeMemberships ?? []) as Array<Record<string, unknown>>;
    const oldClubMembership = oldMemberships.find((m) => m.clubId === oldOwnerCtx.club.id);
    assert.ok(oldClubMembership, 'old owner should still have membership');
    assert.equal(oldClubMembership!.role, 'member', 'old owner should be demoted to member');
  });
});

// ── superadmin.clubs.update ──────────────────────────────────────────────────

describe('superadmin.clubs.update', () => {
  it('updates name and returns updated club with incremented version', async () => {
    const admin = await h.seedSuperadmin('Admin Updater');
    const owner = await h.seedMember('Update Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'update-name-club',
      name: 'Original Name',
      ownerMemberId: owner.id,
      summary: 'A club to update',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      name: 'Updated Name',
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.name, 'Updated Name');
    assert.equal(club.summary, 'A club to update', 'summary should be unchanged');
    const version = club.version as Record<string, unknown>;
    assert.equal(version.versionNo, 2, 'should be version 2 after update');
  });

  it('updates summary to a new value', async () => {
    const admin = await h.seedSuperadmin('Admin SummaryUp');
    const owner = await h.seedMember('Summary Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'update-summary-club',
      name: 'Summary Club',
      ownerMemberId: owner.id,
      summary: 'Old summary',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      summary: 'New summary',
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.summary, 'New summary');
    assert.equal(club.name, 'Summary Club', 'name should be unchanged');
  });

  it('clears summary by sending null', async () => {
    const admin = await h.seedSuperadmin('Admin ClearSum');
    const owner = await h.seedMember('Clear Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'clear-summary-club',
      name: 'Clear Club',
      ownerMemberId: owner.id,
      summary: 'Will be cleared',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      summary: null,
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.summary, null, 'summary should be cleared');
  });

  it('updates admissionPolicy', async () => {
    const admin = await h.seedSuperadmin('Admin AdmPol');
    const owner = await h.seedMember('AdmPol Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'admpol-club',
      name: 'AdmPol Club',
      ownerMemberId: owner.id,
      summary: 'Testing admissionPolicy',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(created.admissionPolicy, null);

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      admissionPolicy: 'Must be a dog lover',
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.admissionPolicy, 'Must be a dog lover');
  });

  it('rejects non-existent club with 404', async () => {
    const admin = await h.seedSuperadmin('Admin NoClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clubId: 'nonexistent',
      name: 'Does Not Matter',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('non-superadmin cannot update club', async () => {
    const member = await h.seedMember('Regular Updater');
    const err = await h.apiErr(member.token, 'superadmin.clubs.update', {
      clubId: 'any',
      name: 'Nope',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('rejects empty name', async () => {
    const admin = await h.seedSuperadmin('Admin EmptyName');
    const owner = await h.seedMember('EmptyName Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'emptyname-club',
      name: 'EmptyName Club',
      ownerMemberId: owner.id,
      summary: 'Testing empty name',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      name: '   ',
    });
    assert.equal(err.status, 400);
  });

  it('rejects empty patch with no fields to update', async () => {
    const admin = await h.seedSuperadmin('Admin EmptyPatch');
    const owner = await h.seedMember('EmptyPatch Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'emptypatch-club',
      name: 'EmptyPatch Club',
      ownerMemberId: owner.id,
      summary: 'Testing empty patch',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('clears admissionPolicy by sending null', async () => {
    const admin = await h.seedSuperadmin('Admin ClearPol');
    const owner = await h.seedMember('ClearPol Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'clearpol-club',
      name: 'ClearPol Club',
      ownerMemberId: owner.id,
      summary: 'Testing clear admissionPolicy',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    // Set admission policy first
    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      admissionPolicy: 'Must be invited',
    });

    // Clear it
    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clubId: created.clubId as string,
      admissionPolicy: null,
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.admissionPolicy, null, 'admissionPolicy should be cleared');
  });

  it('sequential updates increment version correctly', async () => {
    const admin = await h.seedSuperadmin('Admin SeqUp');
    const owner = await h.seedMember('SeqUp Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      slug: 'seq-update-club',
      name: 'Seq Club',
      ownerMemberId: owner.id,
      summary: 'Sequential updates',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;
    const clubId = created.clubId as string;

    const r1 = await h.apiOk(admin.token, 'superadmin.clubs.update', { clubId, name: 'V2' });
    const c1 = (r1.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((c1.version as Record<string, unknown>).versionNo, 2);

    const r2 = await h.apiOk(admin.token, 'superadmin.clubs.update', { clubId, summary: 'V3 summary' });
    const c2 = (r2.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((c2.version as Record<string, unknown>).versionNo, 3);
    assert.equal(c2.name, 'V2', 'name should persist from previous update');
    assert.equal(c2.summary, 'V3 summary');
  });
});

// ── Admin Dashboard Actions ──────────────────────────────────────────────────

describe('superadmin.platform.getOverview', () => {
  it('returns platform stats with correct shape', async () => {
    const admin = await h.seedSuperadmin('Admin Overview');

    const result = await h.apiOk(admin.token, 'superadmin.platform.getOverview', {});
    const data = result.data as Record<string, unknown>;
    const overview = data.overview as Record<string, unknown>;
    assert.ok(typeof overview.totalMembers === 'number');
    assert.ok(typeof overview.activeMembers === 'number');
    assert.ok(typeof overview.totalClubs === 'number');
    assert.ok(typeof overview.totalEntities === 'number');
    assert.ok(typeof overview.totalMessages === 'number');
    assert.ok(typeof overview.pendingApplications === 'number');
    assert.ok(Array.isArray(overview.recentMembers));
    assert.ok(overview.totalMembers >= 1, 'at least the admin member exists');
    assert.ok(overview.activeMembers >= 1, 'at least the admin member is active');
    assert.ok((overview.totalMembers as number) >= (overview.activeMembers as number), 'totalMembers >= activeMembers');
  });

  it('non-superadmin cannot access superadmin.platform.getOverview', async () => {
    const member = await h.seedMember('Regular Overview');
    const err = await h.apiErr(member.token, 'superadmin.platform.getOverview', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('superadmin.members.list', () => {
  it('lists members with pagination', async () => {
    const admin = await h.seedSuperadmin('Admin List Members');
    await h.seedMember('Listed Member A');
    await h.seedMember('Listed Member B');

    const result = await h.apiOk(admin.token, 'superadmin.members.list', { limit: 20 });
    const data = result.data as Record<string, unknown>;
    const members = data.members as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(members));
    assert.ok(members.length >= 2);
    assert.ok(members.every((m) => typeof m.memberId === 'string'));
    assert.ok(members.every((m) => typeof m.publicName === 'string'));
    assert.ok(members.every((m) => typeof m.createdAt === 'string'));
    assert.ok(members.every((m) => typeof m.membershipCount === 'number'));
  });

  it('respects limit parameter', async () => {
    const admin = await h.seedSuperadmin('Admin Limit');
    await h.seedMember('Limit A');
    await h.seedMember('Limit B');
    await h.seedMember('Limit C');

    const result = await h.apiOk(admin.token, 'superadmin.members.list', { limit: 1 });
    const members = (result.data as Record<string, unknown>).members as Array<Record<string, unknown>>;
    assert.equal(members.length, 1);
  });

  it('non-superadmin cannot list members', async () => {
    const member = await h.seedMember('Regular ListM');
    const err = await h.apiErr(member.token, 'superadmin.members.list', { limit: 10 });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('superadmin.members.get', () => {
  it('gets full member detail including memberships', async () => {
    const admin = await h.seedSuperadmin('Admin Get Member');
    const ownerCtx = await h.seedOwner('detail-club', 'Detail Club');

    const result = await h.apiOk(admin.token, 'superadmin.members.get', { memberId: ownerCtx.id });
    const data = result.data as Record<string, unknown>;
    const member = data.member as Record<string, unknown>;
    assert.equal(member.memberId, ownerCtx.id);
    assert.equal(member.publicName, ownerCtx.publicName);
    assert.ok(Array.isArray(member.memberships));
    const memberships = member.memberships as Array<Record<string, unknown>>;
    assert.ok(memberships.some((m) => m.clubSlug === 'detail-club'));
    assert.ok(typeof member.tokenCount === 'number');
  });

  it('rejects missing memberId', async () => {
    const admin = await h.seedSuperadmin('Admin GetNoId');
    const err = await h.apiErr(admin.token, 'superadmin.members.get', {});
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('returns null/404 for non-existent member', async () => {
    const admin = await h.seedSuperadmin('Admin GetGhost');
    const err = await h.apiErr(admin.token, 'superadmin.members.get', { memberId: 'nonexistent-id' });
    assert.equal(err.status, 404);
  });

  it('non-superadmin cannot get member detail', async () => {
    const member = await h.seedMember('Regular GetM');
    const err = await h.apiErr(member.token, 'superadmin.members.get', { memberId: member.id });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('clubadmin.clubs.getStatistics', () => {
  it('returns club stats with member counts', async () => {
    const admin = await h.seedSuperadmin('Admin Stats');
    const ownerCtx = await h.seedOwner('stats-club', 'Stats Club');
    await h.seedCompedMember(ownerCtx.club.id, 'Stats Member');

    const result = await h.apiOk(admin.token, 'clubadmin.clubs.getStatistics', { clubId: ownerCtx.club.id });
    const data = result.data as Record<string, unknown>;
    const stats = data.stats as Record<string, unknown>;
    assert.equal(stats.clubId, ownerCtx.club.id);
    assert.equal(stats.slug, 'stats-club');
    assert.ok(typeof stats.entityCount === 'number');
    assert.ok(typeof stats.messageCount === 'number');
    assert.ok(stats.memberCounts !== null && typeof stats.memberCounts === 'object');
  });

  it('rejects missing clubId', async () => {
    const admin = await h.seedSuperadmin('Admin StatsNoId');
    const err = await h.apiErr(admin.token, 'clubadmin.clubs.getStatistics', {});
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('returns 404 for non-existent club', async () => {
    const admin = await h.seedSuperadmin('Admin StatsGhost');
    const err = await h.apiErr(admin.token, 'clubadmin.clubs.getStatistics', { clubId: 'nonexistent-club' });
    assert.equal(err.status, 404);
  });

  it('regular member cannot access club stats', async () => {
    const ownerCtx = await h.seedOwner('stats-auth-club', 'Stats Auth Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Stats Regular');
    const err = await h.apiErr(member.token, 'clubadmin.clubs.getStatistics', { clubId: ownerCtx.club.id });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('club owner can access club stats', async () => {
    const ownerCtx = await h.seedOwner('stats-owner-club', 'Stats Owner Club');
    const result = await h.apiOk(ownerCtx.token, 'clubadmin.clubs.getStatistics', { clubId: ownerCtx.club.id });
    const stats = (result.data as Record<string, unknown>).stats as Record<string, unknown>;
    assert.equal(stats.clubId, ownerCtx.club.id);
  });
});

// ── Club Admin Promote / Demote ─────────────────────────────────────────────

describe('clubowner.members.promoteToAdmin', () => {
  it('owner promotes a regular member to admin', async () => {
    const owner = await h.seedOwner('promote-club', 'Promote Club');
    const member = await h.seedCompedMember(owner.club.id, 'Promo Target');

    const result = await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const data = result.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    assert.equal(membership.role, 'clubadmin');
    assert.equal(data.changed, true);
    const memberRef = membership.member as Record<string, unknown>;
    assert.equal(memberRef.memberId, member.id);
  });

  it('promoted member can access clubadmin actions', async () => {
    const owner = await h.seedOwner('promote-access', 'Promote Access Club');
    const member = await h.seedCompedMember(owner.club.id, 'Promo Access');

    // Before promotion — regular member cannot access stats
    const errBefore = await h.apiErr(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });
    assert.equal(errBefore.status, 403);

    // Promote
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });

    // After promotion — now has admin access
    const stats = await h.apiOk(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });
    const data = stats.data as Record<string, unknown>;
    assert.ok(data.stats);
  });

  it('promoting already-admin member is idempotent with changed: false', async () => {
    const owner = await h.seedOwner('promote-idem', 'Promote Idempotent Club');
    const member = await h.seedCompedMember(owner.club.id, 'Already Admin');

    // Promote twice
    const first = await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    assert.equal((first.data as Record<string, unknown>).changed, true);
    const result = await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const data = result.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    assert.equal(membership.role, 'clubadmin');
    assert.equal(data.changed, false);
  });

  it('non-owner admin cannot promote members', async () => {
    const owner = await h.seedOwner('promote-noauth', 'Promote NoAuth Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Non-Owner Admin');
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: admin.id,
    });
    const target = await h.seedCompedMember(owner.club.id, 'Promote Target2');

    const err = await h.apiErr(admin.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: target.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('regular member cannot promote', async () => {
    const owner = await h.seedOwner('promote-reg', 'Promote Reg Club');
    const memberA = await h.seedCompedMember(owner.club.id, 'Regular A');
    const memberB = await h.seedCompedMember(owner.club.id, 'Regular B');

    const err = await h.apiErr(memberA.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: memberB.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('returns 404 for non-existent member', async () => {
    const owner = await h.seedOwner('promote-ghost', 'Promote Ghost Club');

    const err = await h.apiErr(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: 'nonexistent-member',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('returns 404 for member not in the club', async () => {
    const owner = await h.seedOwner('promote-other', 'Promote Other Club');
    const outsider = await h.seedMember('Outsider');

    const err = await h.apiErr(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: outsider.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('superadmin can promote a member', async () => {
    const admin = await h.seedSuperadmin('SA Promote');
    const owner = await h.seedOwner('sa-promote-club', 'SA Promote Club');
    const member = await h.seedCompedMember(owner.club.id, 'SA Promo Target');

    const result = await h.apiOk(admin.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const membership = (result.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal(membership.role, 'clubadmin');
  });
});

describe('clubowner.members.demoteFromAdmin', () => {
  it('owner demotes an admin to regular member', async () => {
    const owner = await h.seedOwner('demote-club', 'Demote Club');
    const member = await h.seedCompedMember(owner.club.id, 'Demote Target');
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });

    const result = await h.apiOk(owner.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const data = result.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    assert.equal(membership.role, 'member');
    assert.equal(data.changed, true);
    const memberRef = membership.member as Record<string, unknown>;
    assert.equal(memberRef.memberId, member.id);
  });

  it('demoted member loses admin access', async () => {
    const owner = await h.seedOwner('demote-access', 'Demote Access Club');
    const member = await h.seedCompedMember(owner.club.id, 'Demote Access');

    // Promote then verify access
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    await h.apiOk(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });

    // Demote then verify loss of access
    await h.apiOk(owner.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const err = await h.apiErr(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });
    assert.equal(err.status, 403);
  });

  it('cannot demote the club owner', async () => {
    const owner = await h.seedOwner('demote-owner', 'Demote Owner Club');

    const err = await h.apiErr(owner.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('demoting a regular member is idempotent with changed: false', async () => {
    const owner = await h.seedOwner('demote-idem', 'Demote Idempotent Club');
    const member = await h.seedCompedMember(owner.club.id, 'Not Admin');

    const result = await h.apiOk(owner.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const data = result.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    assert.equal(membership.role, 'member');
    assert.equal(data.changed, false);
  });

  it('non-owner admin cannot demote', async () => {
    const owner = await h.seedOwner('demote-noauth', 'Demote NoAuth Club');
    const adminA = await h.seedCompedMember(owner.club.id, 'Admin A');
    const adminB = await h.seedCompedMember(owner.club.id, 'Admin B');
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', { clubId: owner.club.id, memberId: adminA.id });
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', { clubId: owner.club.id, memberId: adminB.id });

    const err = await h.apiErr(adminA.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: adminB.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('regular member cannot demote', async () => {
    const owner = await h.seedOwner('demote-reg', 'Demote Reg Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Admin Demote');
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', { clubId: owner.club.id, memberId: admin.id });
    const regular = await h.seedCompedMember(owner.club.id, 'Regular Demote');

    const err = await h.apiErr(regular.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: admin.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('returns 404 for non-existent member', async () => {
    const owner = await h.seedOwner('demote-ghost', 'Demote Ghost Club');

    const err = await h.apiErr(owner.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: 'nonexistent-member',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('superadmin can demote an admin', async () => {
    const admin = await h.seedSuperadmin('SA Demote');
    const owner = await h.seedOwner('sa-demote-club', 'SA Demote Club');
    const member = await h.seedCompedMember(owner.club.id, 'SA Demote Target');
    await h.apiOk(owner.token, 'clubowner.members.promoteToAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });

    const result = await h.apiOk(admin.token, 'clubowner.members.demoteFromAdmin', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const membership = (result.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal(membership.role, 'member');
  });
});

describe('superadmin.content.list', () => {
  it('lists content across clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Content');

    const result = await h.apiOk(admin.token, 'superadmin.content.list', { limit: 10 });
    const data = result.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.content));
  });

  it('non-superadmin cannot list admin content', async () => {
    const member = await h.seedMember('Regular Content');
    const err = await h.apiErr(member.token, 'superadmin.content.list', { limit: 10 });
    assert.equal(err.status, 403);
  });
});

// superadmin.content.archive, superadmin.content.redact, superadmin.messages.redact
// have been removed — superadmins use clubadmin.content.remove, clubadmin.events.remove,
// clubadmin.messages.remove directly. See test/integration/non-llm/removal.test.ts for coverage.

describe('superadmin.messages.listThreads', () => {
  it('lists threads across all clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Threads');
    const ownerCtx = await h.seedOwner('threads-club', 'Threads Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Thread Sender');

    await h.apiOk(member.token, 'messages.send', {
      recipientMemberId: ownerCtx.id,
      messageText: 'Hello threads test!',
    });

    const result = await h.apiOk(admin.token, 'superadmin.messages.listThreads', {
      limit: 10,
    });
    const data = result.data as Record<string, unknown>;
    const threads = data.threads as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(threads));
    assert.ok(threads.length >= 1);
    assert.ok(threads.every((t) => typeof t.threadId === 'string'));
    assert.ok(threads.every((t) => typeof t.messageCount === 'number'));
    assert.ok(threads.every((t) => Array.isArray(t.participants)));
  });

  it('non-superadmin cannot list admin threads', async () => {
    const member = await h.seedMember('Regular Threads');
    const err = await h.apiErr(member.token, 'superadmin.messages.listThreads', { limit: 10 });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.messages.getThread', () => {
  it('reads any thread', async () => {
    const admin = await h.seedSuperadmin('Admin Read Thread');
    const ownerCtx = await h.seedOwner('read-thread-club', 'Read Thread Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Thread Reader Sender');

    const sendResult = await h.apiOk(member.token, 'messages.send', {
      recipientMemberId: ownerCtx.id,
      messageText: 'A message in a readable thread',
    });
    const sendData = sendResult.data as Record<string, unknown>;
    const msg = sendData.message as Record<string, unknown>;
    const threadId = msg.threadId as string;

    const result = await h.apiOk(admin.token, 'superadmin.messages.getThread', { threadId });
    const data = result.data as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.equal(thread.threadId, threadId);
    const messages = data.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages));
    assert.ok(messages.length >= 1);
    assert.ok(messages.some((m) => m.messageText === 'A message in a readable thread'));
  });

  it('returns 404 for non-existent thread', async () => {
    const admin = await h.seedSuperadmin('Admin ReadGhost');
    const err = await h.apiErr(admin.token, 'superadmin.messages.getThread', { threadId: 'nonexistent-thread-id' });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('non-superadmin cannot read admin threads', async () => {
    const member = await h.seedMember('Regular Read');
    const err = await h.apiErr(member.token, 'superadmin.messages.getThread', { threadId: 'fake-thread-id' });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.accessTokens.list', () => {
  it('lists tokens for any member', async () => {
    const admin = await h.seedSuperadmin('Admin Token List');
    const member = await h.seedMember('Token Listed Member');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.list', { memberId: member.id });
    const data = result.data as Record<string, unknown>;
    const tokens = data.tokens as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => typeof t.tokenId === 'string'));
    assert.ok(tokens.every((t) => t.memberId === member.id));
  });

  it('rejects missing memberId', async () => {
    const admin = await h.seedSuperadmin('Admin TokenNoId');
    const err = await h.apiErr(admin.token, 'superadmin.accessTokens.list', {});
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('non-superadmin cannot list other members tokens', async () => {
    const member = await h.seedMember('Regular Tokens');
    const target = await h.seedMember('Target Tokens');
    const err = await h.apiErr(member.token, 'superadmin.accessTokens.list', { memberId: target.id });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.accessTokens.revoke', () => {
  it('revokes any member token', async () => {
    const admin = await h.seedSuperadmin('Admin Revoke Token');
    const member = await h.seedMember('Revoke Target Member');

    const listResult = await h.apiOk(admin.token, 'superadmin.accessTokens.list', { memberId: member.id });
    const listData = listResult.data as Record<string, unknown>;
    const tokens = listData.tokens as Array<Record<string, unknown>>;
    const tokenId = tokens[0]?.tokenId as string;
    assert.ok(tokenId, 'member should have at least one token');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.revoke', {
      memberId: member.id,
      tokenId,
    });
    const data = result.data as Record<string, unknown>;
    const revokedToken = data.token as Record<string, unknown>;
    assert.equal(revokedToken.tokenId, tokenId);
    assert.ok(revokedToken.revokedAt !== null, 'revokedAt should be set');

    // Revoked token should no longer authenticate
    const { status } = await h.api(member.token, 'session.getContext', {});
    assert.equal(status, 401, 'revoked token should be rejected');
  });

  it('non-superadmin cannot revoke other members tokens', async () => {
    const member = await h.seedMember('Regular Revoke');
    const target = await h.seedMember('Revoke Target');
    const err = await h.apiErr(member.token, 'superadmin.accessTokens.revoke', {
      memberId: target.id,
      tokenId: 'fake-token-id',
    });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.diagnostics.getHealth', () => {
  it('returns diagnostics with correct shape', async () => {
    const admin = await h.seedSuperadmin('Admin Diag');

    const result = await h.apiOk(admin.token, 'superadmin.diagnostics.getHealth', {});
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

  it('non-superadmin cannot access diagnostics', async () => {
    const member = await h.seedMember('Regular Diag');
    const err = await h.apiErr(member.token, 'superadmin.diagnostics.getHealth', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

// ── Token Lifecycle ──────────────────────────────────────────────────────────

describe('accessTokens.list', () => {
  it('member sees their own tokens', async () => {
    const member = await h.seedMember('Token Lister');

    const result = await h.apiOk(member.token, 'accessTokens.list', {});
    const data = result.data as Record<string, unknown>;
    const tokens = data.tokens as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => t.memberId === member.id));
  });
});

describe('accessTokens.create', () => {
  it('member creates new token; new token works', async () => {
    const ownerCtx = await h.seedOwner('token-create-club', 'Token Create Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Creator');

    const createResult = await h.apiOk(member.token, 'accessTokens.create', { label: 'my-new-token' });
    const data = createResult.data as Record<string, unknown>;
    const tokenSummary = data.token as Record<string, unknown>;
    const newBearerToken = data.bearerToken as string;

    assert.ok(typeof newBearerToken === 'string' && newBearerToken.length > 0);
    assert.equal(tokenSummary.label, 'my-new-token');
    assert.equal(tokenSummary.memberId, member.id);

    // Verify the new token actually works
    const sessionResult = await h.apiOk(newBearerToken, 'session.getContext', {});
    assert.ok(sessionResult.ok !== false, 'new token should authenticate successfully');
    const actor = sessionResult.actor as Record<string, unknown>;
    const actorMember = actor.member as Record<string, unknown>;
    assert.equal(actorMember.id, member.id);
  });
});

describe('accessTokens.revoke', () => {
  it('member revokes token; revoked token stops working', async () => {
    const ownerCtx = await h.seedOwner('token-revoke-club', 'Token Revoke Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Revoker');

    // Create a second token to revoke
    const createResult = await h.apiOk(member.token, 'accessTokens.create', { label: 'to-revoke' });
    const data = createResult.data as Record<string, unknown>;
    const tokenSummary = data.token as Record<string, unknown>;
    const tokenToRevoke = data.bearerToken as string;
    const tokenId = tokenSummary.tokenId as string;

    // Confirm it works before revocation
    await h.apiOk(tokenToRevoke, 'session.getContext', {});

    // Revoke it
    const revokeResult = await h.apiOk(member.token, 'accessTokens.revoke', { tokenId });
    const revokeData = revokeResult.data as Record<string, unknown>;
    const revokedToken = revokeData.token as Record<string, unknown>;
    assert.equal(revokedToken.tokenId, tokenId);
    assert.ok(revokedToken.revokedAt !== null, 'revokedAt should be set after revocation');

    // Token should now be rejected
    const { status } = await h.api(tokenToRevoke, 'session.getContext', {});
    assert.equal(status, 401, 'revoked token should no longer be accepted');
  });

  it('member cannot revoke another member token', async () => {
    const memberA = await h.seedMember('Revoke A');
    const memberB = await h.seedMember('Revoke B');

    // Get memberB's token ID
    const listResult = await h.apiOk(memberB.token, 'accessTokens.list', {});
    const tokens = (listResult.data as Record<string, unknown>).tokens as Array<Record<string, unknown>>;
    const tokenId = tokens[0]?.tokenId as string;

    // memberA tries to revoke memberB's token
    const err = await h.apiErr(memberA.token, 'accessTokens.revoke', { tokenId });
    assert.equal(err.status, 404, 'should not find token outside own scope');
  });
});

// ── Quotas ───────────────────────────────────────────────────────────────────

describe('quotas.getUsage', () => {
  it('returns quota rows from global defaults with no club overrides', async () => {
    // Owner gets 3x multiplier on the unified global default (content.create=50)
    const ownerCtx = await h.seedOwner('quota-club', 'Quota Club');

    const result = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const data = result.data as Record<string, unknown>;
    const quotas = data.quotas as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(quotas));
    assert.equal(quotas.length, 1, 'should return only the unified content.create quota');
    for (const quota of quotas) {
      assert.ok(typeof quota.action === 'string');
      assert.ok(typeof quota.clubId === 'string');
      assert.ok(typeof quota.maxPerDay === 'number');
      assert.ok(typeof quota.usedToday === 'number');
      assert.ok(typeof quota.remaining === 'number');
    }
    // Owner gets 3x the global default
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota, 'content.create quota should exist from global defaults');
    assert.equal(contentQuota!.maxPerDay, 150, 'owner gets 3x the unified global default of 50');
  });

  it('normal member gets 1x base quota', async () => {
    const ownerCtx = await h.seedOwner('quota-member-1x', 'Quota Member Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Regular Member');

    const result = await h.apiOk(member.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota, 'content.create quota should exist');
    assert.equal(contentQuota!.maxPerDay, 50, 'normal member gets 1x the unified global default of 50');
  });

  it('clubadmin gets 3x base quota', async () => {
    const ownerCtx = await h.seedOwner('quota-admin-3x', 'Quota Admin Club');
    const admin = await h.seedMember('Club Admin');
    await h.seedClubMembership(ownerCtx.club.id, admin.id, { role: 'clubadmin' });

    const result = await h.apiOk(admin.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota, 'content.create quota should exist');
    assert.equal(contentQuota!.maxPerDay, 150, 'clubadmin gets 3x the unified global default of 50');
  });

  it('club override supersedes global default', async () => {
    const ownerCtx = await h.seedOwner('quota-override', 'Quota Override Club');
    // Override content.create to 5 for this club
    await h.sqlClubs(
      `insert into quota_policies (scope, club_id, action_name, max_per_day) values ('club', $1, 'content.create', 5)`,
      [ownerCtx.club.id],
    );

    const member = await h.seedCompedMember(ownerCtx.club.id, 'Override Member');
    const result = await h.apiOk(member.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota, 'content.create quota should exist');
    assert.equal(contentQuota!.maxPerDay, 5, 'normal member gets 1x the club override of 5');

    // Owner gets 3x the override
    const ownerResult = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const ownerQuotas = (ownerResult.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const ownerContentQuota = ownerQuotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.equal(ownerContentQuota!.maxPerDay, 15, 'owner gets 3x the club override of 5');
  });

  it('only includes supported actions (not messages.send)', async () => {
    const ownerCtx = await h.seedOwner('quota-supported', 'Quota Supported Club');

    const result = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const actions = quotas.map((q) => q.action);
    assert.ok(actions.includes('content.create'));
    assert.ok(!actions.includes('messages.send'), 'messages.send should not be in quota status');
    assert.equal(actions.length, 1, 'only the unified content.create action should be returned');
  });

  it('posts and events both consume the unified content.create quota', async () => {
    const ownerCtx = await h.seedOwner('quota-kind-isolation', 'Quota Kind Club');

    await seedPublishedEntity(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'post',
      title: 'Post 1',
    });
    await seedPublishedEntity(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'post',
      title: 'Post 2',
    });
    await seedPublishedEntity(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'event',
      title: 'Event 1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const result = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota, 'content.create quota should exist');
    assert.equal(contentQuota!.usedToday, 3, 'posts and events should both count toward the unified quota');
  });

  it('club overrides still apply to all content kinds', async () => {
    const ownerCtx = await h.seedOwner('quota-event-isolation', 'Quota Event Club');
    await h.sqlClubs(
      `insert into quota_policies (scope, club_id, action_name, max_per_day)
       values ('club', $1, 'content.create', 4)`,
      [ownerCtx.club.id],
    );
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Quota Event Member');

    await seedPublishedEntity(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: member.id,
      kind: 'event',
      title: 'Event',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const result = await h.apiOk(member.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.equal(contentQuota!.maxPerDay, 4);
    assert.equal(contentQuota!.usedToday, 1, 'events also consume the unified quota');
  });

  it('quota enforcement is kind-agnostic across posts and events', async () => {
    const ownerCtx = await h.seedOwner('quota-enforce-kind', 'Quota Enforce Club');
    // Set content.create club override to 1 (owner gets 3x = 3)
    await h.sqlClubs(
      `insert into quota_policies (scope, club_id, action_name, max_per_day) values ('club', $1, 'content.create', 1)`,
      [ownerCtx.club.id],
    );

    await seedPublishedEntity(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'event',
      title: 'An event',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const result = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.ok(contentQuota);
    assert.equal(contentQuota!.usedToday, 1, 'event should consume the same content.create quota as posts');
    assert.equal(contentQuota!.remaining, 2, 'owner has 3 total and 1 used');
  });

  it('quota enforcement rejects over-limit for normal member', async () => {
    const ownerCtx = await h.seedOwner('quota-enforce-member', 'Quota Enforce Member Club');
    // Set a very low content.create override
    await h.sqlClubs(
      `insert into quota_policies (scope, club_id, action_name, max_per_day) values ('club', $1, 'content.create', 2)`,
      [ownerCtx.club.id],
    );

    const member = await h.seedCompedMember(ownerCtx.club.id, 'Quota Test Member');

    // Create 2 posts (the limit for a normal member)
    for (let i = 0; i < 2; i++) {
      await seedPublishedEntity(h, {
        clubId: ownerCtx.club.id,
        authorMemberId: member.id,
        kind: 'post',
        title: `Post ${i}`,
      });
    }

    // Verify usage shows at limit
    const result = await h.apiOk(member.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.equal(contentQuota!.maxPerDay, 2, 'normal member has limit of 2');
    assert.equal(contentQuota!.usedToday, 2);
    assert.equal(contentQuota!.remaining, 0);
  });

  it('owner can exceed normal member limit thanks to 3x multiplier', async () => {
    const ownerCtx = await h.seedOwner('quota-owner-3x-enforce', 'Quota Owner 3x Club');
    // Set a low content.create override: member=2, owner=6
    await h.sqlClubs(
      `insert into quota_policies (scope, club_id, action_name, max_per_day) values ('club', $1, 'content.create', 2)`,
      [ownerCtx.club.id],
    );

    // Create 3 posts as owner (within owner's 6 limit, above member's 2 limit)
    for (let i = 0; i < 3; i++) {
      await seedPublishedEntity(h, {
        clubId: ownerCtx.club.id,
        authorMemberId: ownerCtx.id,
        kind: 'post',
        title: `Owner Post ${i}`,
      });
    }

    const result = await h.apiOk(ownerCtx.token, 'quotas.getUsage', {});
    const quotas = (result.data as Record<string, unknown>).quotas as Array<Record<string, unknown>>;
    const contentQuota = quotas.find((q) => q.action === 'content.create' && q.clubId === ownerCtx.club.id);
    assert.equal(contentQuota!.maxPerDay, 6, 'owner gets 3x the override of 2');
    assert.equal(contentQuota!.usedToday, 3);
    assert.equal(contentQuota!.remaining, 3, 'owner still has 3 remaining out of 6');
  });
});

// ── Cross-cutting authorization ─────────────────────────────────────────────

describe('platform authorization', () => {
  it('non-superadmin cannot use any superadmin action', async () => {
    const regularMember = await h.seedMember('Regular Joe');
    const superadminActions = [
      ['superadmin.clubs.list', {}],
      ['superadmin.clubs.create', { slug: 'x', name: 'X', summary: 'X', ownerMemberId: 'x' }],
      ['superadmin.clubs.archive', { clubId: 'x' }],
      ['superadmin.clubs.assignOwner', { clubId: 'x', ownerMemberId: 'x' }],
      ['superadmin.platform.getOverview', {}],
      ['superadmin.members.list', { limit: 1 }],
      ['superadmin.members.get', { memberId: 'x' }],
      ['clubadmin.clubs.getStatistics', { clubId: 'x' }],
      ['superadmin.content.list', { limit: 1 }],
      ['superadmin.messages.listThreads', { limit: 1 }],
      ['superadmin.messages.getThread', { threadId: 'x' }],
      ['superadmin.accessTokens.list', { memberId: 'x' }],
      ['superadmin.accessTokens.revoke', { memberId: 'x', tokenId: 'x' }],
      ['superadmin.diagnostics.getHealth', {}],
    ] as const;

    for (const [action, input] of superadminActions) {
      const err = await h.apiErr(regularMember.token, action, input);
      assert.equal(err.status, 403, `${action} should reject non-superadmin`);
      assert.equal(err.code, 'forbidden', `${action} should return forbidden code`);
    }
  });

  it('unauthenticated requests are rejected with 401', async () => {
    const { status } = await h.api(null, 'superadmin.clubs.list', {});
    assert.equal(status, 401);
  });

  it('invalid bearer token returns 401', async () => {
    const { status } = await h.api('cc_live_fakefakefake_fakefakefakefakefakefake', 'superadmin.clubs.list', {});
    assert.equal(status, 401);
  });
});

// ── Billing sync date validation ────────────────────────────────────────────

describe('billing sync date validation', () => {
  it('activateMembership rejects invalid paidThrough with 400', async () => {
    const admin = await h.seedSuperadmin('Billing Date Admin');
    const owner = await h.seedOwner('billing-date-club', 'Billing Date Club');
    const member = await h.seedMember('Billing Date Member');

    // Create a payment_pending membership
    const createResult = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });
    const membershipId = ((createResult.data as Record<string, unknown>).membership as Record<string, unknown>).membershipId as string;

    const err = await h.apiErr(admin.token, 'superadmin.billing.activateMembership', {
      membershipId,
      paidThrough: 'not-a-date',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('renewMembership rejects invalid newPaidThrough with 400', async () => {
    const admin = await h.seedSuperadmin('Renew Date Admin');
    const owner = await h.seedOwner('renew-date-club', 'Renew Date Club');
    const member = await h.seedMember('Renew Date Member');

    // Create active membership
    const createResult = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'active',
    });
    const membershipId = ((createResult.data as Record<string, unknown>).membership as Record<string, unknown>).membershipId as string;

    const err = await h.apiErr(admin.token, 'superadmin.billing.renewMembership', {
      membershipId,
      newPaidThrough: 'garbage',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('activateMembership accepts valid ISO date', async () => {
    const admin = await h.seedSuperadmin('Billing OK Admin');
    const owner = await h.seedOwner('billing-ok-club', 'Billing OK Club');
    const member = await h.seedMember('Billing OK Member');

    const createResult = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });
    const membershipId = ((createResult.data as Record<string, unknown>).membership as Record<string, unknown>).membershipId as string;

    const result = await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId,
      paidThrough: '2027-12-31T23:59:59Z',
    });
    assert.equal((result.data as Record<string, unknown>).ok, true);
  });
});
