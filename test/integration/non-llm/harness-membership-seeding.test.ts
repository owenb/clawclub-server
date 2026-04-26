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

test('seedApplication keeps pre-acceptance applicants out of access views and profile versions', async () => {
  const h = await TestHarness.start();
  try {
    const owner = await h.seedOwner('harness-seed-pending', 'Harness Seed Pending');
    const pending = await h.seedMember('Pending Member', 'pending@example.com');
    const application = await h.seedApplication(owner.club.id, pending.id, {
      phase: 'awaiting_review',
      submissionPath: 'cold',
      draftName: 'Pending Member',
      draftSocials: '@pending',
      draftApplication: 'I would like to join this club.',
    });

    const error = await h.apiErr(pending.token, 'members.list', {
      clubId: owner.club.id,
      limit: 10,
    });
    assert.equal(error.status, 403);
    assert.equal(error.code, 'forbidden_scope');

    const accessibleRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from accessible_club_memberships
       where member_id = $1 and club_id = $2`,
      [pending.id, owner.club.id],
    );
    assert.equal(Number(accessibleRows[0]?.count ?? 0), 0);

    const profileRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from member_club_profile_versions
       where member_id = $1 and club_id = $2`,
      [pending.id, owner.club.id],
    );
    assert.equal(Number(profileRows[0]?.count ?? 0), 0);

    const applicationRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from club_applications
       where id = $1`,
      [application.id],
    );
    assert.equal(Number(applicationRows[0]?.count ?? 0), 1);
  } finally {
    await h.stop();
  }
});
