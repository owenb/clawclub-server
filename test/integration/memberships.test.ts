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
    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
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
    const transitionBody = await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
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

    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
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
    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
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

    const listBody = await h.apiOk(owner.token, 'clubadmin.memberships.list', {
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
    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'invited',
    });

    const reviewBody = await h.apiOk(owner.token, 'clubadmin.memberships.review', {
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

// ── Billing state tests ─────────────────────────────────────────────────────

describe('payment_pending member has no access', () => {
  it('creating a membership with payment_pending does not grant access', async () => {
    const owner = await h.seedOwner('pay-pending-club', 'PayPending Club');
    const member = await h.seedMember('Pending Pam', 'pending-pam');

    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });

    const created = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((created.state as Record<string, unknown>).status, 'payment_pending');

    const session = await h.apiOk(member.token, 'session.describe', {});
    const hasClub = activeMemberships(session).some((m) => m.clubId === owner.club.id);
    assert.equal(hasClub, false, 'payment_pending member should not see club');
  });
});

describe('banned member loses access', () => {
  it('transitioning to banned revokes access', async () => {
    const owner = await h.seedOwner('ban-club', 'Ban Club');
    const member = await h.seedClubMember(owner.club.id, 'Banned Bob', 'banned-bob', {
      sponsorId: owner.id,
    });

    // Confirm access before ban
    const before = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(before).some((m) => m.clubId === owner.club.id),
      true, 'member should have access before ban',
    );

    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
      membershipId: member.membership.id,
      status: 'banned',
      reason: 'lost dispute',
    });

    const after = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(after).some((m) => m.clubId === owner.club.id),
      false, 'banned member should not see club',
    );
  });
});

describe('expired member has no access', () => {
  it('transitioning to expired revokes access', async () => {
    const owner = await h.seedOwner('expire-club', 'Expire Club');
    const member = await h.seedClubMember(owner.club.id, 'Expired Eve', 'expired-eve', {
      sponsorId: owner.id,
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
      membershipId: member.membership.id,
      status: 'expired',
      reason: 'period ended',
    });

    const session = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false, 'expired member should not see club',
    );
  });
});

describe('is_comped grants access without subscription', () => {
  it('comped member has access via is_comped flag, not a subscription row', async () => {
    const owner = await h.seedOwner('comp-club', 'Comp Club');
    const member = await h.seedClubMember(owner.club.id, 'Comped Carl', 'comped-carl', {
      sponsorId: owner.id,
    });

    // Verify access
    const session = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true, 'comped member should see club',
    );

    // Verify no subscription row exists (comp is via flag, not subscription)
    const subs = await h.sql<{ count: string }>(
      `SELECT count(*)::text as count FROM app.subscriptions WHERE membership_id = $1`,
      [member.membership.id],
    );
    assert.equal(subs[0]!.count, '0', 'comped member should have no subscription rows');
  });
});

describe('renewal_pending grants grace period access', () => {
  it('member in renewal_pending state retains access', async () => {
    const owner = await h.seedOwner('renewal-club', 'Renewal Club');
    const member = await h.seedClubMember(owner.club.id, 'Renewing Rita', 'renewing-rita', {
      sponsorId: owner.id,
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
      membershipId: member.membership.id,
      status: 'renewal_pending',
      reason: 'payment failed',
    });

    const session = await h.apiOk(member.token, 'session.describe', {});
    const membership = activeMemberships(session).find((m) => m.clubId === owner.club.id);
    assert.ok(membership, 'renewal_pending member should still see club during grace period');
    assert.equal(membership.status, 'renewal_pending');
  });
});

// ── Subscription edge cases ─────────────────────────────────────────────────

describe('trialing subscription grants access', () => {
  it('member with trialing subscription can access the club', async () => {
    const owner = await h.seedOwner('trial-club', 'Trial Club');
    const member = await h.seedMember('Trial Tina', 'trial-tina');

    // Create membership without auto-comp (use payment_pending, then manually set up)
    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'active',
    });
    const msRows = await h.sql<{ id: string }>(
      `SELECT id FROM app.memberships WHERE club_id = $1 AND member_id = $2`,
      [owner.club.id, member.id],
    );
    const msId = msRows[0]!.id;

    // Remove the auto-comp and add a trialing subscription instead
    await h.sql(`UPDATE app.memberships SET is_comped = false WHERE id = $1`, [msId]);
    await h.sql(
      `INSERT INTO app.subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
       VALUES ($1, $2, 'trialing', 29, now() + interval '30 days')`,
      [msId, member.id],
    );

    const session = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true, 'trialing subscription should grant access',
    );
  });
});

describe('ended_at revokes access even if current_period_end is future', () => {
  it('subscription with ended_at in the past does not grant access', async () => {
    const owner = await h.seedOwner('ended-club', 'Ended Club');
    const member = await h.seedMember('Ended Ed', 'ended-ed');

    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'active',
    });
    const msRows = await h.sql<{ id: string }>(
      `SELECT id FROM app.memberships WHERE club_id = $1 AND member_id = $2`,
      [owner.club.id, member.id],
    );
    const msId = msRows[0]!.id;

    // Remove auto-comp, add a subscription that ended early but has future period_end
    await h.sql(`UPDATE app.memberships SET is_comped = false WHERE id = $1`, [msId]);
    await h.sql(
      `INSERT INTO app.subscriptions (membership_id, payer_member_id, status, amount, current_period_end, ended_at)
       VALUES ($1, $2, 'active', 29, now() + interval '60 days', now() - interval '1 hour')`,
      [msId, member.id],
    );

    const session = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false, 'ended subscription should not grant access even with future period_end',
    );
  });
});

describe('reactivating member with past_due subscription does not auto-comp', () => {
  it('admin transition to active recognizes past_due as live access', async () => {
    const owner = await h.seedOwner('pastdue-club', 'PastDue Club');
    const member = await h.seedMember('PastDue Pete', 'pastdue-pete');

    // Create with payment_pending (no auto-comp)
    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });
    const msId = ((createBody.data as Record<string, unknown>).membership as Record<string, unknown>).membershipId as string;

    // Manually add a past_due subscription (simulating Stripe sync)
    await h.sql(
      `INSERT INTO app.subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
       VALUES ($1, $2, 'past_due', 29, now() + interval '30 days')`,
      [msId, member.id],
    );

    // Admin transitions to active
    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
      membershipId: msId,
      status: 'active',
    });

    // Member should NOT be comped — they have a live (past_due) subscription
    const compRows = await h.sql<{ is_comped: boolean }>(
      `SELECT is_comped FROM app.memberships WHERE id = $1`,
      [msId],
    );
    assert.equal(compRows[0]!.is_comped, false, 'member with past_due subscription should not be auto-comped');

    // But member should have access (via subscription)
    const session = await h.apiOk(member.token, 'session.describe', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true, 'member with past_due subscription should have access after reactivation',
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

    const err = await h.apiErr(regularMember.token, 'clubadmin.memberships.list', {
      clubId: owner.club.id,
    });

    assert.equal(err.status, 403, 'Should get 403 for non-owner calling memberships.list');
    assert.equal(err.code, 'forbidden');
  });
});
