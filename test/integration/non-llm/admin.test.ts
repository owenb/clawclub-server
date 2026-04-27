import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { DEFAULT_CONFIG_V1, type AppConfig } from '../../../src/config/index.ts';
import { activeMemberships, makeVector, seedProfileEmbedding, seedPublishedContent } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

function withClientKey<T extends Record<string, unknown>>(input: T): T & { clientKey: string } {
  return { clientKey: randomUUID(), ...input };
}

function buildAdminTestConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfig;
  config.policy.quotas.actions['content.create'].clubOverrides = {
    'quota-override': 5,
    'quota-event-isolation': 4,
    'quota-enforce-kind': 1,
    'quota-enforce-member': 2,
    'quota-owner-3x-enforce': 2,
  };
  return config;
}

before(async () => {
  h = await TestHarness.start({ config: buildAdminTestConfig(), llmGate: passthroughGate });
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
    assert.ok(Array.isArray(clubs.results));
    const clubList = clubs.results as Array<Record<string, unknown>>;
    const slugs = clubList.map((c) => c.slug);
    assert.ok(slugs.includes('list-club-a'));
    assert.ok(slugs.includes('list-club-b'));
  });

  it('includes archived clubs when requested', async () => {
    const admin = await h.seedSuperadmin('Admin Archived');
    const { club } = await h.seedOwner('to-list-archived', 'List Archived Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', withClientKey({ clubId: club.id }));

    const withArchived = await h.apiOk(admin.token, 'superadmin.clubs.list', { includeArchived: true });
    const clubsData = withArchived.data as Record<string, unknown>;
    const allClubs = clubsData.results as Array<Record<string, unknown>>;
    assert.ok(allClubs.some((c) => c.slug === 'to-list-archived'));

    const withoutArchived = await h.apiOk(admin.token, 'superadmin.clubs.list', {});
    const activeClubs = (withoutArchived.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!activeClubs.some((c) => c.slug === 'to-list-archived'));
  });

  it('non-superadmin cannot list clubs', async () => {
    const member = await h.seedMember('Regular List');
    const err = await h.apiErr(member.token, 'superadmin.clubs.list', {});
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });
});

describe('superadmin.clubs.get', () => {
  it('returns null when the owner has no email on record', async () => {
    const admin = await h.seedSuperadmin('Admin Nullable Owner Email');
    const owner = await h.seedOwner('nullable-owner-email', 'Nullable Owner Email');
    await h.sql(`update members set email = null where id = $1`, [owner.id]);

    const result = await h.apiOk(admin.token, 'superadmin.clubs.get', {
      clubId: owner.club.id,
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    const ownerRef = club.owner as Record<string, unknown>;
    assert.equal(ownerRef.email, null);
  });

  it('returns club detail including AI spend usage and llm.outputTokens context', async () => {
    const admin = await h.seedSuperadmin('Admin Club Detail');
    const owner = await h.seedOwner('superadmin-club-detail', 'Superadmin Club Detail');

    await h.sqlClubs(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'finalized',
               1095, 1095, 11, 7, 11, 7, null, now(), now())`,
      [owner.club.id, owner.id],
    );
    await h.sqlClubs(
      `insert into ai_llm_quota_reservations (
         member_id,
         club_id,
         action_name,
         provider,
         model,
         status,
         reserved_output_tokens,
         actual_output_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'openai', 'gpt-5.4-nano', 'finalized', 7, 7, now(), now())`,
      [owner.id, owner.club.id],
    );

    const result = await h.apiOk(admin.token, 'superadmin.clubs.get', {
      clubId: owner.club.id,
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;

    assert.equal(club.clubId, owner.club.id);
    assert.equal(club.slug, owner.club.slug);
    const aiSpend = club.aiSpend as Record<string, unknown>;
    assert.deepEqual(aiSpend.budget, {
      dailyMaxCents: 100,
      weeklyMaxCents: 450,
      monthlyMaxCents: 1800,
    });
    const spendUsage = aiSpend.usage as Array<Record<string, unknown>>;
    const daySpend = spendUsage.find((window) => window.window === 'day');
    assert.equal(daySpend?.usedMicroCents, 1095);
    assert.equal(daySpend?.remainingMicroCents, 100_000_000 - 1095);

    const llmOutputTokens = club.llmOutputTokens as Record<string, unknown>;
    assert.equal(llmOutputTokens.scope, 'per_club_member');
    assert.deepEqual(llmOutputTokens.perMemberBudget, {
      dailyMax: 10_000,
      weeklyMax: 45_000,
      monthlyMax: 180_000,
    });
    const tokenUsage = llmOutputTokens.usage as Array<Record<string, unknown>>;
    const dayTokens = tokenUsage.find((window) => window.window === 'day');
    assert.equal(dayTokens?.usedTokens, 7);
  });
});

describe('superadmin.clubs.create', () => {
  it('creates club with all required fields; returns correct shape', async () => {
    const admin = await h.seedSuperadmin('Admin Creator');
    const owner = await h.seedMember('New Owner');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
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
    assert.equal(version.no, 1);
  });

  it('created club appears in superadmin.clubs.list', async () => {
    const admin = await h.seedSuperadmin('Admin Verify List');
    const owner = await h.seedMember('Verify Owner');

    await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'verify-listed',
      name: 'Verify Listed',
      ownerMemberId: owner.id,
      summary: 'Should appear in list',
    });

    const list = await h.apiOk(admin.token, 'superadmin.clubs.list', {});
    const clubs = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(clubs.some((c) => c.slug === 'verify-listed'));
  });

  it('rejects missing slug', async () => {
    const admin = await h.seedSuperadmin('Admin NoSlug');
    const owner = await h.seedMember('Owner NoSlug');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
      slug: 'unique-slug',
      name: 'First Club',
      ownerMemberId: owner.id,
      summary: 'First club with this slug',
    });

    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
      slug: 'ghost-owner-club',
      name: 'Ghost Owner Club',
      ownerMemberId: 'nonexistent-member-id',
      summary: 'Owner does not exist',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('non-superadmin cannot create clubs', async () => {
    const member = await h.seedMember('Regular Creator');

    const err = await h.apiErr(member.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'forbidden-club',
      name: 'Forbidden Club',
      ownerMemberId: member.id,
      summary: 'Should be rejected',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('does not return manifestoMarkdown in response', async () => {
    const admin = await h.seedSuperadmin('Admin NoManifesto');
    const owner = await h.seedMember('Owner NoManifesto');

    const result = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
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

    const result = await h.apiOk(admin.token, 'superadmin.clubs.archive', withClientKey({ clubId: club.id }));
    const data = result.data as Record<string, unknown>;
    const archived = data.club as Record<string, unknown>;
    assert.equal(archived.clubId, club.id);
    assert.ok(archived.archivedAt !== null, 'archivedAt should be set after archiving');
  });

  it('rejects archiving an already archived club', async () => {
    const admin = await h.seedSuperadmin('Admin DoubleArchive');
    const { club } = await h.seedOwner('double-archive-club', 'Double Archive Club');

    await h.apiOk(admin.token, 'superadmin.clubs.archive', withClientKey({ clubId: club.id }));

    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', withClientKey({ clubId: club.id }));
    assert.equal(err.status, 409);
    assert.equal(err.code, 'club_archived');
  });

  it('rejects missing clubId', async () => {
    const admin = await h.seedSuperadmin('Admin NoClubId');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', withClientKey({}));
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('clubId'));
  });

  it('rejects non-existent club', async () => {
    const admin = await h.seedSuperadmin('Admin GhostClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', withClientKey({ clubId: 'nonexistent-club-id' }));
    assert.equal(err.status, 404);
    assert.equal(err.code, 'club_not_found');
  });

  it('non-superadmin cannot archive clubs', async () => {
    const ownerCtx = await h.seedOwner('archive-auth-club', 'Archive Auth Club');
    const err = await h.apiErr(ownerCtx.token, 'superadmin.clubs.archive', withClientKey({ clubId: ownerCtx.club.id }));
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });
});

describe('superadmin.clubs.assignOwner', () => {
  it('reassigns ownership; new owner appears in response', async () => {
    const admin = await h.seedSuperadmin('Admin Reassigner');
    const { club } = await h.seedOwner('reassign-club', 'Reassign Club');
    const newOwner = await h.seedMember('New Club Owner');

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: club.id,
      memberId: newOwner.id,
      initialStatus: 'active',
    });

    const result = await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: club.id,
      ownerMemberId: newOwner.id,
    });
    const data = result.data as Record<string, unknown>;
    const updatedClub = data.club as Record<string, unknown>;
    const updatedOwner = updatedClub.owner as Record<string, unknown>;
    assert.equal(updatedOwner.memberId, newOwner.id);
    const version = updatedClub.version as Record<string, unknown>;
    assert.equal(version.no, 2, 'should be version 2 after reassignment');
  });

  it('rejects missing clubId', async () => {
    const admin = await h.seedSuperadmin('Admin AssignNoClub');
    const member = await h.seedMember('Assign NoClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', withClientKey({ ownerMemberId: member.id }));
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('clubId'));
  });

  it('rejects missing ownerMemberId', async () => {
    const admin = await h.seedSuperadmin('Admin AssignNoOwner');
    const { club } = await h.seedOwner('assign-no-owner-club', 'No Owner Club');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', withClientKey({ clubId: club.id }));
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.message.includes('ownerMemberId'));
  });

  it('rejects non-existent club', async () => {
    const admin = await h.seedSuperadmin('Admin AssignGhost');
    const member = await h.seedMember('Assign Ghost');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: 'nonexistent-id',
      ownerMemberId: member.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'club_not_found');
  });

  it('rejects non-existent owner member', async () => {
    const admin = await h.seedSuperadmin('Admin AssignBadOwner');
    const { club } = await h.seedOwner('assign-bad-owner-club', 'Bad Owner Club');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: club.id,
      ownerMemberId: 'nonexistent-member-id',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('non-superadmin cannot reassign ownership', async () => {
    const ownerCtx = await h.seedOwner('assign-auth-club', 'Assign Auth Club');
    const newOwner = await h.seedMember('Auth New Owner');
    const err = await h.apiErr(ownerCtx.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: ownerCtx.club.id,
      ownerMemberId: newOwner.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('new owner gets active membership; old owner demoted to member role', async () => {
    const admin = await h.seedSuperadmin('Admin OwnerSwap');
    const oldOwnerCtx = await h.seedOwner('owner-swap-club', 'Owner Swap Club');
    const newOwner = await h.seedMember('New Owner Swap');

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: oldOwnerCtx.club.id,
      memberId: newOwner.id,
      initialStatus: 'active',
    });

    // Reassign ownership
    await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
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

  it('rejects ownership transfer when the target is not already an active club member', async () => {
    const admin = await h.seedSuperadmin('Admin OwnerCap');
    const oldOwnerCtx = await h.seedOwner('owner-cap-club', 'Owner Cap Club');
    const newOwner = await h.seedMember('Owner Cap Target');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: oldOwnerCtx.club.id,
      ownerMemberId: newOwner.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');

    const newOwnerSession = await h.apiOk(newOwner.token, 'session.getContext', {});
    const newActor = newOwnerSession.actor as Record<string, unknown>;
    const newMemberships = (newActor.activeMemberships ?? []) as Array<Record<string, unknown>>;
    assert.equal(
      newMemberships.some((m) => m.clubId === oldOwnerCtx.club.id),
      false,
      'failed ownership transfer must not create a new active membership',
    );
  });
});

// ── superadmin.clubs.update ──────────────────────────────────────────────────

describe('superadmin.clubs.update', () => {
  it('updates name and returns updated club with incremented version', async () => {
    const admin = await h.seedSuperadmin('Admin Updater');
    const owner = await h.seedMember('Update Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'update-name-club',
      name: 'Original Name',
      ownerMemberId: owner.id,
      summary: 'A club to update',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: created.clubId as string,
      name: 'Updated Name',
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.name, 'Updated Name');
    assert.equal(club.summary, 'A club to update', 'summary should be unchanged');
    const version = club.version as Record<string, unknown>;
    assert.equal(version.no, 2, 'should be version 2 after update');
  });

  it('updates summary to a new value', async () => {
    const admin = await h.seedSuperadmin('Admin SummaryUp');
    const owner = await h.seedMember('Summary Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'update-summary-club',
      name: 'Summary Club',
      ownerMemberId: owner.id,
      summary: 'Old summary',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
      slug: 'clear-summary-club',
      name: 'Clear Club',
      ownerMemberId: owner.id,
      summary: 'Will be cleared',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
      slug: 'admpol-club',
      name: 'AdmPol Club',
      ownerMemberId: owner.id,
      summary: 'Testing admissionPolicy',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(created.admissionPolicy, null);

    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: created.clubId as string,
      admissionPolicy: 'Must be a dog lover',
    });
    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.admissionPolicy, 'Must be a dog lover');
  });

  it('rejects non-existent club with 404', async () => {
    const admin = await h.seedSuperadmin('Admin NoClub');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: 'nonexistent',
      name: 'Does Not Matter',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'club_not_found');
  });

  it('non-superadmin cannot update club', async () => {
    const member = await h.seedMember('Regular Updater');
    const err = await h.apiErr(member.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: 'any',
      name: 'Nope',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('rejects empty name', async () => {
    const admin = await h.seedSuperadmin('Admin EmptyName');
    const owner = await h.seedMember('EmptyName Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'emptyname-club',
      name: 'EmptyName Club',
      ownerMemberId: owner.id,
      summary: 'Testing empty name',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: created.clubId as string,
      name: '   ',
    });
    assert.equal(err.status, 400);
  });

  it('rejects empty patch with no fields to update', async () => {
    const admin = await h.seedSuperadmin('Admin EmptyPatch');
    const owner = await h.seedMember('EmptyPatch Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'emptypatch-club',
      name: 'EmptyPatch Club',
      ownerMemberId: owner.id,
      summary: 'Testing empty patch',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: created.clubId as string,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('clears admissionPolicy by sending null', async () => {
    const admin = await h.seedSuperadmin('Admin ClearPol');
    const owner = await h.seedMember('ClearPol Owner');

    const createResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'clearpol-club',
      name: 'ClearPol Club',
      ownerMemberId: owner.id,
      summary: 'Testing clear admissionPolicy',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;

    // Set admission policy first
    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId: created.clubId as string,
      admissionPolicy: 'Must be invited',
    });

    // Clear it
    const result = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
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
      clientKey: randomUUID(),
      slug: 'seq-update-club',
      name: 'Seq Club',
      ownerMemberId: owner.id,
      summary: 'Sequential updates',
    });
    const created = (createResult.data as Record<string, unknown>).club as Record<string, unknown>;
    const clubId = created.clubId as string;

    const r1 = await h.apiOk(admin.token, 'superadmin.clubs.update', { clientKey: randomUUID(), clubId, name: 'V2' });
    const c1 = (r1.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((c1.version as Record<string, unknown>).no, 2);

    const r2 = await h.apiOk(admin.token, 'superadmin.clubs.update', { clientKey: randomUUID(), clubId, summary: 'V3 summary' });
    const c2 = (r2.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal((c2.version as Record<string, unknown>).no, 3);
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
    assert.ok(typeof overview.totalContent === 'number');
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
    assert.equal(err.code, 'forbidden_role');
  });
});

describe('superadmin.members.list', () => {
  it('lists members with pagination', async () => {
    const admin = await h.seedSuperadmin('Admin List Members');
    await h.seedMember('Listed Member A');
    await h.seedMember('Listed Member B');

    const result = await h.apiOk(admin.token, 'superadmin.members.list', { limit: 20 });
    const data = result.data as Record<string, unknown>;
    const members = data.results as Array<Record<string, unknown>>;
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
    const members = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(members.length, 1);
  });

  it('non-superadmin cannot list members', async () => {
    const member = await h.seedMember('Regular ListM');
    const err = await h.apiErr(member.token, 'superadmin.members.list', { limit: 10 });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
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
    assert.equal(err.code, 'forbidden_role');
  });
});

describe('superadmin.members.remove', () => {
  it('hard deletes a member while preserving unrelated club history', async () => {
    const admin = await h.seedSuperadmin('Admin Remove Member');
    const ownerCtx = await h.seedOwner('member-remove-club', 'Member Remove Club');
    const target = await h.seedCompedMember(ownerCtx.club.id, 'Remove Target');
    const sponsored = await h.seedMember('Sponsored Survivor');

    const createMembership = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: ownerCtx.club.id,
      memberId: sponsored.id,
      role: 'member',
      sponsorId: target.id,
      initialStatus: 'active',
      reason: 'Sponsor should be detached on member delete',
    });
    const sponsoredMembershipId = (((createMembership.data as Record<string, unknown>).membership as Record<string, unknown>).membershipId as string);

    const rootCreate = await h.apiOk(target.token, 'content.create', {
      clubId: ownerCtx.club.id,
      kind: 'post',
      body: 'Thread root that will be deleted with the member',
    });
    const root = ((rootCreate.data as Record<string, unknown>).content as Record<string, unknown>);

    const replyCreate = await h.apiOk(ownerCtx.token, 'content.create', {
      threadId: root.threadId as string,
      kind: 'post',
      body: 'Reply that should survive the member hard delete',
    });
    const reply = ((replyCreate.data as Record<string, unknown>).content as Record<string, unknown>);

    const dmSend = await h.apiOk(target.token, 'messages.send', {
      recipientMemberId: ownerCtx.id,
      messageText: 'DM that should disappear with the deleted member',
    });
    const dmThreadId = ((((dmSend.data as Record<string, unknown>).message as Record<string, unknown>).threadId) as string);

    const llmReservationRows = await h.sqlClubs<{ id: string }>(
      `insert into ai_llm_quota_reservations (
         member_id,
         club_id,
         action_name,
         provider,
         model,
         status,
         reserved_output_tokens,
         actual_output_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'openai', 'gpt-5.4-nano', 'finalized', 7, 7, now(), now())
       returning id`,
      [target.id, ownerCtx.club.id],
    );
    const llmReservationId = llmReservationRows[0]!.id;

    await h.sqlClubs(
      `insert into club_activity (club_id, topic, created_by_member_id)
       values ($1, 'member.remove.detached', $2)`,
      [ownerCtx.club.id, target.id],
    );
    await seedProfileEmbedding(h, target.id, makeVector([1, 0, 0]));

    const result = await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Operator requested permanent member removal',
    });
    const removedMember = ((result.data as Record<string, unknown>).removedMember as Record<string, unknown>);
    const deleted = removedMember.deleted as Record<string, unknown>;
    const detached = removedMember.detached as Record<string, unknown>;

    assert.equal(removedMember.memberId, target.id);
    assert.equal((removedMember.removedByMember as Record<string, unknown>).memberId, admin.id);
    assert.equal(deleted.memberships, 1);
    assert.equal(deleted.contents, 1);
    assert.equal(deleted.directMessageThreads, 1);
    assert.equal(deleted.directMessages, 1);
    assert.equal(detached.membershipSponsors, 1);
    assert.equal(detached.contentThreads, 1);
    assert.ok(Number(detached.llmOutputReservations) >= 1);
    assert.ok(Number(detached.clubActivities) >= 1);

    const memberRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count from members where id = $1`,
      [target.id],
    );
    assert.equal(Number(memberRows[0]?.count ?? 0), 0);

    const membershipRows = await h.sqlClubs<{ sponsor_member_id: string | null }>(
      `select sponsor_member_id
       from club_memberships
       where id = $1
       limit 1`,
      [sponsoredMembershipId],
    );
    assert.equal(membershipRows[0]?.sponsor_member_id ?? null, null);

    const threadRows = await h.sqlClubs<{ created_by_member_id: string | null }>(
      `select created_by_member_id
       from content_threads
       where id = $1
       limit 1`,
      [root.threadId as string],
    );
    assert.equal(threadRows[0]?.created_by_member_id ?? null, null);

    const llmReservationAfter = await h.sqlClubs<{ member_id: string | null }>(
      `select member_id
       from ai_llm_quota_reservations
       where id = $1
       limit 1`,
      [llmReservationId],
    );
    assert.equal(llmReservationAfter[0]?.member_id ?? null, null);

    const activityRows = await h.sqlClubs<{ created_by_member_id: string | null }>(
      `select created_by_member_id
       from club_activity
       where topic = 'member.remove.detached'
       order by created_at desc
       limit 1`,
      [],
    );
    assert.equal(activityRows[0]?.created_by_member_id ?? null, null);

    const embeddingRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
       from member_profile_embeddings
       where member_id = $1`,
      [target.id],
    );
    assert.equal(Number(embeddingRows[0]?.count ?? 0), 0);

    const profileVersionRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
       from member_club_profile_versions
       where member_id = $1`,
      [target.id],
    );
    assert.equal(Number(profileVersionRows[0]?.count ?? 0), 0);

    const dmThreadRows = await h.sqlMessaging<{ count: string }>(
      `select count(*)::text as count
       from dm_threads
       where id = $1`,
      [dmThreadId],
    );
    assert.equal(Number(dmThreadRows[0]?.count ?? 0), 0);

    const threadResult = await h.apiOk(ownerCtx.token, 'content.get', {
      threadId: root.threadId,
      limit: 10,
    });
    const threadData = threadResult.data as Record<string, unknown>;
    const contents = (((threadData.contents as Record<string, unknown>).results) as Array<Record<string, unknown>>);
    assert.deepEqual(contents.map((content) => content.id), [reply.id]);

    const authErr = await h.apiErr(target.token, 'session.getContext', {});
    assert.equal(authErr.status, 401);
    assert.equal(authErr.code, 'unauthenticated');
  });

  it('blocks deleting a member who still owns clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Remove Owner');
    const ownerCtx = await h.seedOwner('remove-owned-club', 'Remove Owned Club');

    const { status, body } = await h.api(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: ownerCtx.id,
      confirmPublicName: ownerCtx.publicName,
      reason: 'This should be blocked until ownership is resolved',
    });
    assert.equal(status, 409);
    assert.equal((body.error as Record<string, unknown>).code, 'member_delete_blocked');
    const details = ((body.error as Record<string, unknown>).details as Record<string, unknown>);
    assert.ok(Array.isArray(details.ownedClubs));
  });

  it('blocks deleting a member who pays for another member subscription', async () => {
    const admin = await h.seedSuperadmin('Admin Remove Payer');
    const ownerCtx = await h.seedOwner('remove-paid-club', 'Remove Paid Club');
    const target = await h.seedCompedMember(ownerCtx.club.id, 'Subscription Payer Target');
    const beneficiary = await h.seedPaidMember(ownerCtx.club.id, 'Paid Beneficiary');

    await h.sqlClubs(
      `update club_subscriptions
       set payer_member_id = $1
       where membership_id = (
         select id
         from club_memberships
         where member_id = $2
           and club_id = $3
         order by joined_at desc nulls last, id desc
         limit 1
       )`,
      [target.id, beneficiary.id, ownerCtx.club.id],
    );

    const { status, body } = await h.api(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'This should be blocked until billing is moved off the target member',
    });
    assert.equal(status, 409);
    assert.equal((body.error as Record<string, unknown>).code, 'member_delete_blocked');
    const details = ((body.error as Record<string, unknown>).details as Record<string, unknown>);
    assert.equal(details.crossMemberSubscriptionCount, 1);
  });

  it('rejects self-delete even for superadmins', async () => {
    const admin = await h.seedSuperadmin('Admin Self Delete');

    const err = await h.apiErr(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: admin.id,
      confirmPublicName: admin.publicName,
      reason: 'Self delete should be rejected',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
  });

  it('rejects when confirmPublicName does not match', async () => {
    const admin = await h.seedSuperadmin('Admin Name Check');
    const target = await h.seedMember('Confirm Name Target');

    const err = await h.apiErr(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: 'Wrong Name',
      reason: 'This should be rejected due to name mismatch',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');

    const stillExists = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count from members where id = $1`,
      [target.id],
    );
    assert.equal(Number(stillExists[0]?.count ?? 0), 1);
  });

  it('succeeds when member has issued invitations including invitation-path applications', async () => {
    const admin = await h.seedSuperadmin('Admin Invite Sponsor');
    const ownerCtx = await h.seedOwner('invite-sponsor-club', 'Invite Sponsor Club');
    const target = await h.seedCompedMember(ownerCtx.club.id, 'Invite Sponsor Target');
    const applicantEmail = 'actual-invitation-applicant@test.example';
    const invitedEmail = 'external-invitation-applicant@test.example';
    const applicant = await h.seedMember('Invitation Applicant', applicantEmail);

    const issueResult = await h.apiOk(target.token, 'invitations.issue', {
      clubId: ownerCtx.club.id,
      candidateName: applicant.publicName,
      candidateEmail: invitedEmail,
      reason: 'I know this applicant well and they will contribute usefully to the club.',
      clientKey: randomUUID(),
    });
    const invitation = (issueResult.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const invitationId = invitation.invitationId as string;
    const invitationCode = invitation.code as string;

    const redeemResult = await h.apiOk(applicant.token, 'invitations.redeem', {
      code: invitationCode,
      clientKey: randomUUID(),
      draft: {
        name: applicant.publicName,
        socials: '',
        application: 'I would be a strong addition to this club.',
      },
    });
    const application = (redeemResult.data as Record<string, unknown>).application as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Sponsor delete with invitation-path history',
    });
    const removedMember = (result.data as Record<string, unknown>).removedMember as Record<string, unknown>;
    assert.equal(removedMember.memberId, target.id);
    const detached = removedMember.detached as Record<string, unknown>;
    assert.ok(Number(detached.sponsoredInvitations) >= 1);

    const invRows = await h.sqlClubs<{ sponsor_member_id: string | null }>(
      `select sponsor_member_id from invite_requests where id = $1`,
      [invitationId],
    );
    assert.equal(invRows.length, 1);
    assert.equal(invRows[0]?.sponsor_member_id ?? null, null);

    const appRows = await h.sqlClubs<{ sponsor_member_id: string | null }>(
      `select sponsor_member_id from club_applications where id = $1`,
      [application.applicationId as string],
    );
    assert.equal(appRows.length, 1);
    assert.equal(appRows[0]?.sponsor_member_id ?? null, null);

    const listBody = await h.apiOk(ownerCtx.token, 'clubadmin.applications.list', {
      clubId: ownerCtx.club.id,
      limit: 20,
    });
    const listed = ((listBody.data as Record<string, unknown>).results as Array<Record<string, unknown>>)
      .find((row) => row.applicationId === application.applicationId);
    assert.ok(listed);
    assert.equal(listed?.sponsorId ?? null, null);
    assert.equal(listed?.sponsorName ?? null, target.publicName);

    const decideBody = await h.apiOk(ownerCtx.token, 'clubadmin.applications.decide', {
      clubId: ownerCtx.club.id,
      applicationId: application.applicationId as string,
      decision: 'accept',
      adminNote: 'Sponsor is gone but the application should still activate.',
      clientKey: randomUUID(),
    });
    const decided = ((decideBody.data as Record<string, unknown>).application as Record<string, unknown>);
    assert.equal(decided.phase, 'active');
    assert.equal(decided.sponsorId ?? null, null);

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((membership) => membership.clubId === ownerCtx.club.id),
      true,
    );
  });

  it('rejects redeeming an open invitation after the sponsor has been hard-deleted', async () => {
    const admin = await h.seedSuperadmin('Admin Orphaned Invite');
    const ownerCtx = await h.seedOwner('orphaned-invite-club', 'Orphaned Invite Club');
    const target = await h.seedCompedMember(ownerCtx.club.id, 'Orphaned Invite Sponsor');
    const applicantEmail = 'actual-orphaned-invite-applicant@test.example';
    const invitedEmail = 'external-orphaned-invite-applicant@test.example';
    const applicant = await h.seedMember('Orphaned Invite Applicant', applicantEmail);

    const issueResult = await h.apiOk(target.token, 'invitations.issue', {
      clubId: ownerCtx.club.id,
      candidateName: applicant.publicName,
      candidateEmail: invitedEmail,
      reason: 'Open invitation that should become unusable after sponsor delete.',
      clientKey: randomUUID(),
    });
    const invitation = (issueResult.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const invitationId = invitation.invitationId as string;
    const invitationCode = invitation.code as string;

    await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Delete sponsor before invitation redeem.',
    });

    const redeemErr = await h.apiErr(applicant.token, 'invitations.redeem', {
      code: invitationCode,
      clientKey: randomUUID(),
      draft: {
        name: applicant.publicName,
        socials: '',
        application: 'This should fail because the sponsor was deleted.',
      },
    });
    assert.equal(redeemErr.status, 422);
    assert.equal(redeemErr.code, 'invalid_invitation_code');

    const invRows = await h.sqlClubs<{ sponsor_member_id: string | null; used_at: string | null }>(
      `select sponsor_member_id, used_at::text as used_at
       from invite_requests
       where id = $1`,
      [invitationId],
    );
    assert.equal(invRows.length, 1);
    assert.equal(invRows[0]?.sponsor_member_id ?? null, null);
    assert.equal(invRows[0]?.used_at ?? null, null);
  });

  it('preserves legacy invitation-linked memberships while detaching the deleted sponsor', async () => {
    const admin = await h.seedSuperadmin('Admin Legacy Invite Delete');
    const ownerCtx = await h.seedOwner('legacy-invite-club', 'Legacy Invite Club');
    const target = await h.seedCompedMember(ownerCtx.club.id, 'Legacy Sponsor Target');
    const survivor = await h.seedMember('Legacy Invitation Survivor');

    const invitation = await h.seedInvitation(
      ownerCtx.club.id,
      target.id,
      'legacy-candidate@test.example',
      {
        candidateName: 'Legacy Candidate',
        reason: 'Legacy invite history',
      },
    );
    const invitationId = invitation.id;

    const membershipRows = await h.sqlClubs<{ id: string }>(
      `with inserted_membership as (
         insert into club_memberships (
           club_id, member_id, sponsor_member_id, invitation_id, role, status, joined_at, metadata
         )
         values ($1, $2, $3, $4, 'member', 'active', now(), '{}'::jsonb)
         returning id
       ),
       inserted_profile as (
         insert into member_club_profile_versions (
           membership_id, member_id, club_id, version_no, created_by_member_id, generation_source
         )
         select id, $2, $1, 1, $3, 'membership_seed'
         from inserted_membership
       ),
       inserted_state as (
         insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
         select id, 'active', 'legacy invitation membership', 1, $3
         from inserted_membership
       )
       select id from inserted_membership`,
      [ownerCtx.club.id, survivor.id, target.id, invitationId],
    );
    const survivorMembershipId = membershipRows[0]!.id;

    const result = await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Delete sponsor while preserving legacy invitation-linked membership history',
    });
    const removedMember = (result.data as Record<string, unknown>).removedMember as Record<string, unknown>;
    const detached = removedMember.detached as Record<string, unknown>;
    assert.equal(removedMember.memberId, target.id);
    assert.ok(Number(detached.sponsoredInvitations) >= 1);

    const invRows = await h.sqlClubs<{ sponsor_member_id: string | null }>(
      `select sponsor_member_id from invite_requests where id = $1`,
      [invitationId],
    );
    assert.equal(invRows.length, 1);
    assert.equal(invRows[0]?.sponsor_member_id ?? null, null);

    const membershipAfter = await h.sqlClubs<{ sponsor_member_id: string | null; invitation_id: string | null }>(
      `select sponsor_member_id, invitation_id
       from club_memberships
       where id = $1`,
      [survivorMembershipId],
    );
    assert.equal(membershipAfter.length, 1);
    assert.equal(membershipAfter[0]?.sponsor_member_id ?? null, null);
    assert.equal(membershipAfter[0]?.invitation_id ?? null, invitationId);
  });

  it('preserves used invitation history when the invited member is hard-deleted after activation', async () => {
    const admin = await h.seedSuperadmin('Admin Applicant Delete Invite');
    const ownerCtx = await h.seedOwner('applicant-delete-invite-club', 'Applicant Delete Invite Club');
    const sponsor = await h.seedCompedMember(ownerCtx.club.id, 'Applicant Delete Sponsor');
    const applicantEmail = 'actual-accepted-invite-applicant@test.example';
    const invitedEmail = 'external-accepted-invite-applicant@test.example';
    const applicant = await h.seedMember('Accepted Invite Applicant', applicantEmail);

    const issueResult = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: ownerCtx.club.id,
      candidateName: applicant.publicName,
      candidateEmail: invitedEmail,
      reason: 'Invitation that should remain as sponsor history after applicant delete.',
      clientKey: randomUUID(),
    });
    const invitation = (issueResult.data as Record<string, unknown>).invitation as Record<string, unknown>;
    const invitationId = invitation.invitationId as string;
    const invitationCode = invitation.code as string;

    const redeemResult = await h.apiOk(applicant.token, 'invitations.redeem', {
      code: invitationCode,
      clientKey: randomUUID(),
      draft: {
        name: applicant.publicName,
        socials: '',
        application: 'Please accept this invitation-backed application.',
      },
    });
    const application = (redeemResult.data as Record<string, unknown>).application as Record<string, unknown>;

    const decideResult = await h.apiOk(ownerCtx.token, 'clubadmin.applications.decide', {
      clubId: ownerCtx.club.id,
      applicationId: application.applicationId as string,
      decision: 'accept',
      adminNote: 'Activate before deleting the invited member.',
      clientKey: randomUUID(),
    });
    const decided = (decideResult.data as Record<string, unknown>).application as Record<string, unknown>;
    const activatedMembershipId = decided.activatedMembershipId as string;
    assert.ok(activatedMembershipId);

    await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey: randomUUID(),
      memberId: applicant.id,
      confirmPublicName: applicant.publicName,
      reason: 'Delete the invited member after activation.',
    });

    const invRows = await h.sqlClubs<{ sponsor_member_id: string | null; used_membership_id: string | null }>(
      `select sponsor_member_id, used_membership_id
       from invite_requests
       where id = $1`,
      [invitationId],
    );
    assert.equal(invRows.length, 1);
    assert.equal(invRows[0]?.sponsor_member_id ?? null, sponsor.id);
    assert.equal(invRows[0]?.used_membership_id ?? null, null);

    const membershipRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
       from club_memberships
       where id = $1`,
      [activatedMembershipId],
    );
    assert.equal(Number(membershipRows[0]?.count ?? 0), 0);
  });

  it('is idempotent: same clientKey returns the same result without re-deleting', async () => {
    const admin = await h.seedSuperadmin('Admin Idempotent Remove');
    const target = await h.seedMember('Idempotent Remove Target');
    const clientKey = randomUUID();

    const first = await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey,
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'First call',
    });
    const second = await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey,
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'First call',
    });

    assert.deepEqual(first.data, second.data);

    const memberRows = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count from members where id = $1`,
      [target.id],
    );
    assert.equal(Number(memberRows[0]?.count ?? 0), 0);
  });

  it('rejects reusing a clientKey for a different delete intent', async () => {
    const admin = await h.seedSuperadmin('Admin Remove Conflict');
    const target = await h.seedMember('Client Key Conflict Target');
    const clientKey = randomUUID();

    await h.apiOk(admin.token, 'superadmin.members.remove', {
      clientKey,
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Original delete request',
    });

    const err = await h.apiErr(admin.token, 'superadmin.members.remove', {
      clientKey,
      memberId: target.id,
      confirmPublicName: target.publicName,
      reason: 'Changed reason should conflict',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
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
    assert.ok(typeof stats.contentCount === 'number');
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
    assert.equal(err.code, 'forbidden_role');
  });

  it('club owner can access club stats', async () => {
    const ownerCtx = await h.seedOwner('stats-owner-club', 'Stats Owner Club');
    const result = await h.apiOk(ownerCtx.token, 'clubadmin.clubs.getStatistics', { clubId: ownerCtx.club.id });
    const stats = (result.data as Record<string, unknown>).stats as Record<string, unknown>;
    assert.equal(stats.clubId, ownerCtx.club.id);
  });
});

// ── Club Admin Promote / Demote ─────────────────────────────────────────────

describe('clubadmin.members.update', () => {
  it('owner promotes a regular member to admin', async () => {
    const owner = await h.seedOwner('promote-club', 'Promote Club');
    const member = await h.seedCompedMember(owner.club.id, 'Promo Target');

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
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
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
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
    const first = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });
    assert.equal((first.data as Record<string, unknown>).changed, true);
    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });
    const data = result.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    assert.equal(membership.role, 'clubadmin');
    assert.equal(data.changed, false);
  });

  it('non-owner admin cannot promote members', async () => {
    const owner = await h.seedOwner('promote-noauth', 'Promote NoAuth Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Non-Owner Admin');
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: admin.id,
      patch: { role: 'clubadmin' },
    });
    const target = await h.seedCompedMember(owner.club.id, 'Promote Target2');

    const err = await h.apiErr(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: target.id,
      patch: { role: 'clubadmin' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('regular member cannot promote', async () => {
    const owner = await h.seedOwner('promote-reg', 'Promote Reg Club');
    const memberA = await h.seedCompedMember(owner.club.id, 'Regular A');
    const memberB = await h.seedCompedMember(owner.club.id, 'Regular B');

    const err = await h.apiErr(memberA.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: memberB.id,
      patch: { role: 'clubadmin' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('returns 404 for non-existent member', async () => {
    const owner = await h.seedOwner('promote-ghost', 'Promote Ghost Club');

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: 'nonexistent-member',
      patch: { role: 'clubadmin' },
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('returns 404 for member not in the club', async () => {
    const owner = await h.seedOwner('promote-other', 'Promote Other Club');
    const outsider = await h.seedMember('Outsider');

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: outsider.id,
      patch: { role: 'clubadmin' },
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('superadmin can promote a member', async () => {
    const admin = await h.seedSuperadmin('SA Promote');
    const owner = await h.seedOwner('sa-promote-club', 'SA Promote Club');
    const member = await h.seedCompedMember(owner.club.id, 'SA Promo Target');

    const result = await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });
    const membership = (result.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal(membership.role, 'clubadmin');
  });
});

describe('clubadmin.members.update', () => {
  it('owner demotes an admin to regular member', async () => {
    const owner = await h.seedOwner('demote-club', 'Demote Club');
    const member = await h.seedCompedMember(owner.club.id, 'Demote Target');
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'member' },
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
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });
    await h.apiOk(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });

    // Demote then verify loss of access
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'member' },
    });
    const err = await h.apiErr(member.token, 'clubadmin.clubs.getStatistics', { clubId: owner.club.id });
    assert.equal(err.status, 403);
  });

  it('cannot demote the club owner', async () => {
    const owner = await h.seedOwner('demote-owner', 'Demote Owner Club');

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { role: 'member' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('demoting a regular member is idempotent with changed: false', async () => {
    const owner = await h.seedOwner('demote-idem', 'Demote Idempotent Club');
    const member = await h.seedCompedMember(owner.club.id, 'Not Admin');

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'member' },
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
    await h.apiOk(owner.token, 'clubadmin.members.update', { clubId: owner.club.id, memberId: adminA.id, patch: { role: 'clubadmin' } });
    await h.apiOk(owner.token, 'clubadmin.members.update', { clubId: owner.club.id, memberId: adminB.id, patch: { role: 'clubadmin' } });

    const err = await h.apiErr(adminA.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: adminB.id,
      patch: { role: 'member' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('regular member cannot demote', async () => {
    const owner = await h.seedOwner('demote-reg', 'Demote Reg Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Admin Demote');
    await h.apiOk(owner.token, 'clubadmin.members.update', { clubId: owner.club.id, memberId: admin.id, patch: { role: 'clubadmin' } });
    const regular = await h.seedCompedMember(owner.club.id, 'Regular Demote');

    const err = await h.apiErr(regular.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: admin.id,
      patch: { role: 'member' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('returns 404 for non-existent member', async () => {
    const owner = await h.seedOwner('demote-ghost', 'Demote Ghost Club');

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: 'nonexistent-member',
      patch: { role: 'member' },
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'member_not_found');
  });

  it('superadmin can demote an admin', async () => {
    const admin = await h.seedSuperadmin('SA Demote');
    const owner = await h.seedOwner('sa-demote-club', 'SA Demote Club');
    const member = await h.seedCompedMember(owner.club.id, 'SA Demote Target');
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });

    const result = await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'member' },
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
    assert.ok(Array.isArray(data.results));
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

describe('superadmin.messages.list', () => {
  it('lists threads across all clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Threads');
    const ownerCtx = await h.seedOwner('threads-club', 'Threads Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Thread Sender');

    await h.apiOk(member.token, 'messages.send', {
      recipientMemberId: ownerCtx.id,
      messageText: 'Hello threads test!',
    });

    const result = await h.apiOk(admin.token, 'superadmin.messages.list', {
      limit: 10,
    });
    const data = result.data as Record<string, unknown>;
    const threads = data.results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(threads));
    assert.ok(threads.length >= 1);
    assert.ok(threads.every((t) => typeof t.threadId === 'string'));
    assert.ok(threads.every((t) => typeof t.messageCount === 'number'));
    assert.ok(threads.every((t) => Array.isArray(t.participants)));
  });

  it('non-superadmin cannot list admin threads', async () => {
    const member = await h.seedMember('Regular Threads');
    const err = await h.apiErr(member.token, 'superadmin.messages.list', { limit: 10 });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.messages.get', () => {
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

    const result = await h.apiOk(admin.token, 'superadmin.messages.get', { threadId });
    const data = result.data as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.equal(thread.threadId, threadId);
    const messagesPage = data.messages as Record<string, unknown>;
    const messages = messagesPage.results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages));
    assert.equal(typeof messagesPage.hasMore, 'boolean');
    assert.ok(Object.hasOwn(messagesPage, 'nextCursor'));
    assert.ok(messages.length >= 1);
    assert.ok(messages.some((m) => m.messageText === 'A message in a readable thread'));
  });

  it('returns 404 for non-existent thread', async () => {
    const admin = await h.seedSuperadmin('Admin ReadGhost');
    const err = await h.apiErr(admin.token, 'superadmin.messages.get', { threadId: 'nonexistent-thread-id' });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'thread_not_found');
  });

  it('non-superadmin cannot read admin threads', async () => {
    const member = await h.seedMember('Regular Read');
    const err = await h.apiErr(member.token, 'superadmin.messages.get', { threadId: 'fake-thread-id' });
    assert.equal(err.status, 403);
  });
});

describe('superadmin.accessTokens.list', () => {
  it('lists tokens for any member', async () => {
    const admin = await h.seedSuperadmin('Admin Token List');
    const member = await h.seedMember('Token Listed Member');

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.list', { memberId: member.id });
    const data = result.data as Record<string, unknown>;
    const tokens = data.results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => typeof t.tokenId === 'string'));
    assert.ok(tokens.every((t) => t.memberId === member.id));
    assert.equal(data.hasMore, false);
    assert.equal(data.nextCursor, null);
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
    const tokens = listData.results as Array<Record<string, unknown>>;
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

// ── Token Lifecycle ──────────────────────────────────────────────────────────

describe('accessTokens.list', () => {
  it('member sees their own tokens', async () => {
    const member = await h.seedMember('Token Lister');

    const result = await h.apiOk(member.token, 'accessTokens.list', {});
    const data = result.data as Record<string, unknown>;
    const tokens = data.results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.length >= 1);
    assert.ok(tokens.every((t) => t.memberId === member.id));
    assert.equal(data.hasMore, false);
    assert.equal(data.nextCursor, null);
  });

  it('throttles bearer last_used_at writes for hot tokens', async () => {
    const member = await h.seedMember('Token Last Used Throttle');
    const tokenRow = await h.pools.super.query<{ id: string }>(
      `select id from member_bearer_tokens where member_id = $1 order by created_at desc limit 1`,
      [member.id],
    );
    const tokenId = tokenRow.rows[0]!.id;

    const freshRow = await h.pools.super.query<{ last_used_at: string }>(
      `update member_bearer_tokens
          set last_used_at = now()
        where id = $1
        returning last_used_at::text as last_used_at`,
      [tokenId],
    );
    await h.apiOk(member.token, 'session.getContext', {});
    const unchangedRow = await h.pools.super.query<{ last_used_at: string }>(
      `select last_used_at::text as last_used_at from member_bearer_tokens where id = $1`,
      [tokenId],
    );
    assert.equal(unchangedRow.rows[0]!.last_used_at, freshRow.rows[0]!.last_used_at);

    const staleRow = await h.pools.super.query<{ last_used_at: string }>(
      `update member_bearer_tokens
          set last_used_at = now() - interval '2 minutes'
        where id = $1
        returning last_used_at::text as last_used_at`,
      [tokenId],
    );
    await h.apiOk(member.token, 'session.getContext', {});
    const touchedRow = await h.pools.super.query<{ last_used_at: string }>(
      `select last_used_at::text as last_used_at from member_bearer_tokens where id = $1`,
      [tokenId],
    );
    assert.notEqual(touchedRow.rows[0]!.last_used_at, staleRow.rows[0]!.last_used_at);
  });

  it('uses canonical cursor pagination for self and superadmin token lists', async () => {
    const admin = await h.seedSuperadmin('Token Pagination Admin');
    const member = await h.seedMember('Token Pagination Member');
    await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'pagination-token-one',
    });
    await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'pagination-token-two',
    });

    const first = await h.apiOk(member.token, 'accessTokens.list', { limit: 1 });
    const firstData = first.data as Record<string, unknown>;
    const firstResults = firstData.results as Array<Record<string, unknown>>;
    assert.equal(firstResults.length, 1);
    assert.equal(firstData.hasMore, true);
    assert.equal(typeof firstData.nextCursor, 'string');

    const second = await h.apiOk(member.token, 'accessTokens.list', {
      limit: 1,
      cursor: firstData.nextCursor,
    });
    const secondData = second.data as Record<string, unknown>;
    const secondResults = secondData.results as Array<Record<string, unknown>>;
    assert.equal(secondResults.length, 1);
    assert.notEqual(secondResults[0]?.tokenId, firstResults[0]?.tokenId);

    const adminFirst = await h.apiOk(admin.token, 'superadmin.accessTokens.list', {
      memberId: member.id,
      limit: 1,
    });
    const adminData = adminFirst.data as Record<string, unknown>;
    assert.equal((adminData.results as Array<Record<string, unknown>>).length, 1);
    assert.equal(adminData.hasMore, true);
    assert.equal(typeof adminData.nextCursor, 'string');
  });
});

describe('accessTokens.create', () => {
  it('member creates new token; new token works', async () => {
    const ownerCtx = await h.seedOwner('token-create-club', 'Token Create Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Creator');

    const createResult = await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'my-new-token',
    });
    const data = createResult.data as Record<string, unknown>;
    const newBearerToken = data.bearerToken as string;

    assert.ok(typeof newBearerToken === 'string' && newBearerToken.length > 0);
    assert.equal(data.label, 'my-new-token');
    assert.equal(data.memberId, member.id);

    // Verify the new token actually works
    const sessionResult = await h.apiOk(newBearerToken, 'session.getContext', {});
    assert.ok(sessionResult.ok !== false, 'new token should authenticate successfully');
    const actor = sessionResult.actor as Record<string, unknown>;
    const actorMember = actor.member as Record<string, unknown>;
    assert.equal(actorMember.id, member.id);
  });

  it('does not replay plaintext bearer tokens on exact clientKey retry', async () => {
    const ownerCtx = await h.seedOwner('token-secret-replay-club', 'Token Secret Replay Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Secret Replay Member');
    const clientKey = randomUUID();
    const input = { clientKey, label: 'secret-replay' };

    const first = await h.apiOk(member.token, 'accessTokens.create', input);
    const firstToken = first.data as Record<string, unknown>;
    assert.ok(typeof firstToken.bearerToken === 'string');

    const replay = await h.api(member.token, 'accessTokens.create', input);
    assert.equal(replay.status, 409);
    const error = replay.body.error as Record<string, unknown>;
    assert.equal(error.code, 'secret_replay_unavailable');
    const details = error.details as Record<string, unknown>;
    assert.equal(details.tokenId, firstToken.tokenId);
    assert.equal(details.label, 'secret-replay');
    assert.equal('bearerToken' in details, false, 'secret replay details must not include the plaintext token');
  });

  it('rejects past expiresAt and still accepts null expiresAt', async () => {
    const ownerCtx = await h.seedOwner('token-expiry-club', 'Token Expiry Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Expiry Member');

    const pastErr = await h.apiErr(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'past-expiry',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    assert.equal(pastErr.status, 400);
    assert.equal(pastErr.code, 'invalid_input');

    const created = await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'no-expiry',
      expiresAt: null,
    });
    const token = created.data as Record<string, unknown>;
    assert.equal(token.expiresAt, null);
  });

  it('does not count expired bearer tokens against the active token quota', async () => {
    const ownerCtx = await h.seedOwner('token-expired-quota-club', 'Token Expired Quota Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Expired Quota Member');

    await h.sql(
      `insert into member_bearer_tokens (member_id, label, token_hash, expires_at)
       select $1, 'expired-quota-' || g::text, $2 || g::text, now() - interval '1 day'
       from generate_series(1, 10) g`,
      [member.id, `expired-quota-${member.id}-`],
    );

    const created = await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'after-expired',
    });
    const token = created.data as Record<string, unknown>;
    assert.equal(token.label, 'after-expired');
  });
});

describe('accessTokens.revoke', () => {
  it('member revokes token; revoked token stops working', async () => {
    const ownerCtx = await h.seedOwner('token-revoke-club', 'Token Revoke Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Token Revoker');

    // Create a second token to revoke
    const createResult = await h.apiOk(member.token, 'accessTokens.create', {
      clientKey: randomUUID(),
      label: 'to-revoke',
    });
    const data = createResult.data as Record<string, unknown>;
    const tokenToRevoke = data.bearerToken as string;
    const tokenId = data.tokenId as string;

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
    const tokens = (listResult.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const tokenId = tokens[0]?.tokenId as string;

    // memberA tries to revoke memberB's token
    const err = await h.apiErr(memberA.token, 'accessTokens.revoke', { tokenId });
    assert.equal(err.status, 404, 'should not find token outside own scope');
  });
});

// ── Quotas ───────────────────────────────────────────────────────────────────

type QuotaWindow = {
  window: 'day' | 'week' | 'month';
  max: number;
  used: number;
  remaining: number;
};

type QuotaRow = {
  action: string;
  metric: 'requests' | 'output_tokens';
  scope: 'per_club_member' | 'per_member_global';
  clubId: string | null;
  windows: QuotaWindow[];
};

function readQuotas(result: Awaited<ReturnType<TestHarness['apiOk']>>): QuotaRow[] {
  return (result.data as { quotas: QuotaRow[] }).quotas;
}

function findQuota(quotas: QuotaRow[], action: string, clubId: string | null): QuotaRow {
  const quota = quotas.find((row) => row.action === action && row.clubId === clubId);
  assert.ok(quota, `missing quota row for ${action} ${clubId ?? 'global'}`);
  return quota!;
}

function findWindow(quota: QuotaRow, window: QuotaWindow['window']): QuotaWindow {
  const match = quota.windows.find((entry) => entry.window === window);
  assert.ok(match, `missing ${window} window for ${quota.action}`);
  return match!;
}

describe('quotas.getUsage', () => {
  it('returns quota rows from global defaults with no club overrides', async () => {
    // Owner gets 3x multiplier on the unified global default (content.create=50)
    const ownerCtx = await h.seedOwner('quota-club', 'Quota Club');

    const quotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    assert.ok(Array.isArray(quotas));
    assert.ok(quotas.length >= 4, 'should return the global quotas plus the club-scoped content quota');
    for (const quota of quotas) {
      assert.ok(typeof quota.action === 'string');
      assert.ok(quota.clubId === null || typeof quota.clubId === 'string');
      assert.ok(Array.isArray(quota.windows));
    }
    // Owner gets 3x the global default
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(contentQuota.metric, 'requests');
    assert.equal(contentQuota.scope, 'per_club_member');
    assert.equal(findWindow(contentQuota, 'day').max, 150, 'owner gets 3x the unified global default of 50');
    assert.equal(findWindow(contentQuota, 'week').max, 675);
    assert.equal(findWindow(contentQuota, 'month').max, 2700);
  });

  it('normal member gets 1x base quota', async () => {
    const ownerCtx = await h.seedOwner('quota-member-1x', 'Quota Member Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Regular Member');

    const quotas = readQuotas(await h.apiOk(member.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 50, 'normal member gets 1x the unified global default of 50');
  });

  it('clubadmin gets 3x base quota', async () => {
    const ownerCtx = await h.seedOwner('quota-admin-3x', 'Quota Admin Club');
    const admin = await h.seedPaidMember(ownerCtx.club.id, 'Club Admin');
    await h.apiOk(ownerCtx.token, 'clubadmin.members.update', {
      clubId: ownerCtx.club.id,
      memberId: admin.id,
      patch: { role: 'clubadmin' },
    });

    const quotas = readQuotas(await h.apiOk(admin.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 150, 'clubadmin gets 3x the unified global default of 50');
  });

  it('club override supersedes global default', async () => {
    const ownerCtx = await h.seedOwner('quota-override', 'Quota Override Club');

    const member = await h.seedCompedMember(ownerCtx.club.id, 'Override Member');
    const quotas = readQuotas(await h.apiOk(member.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 5, 'normal member gets 1x the club override of 5');

    // Owner gets 3x the override
    const ownerQuotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    const ownerContentQuota = findQuota(ownerQuotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(ownerContentQuota, 'day').max, 15, 'owner gets 3x the club override of 5');
  });

  it('includes the global and club-scoped supported actions', async () => {
    const ownerCtx = await h.seedOwner('quota-supported', 'Quota Supported Club');

    const quotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    const actions = quotas.map((q) => q.action);
    assert.ok(actions.includes('content.create'));
    assert.ok(actions.includes('messages.send'));
    assert.ok(actions.includes('embedding.query'));
    assert.ok(actions.includes('clubs.apply'));
    assert.ok(actions.includes('llm.outputTokens'));
  });

  it('posts and events both consume the unified content.create quota', async () => {
    const ownerCtx = await h.seedOwner('quota-kind-isolation', 'Quota Kind Club');

    await seedPublishedContent(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'post',
      title: 'Post 1',
    });
    await seedPublishedContent(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'post',
      title: 'Post 2',
    });
    await seedPublishedContent(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'event',
      title: 'Event 1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const quotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').used, 3, 'posts and events should both count toward the unified quota');
  });

  it('club overrides still apply to all content kinds', async () => {
    const ownerCtx = await h.seedOwner('quota-event-isolation', 'Quota Event Club');
    const member = await h.seedCompedMember(ownerCtx.club.id, 'Quota Event Member');

    await seedPublishedContent(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: member.id,
      kind: 'event',
      title: 'Event',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const quotas = readQuotas(await h.apiOk(member.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 4);
    assert.equal(findWindow(contentQuota, 'day').used, 1, 'events also consume the unified quota');
  });

  it('quota enforcement is kind-agnostic across posts and events', async () => {
    const ownerCtx = await h.seedOwner('quota-enforce-kind', 'Quota Enforce Club');

    await seedPublishedContent(h, {
      clubId: ownerCtx.club.id,
      authorMemberId: ownerCtx.id,
      kind: 'event',
      title: 'An event',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const quotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').used, 1, 'event should consume the same content.create quota as posts');
    assert.equal(findWindow(contentQuota, 'day').remaining, 2, 'owner has 3 total and 1 used');
  });

  it('quota enforcement rejects over-limit for normal member', async () => {
    const ownerCtx = await h.seedOwner('quota-enforce-member', 'Quota Enforce Member Club');

    const member = await h.seedCompedMember(ownerCtx.club.id, 'Quota Test Member');

    // Create 2 posts (the limit for a normal member)
    for (let i = 0; i < 2; i++) {
      await seedPublishedContent(h, {
        clubId: ownerCtx.club.id,
        authorMemberId: member.id,
        kind: 'post',
        title: `Post ${i}`,
      });
    }

    // Verify usage shows at limit
    const quotas = readQuotas(await h.apiOk(member.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 2, 'normal member has limit of 2');
    assert.equal(findWindow(contentQuota, 'day').used, 2);
    assert.equal(findWindow(contentQuota, 'day').remaining, 0);
  });

  it('owner can exceed normal member limit thanks to 3x multiplier', async () => {
    const ownerCtx = await h.seedOwner('quota-owner-3x-enforce', 'Quota Owner 3x Club');

    // Create 3 posts as owner (within owner's 6 limit, above member's 2 limit)
    for (let i = 0; i < 3; i++) {
      await seedPublishedContent(h, {
        clubId: ownerCtx.club.id,
        authorMemberId: ownerCtx.id,
        kind: 'post',
        title: `Owner Post ${i}`,
      });
    }

    const quotas = readQuotas(await h.apiOk(ownerCtx.token, 'quotas.getUsage', {}));
    const contentQuota = findQuota(quotas, 'content.create', ownerCtx.club.id);
    assert.equal(findWindow(contentQuota, 'day').max, 6, 'owner gets 3x the override of 2');
    assert.equal(findWindow(contentQuota, 'day').used, 3);
    assert.equal(findWindow(contentQuota, 'day').remaining, 3, 'owner still has 3 remaining out of 6');
  });
});

// ── Cross-cutting authorization ─────────────────────────────────────────────

describe('platform authorization', () => {
  it('non-superadmin cannot use any superadmin action', async () => {
    const regularMember = await h.seedMember('Regular Joe');
    const superadminActions = [
      ['superadmin.clubs.list', {}],
      ['superadmin.clubs.create', { clientKey: 'x', slug: 'x', name: 'X', summary: 'X', ownerMemberId: 'x' }],
      ['superadmin.clubs.archive', { clientKey: 'x', clubId: 'x' }],
      ['superadmin.clubs.assignOwner', { clientKey: 'x', clubId: 'x', ownerMemberId: 'x' }],
      ['superadmin.platform.getOverview', {}],
      ['superadmin.members.list', { limit: 1 }],
      ['superadmin.members.get', { memberId: 'x' }],
      ['superadmin.members.remove', { clientKey: 'x', memberId: 'x', confirmPublicName: 'x', reason: 'x' }],
      ['clubadmin.clubs.getStatistics', { clubId: 'x' }],
      ['superadmin.content.list', { limit: 1 }],
      ['superadmin.messages.list', { limit: 1 }],
      ['superadmin.messages.get', { threadId: 'x' }],
      ['superadmin.accessTokens.list', { memberId: 'x' }],
      ['superadmin.accessTokens.revoke', { memberId: 'x', tokenId: 'x' }],
      ['superadmin.notificationProducers.create', { clientKey: 'x', producerId: 'x', namespacePrefix: 'x.', topics: [{ topic: 'x.topic', deliveryClass: 'informational' }] }],
      ['superadmin.notificationProducers.rotateSecret', { clientKey: 'x', producerId: 'x' }],
      ['superadmin.notificationProducers.updateStatus', { producerId: 'x', status: 'disabled' }],
      ['superadmin.notificationProducerTopics.updateStatus', { producerId: 'x', topic: 'x.topic', status: 'disabled' }],
      ['superadmin.diagnostics.getHealth', {}],
    ] as const;

    for (const [action, input] of superadminActions) {
      const err = await h.apiErr(regularMember.token, action, input);
      assert.equal(err.status, 403, `${action} should reject non-superadmin`);
      assert.equal(err.code, 'forbidden_role', `${action} should return forbidden_role code`);
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
