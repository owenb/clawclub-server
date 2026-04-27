import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { activeMemberships, getActivity } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('superadmin.memberships.create', () => {
  it('active direct-add gives immediate club access and emits membership.activated activity', async () => {
    const admin = await h.seedSuperadmin('Direct Active Admin');
    const owner = await h.seedOwner('direct-active-club', 'Direct Active Club');
    const member = await h.seedMember('Alice Active');
    const adminCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    const createBody = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });

    const membership = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((membership.version as Record<string, unknown>).status, 'active');
    assert.equal(membership.joinedAt !== null, true);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true,
      'active direct-add should grant access immediately',
    );

    const activity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: adminCursor,
    })).body);
    const activated = activity.results.filter((row) => row.topic === 'membership.activated');
    assert.equal(activated.length, 1);
    assert.equal((activated[0]?.payload as Record<string, unknown>).publicName, member.publicName);
    assert.equal(
      ((activated[0]?.createdByMember ?? {}) as Record<string, unknown>).memberId,
      admin.id,
    );

    const membershipNotification = await h.sql<{
      id: string;
    }>(
      `select id
         from member_notifications
        where club_id = $1
          and recipient_member_id = $2
          and topic = 'membership.activated'
        order by created_at desc
        limit 1`,
      [owner.club.id, member.id],
    );
    const refs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [membershipNotification[0]?.id],
    );
    assert.deepEqual(refs, [
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'membership', ref_id: String(membership.membershipId) },
    ]);
  });

  it('removes clubadmin.memberships.create from the public API', async () => {
    const admin = await h.seedSuperadmin('Direct Add Cap Admin');
    const owner = await h.seedOwner('direct-cap-club', 'Direct Cap Club');
    const member = await h.seedMember('Cap Blocked Direct Add');

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: 'direct-cap-1',
      clubId: owner.club.id,
      usesFreeAllowance: false,
      memberCap: 1,
    });

    const err = await h.apiErr(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'unknown_action');
  });

  it('rejects blocked members until the historical membership is reactivated', async () => {
    const admin = await h.seedSuperadmin('Direct Add Blocked Admin');
    const owner = await h.seedOwner('direct-add-blocked-club', 'Direct Add Blocked Club');
    const member = await h.seedCompedMember(owner.club.id, 'Blocked Direct Add Member');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'removed', reason: 'Removed before direct-add attempt.' },
    });

    const err = await h.apiErr(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'application_blocked');
  });
});

describe('clubadmin.members.get', () => {
  it('uses memberId as the canonical input identifier', async () => {
    const owner = await h.seedOwner('member-get-club', 'Member Get Club');
    const member = await h.seedCompedMember(owner.club.id, 'Member Get Target');

    const result = await h.apiOk(owner.token, 'clubadmin.members.get', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    const data = result.data as { member: { memberId: string } };
    assert.equal(data.member.memberId, member.id);

    const legacy = await h.apiErr(owner.token, 'clubadmin.members.get', {
      clubId: owner.club.id,
      membershipId: member.membership.id,
    });
    assert.equal(legacy.status, 400);
    assert.equal(legacy.code, 'invalid_input');
  });
});

describe('clubadmin.members.update', () => {
  it('removed memberships revoke access and write applicant blocks', async () => {
    const owner = await h.seedOwner('removed-club', 'Removed Club');
    const member = await h.seedCompedMember(owner.club.id, 'Removed Member');
    await h.seedApplication(owner.club.id, member.id, {
      phase: 'active',
      draftName: 'Removed Member',
      draftSocials: '@removed',
      draftApplication: 'Application that led to membership.',
      decidedAt: '2026-04-03T00:00:00Z',
      decidedByMemberId: owner.id,
      activatedMembershipId: member.membership.id,
    });

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'removed', reason: 'Removed for testing.' },
    });

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false,
      'removed memberships must lose access immediately',
    );

    const [block] = await h.sql<{ block_kind: string; reason: string | null }>(
      `select block_kind::text as block_kind, reason
         from club_applicant_blocks
        where club_id = $1 and member_id = $2`,
      [owner.club.id, member.id],
    );
    assert.equal(block?.block_kind, 'removed');
    assert.equal(block?.reason, 'Removed for testing.');

    const [application] = await h.sql<{ phase: string }>(
      `select phase
         from club_applications
        where activated_membership_id = $1`,
      [member.membership.id],
    );
    assert.equal(application?.phase, 'removed');

    const [removed] = await h.sql<{ payload: Record<string, unknown> }>(
      `select payload
         from member_notifications
        where recipient_member_id = $1
          and topic = 'membership.removed'
        order by created_at desc
        limit 1`,
      [member.id],
    );
    assert.ok(removed, 'removed member should receive a membership.removed notification');
    const payload = (removed?.payload ?? {}) as Record<string, unknown>;
    const club = (payload.club ?? {}) as Record<string, unknown>;
    assert.equal(club.clubId, owner.club.id);
    assert.equal(club.slug, owner.club.slug);
    assert.equal(club.name, owner.club.name);

    const removedRefs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select nr.ref_role, nr.ref_kind, nr.ref_id
         from notification_refs nr
         join member_notifications mn on mn.id = nr.notification_id
        where mn.recipient_member_id = $1
          and mn.topic = 'membership.removed'
        order by nr.ref_role, nr.ref_kind, nr.ref_id`,
      [member.id],
    );
    assert.deepEqual(removedRefs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: owner.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'membership', ref_id: member.membership.id },
    ]);
  });

  it('banned memberships revoke access and write permanent applicant blocks', async () => {
    const owner = await h.seedOwner('banned-club', 'Banned Club');
    const member = await h.seedCompedMember(owner.club.id, 'Banned Member');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'banned', reason: 'Banned for testing.' },
    });

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false,
      'banned memberships must lose access immediately',
    );

    const [block] = await h.sql<{ block_kind: string; reason: string | null }>(
      `select block_kind::text as block_kind, reason
         from club_applicant_blocks
        where club_id = $1 and member_id = $2`,
      [owner.club.id, member.id],
    );
    assert.equal(block?.block_kind, 'banned');
    assert.equal(block?.reason, 'Banned for testing.');

    const [banned] = await h.sql<{ payload: Record<string, unknown> }>(
      `select payload
         from member_notifications
        where recipient_member_id = $1
          and topic = 'membership.banned'
        order by created_at desc
        limit 1`,
      [member.id],
    );
    assert.ok(banned, 'banned member should receive a membership.banned notification');
    const payload = (banned?.payload ?? {}) as Record<string, unknown>;
    const club = (payload.club ?? {}) as Record<string, unknown>;
    assert.equal(club.clubId, owner.club.id);
    assert.equal(club.slug, owner.club.slug);
    assert.equal(club.name, owner.club.name);
  });

  it('cancelled memberships revoke the sponsor’s open invitations without writing an applicant block', async () => {
    const owner = await h.seedOwner('cancelled-sponsor-club', 'Cancelled Sponsor Club');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Cancelled Sponsor');
    const invitation = await h.seedInvitation(owner.club.id, sponsor.id, 'cancelled-sponsor-candidate@example.com', {
      candidateName: 'Cancelled Sponsor Candidate',
      reason: 'Open invitation that should be revoked when the sponsor is cancelled.',
    });

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: sponsor.id,
      patch: { status: 'cancelled', reason: 'Pause sponsorship privileges.' },
    });

    const listed = await h.apiOk(sponsor.token, 'invitations.list', {});
    const invitations = ((listed.data as Record<string, unknown>).results ?? []) as Array<Record<string, unknown>>;
    const listedInvitation = invitations.find((row) => row.invitationId === invitation.id);
    assert.ok(listedInvitation, 'cancelled sponsor should still be able to inspect their historical invite record');
    assert.equal(listedInvitation?.status, 'revoked');
    assert.equal(listedInvitation?.quotaState, 'free');

    const [block] = await h.sql<{ block_kind: string }>(
      `select block_kind::text as block_kind
         from club_applicant_blocks
        where club_id = $1
          and member_id = $2
        limit 1`,
      [owner.club.id, sponsor.id],
    );
    assert.equal(block, undefined, 'cancelling a sponsor should not create an applicant block');
  });

  it('rejects role patches on non-active memberships', async () => {
    const owner = await h.seedOwner('role-non-active-club', 'Role Non Active Club');
    const statuses = ['cancelled', 'removed', 'banned'] as const;

    for (const status of statuses) {
      const member = await h.seedCompedMember(owner.club.id, `Role ${status} Target`);
      await h.apiOk(owner.token, 'clubadmin.members.update', {
        clubId: owner.club.id,
        memberId: member.id,
        patch: { status, reason: `Move to ${status} before role patch.` },
      });

      const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
        clubId: owner.club.id,
        memberId: member.id,
        patch: { role: 'clubadmin' },
      });
      assert.equal(err.status, 409);
      assert.equal(err.code, 'invalid_state');
    }
  });

  it('lists removed and banned memberships when explicitly filtered', async () => {
    const owner = await h.seedOwner('member-list-terminal-club', 'Member List Terminal Club');
    const removed = await h.seedCompedMember(owner.club.id, 'Member List Removed');
    const banned = await h.seedCompedMember(owner.club.id, 'Member List Banned');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: removed.id,
      patch: { status: 'removed', reason: 'Testing removed filter.' },
    });
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: banned.id,
      patch: { status: 'banned', reason: 'Testing banned filter.' },
    });

    const listed = await h.apiOk(owner.token, 'clubadmin.members.list', {
      clubId: owner.club.id,
      statuses: ['removed', 'banned'],
      limit: 20,
    });
    const results = (listed.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const byMemberId = new Map(results.map((member) => [member.memberId, member]));

    assert.equal((byMemberId.get(removed.id)?.version as Record<string, unknown>)?.status, 'removed');
    assert.equal((byMemberId.get(banned.id)?.version as Record<string, unknown>)?.status, 'banned');
  });

  it('forbids a non-owner clubadmin from banning the club owner', async () => {
    const owner = await h.seedOwner('owner-ban-guard-club', 'Owner Ban Guard Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Owner Ban Guard Admin');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: admin.id,
      patch: { role: 'clubadmin' },
    });

    const err = await h.apiErr(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'banned', reason: 'Attempted owner ban.' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');

    const [membership] = await h.sql<{ status: string; role: string }>(
      `select status::text as status, role::text as role
         from accessible_club_memberships
        where club_id = $1
          and member_id = $2`,
      [owner.club.id, owner.id],
    );
    assert.equal(membership?.status, 'active');
    assert.equal(membership?.role, 'clubadmin');
  });

  it('forbids a non-owner clubadmin from removing the club owner', async () => {
    const owner = await h.seedOwner('owner-remove-guard-club', 'Owner Remove Guard Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Owner Remove Guard Admin');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: admin.id,
      patch: { role: 'clubadmin' },
    });

    const err = await h.apiErr(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'removed', reason: 'Attempted owner removal.' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('forbids a non-owner clubadmin from cancelling the club owner', async () => {
    const owner = await h.seedOwner('owner-cancel-guard-club', 'Owner Cancel Guard Club');
    const admin = await h.seedCompedMember(owner.club.id, 'Owner Cancel Guard Admin');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: admin.id,
      patch: { role: 'clubadmin' },
    });

    const err = await h.apiErr(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'cancelled', reason: 'Attempted owner cancellation.' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('keeps the self-revoke guard ahead of owner demotion for owner self-ban attempts', async () => {
    const owner = await h.seedOwner('owner-self-ban-club', 'Owner Self Ban Club');

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'banned', reason: 'Self-ban should be rejected.' },
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_role');
  });

  it('still allows the owner to ban a non-owner member', async () => {
    const owner = await h.seedOwner('owner-ban-member-club', 'Owner Ban Member Club');
    const member = await h.seedCompedMember(owner.club.id, 'Owner Ban Target');

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'banned', reason: 'Legitimate ban.' },
    });
    assert.equal((result.data as Record<string, unknown>).changed, true);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false,
      'banned non-owner members must still lose access immediately',
    );
  });

  it('treats active status updates on the owner as a no-op', async () => {
    const owner = await h.seedOwner('owner-active-noop-club', 'Owner Active Noop Club');

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'active' },
    });
    assert.equal((result.data as Record<string, unknown>).changed, false);
  });

  it('rejects reactivating a cancelled membership even when the club is already at capacity', async () => {
    const admin = await h.seedSuperadmin('Membership Reactivation Cap Admin');
    const owner = await h.seedOwner('reactivate-cap-club', 'Reactivate Cap Club');
    const member = await h.seedMember('Reactivation Target');
    const filler = await h.seedMember('Capacity Filler');

    await h.apiOk(admin.token, 'superadmin.clubs.update', {
      clientKey: 'reactivate-cap-1',
      clubId: owner.club.id,
      usesFreeAllowance: false,
      memberCap: 2,
    });

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'cancelled', reason: 'Make room for a replacement.' },
    });

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: filler.id,
      initialStatus: 'active',
    });

    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'active', reason: 'Try to reactivate into a full club.' },
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'invalid_state_transition');
  });

  it('no-op active status updates do not emit membership.activated again', async () => {
    const admin = await h.seedSuperadmin('Membership Noop Admin');
    const owner = await h.seedOwner('membership-noop-club', 'Membership Noop Club');
    const member = await h.seedMember('Noop Membership');

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });

    const adminCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    const result = await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'active' },
    });
    assert.equal((result.data as Record<string, unknown>).changed, false);

    const activity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: adminCursor,
    })).body);
    assert.equal(
      activity.results.some((row) => row.topic === 'membership.activated'),
      false,
    );
  });

  it('rejects reactivating a cancelled membership and emits no second membership.activated row', async () => {
    const admin = await h.seedSuperadmin('Membership Reactivate Admin');
    const owner = await h.seedOwner('membership-reactivate-club', 'Membership Reactivate Club');
    const member = await h.seedMember('Reactivate Membership');
    const adminCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'cancelled', reason: 'Pause membership.' },
    });
    const err = await h.apiErr(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'active', reason: 'Restore membership.' },
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'invalid_state_transition');

    const activity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: adminCursor,
    })).body);
    const activated = activity.results.filter((row) => (
      row.topic === 'membership.activated'
      && ((row.payload as Record<string, unknown>).publicName === member.publicName)
    ));
    assert.equal(activated.length, 1);
    assert.deepEqual(
      activated.map((row) => ((row.createdByMember ?? {}) as Record<string, unknown>).memberId),
      [admin.id],
    );

    const [notificationTotals] = await h.sql<{ total: number }>(
      `select count(*)::int as total
         from member_notifications
        where club_id = $1
          and recipient_member_id = $2
          and topic = 'membership.activated'`,
      [owner.club.id, member.id],
    );
    assert.equal(
      notificationTotals?.total,
      1,
      'failed reactivation should not duplicate the member notification',
    );
  });

  it('lets a superadmin reactivate a removed membership and clears the applicant block', async () => {
    const admin = await h.seedSuperadmin('Membership Removed Reactivate Admin');
    const owner = await h.seedOwner('removed-reactivate-club', 'Removed Reactivate Club');
    const member = await h.seedCompedMember(owner.club.id, 'Removed Reactivate Member');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'removed', reason: 'Remove before superadmin restore.' },
    });

    const restored = await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'active', reason: 'Superadmin restored this membership.' },
    });
    const data = restored.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    const version = membership.version as Record<string, unknown>;
    assert.equal(data.changed, true);
    assert.equal(version.status, 'active');
    assert.equal(version.no, 3);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true,
      'superadmin reactivation should restore access immediately',
    );

    const [block] = await h.sql<{ block_kind: string }>(
      `select block_kind::text as block_kind
         from club_applicant_blocks
        where club_id = $1
          and member_id = $2
        limit 1`,
      [owner.club.id, member.id],
    );
    assert.equal(block, undefined);
  });

  it('closes the owner ban -> transfer -> reactivate lifecycle cleanly', async () => {
    const admin = await h.seedSuperadmin('Owner Lifecycle Superadmin');
    const owner = await h.seedOwner('owner-lifecycle-club', 'Owner Lifecycle Club');
    const successor = await h.seedCompedMember(owner.club.id, 'Owner Lifecycle Successor');

    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: successor.id,
      patch: { role: 'clubadmin' },
    });

    const ownerBanErr = await h.apiErr(successor.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'banned', reason: 'Attempted owner ban.' },
    });
    assert.equal(ownerBanErr.status, 403);
    assert.equal(ownerBanErr.code, 'forbidden_role');

    await h.apiOk(admin.token, 'superadmin.clubs.assignOwner', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      ownerMemberId: successor.id,
    });

    const banned = await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'banned', reason: 'Former owner ban.' },
    });
    assert.equal((banned.data as Record<string, unknown>).changed, true);

    const restored = await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: owner.id,
      patch: { status: 'active', reason: 'Former owner restored.' },
    });
    assert.equal((restored.data as Record<string, unknown>).changed, true);

    const ownerSession = await h.apiOk(owner.token, 'session.getContext', {});
    const restoredMembership = activeMemberships(ownerSession).find((m) => m.clubId === owner.club.id);
    assert.ok(restoredMembership, 'restored former owner should regain access');
    assert.equal(restoredMembership?.role, 'member');

    const ownerHealthRows = await h.sql<{ club_id: string }>(
      `select c.id as club_id
         from clubs c
        where c.id = $1
          and not exists (
            select 1
              from accessible_club_memberships acm
             where acm.club_id = c.id
               and acm.member_id = c.owner_member_id
               and acm.role = 'clubadmin'
          )`,
      [owner.club.id],
    );
    assert.equal(ownerHealthRows.length, 0);
  });
});

describe('clubadmin surfaces stay scoped', () => {
  it('regular members cannot use admin member or application surfaces', async () => {
    const owner = await h.seedOwner('clubadmin-scope-club', 'Clubadmin Scope Club');
    const member = await h.seedCompedMember(owner.club.id, 'Regular Member');

    const membersErr = await h.apiErr(member.token, 'clubadmin.members.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    assert.equal(membersErr.status, 403);
    assert.equal(membersErr.code, 'forbidden_role');

    const applicationsErr = await h.apiErr(member.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    assert.equal(applicationsErr.status, 403);
    assert.equal(applicationsErr.code, 'forbidden_role');
  });

  it('superadmin can direct-add and transition memberships in unrelated clubs', async () => {
    const admin = await h.seedSuperadmin('Membership Superadmin');
    const owner = await h.seedOwner('membership-superadmin-club', 'Membership Superadmin Club');
    const member = await h.seedMember('Remote Managed Member');

    const created = await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });
    await h.apiOk(admin.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: { status: 'removed', reason: 'Superadmin cleanup.' },
    });

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false,
      'superadmin transition should revoke access in the unrelated club too',
    );
  });

  it('superadmin direct-add emits membership.activated activity with the superadmin as creator', async () => {
    const admin = await h.seedSuperadmin('Activity Superadmin');
    const owner = await h.seedOwner('membership-superadmin-activity-club', 'Membership Superadmin Activity Club');
    const member = await h.seedMember('Superadmin Activity Member');
    const ownerCursor = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: 'latest',
    })).body).nextCursor;

    await h.apiOk(admin.token, 'superadmin.memberships.create', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });

    const activity = getActivity((await h.getActivity(owner.token, {
      clubId: owner.club.id,
      after: ownerCursor,
    })).body);
    const activated = activity.results.filter((row) => row.topic === 'membership.activated');
    assert.equal(activated.length, 1);
    assert.equal((activated[0]?.payload as Record<string, unknown>).publicName, member.publicName);
    assert.equal(
      ((activated[0]?.createdByMember ?? {}) as Record<string, unknown>).memberId,
      admin.id,
    );
  });
});
