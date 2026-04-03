import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getHarness } from './setup.ts';
import type { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await getHarness();
}, { timeout: 30_000 });

// ── helpers ──────────────────────────────────────────────────────────────────

function activeMemberships(sessionBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const actor = sessionBody.actor as Record<string, unknown>;
  return (actor.activeMemberships ?? []) as Array<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('membership lifecycle: invited → active → access', () => {
  it('invited member has no access; transitioning to active grants it', async () => {
    const owner = await h.seedOwner('lifecycle-club', 'Lifecycle Club');
    const member = await h.seedMember('Alice Invited', 'alice-invited');

    // Owner creates membership with initialStatus 'invited'
    const createBody = await h.apiOk(owner.token, 'memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'invited',
    });

    const created = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal(created.membershipId !== undefined, true, 'membershipId should be present');
    assert.equal((created.state as Record<string, unknown>).status, 'invited');

    // Invited member should NOT see the club in session.describe
    const sessionBefore = await h.apiOk(member.token, 'session.describe', {});
    const membershipsBefore = activeMemberships(sessionBefore);
    const hasClubBefore = membershipsBefore.some((m) => m.clubId === owner.club.id);
    assert.equal(hasClubBefore, false, 'invited member should not see club in activeMemberships');

    // Owner transitions to 'active'
    const transitionBody = await h.apiOk(owner.token, 'memberships.transition', {
      membershipId: created.membershipId,
      status: 'active',
      reason: 'welcome aboard',
    });

    const transitioned = (transitionBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((transitioned.state as Record<string, unknown>).status, 'active');

    // Member should now see the club
    const sessionAfter = await h.apiOk(member.token, 'session.describe', {});
    const membershipsAfter = activeMemberships(sessionAfter);
    const hasClubAfter = membershipsAfter.some((m) => m.clubId === owner.club.id);
    assert.equal(hasClubAfter, true, 'active member should see club in activeMemberships');

    // Active member can use member actions (entities.list)
    const entitiesBody = await h.apiOk(member.token, 'entities.list', { clubId: owner.club.id });
    const entitiesData = entitiesBody.data as Record<string, unknown>;
    assert.ok(Array.isArray(entitiesData.results), 'entities.list should return results array');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('membership create with active status gives immediate access', () => {
  it('member sees club immediately when created with initialStatus active', async () => {
    const owner = await h.seedOwner('immediate-club', 'Immediate Club');
    const member = await h.seedMember('Bob Active', 'bob-active');

    await h.apiOk(owner.token, 'memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'active',
    });

    const sessionBody = await h.apiOk(member.token, 'session.describe', {});
    const memberships = activeMemberships(sessionBody);
    const hasClub = memberships.some((m) => m.clubId === owner.club.id);
    assert.equal(hasClub, true, 'member should immediately see club after active creation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pausing/removing a membership revokes access', () => {
  it('paused member loses the club from session.describe', async () => {
    const owner = await h.seedOwner('pause-club', 'Pause Club');
    const clubMember = await h.seedClubMember(owner.club.id, 'Carol Paused', 'carol-paused', {
      sponsorId: owner.id,
    });

    // Confirm access before pause
    const sessionBefore = await h.apiOk(clubMember.token, 'session.describe', {});
    const hasBefore = activeMemberships(sessionBefore).some((m) => m.clubId === owner.club.id);
    assert.equal(hasBefore, true, 'active member should see club before pause');

    // Owner pauses the membership
    await h.apiOk(owner.token, 'memberships.transition', {
      membershipId: clubMember.membership.id,
      status: 'paused',
      reason: 'temporary pause',
    });

    // Member should no longer see the club
    const sessionAfter = await h.apiOk(clubMember.token, 'session.describe', {});
    const hasAfter = activeMemberships(sessionAfter).some((m) => m.clubId === owner.club.id);
    assert.equal(hasAfter, false, 'paused member should not see club in activeMemberships');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('memberships.list and memberships.review work for owners', () => {
  it('owner can list memberships for their club', async () => {
    const owner = await h.seedOwner('list-club', 'List Club');
    await h.seedClubMember(owner.club.id, 'Dave List', 'dave-list', { sponsorId: owner.id });
    await h.seedClubMember(owner.club.id, 'Eve List', 'eve-list', { sponsorId: owner.id });

    const listBody = await h.apiOk(owner.token, 'memberships.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const listData = listBody.data as Record<string, unknown>;
    const results = listData.results as Array<Record<string, unknown>>;

    // Owner + 2 members = at least 3 memberships
    assert.ok(results.length >= 3, `Expected at least 3 memberships, got ${results.length}`);
    const memberIds = results.map((r) => r.member as Record<string, unknown>).map((m) => m.memberId);
    assert.ok(memberIds.includes(owner.id), 'Owner should appear in memberships list');
  });

  it('owner can review pending memberships for their club', async () => {
    const owner = await h.seedOwner('review-club', 'Review Club');
    const member = await h.seedMember('Frank Review', 'frank-review');

    // Create an invited membership so it shows up in review
    await h.apiOk(owner.token, 'memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'invited',
    });

    const reviewBody = await h.apiOk(owner.token, 'memberships.review', {
      clubId: owner.club.id,
      statuses: ['invited'],
    });
    const reviewData = reviewBody.data as Record<string, unknown>;
    const results = reviewData.results as Array<Record<string, unknown>>;

    assert.ok(results.length >= 1, 'Should have at least one invited membership');
    const memberSummaries = results.map((r) => r.member as Record<string, unknown>);
    assert.ok(
      memberSummaries.some((m) => m.memberId === member.id),
      'Invited member should appear in review results',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('non-owner cannot use owner actions', () => {
  it('regular member gets forbidden when calling memberships.list', async () => {
    const owner = await h.seedOwner('auth-club', 'Auth Club');
    const regularMember = await h.seedClubMember(owner.club.id, 'Grace Member', 'grace-member', {
      sponsorId: owner.id,
    });

    const err = await h.apiErr(regularMember.token, 'memberships.list', {
      clubId: owner.club.id,
    });

    assert.equal(err.status, 403, 'Should get 403 for non-owner calling memberships.list');
    assert.equal(err.code, 'forbidden');
  });
});
