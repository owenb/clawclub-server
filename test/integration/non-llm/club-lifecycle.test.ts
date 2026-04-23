import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('clubs.create', () => {
  it('creates one free-allowance club and refreshes the actor envelope', async () => {
    const member = await h.seedMember('Free Club Creator');

    const result = await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'free-club',
      name: 'Free Club',
      summary: 'A free club',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });

    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.slug, 'free-club');
    assert.equal(club.usesFreeAllowance, true);
    assert.equal(club.memberCap, 5);
    assert.equal(club.archivedAt, null);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    const memberships = activeMemberships(session);
    const createdMembership = memberships.find((membership) => membership.clubId === club.clubId);
    assert.ok(createdMembership, 'creator should immediately see the new club membership');
    assert.equal(createdMembership?.isOwner, true);
    assert.equal(createdMembership?.role, 'clubadmin');
  });

  it('rejects a second free club for the same owner', async () => {
    const member = await h.seedMember('One Free Club');

    await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'one-free-club',
      name: 'One Free Club',
      summary: 'First free club',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });

    const err = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'two-free-club',
      name: 'Two Free Club',
      summary: 'Second free club',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'owner_club_limit_reached');
  });

  it('allows a replacement self-serve club after the prior owned club is archived', async () => {
    const member = await h.seedMember('Archived Free Club Owner');
    const admin = await h.seedSuperadmin('Archived Free Club Admin');

    const first = await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'archived-free-club',
      name: 'Archived Free Club',
      summary: 'First free club that will be archived.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const firstClubId = String((((first.data as Record<string, unknown>).club as Record<string, unknown>).clubId));

    await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: firstClubId });

    const second = await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'replacement-free-club',
      name: 'Replacement Free Club',
      summary: 'A replacement free club after archival.',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const secondClub = (second.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(secondClub.slug, 'replacement-free-club');
    assert.equal(secondClub.usesFreeAllowance, true);
  });

  it('still rejects a second self-serve club after the first club is upgraded out of the free allowance', async () => {
    const member = await h.seedMember('Upgraded Single Club Owner');
    const admin = await h.seedSuperadmin('Free Upgrade Admin');

    const created = await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'upgraded-only-club',
      name: 'Upgraded Only Club',
      summary: 'Starts as the one self-serve club',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = ((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId as string;

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 20,
    });

    const err = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'attempted-second-club',
      name: 'Attempted Second Club',
      summary: 'Should still be blocked after the first club is upgraded',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'owner_club_limit_reached');
  });
});

describe('clubadmin.clubs.update', () => {
  it('owner can update club text, but a non-owner clubadmin cannot', async () => {
    const owner = await h.seedMember('Owner Updater');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'owner-updated-club',
      name: 'Original Club Name',
      summary: 'Original summary',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = ((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId as string;

    const member = await h.seedCompedMember(clubId, 'Promoted Admin');
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });

    const updated = await h.apiOk(owner.token, 'clubadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      summary: 'Updated summary',
      admissionPolicy: 'Be kind.',
    });
    const updatedClub = (updated.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(updatedClub.summary, 'Updated summary');
    assert.equal(updatedClub.admissionPolicy, 'Be kind.');

    const err = await h.apiErr(member.token, 'clubadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      summary: 'Admin should not be allowed',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

describe('superadmin.clubs.update', () => {
  it('can move a free club out of the free allowance and raise its cap', async () => {
    const admin = await h.seedSuperadmin('Lifecycle Admin');
    const owner = await h.seedMember('Custom Club Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'custom-cap-club',
      name: 'Custom Cap Club',
      summary: 'Starts free',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = ((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId as string;

    const updated = await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      usesFreeAllowance: false,
      memberCap: 20,
    });
    const club = (updated.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(club.usesFreeAllowance, false);
    assert.equal(club.memberCap, 20);
  });
});

describe('member cap enforcement', () => {
  it('free clubs cap total active members at five, including the owner', async () => {
    const owner = await h.seedMember('Capacity Owner');
    const admin = await h.seedSuperadmin('Capacity Admin');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: 'capacity-club',
      name: 'Capacity Club',
      summary: 'Cap enforcement',
      admissionPolicy: 'Tell us what you build and link one recent project.',
    });
    const clubId = ((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId as string;

    for (let index = 0; index < 4; index += 1) {
      const member = await h.seedMember(`Capacity Member ${index}`);
      await h.apiOk(admin.token, 'superadmin.memberships.create', {
        clubId,
        memberId: member.id,
        initialStatus: 'active',
      });
    }

    const extraMember = await h.seedMember('Capacity Overflow');
    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clubId,
      memberId: extraMember.id,
      initialStatus: 'active',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'member_cap_reached');
  });
});

describe('removed clubs', () => {
  it('requires archive before physical removal', async () => {
    const admin = await h.seedSuperadmin('Removal Admin');
    const owner = await h.seedOwner('remove-needs-archive', 'Remove Needs Archive');

    const err = await h.apiErr(admin.token, 'superadmin.clubs.remove', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      confirmSlug: owner.club.slug,
      reason: 'Attempted early removal',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'remove_requires_archived');
  });

  it('removes an archived club, lists the archive, and restores it live', async () => {
    const admin = await h.seedSuperadmin('Restore Admin');
    const owner = await h.seedOwner('restore-club', 'Restore Club');

    await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: owner.club.id });

    const removed = await h.apiOk(admin.token, 'superadmin.clubs.remove', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      confirmSlug: owner.club.slug,
      reason: 'Lifecycle integration test',
    });
    const removedClub = (removed.data as Record<string, unknown>).removedClub as Record<string, unknown>;
    assert.equal(removedClub.clubId, owner.club.id);
    assert.equal(removedClub.clubSlug, owner.club.slug);
    assert.equal(removedClub.isExpired, false);

    const afterRemoval = await h.apiOk(owner.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(afterRemoval).some((membership) => membership.clubId === owner.club.id),
      false,
      'owner should lose the club membership after physical removal',
    );

    const listed = await h.apiOk(admin.token, 'superadmin.removedClubs.list', { limit: 20 });
    const listedResults = (listed.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const archiveEntry = listedResults.find((entry) => entry.clubId === owner.club.id);
    assert.ok(archiveEntry, 'removed club should appear in removedClubs.list');
    assert.equal(archiveEntry?.isExpired, false);

    const restored = await h.apiOk(admin.token, 'superadmin.removedClubs.restore', {
      clientKey: randomUUID(),
      archiveId: String(archiveEntry?.archiveId),
    });
    const restoredClub = (restored.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.equal(restoredClub.clubId, owner.club.id);
    assert.equal(restoredClub.archivedAt, null, 'restored club should come back live');

    const afterRestore = await h.apiOk(owner.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(afterRestore).some((membership) => membership.clubId === owner.club.id),
      true,
      'owner should regain access after restore',
    );
  });
});
