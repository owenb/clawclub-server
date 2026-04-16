/**
 * Integration tests for the billing sync surface (superadmin.billing.*),
 * paid club join flow, billing.getMembershipStatus, and paid-club guards.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';

let h: TestHarness;
let admin: { id: string; publicName: string; token: string };

before(async () => {
  h = await TestHarness.start();
  admin = await h.seedSuperadmin('Billing Admin');
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Paid club join fork ─────────────────────────────────────────────────────

describe('paid club acceptance creates payment_pending membership', () => {
  it('member joining a paid club enters payment_pending, not active', async () => {
    const owner = await h.seedOwner('paid-club', 'Paid Club');

    // Set the club price via billing sync
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 100,
      currency: 'USD',
    });

    // Create a new member and pending paid-club membership
    const member = await h.seedMember('Pay Member');
    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });

    const created = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((created.state as Record<string, unknown>).status, 'payment_pending');

    // Member should NOT have access
    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false, 'payment_pending member should not see club',
    );
  });
});

// ── activateMembership ──────────────────────────────────────────────────────

describe('superadmin.billing.activateMembership creates access', () => {
  it('transitions payment_pending to active with subscription', async () => {
    const owner = await h.seedOwner('activate-club', 'Activate Club');
    const member = await h.seedMember('Activate Al');

    // Set paid price
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 50,
    });

    // Create payment_pending membership
    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });
    const msRows = await h.sql<{ id: string }>(
      `SELECT id FROM club_memberships WHERE club_id = $1 AND member_id = $2`,
      [owner.club.id, member.id],
    );
    const msId = msRows[0]!.id;

    // No access yet
    let session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(activeMemberships(session).some((m) => m.clubId === owner.club.id), false);

    // Activate via billing sync
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString();
    await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId: msId,
      paidThrough: futureDate,
    });

    // Now has access
    session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true, 'activated member should see club',
    );

    // Verify subscription row exists
    const subs = await h.sql<{ status: string; current_period_end: string }>(
      `SELECT status, current_period_end::text FROM club_subscriptions WHERE membership_id = $1`,
      [msId],
    );
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.status, 'active');

    // Idempotent: calling again is a no-op
    await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId: msId,
      paidThrough: futureDate,
    });
  });
});

// ── cancelAtPeriodEnd ───────────────────────────────────────────────────────

describe('superadmin.billing.cancelAtPeriodEnd preserves access', () => {
  it('cancelled member retains access until period end', async () => {
    const owner = await h.seedOwner('cancel-club', 'Cancel Club');
    const member = await h.seedMember('Cancel Cathy');

    // Set price and create paid membership
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 99,
    });
    await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      sponsorMemberId: owner.id,
      initialStatus: 'payment_pending',
    });
    const msRows = await h.sql<{ id: string }>(
      `SELECT id FROM club_memberships WHERE club_id = $1 AND member_id = $2`,
      [owner.club.id, member.id],
    );
    const msId = msRows[0]!.id;

    // Activate
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString();
    await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId: msId,
      paidThrough: futureDate,
    });

    // Cancel at period end
    await h.apiOk(admin.token, 'superadmin.billing.cancelAtPeriodEnd', {
      membershipId: msId,
    });

    // Access should be preserved (subscription still active with future period_end)
    const session = await h.apiOk(member.token, 'session.getContext', {});
    const membership = activeMemberships(session).find((m) => m.clubId === owner.club.id);
    assert.ok(membership, 'cancelled member should retain access until period end');
    assert.equal(membership.status, 'cancelled');

    // Idempotent
    await h.apiOk(admin.token, 'superadmin.billing.cancelAtPeriodEnd', {
      membershipId: msId,
    });
  });
});

// ── expireMembership ────────────────────────────────────────────────────────

describe('superadmin.billing.expireMembership removes access', () => {
  it('expired member loses access', async () => {
    const owner = await h.seedOwner('expire-sync-club', 'ExpireSync Club');
    const member = await h.seedCompedMember(owner.club.id, 'Expire Eric');

    // Confirm access
    let session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(activeMemberships(session).some((m) => m.clubId === owner.club.id), true);

    // Expire
    await h.apiOk(admin.token, 'superadmin.billing.expireMembership', {
      membershipId: member.membership.id,
    });

    // Access revoked
    session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false, 'expired member should not see club',
    );

    // Idempotent
    await h.apiOk(admin.token, 'superadmin.billing.expireMembership', {
      membershipId: member.membership.id,
    });
  });
});

describe('superadmin.billing.banMember preserves terminal memberships', () => {
  it('does not rewrite declined or withdrawn memberships, and appends exactly one banned history row for active memberships', async () => {
    const target = await h.seedMember('Ban Target');
    const declinedClub = await h.seedOwner('ban-declined-club', 'Ban Declined Club');
    const withdrawnClub = await h.seedOwner('ban-withdrawn-club', 'Ban Withdrawn Club');
    const activeClub = await h.seedOwner('ban-active-club', 'Ban Active Club');

    const declined = await h.seedClubMembership(declinedClub.club.id, target.id, {
      status: 'declined',
      reason: 'declined before platform ban',
    });
    const withdrawn = await h.seedClubMembership(withdrawnClub.club.id, target.id, {
      status: 'withdrawn',
      reason: 'withdrew before platform ban',
    });
    const active = await h.seedCompedMembership(activeClub.club.id, target.id);

    const countVersions = async (membershipId: string): Promise<number> => {
      const rows = await h.sql<{ count: string }>(
        `select count(*)::text as count
         from club_membership_state_versions
         where membership_id = $1`,
        [membershipId],
      );
      return Number(rows[0]?.count ?? 0);
    };

    const beforeDeclinedCount = await countVersions(declined.id);
    const beforeWithdrawnCount = await countVersions(withdrawn.id);
    const beforeActiveCount = await countVersions(active.id);

    await h.apiOk(admin.token, 'superadmin.billing.banMember', {
      memberId: target.id,
      reason: 'platform ban for audit-trail regression test',
    });

    const memberRows = await h.sql<{ state: string }>(
      `select state::text as state from members where id = $1`,
      [target.id],
    );
    assert.equal(memberRows[0]?.state, 'banned');

    const statuses = await h.sql<{ id: string; status: string }>(
      `select id, status::text as status
       from current_club_memberships
       where id in ($1, $2, $3)`,
      [declined.id, withdrawn.id, active.id],
    );
    const statusByMembershipId = new Map(statuses.map((row) => [row.id, row.status]));
    assert.equal(statusByMembershipId.get(declined.id), 'declined');
    assert.equal(statusByMembershipId.get(withdrawn.id), 'withdrawn');
    assert.equal(statusByMembershipId.get(active.id), 'banned');

    const afterDeclinedCount = await countVersions(declined.id);
    const afterWithdrawnCount = await countVersions(withdrawn.id);
    const afterActiveCount = await countVersions(active.id);
    assert.equal(afterDeclinedCount, beforeDeclinedCount, 'declined memberships should not gain new history rows');
    assert.equal(afterWithdrawnCount, beforeWithdrawnCount, 'withdrawn memberships should not gain new history rows');
    assert.equal(afterActiveCount, beforeActiveCount + 1, 'active membership should gain exactly one banned history row');

    const activeBannedRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from club_membership_state_versions
       where membership_id = $1
         and status = 'banned'`,
      [active.id],
    );
    assert.equal(Number(activeBannedRows[0]?.count ?? 0), 1, 'active membership should have exactly one banned history row');

    const latestActiveVersion = await h.sql<{ status: string }>(
      `select status::text as status
       from club_membership_state_versions
       where membership_id = $1
       order by version_no desc
       limit 1`,
      [active.id],
    );
    assert.equal(latestActiveVersion[0]?.status, 'banned');
  });
});

// ── setClubPrice idempotency ────────────────────────────────────────────────

describe('superadmin.billing.setClubPrice is idempotent', () => {
  it('setting the same price twice creates only one version', async () => {
    const owner = await h.seedOwner('price-club', 'Price Club');

    // Set price
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 200,
      currency: 'USD',
    });

    // Get version count
    const v1 = await h.sql<{ count: string }>(
      `SELECT count(*)::text as count FROM club_versions WHERE club_id = $1`,
      [owner.club.id],
    );

    // Set same price again
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 200,
      currency: 'USD',
    });

    // Version count should not increase
    const v2 = await h.sql<{ count: string }>(
      `SELECT count(*)::text as count FROM club_versions WHERE club_id = $1`,
      [owner.club.id],
    );
    assert.equal(v1[0]!.count, v2[0]!.count, 'idempotent setClubPrice should not create extra version');

    // Verify price is set
    const club = await h.sql<{ membership_price_amount: string }>(
      `SELECT membership_price_amount::text FROM clubs WHERE id = $1`,
      [owner.club.id],
    );
    assert.equal(club[0]!.membership_price_amount, '200.00');
  });
});

// ── Paid-club guards ────────────────────────────────────────────────────────

describe('paid club guards', () => {
  it('superadmin.clubs.archive is blocked for paid clubs', async () => {
    const owner = await h.seedOwner('guard-archive-club', 'GuardArchive Club');

    // Make it paid
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 50,
    });

    // Try to archive through the normal path
    const err = await h.apiErr(admin.token, 'superadmin.clubs.archive', {
      clubId: owner.club.id,
    });
    assert.equal(err.code, 'paid_club');
  });

  it('superadmin.clubs.assignOwner is blocked for paid clubs', async () => {
    const owner = await h.seedOwner('guard-transfer-club', 'GuardTransfer Club');
    const newOwner = await h.seedMember('New Owner');

    // Make it paid
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 50,
    });

    // Try to transfer
    const err = await h.apiErr(admin.token, 'superadmin.clubs.assignOwner', {
      clubId: owner.club.id,
      ownerMemberId: newOwner.id,
    });
    assert.equal(err.code, 'paid_club');
  });

  it('superadmin.billing.archiveClub bypasses the paid-club guard', async () => {
    const owner = await h.seedOwner('billing-archive-club', 'BillingArchive Club');

    // Make it paid
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 50,
    });

    // Archive through billing path works
    await h.apiOk(admin.token, 'superadmin.billing.archiveClub', {
      clubId: owner.club.id,
    });

    // Verify archived
    const club = await h.sql<{ archived_at: string | null }>(
      `SELECT archived_at::text FROM clubs WHERE id = $1`,
      [owner.club.id],
    );
    assert.ok(club[0]!.archived_at, 'club should be archived');
  });
});

// ── billing.getMembershipStatus ─────────────────────────────────────────────

describe('billing.getMembershipStatus returns membership billing info', () => {
  it('returns comped status for free club member', async () => {
    const owner = await h.seedOwner('status-free-club', 'StatusFree Club');
    const member = await h.seedCompedMember(owner.club.id, 'Status Sam');

    const body = await h.apiOk(member.token, 'billing.getMembershipStatus', {
      clubId: owner.club.id,
    });
    const data = body.data as Record<string, unknown>;
    const ms = data.membership as Record<string, unknown>;
    assert.ok(ms);
    assert.equal(ms.state, 'active');
    assert.equal(ms.isComped, true);
    assert.equal(ms.paidThrough, null);
  });

  it('returns null for non-member', async () => {
    const owner = await h.seedOwner('status-nomember-club', 'StatusNoMember Club');
    const outsider = await h.seedMember('Outsider Ollie');

    // Outsider needs at least one accessible club to authenticate
    const otherOwner = await h.seedOwner('outsider-home', 'Outsider Home');
    await h.seedCompedMembership(otherOwner.club.id, outsider.id);

    const body = await h.apiOk(outsider.token, 'billing.getMembershipStatus', {
      clubId: owner.club.id,
    });
    const data = body.data as Record<string, unknown>;
    assert.equal(data.membership, null);
  });
});

// ── ISO datetime validation ─────────────────────────────────────────────

describe('parseIsoDatetime rejects non-ISO date formats', () => {
  it('rejects ambiguous date strings, accepts strict ISO', async () => {
    // Set up a paid club with a payment_pending membership via the real flow
    const owner = await h.seedOwner('iso-club', 'IsoClub');
    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: owner.club.id,
      amount: 2900,
      currency: 'usd',
    });
    const member = await h.seedMember('Iso Member');
    const membership = await h.seedClubMembership(owner.club.id, member.id, { status: 'payment_pending' });
    const msId = membership.id;

    // Non-ISO formats should be rejected at the parse layer
    for (const badDate of ['March 5, 2027', '12/31/2027', '2027-12-31 23:59:59']) {
      const err = await h.apiErr(admin.token, 'superadmin.billing.activateMembership', {
        membershipId: msId,
        paidThrough: badDate,
      });
      assert.equal(err.code, 'invalid_input', `should reject "${badDate}"`);
    }

    // Valid ISO formats should be accepted
    const goodResult = await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId: msId,
      paidThrough: '2027-12-31T23:59:59Z',
    });
    assert.ok(goodResult.ok);
  });
});
