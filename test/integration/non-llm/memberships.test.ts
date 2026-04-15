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

    const members = await h.apiOk(member.token, 'members.list', { clubId: owner.club.id, limit: 10 });
    assert.ok(Array.isArray((members.data as Record<string, unknown>).results));
  });
});

describe('clubadmin.memberships.create payment_pending stays non-accessible', () => {
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

describe('clubs.join creates applying memberships without access', () => {
  it('anonymous join returns an applying membership and PoW challenge', async () => {
    const owner = await h.seedOwner('join-applying-club', 'Join Applying Club');

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'joiner@example.com',
    });

    assert.equal(joinBody.action, 'clubs.join');
    const joinData = joinBody.data as Record<string, unknown>;
    assert.equal(typeof joinData.memberToken, 'string');
    assert.equal(joinData.clubId, owner.club.id);
    assert.equal((joinData.proof as Record<string, unknown>).kind, 'pow');
    assert.equal(typeof (joinData.proof as Record<string, unknown>).challengeId, 'string');

    const memberToken = joinData.memberToken as string;
    const membershipId = joinData.membershipId as string;
    const application = await h.apiOk(memberToken, 'clubs.applications.get', { membershipId });
    assert.equal((application.data as any).application.state, 'applying');

    const retryBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'joiner@example.com',
    });

    assert.notEqual((retryBody.data as Record<string, unknown>).membershipId, membershipId);
  });
});

describe('clubadmin.memberships.listForReview defaults to reviewable application states', () => {
  it('includes submitted and interview stages, excludes applying', async () => {
    const owner = await h.seedOwner('review-default-club', 'Review Default Club');
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

    const reviewBody = await h.apiOk(owner.token, 'clubadmin.memberships.listForReview', {
      clubId: owner.club.id,
      limit: 20,
    });
    const results = (reviewBody.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const memberIds = results.map((result) => (result.member as Record<string, unknown>).memberId);

    assert.ok(memberIds.includes(submitted.id), 'submitted application should appear in default review queue');
    assert.ok(memberIds.includes(interviewed.id), 'interview_scheduled application should appear in default review queue');
    assert.ok(!memberIds.includes(applying.id), 'applying membership should not appear in default review queue');
  });
});

describe('clubadmin.memberships.get returns the unified application summary', () => {
  it('surfaces submitted application details for review', async () => {
    const owner = await h.seedOwner('membership-get-club', 'Membership Get Club');
    const applicant = await h.seedPendingMember(owner.club.id, 'Get Gail', {
      status: 'submitted',
      submissionPath: 'invitation',
      proofKind: 'invitation',
      applicationEmail: 'get-gail@example.com',
      applicationName: 'Get Gail',
      applicationText: 'I build backend systems.',
      applicationSocials: '@getgail',
      sponsorMemberId: owner.id,
      invitationId: (await h.seedInvitation(owner.club.id, owner.id, 'get-gail@example.com', {
        candidateName: 'Get Gail',
      })).id,
      generatedProfileDraft: { tagline: 'Builder of reliable systems' },
    });

    const body = await h.apiOk(owner.token, 'clubadmin.memberships.get', {
      clubId: owner.club.id,
      membershipId: applicant.membership.id,
    });

    const data = body.data as Record<string, unknown>;
    const membership = data.membership as Record<string, unknown>;
    const application = data.application as Record<string, unknown> | undefined;
    assert.equal(((membership.state as Record<string, unknown>).status), 'submitted');
    assert.equal(application?.submissionPath, 'invitation');
    assert.equal(application?.proofKind, 'invitation');
    assert.equal(application?.applicationEmail, 'get-gail@example.com');
    assert.equal(application?.applicationText, 'I build backend systems.');
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
      generatedProfileDraft: { tagline: 'Community operator' },
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

describe('review vouches stay attached to the correct application', () => {
  it('listForReview batches vouch loading by applicant and keeps newest-first order', async () => {
    const owner = await h.seedOwner('vouch-review-club', 'Vouch Review Club');
    const applicantA = await h.seedPendingMember(owner.club.id, 'Alice Applicant', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'alice@applicants.example.com',
      applicationName: 'Alice Applicant',
      applicationText: 'Application A',
      applicationSocials: '@alice',
    });
    const applicantB = await h.seedPendingMember(owner.club.id, 'Bob Applicant', {
      status: 'submitted',
      submissionPath: 'cold',
      proofKind: 'pow',
      applicationEmail: 'bob@applicants.example.com',
      applicationName: 'Bob Applicant',
      applicationText: 'Application B',
      applicationSocials: '@bob',
    });
    const voucher1 = await h.seedCompedMember(owner.club.id, 'Voucher One');
    const voucher2 = await h.seedCompedMember(owner.club.id, 'Voucher Two');

    await h.sql(
      `insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, created_at)
       values ($1, 'vouched_for', $2, $3, 'A vouch 1', $2, '2026-04-01T10:00:00Z'),
              ($1, 'vouched_for', $4, $3, 'A vouch 2', $4, '2026-04-01T11:00:00Z'),
              ($1, 'vouched_for', $2, $5, 'B vouch 1', $2, '2026-04-01T09:00:00Z')`,
      [owner.club.id, voucher1.id, applicantA.id, voucher2.id, applicantB.id],
    );

    const reviewBody = await h.apiOk(owner.token, 'clubadmin.memberships.listForReview', {
      clubId: owner.club.id,
      statuses: ['submitted'],
      limit: 20,
    });
    const results = (reviewBody.data as Record<string, unknown>).results as Array<Record<string, unknown>>;

    const reviewA = results.find((result) => ((result.member as Record<string, unknown>).memberId) === applicantA.id);
    const reviewB = results.find((result) => ((result.member as Record<string, unknown>).memberId) === applicantB.id);
    assert.ok(reviewA);
    assert.ok(reviewB);

    const vouchesA = (reviewA!.vouches as Array<Record<string, unknown>>).map((vouch) => vouch.reason);
    const vouchesB = (reviewB!.vouches as Array<Record<string, unknown>>).map((vouch) => vouch.reason);

    assert.deepEqual(vouchesA, ['A vouch 2', 'A vouch 1']);
    assert.deepEqual(vouchesB, ['B vouch 1']);
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

describe('clubadmin membership actions stay scoped to admins and superadmins', () => {
  it('regular members cannot use clubadmin.memberships.list', async () => {
    const owner = await h.seedOwner('membership-scope-club', 'Membership Scope Club');
    const regular = await h.seedCompedMember(owner.club.id, 'Regular Riley');

    const err = await h.apiErr(regular.token, 'clubadmin.memberships.list', {
      clubId: owner.club.id,
    });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
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
