import test from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

test('seedClubMembership creates an access-granting member without manual subscription setup', async () => {
  const h = await TestHarness.start();
  try {
    const owner = await h.seedOwner('harness-seed-active', 'Harness Seed Active');
    const member = await h.seedCompedMember(owner.club.id, 'Access Member');

    const body = await h.apiOk(member.token, 'members.list', {
      clubId: owner.club.id,
      limit: 10,
    });

    const results = (((body.data as Record<string, unknown>).results) ?? []) as Array<Record<string, unknown>>;
    assert.ok(results.length >= 1);

    const accessibleRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from accessible_club_memberships
       where id = $1`,
      [member.membership.id],
    );
    assert.equal(Number(accessibleRows[0]?.count ?? 0), 1);
  } finally {
    await h.stop();
  }
});

test('seedPendingMembership keeps pre-acceptance members out of access views and profile versions', async () => {
  const h = await TestHarness.start();
  try {
    const owner = await h.seedOwner('harness-seed-pending', 'Harness Seed Pending');
    const pending = await h.seedPendingMember(owner.club.id, 'Pending Member', {
      status: 'applying',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'pending@example.com',
      applicationName: 'Pending Member',
    });

    const error = await h.apiErr(pending.token, 'members.list', {
      clubId: owner.club.id,
      limit: 10,
    });
    assert.equal(error.status, 403);
    assert.equal(error.code, 'forbidden');

    const accessibleRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from accessible_club_memberships
       where id = $1`,
      [pending.membership.id],
    );
    assert.equal(Number(accessibleRows[0]?.count ?? 0), 0);

    const profileRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from member_club_profile_versions
       where membership_id = $1`,
      [pending.membership.id],
    );
    assert.equal(Number(profileRows[0]?.count ?? 0), 0);
  } finally {
    await h.stop();
  }
});
