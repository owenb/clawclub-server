import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;
let admin: { id: string; publicName: string; token: string };

async function lapseSubscription(membershipId: string): Promise<void> {
  await h.sql(
    `update club_subscriptions
     set status = 'ended',
         ended_at = now(),
         current_period_end = now() - interval '1 second'
     where membership_id = $1
       and status in ('active', 'trialing', 'past_due')`,
    [membershipId],
  );
}

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
  admin = await h.seedSuperadmin('Clubadmin Access Admin');
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('owner auto-comp preserves access without subscriptions', () => {
  it('owner remains admin without a subscription after clubs.create', async () => {
    const owner = await h.seedMember('Owner Auto Comp');

    const clubResult = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: 'owner-auto-comp',
      name: 'Owner Auto Comp Club',
      summary: 'owner auto comp regression',
      ownerMemberId: owner.id,
    });
    const clubId = ((clubResult.data as Record<string, unknown>).club as Record<string, unknown>).clubId as string;

    const stats = await h.apiOk(owner.token, 'clubadmin.clubs.getStatistics', { clubId });
    assert.equal(((stats.data as Record<string, unknown>).stats as Record<string, unknown>).clubId, clubId);

    const rows = await h.sql<{ is_comped: boolean; comped_at: string | null; comped_by_member_id: string | null }>(
      `select is_comped, comped_at::text as comped_at, comped_by_member_id
       from club_memberships
       where club_id = $1 and member_id = $2
       order by joined_at desc, id desc
       limit 1`,
      [clubId, owner.id],
    );

    assert.equal(rows[0]?.is_comped, true);
    assert.ok(rows[0]?.comped_at);
    assert.equal(rows[0]?.comped_by_member_id, null);
  });
});

describe('ownership transfer auto-comps the new owner', () => {
  it('assigned new owner is auto-comped on ownership transfer', async () => {
    const oldOwner = await h.seedOwner('assign-owner-comp', 'Assign Owner Comp Club');
    const newOwner = await h.seedPaidMember(oldOwner.club.id, 'Bob New Owner');

    await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: oldOwner.club.id,
      ownerMemberId: newOwner.id,
    });

    const rows = await h.sql<{ role: string; is_comped: boolean; comped_at: string | null; comped_by_member_id: string | null }>(
      `select role::text as role, is_comped, comped_at::text as comped_at, comped_by_member_id
       from club_memberships
       where id = $1`,
      [newOwner.membership.id],
    );

    assert.equal(rows[0]?.role, 'clubadmin');
    assert.equal(rows[0]?.is_comped, true);
    assert.ok(rows[0]?.comped_at);
    assert.equal(rows[0]?.comped_by_member_id, null);

    const oldOwnerRows = await h.sql<{ is_comped: boolean; comped_at: string | null }>(
      `select is_comped, comped_at::text as comped_at
         from current_club_memberships
        where club_id = $1
          and member_id = $2
          and left_at is null`,
      [oldOwner.club.id, oldOwner.id],
    );
    assert.equal(oldOwnerRows[0]?.is_comped, false);
    assert.equal(oldOwnerRows[0]?.comped_at, null);

    const stats = await h.apiOk(newOwner.token, 'clubadmin.clubs.getStatistics', {
      clubId: oldOwner.club.id,
    });
    assert.equal(((stats.data as Record<string, unknown>).stats as Record<string, unknown>).clubId, oldOwner.club.id);
  });
});

describe('non-owner clubadmin access in the reference implementation', () => {
  it('comped non-owner clubadmin retains access when their subscription lapses', async () => {
    const owner = await h.seedOwner('comped-admin-club', 'Comped Admin Club');
    const member = await h.seedPaidMember(owner.club.id, 'Comped Admin');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { role: 'clubadmin' },
    });

    await h.sql(
      `update club_memberships
       set is_comped = true,
           comped_at = now(),
           comped_by_member_id = $2
       where id = $1`,
      [member.membership.id, owner.id],
    );

    await lapseSubscription(member.membership.id);

    const stats = await h.apiOk(member.token, 'clubadmin.clubs.getStatistics', {
      clubId: owner.club.id,
    });
    assert.equal(((stats.data as Record<string, unknown>).stats as Record<string, unknown>).clubId, owner.club.id);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(activeMemberships(session).some((m) => m.clubId === owner.club.id), true);
  });
});
