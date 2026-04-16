import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { activeMemberships } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('clubadmin.memberships.create direct-adds active members', () => {
  it('active direct-add gives immediate club access', async () => {
    const owner = await h.seedOwner('direct-active-club', 'Direct Active Club');
    const member = await h.seedMember('Alice Active');

    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'active',
    });

    const membership = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((membership.state as Record<string, unknown>).status, 'active');
    assert.equal(membership.joinedAt !== null, true);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      true,
      'active direct-add should grant access immediately',
    );
  });

  it('payment_pending direct-add does not grant access', async () => {
    const owner = await h.seedOwner('direct-payment-pending', 'Direct Payment Pending');
    const member = await h.seedMember('Pam Pending');

    const createBody = await h.apiOk(owner.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: member.id,
      initialStatus: 'payment_pending',
    });

    const membership = (createBody.data as Record<string, unknown>).membership as Record<string, unknown>;
    assert.equal((membership.state as Record<string, unknown>).status, 'payment_pending');
    assert.equal(membership.joinedAt, null);

    const session = await h.apiOk(member.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(session).some((m) => m.clubId === owner.club.id),
      false,
      'payment_pending direct-add should not grant club access',
    );
  });
});

describe('clubadmin.applications.*', () => {
  it('applications.list returns only in-flight applications by default', async () => {
    const owner = await h.seedOwner('applications-list-club', 'Applications List Club');
    const applying = await h.seedPendingMember(owner.club.id, 'Applying Annie', {
      status: 'applying',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'applying@example.com',
      applicationName: 'Applying Annie',
    });
    const submitted = await h.seedPendingMember(owner.club.id, 'Submitted Sam', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'submitted@example.com',
      applicationName: 'Submitted Sam',
      applicationText: 'I want to help.',
      applicationSocials: '@submitted',
    });
    const interviewed = await h.seedPendingMember(owner.club.id, 'Interview Ira', {
      status: 'interview_scheduled',
      submissionPath: 'cross_apply',
      proofKind: 'pow',
      applicationEmail: 'ira@example.com',
      applicationName: 'Interview Ira',
      applicationText: 'Already active elsewhere.',
      applicationSocials: '@ira',
    });
    const active = await h.seedCompedMember(owner.club.id, 'Already Active');
    await h.seedPendingMember(owner.club.id, 'Declined Deb', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'declined@example.com',
      applicationName: 'Declined Deb',
    }).then(async ({ membership }) => {
      await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
        clubId: owner.club.id,
        membershipId: membership.id,
        status: 'declined',
        reason: 'not a fit',
      });
    });

    const body = await h.apiOk(owner.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const data = body.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    const memberIds = results.map((result) => result.memberId);

    assert.ok(memberIds.includes(applying.id));
    assert.ok(memberIds.includes(submitted.id));
    assert.ok(memberIds.includes(interviewed.id));
    assert.ok(!memberIds.includes(active.id));
    assert.equal((data.clubScope as Array<Record<string, unknown>>)[0]?.clubId, owner.club.id);
    assert.equal(data.statuses, null);
  });

  it('applications.list rejects member-status filters with sibling-action guidance', async () => {
    const owner = await h.seedOwner('applications-list-invalid', 'Applications List Invalid');

    const err = await h.apiErr(owner.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
      statuses: ['active'],
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /clubadmin\.members\.list/);
  });

  it('applications.get returns rich application and club context', async () => {
    const owner = await h.seedOwner('applications-get-club', 'Applications Get Club');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'gail@example.com', {
      candidateName: 'Get Gail',
      reason: 'Trusted operator',
    });
    const applicant = await h.seedPendingMember(owner.club.id, 'Get Gail', {
      status: 'submitted',
      submissionPath: 'invitation',
      proofKind: 'invitation',
      applicationEmail: 'gail@example.com',
      applicationName: 'Get Gail',
      applicationText: 'I build backend systems.',
      applicationSocials: '@getgail',
      sponsorMemberId: owner.id,
      invitationId: invitation.id,
      generatedProfileDraft: {
        tagline: 'Builder of reliable systems',
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      },
    });

    const body = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      membershipId: applicant.membership.id,
    });

    const data = body.data as Record<string, unknown>;
    const application = data.application as Record<string, unknown>;
    const club = data.club as Record<string, unknown>;
    assert.equal((application.state as Record<string, unknown>).status, 'submitted');
    assert.equal(application.submissionPath, 'invitation');
    assert.equal(application.proofKind, 'invitation');
    assert.equal(application.applicationEmail, 'gail@example.com');
    assert.equal(application.applicationText, 'I build backend systems.');
    assert.equal(club.clubId, owner.club.id);
    assert.equal(club.slug, owner.club.slug);
  });
});

describe('clubadmin.members.*', () => {
  it('members.list returns accessible members with inline vouches', async () => {
    const owner = await h.seedOwner('members-list-club', 'Members List Club');
    const admin = await h.seedPaidMember(owner.club.id, 'Admin Ada', { role: 'clubadmin' });
    const member = await h.seedCompedMember(owner.club.id, 'Member Mia');
    const renewing = await h.seedPaidMember(owner.club.id, 'Renewing Rita', { status: 'renewal_pending' });
    await h.seedPendingMember(owner.club.id, 'Pending Pete', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'pending@example.com',
      applicationName: 'Pending Pete',
      applicationText: 'Would like to join.',
      applicationSocials: '@pending',
    });

    await h.sql(
      `insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, created_at)
       values
         ($1, 'vouched_for', $2, $3, 'Great in person', $2, '2026-04-01T10:00:00Z'),
         ($1, 'vouched_for', $4, $3, 'Shows up consistently', $4, '2026-04-01T11:00:00Z')`,
      [owner.club.id, owner.id, member.id, admin.id],
    );

    const body = await h.apiOk(owner.token, 'clubadmin.members.list', {
      clubId: owner.club.id,
      statuses: ['active', 'renewal_pending'],
      roles: ['member'],
      limit: 20,
    });

    const data = body.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    const memberIds = results.map((result) => result.memberId);

    assert.ok(memberIds.includes(member.id));
    assert.ok(memberIds.includes(renewing.id));
    assert.ok(!memberIds.includes(admin.id), 'role filter should exclude clubadmins');

    const memberRow = results.find((result) => result.memberId === member.id);
    const vouches = (memberRow?.vouches as Array<Record<string, unknown>>) ?? [];
    assert.deepEqual(vouches.map((vouch) => vouch.reason), ['Shows up consistently', 'Great in person']);
  });

  it('members.list rejects application-status filters with sibling-action guidance', async () => {
    const owner = await h.seedOwner('members-list-invalid', 'Members List Invalid');

    const err = await h.apiErr(owner.token, 'clubadmin.members.list', {
      clubId: owner.club.id,
      statuses: ['submitted'],
    });

    assert.equal(err.status, 422);
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /clubadmin\.applications\.list/);
  });

  it('members.get returns admin member details', async () => {
    const owner = await h.seedOwner('members-get-club', 'Members Get Club');
    const member = await h.seedCompedMember(owner.club.id, 'Get Mo');

    const body = await h.apiOk(owner.token, 'clubadmin.members.get', {
      clubId: owner.club.id,
      membershipId: member.membership.id,
    });

    const data = body.data as Record<string, unknown>;
    const club = data.club as Record<string, unknown>;
    const adminMember = data.member as Record<string, unknown>;

    assert.equal(club.clubId, owner.club.id);
    assert.equal(adminMember.memberId, member.id);
    assert.equal(adminMember.isComped, true);
    assert.equal((adminMember.state as Record<string, unknown>).status, 'active');
  });
});

describe('members.* public read surface', () => {
  it('members.list returns flattened public member summaries with inline vouches', async () => {
    const owner = await h.seedOwner('public-members-club', 'Public Members Club');
    const member = await h.seedCompedMember(owner.club.id, 'Public Pat');
    const pending = await h.seedPendingMember(owner.club.id, 'Pending Polly', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'pending-polly@example.com',
      applicationName: 'Pending Polly',
    });

    await h.sql(
      `insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id)
       values ($1, 'vouched_for', $2, $3, 'Known for follow-through', $2)`,
      [owner.club.id, owner.id, member.id],
    );

    const body = await h.apiOk(owner.token, 'members.list', {
      clubId: owner.club.id,
      limit: 20,
    });

    const results = ((body.data as Record<string, unknown>).results as Array<Record<string, unknown>>);
    const ids = results.map((result) => result.memberId);
    assert.ok(ids.includes(owner.id));
    assert.ok(ids.includes(member.id));
    assert.equal(ids.includes(pending.id), false);

    const memberRow = results.find((result) => result.memberId === member.id);
    assert.equal(memberRow?.membershipId, member.membership.id);
    assert.deepEqual((memberRow?.vouches as Array<Record<string, unknown>>).map((vouch) => vouch.reason), ['Known for follow-through']);
  });

  it('members.get returns one accessible member and hides applications', async () => {
    const owner = await h.seedOwner('public-member-get', 'Public Member Get');
    const member = await h.seedCompedMember(owner.club.id, 'Visible Vic');
    const pending = await h.seedPendingMember(owner.club.id, 'Hidden Hannah', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'hidden@example.com',
      applicationName: 'Hidden Hannah',
    });

    const ok = await h.apiOk(owner.token, 'members.get', {
      clubId: owner.club.id,
      memberId: member.id,
    });
    assert.equal(((ok.data as Record<string, unknown>).member as Record<string, unknown>).memberId, member.id);

    const err = await h.apiErr(owner.token, 'members.get', {
      clubId: owner.club.id,
      memberId: pending.id,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});

describe('submitted applications can be accepted into active memberships', () => {
  it('owner transitions submitted application to active and access appears', async () => {
    const owner = await h.seedOwner('accept-submitted-club', 'Accept Submitted Club');
    const applicant = await h.seedPendingMember(owner.club.id, 'Accept Ava', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'accept-ava@example.com',
      applicationName: 'Accept Ava',
      applicationText: 'I run community ops.',
      applicationSocials: '@acceptava',
      generatedProfileDraft: {
        tagline: 'Community operator',
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      },
    });

    const before = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(before).some((m) => m.clubId === owner.club.id),
      false,
      'submitted application should not grant access before acceptance',
    );

    const transition = await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membership.id,
      status: 'active',
      reason: 'accepted after review',
    });
    assert.equal((((transition.data as Record<string, unknown>).membership as Record<string, unknown>).state as Record<string, unknown>).status, 'active');

    const after = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(
      activeMemberships(after).some((m) => m.clubId === owner.club.id),
      true,
      'accepted application should grant club access',
    );

    const profileRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from member_club_profile_versions
       where membership_id = $1`,
      [applicant.membership.id],
    );
    assert.equal(Number(profileRows[0]?.count ?? 0), 1, 'acceptance should create the first club profile version');
  });
});

describe('membership state transitions update access correctly', () => {
  it('banned and expired states revoke access', async () => {
    const owner = await h.seedOwner('ban-expire-club', 'Ban Expire Club');
    const banned = await h.seedCompedMember(owner.club.id, 'Banned Bob');
    const expired = await h.seedCompedMember(owner.club.id, 'Expired Eve');

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: banned.membership.id,
      status: 'banned',
      reason: 'moderation',
    });
    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: expired.membership.id,
      status: 'expired',
      reason: 'billing lapsed',
    });

    const bannedSession = await h.apiOk(banned.token, 'session.getContext', {});
    const expiredSession = await h.apiOk(expired.token, 'session.getContext', {});
    assert.equal(activeMemberships(bannedSession).some((m) => m.clubId === owner.club.id), false);
    assert.equal(activeMemberships(expiredSession).some((m) => m.clubId === owner.club.id), false);
  });

  it('comped members and renewal_pending members keep the right access semantics', async () => {
    const owner = await h.seedOwner('comp-renewal-club', 'Comp Renewal Club');
    const comped = await h.seedCompedMember(owner.club.id, 'Comped Carl');
    const renewing = await h.seedPaidMember(owner.club.id, 'Renewing Rita');

    const compedSubs = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from club_subscriptions
       where membership_id = $1`,
      [comped.membership.id],
    );
    assert.equal(Number(compedSubs[0]?.count ?? 0), 0, 'comped access should not require a subscription row');

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: renewing.membership.id,
      status: 'renewal_pending',
      reason: 'payment retry window',
    });

    const compedSession = await h.apiOk(comped.token, 'session.getContext', {});
    const renewingSession = await h.apiOk(renewing.token, 'session.getContext', {});
    assert.equal(activeMemberships(compedSession).some((m) => m.clubId === owner.club.id), true);
    const renewalMembership = activeMemberships(renewingSession).find((m) => m.clubId === owner.club.id);
    assert.ok(renewalMembership, 'renewal_pending should remain accessible during grace period');
    assert.equal(renewalMembership.status, 'renewal_pending');
  });
});

describe('clubadmin read surfaces stay scoped to admins and superadmins', () => {
  it('regular members cannot use admin member or application surfaces', async () => {
    const owner = await h.seedOwner('membership-scope-club', 'Membership Scope Club');
    const regular = await h.seedCompedMember(owner.club.id, 'Regular Riley');

    const membersErr = await h.apiErr(regular.token, 'clubadmin.members.list', {
      clubId: owner.club.id,
    });
    const applicationsErr = await h.apiErr(regular.token, 'clubadmin.applications.list', {
      clubId: owner.club.id,
    });

    assert.equal(membersErr.status, 403);
    assert.equal(membersErr.code, 'forbidden');
    assert.equal(applicationsErr.status, 403);
    assert.equal(applicationsErr.code, 'forbidden');
  });

  it('superadmin can direct-add and transition memberships in unrelated clubs', async () => {
    const admin = await h.seedSuperadmin('SA Memberships');
    const owner = await h.seedOwner('sa-membership-club', 'SA Membership Club');
    const directMember = await h.seedMember('Direct Dana');
    const applicant = await h.seedPendingMember(owner.club.id, 'Pending Pat', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'pending-pat@example.com',
      applicationName: 'Pending Pat',
      applicationText: 'Would like to join.',
      applicationSocials: '@pendingpat',
    });

    const create = await h.apiOk(admin.token, 'clubadmin.memberships.create', {
      clubId: owner.club.id,
      memberId: directMember.id,
      initialStatus: 'active',
    });
    assert.equal((((create.data as Record<string, unknown>).membership as Record<string, unknown>).state as Record<string, unknown>).status, 'active');

    const transition = await h.apiOk(admin.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membership.id,
      status: 'active',
      reason: 'superadmin override',
    });
    assert.equal((((transition.data as Record<string, unknown>).membership as Record<string, unknown>).state as Record<string, unknown>).status, 'active');

    const directSession = await h.apiOk(directMember.token, 'session.getContext', {});
    const applicantSession = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(activeMemberships(directSession).some((m) => m.clubId === owner.club.id), true);
    assert.equal(activeMemberships(applicantSession).some((m) => m.clubId === owner.club.id), true);
  });
});
