import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { activeMemberships, getNotifications } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';
import { getRegistry } from '../../../src/schemas/registry.ts';

const COLD_DIFFICULTY_ENV = 'CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY';
const CROSS_DIFFICULTY_ENV = 'CLAWCLUB_TEST_CROSS_APPLICATION_DIFFICULTY';
const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
const TEST_COLD_DIFFICULTY = '2';
const TEST_CROSS_DIFFICULTY = '1';

let h: TestHarness;
let previousColdDifficulty: string | undefined;
let previousCrossDifficulty: string | undefined;
let previousApiKey: string | undefined;
let originalFetch: typeof globalThis.fetch;

function makeOpenAiResponse(text: string): Response {
  return new Response(JSON.stringify({
    id: 'resp_test',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.4-mini',
    output: [{
      type: 'message',
      role: 'assistant',
      id: 'msg_test',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function findNonce(challengeId: string, difficulty: number): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 250_000; nonce += 1) {
    const candidate = String(nonce);
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');
    if (hash.endsWith(zeros)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find trailing-zero nonce for difficulty ${difficulty}`);
}

function actorOnboardingPending(body: Record<string, unknown>): boolean {
  return Boolean((body.actor as Record<string, unknown>).onboardingPending);
}

function actorNotifications(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const actor = body.actor as Record<string, unknown>;
  const sharedContext = actor.sharedContext as Record<string, unknown>;
  return (sharedContext.notifications as Array<Record<string, unknown>> | undefined) ?? [];
}

async function joinAndSubmitApplication(input: {
  token: string | null;
  clubSlug: string;
  email: string;
  invitationCode?: string;
  name: string;
  socials: string;
  application: string;
}): Promise<{ token: string; membershipId: string }> {
  const joinBody = await h.apiOk(input.token, 'clubs.join', {
    clubSlug: input.clubSlug,
    email: input.email,
    ...(input.invitationCode ? { invitationCode: input.invitationCode } : {}),
  });
  const joinData = joinBody.data as Record<string, unknown>;
  const proof = joinData.proof as Record<string, unknown>;
  const membershipId = joinData.membershipId as string;
  const token = (joinData.memberToken as string | null) ?? input.token;
  assert.ok(token, 'join should yield an authenticated token');

  const submitInput: Record<string, unknown> = {
    membershipId,
    name: input.name,
    socials: input.socials,
    application: input.application,
  };
  if (proof.kind === 'pow') {
    submitInput.nonce = findNonce(proof.challengeId as string, proof.difficulty as number);
  }

  const submitBody = await h.apiOk(token, 'clubs.applications.submit', submitInput);
  assert.equal((submitBody.data as Record<string, unknown>).status, 'submitted');

  return { token, membershipId };
}

async function installNotificationFailureTrigger(topic: string): Promise<{ triggerName: string; functionName: string }> {
  const suffix = randomUUID().replace(/-/g, '');
  const functionName = `test_fail_member_notifications_${suffix}`;
  const triggerName = `test_fail_member_notifications_trigger_${suffix}`;
  const topicLiteral = `'${topic.replace(/'/g, "''")}'`;
  await h.sql(
    `create function ${functionName}() returns trigger
       language plpgsql
     as $$
     begin
       if new.topic = ${topicLiteral} then
         raise exception 'forced member_notifications failure for %', new.topic;
       end if;
       return new;
     end;
     $$`,
  );
  await h.sql(
    `create trigger ${triggerName}
       before insert on member_notifications
       for each row
       execute function ${functionName}()`,
  );
  return { triggerName, functionName };
}

async function dropNotificationFailureTrigger(input: { triggerName: string; functionName: string }): Promise<void> {
  await h.sql(`drop trigger if exists ${input.triggerName} on member_notifications`);
  await h.sql(`drop function if exists ${input.functionName}()`);
}

before(async () => {
  previousColdDifficulty = process.env[COLD_DIFFICULTY_ENV];
  previousCrossDifficulty = process.env[CROSS_DIFFICULTY_ENV];
  previousApiKey = process.env[OPENAI_API_KEY_ENV];
  process.env[COLD_DIFFICULTY_ENV] = TEST_COLD_DIFFICULTY;
  process.env[CROSS_DIFFICULTY_ENV] = TEST_CROSS_DIFFICULTY;
  process.env[OPENAI_API_KEY_ENV] = 'test-openai-key';

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      text?: { format?: { type?: string } };
    };
    const text = body.text?.format?.type === 'json_schema'
      ? JSON.stringify({
          tagline: null,
          summary: 'Generated from application',
          whatIDo: null,
          knownFor: null,
          servicesSummary: null,
          websiteUrl: null,
          links: [],
        })
      : 'PASS';
    return makeOpenAiResponse(text);
  };
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
  globalThis.fetch = originalFetch;
  if (previousColdDifficulty === undefined) {
    delete process.env[COLD_DIFFICULTY_ENV];
  } else {
    process.env[COLD_DIFFICULTY_ENV] = previousColdDifficulty;
  }
  if (previousCrossDifficulty === undefined) {
    delete process.env[CROSS_DIFFICULTY_ENV];
  } else {
    process.env[CROSS_DIFFICULTY_ENV] = previousCrossDifficulty;
  }
  if (previousApiKey === undefined) {
    delete process.env[OPENAI_API_KEY_ENV];
  } else {
    process.env[OPENAI_API_KEY_ENV] = previousApiKey;
  }
}, { timeout: 15_000 });

describe('onboarding ceremony gate', () => {
  it('gates every non-allowlisted action for admitted-but-unonboarded members', async () => {
    const owner = await h.seedOwner('onboarding-gate-club', 'Onboarding Gate Club');
    const applicant = await joinAndSubmitApplication({
      token: null,
      clubSlug: owner.club.slug,
      email: 'gate-applicant@example.com',
      name: 'Gate Applicant',
      socials: '@gate-applicant',
      application: 'I help run healthy communities.',
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membershipId,
      status: 'active',
      reason: 'accepted after review',
    });

    const sessionBefore = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(actorOnboardingPending(sessionBefore), true);
    assert.equal(activeMemberships(sessionBefore).length, 1);

    const allowlisted = new Set(['session.getContext', 'clubs.onboard']);
    for (const [action, def] of getRegistry()) {
      if (allowlisted.has(action) || def.auth === 'none') {
        continue;
      }

      const err = await h.apiErr(applicant.token, action, {});
      assert.equal(err.status, 403, `${action} should be blocked until onboarding completes`);
      assert.equal(err.code, 'onboarding_required', `${action} should fail with onboarding_required`);
      assert.match(err.message, /clubs\.onboard/, `${action} error should direct the agent to clubs.onboard`);
    }

    const onboardBody = await h.apiOk(applicant.token, 'clubs.onboard', {});
    const onboardData = onboardBody.data as Record<string, unknown>;
    assert.equal(onboardData.alreadyOnboarded, false);
    assert.equal(actorOnboardingPending(onboardBody), false);
    assert.match(String(((onboardData.welcome as Record<string, unknown>).greeting)), /Welcome to Onboarding Gate Club/);

    const tokens = await h.apiOk(applicant.token, 'accessTokens.list', {});
    assert.ok(Array.isArray(((tokens.data as Record<string, unknown>).tokens)), 'non-allowlisted actions should work after onboarding');
  });

  it('does not gate pre-admission bearer holders from clubs.join and keeps onboardingPending false', async () => {
    const owner = await h.seedOwner('pre-admission-club', 'Pre Admission Club');

    const joinBody = await h.apiOk(null, 'clubs.join', {
      clubSlug: owner.club.slug,
      email: 'pre-admission@example.com',
    });
    const joinData = joinBody.data as Record<string, unknown>;
    const token = joinData.memberToken as string;
    const proof = joinData.proof as Record<string, unknown>;
    const membershipId = joinData.membershipId as string;

    const session = await h.apiOk(token, 'session.getContext', {});
    assert.equal(actorOnboardingPending(session), false);
    assert.equal(activeMemberships(session).length, 0);

    const submitBody = await h.apiOk(token, 'clubs.applications.submit', {
      membershipId,
      nonce: proof.kind === 'pow' ? findNonce(proof.challengeId as string, proof.difficulty as number) : undefined,
      name: 'Pre Admission Person',
      socials: '@preadmission',
      application: 'I am still applying and must not be blocked by onboarding.',
    });
    assert.equal((submitBody.data as Record<string, unknown>).status, 'submitted');
  });

  it('clubs.onboard is idempotent and preserves the original onboarded_at timestamp', async () => {
    const owner = await h.seedOwner('onboarding-idempotent', 'Onboarding Idempotent');
    const applicant = await joinAndSubmitApplication({
      token: null,
      clubSlug: owner.club.slug,
      email: 'idempotent@example.com',
      name: 'Idempotent Ida',
      socials: '@idempotentida',
      application: 'I will read the welcome carefully.',
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membershipId,
      status: 'active',
      reason: 'accepted after review',
    });

    const first = await h.apiOk(applicant.token, 'clubs.onboard', {});
    const [firstRow] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members
       where id = (
         select member_id from club_memberships where id = $1
       )`,
      [applicant.membershipId],
    );
    assert.equal((first.data as Record<string, unknown>).alreadyOnboarded, false);
    assert.ok(firstRow?.onboarded_at);

    const second = await h.apiOk(applicant.token, 'clubs.onboard', {});
    const [secondRow] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members
       where id = (
         select member_id from club_memberships where id = $1
       )`,
      [applicant.membershipId],
    );

    assert.deepEqual(second.data, { alreadyOnboarded: true });
    assert.equal(secondRow?.onboarded_at, firstRow?.onboarded_at);
  });
});

describe('onboarding ceremony notification fanout', () => {
  it('fires invitation.accepted and membership.activated for invited cross-joins and both topics are acknowledgeable', async () => {
    const sourceOwner = await h.seedOwner('fanout-source-club', 'Fanout Source Club');
    const targetOwner = await h.seedOwner('fanout-target-club', 'Fanout Target Club');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Cross Join Casey');
    const invitation = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Cross Join Casey',
      candidateEmail: 'cross-join@example.com',
      reason: 'Trusted across clubs',
    });
    const invitationCode = (invitation.data as Record<string, unknown>).invitationCode as string;

    const application = await joinAndSubmitApplication({
      token: member.token,
      clubSlug: targetOwner.club.slug,
      email: 'cross-join@example.com',
      invitationCode,
      name: 'Cross Join Casey',
      socials: '@crossjoincasey',
      application: 'Already active elsewhere and ready to contribute here too.',
    });

    await h.apiOk(targetOwner.token, 'clubadmin.memberships.setStatus', {
      clubId: targetOwner.club.id,
      membershipId: application.membershipId,
      status: 'active',
      reason: 'accepted after review',
    });

    const sponsorNotifications = getNotifications(await h.apiOk(targetOwner.token, 'notifications.list', { limit: 20 }));
    const invitationAccepted = sponsorNotifications.items.find((item) => item.kind === 'invitation.accepted');
    assert.ok(invitationAccepted, 'sponsor should receive invitation.accepted');
    assert.equal(invitationAccepted?.acknowledgeable, true);
    const sponsorPayload = invitationAccepted?.payload as Record<string, unknown>;
    assert.equal(sponsorPayload.newMemberPublicName, 'Cross Join Casey');
    assert.match(String(sponsorPayload.headsUp), /welcome DM/i);

    const memberNotifications = getNotifications(await h.apiOk(member.token, 'notifications.list', { limit: 20 }));
    const activated = memberNotifications.items.find((item) => item.kind === 'membership.activated');
    assert.ok(activated, 'cross-joiner should receive membership.activated');
    assert.equal(activated?.acknowledgeable, true);
    const activatedPayload = activated?.payload as Record<string, unknown>;
    assert.equal(activatedPayload.clubId, targetOwner.club.id);
    assert.equal(activatedPayload.sponsorPublicName, targetOwner.publicName);
    assert.match(String(((activatedPayload.welcome as Record<string, unknown>).greeting)), /Fanout Target Club/);

    await h.apiOk(targetOwner.token, 'notifications.acknowledge', {
      notificationIds: [invitationAccepted!.notificationId],
      state: 'processed',
    });
    await h.apiOk(member.token, 'notifications.acknowledge', {
      notificationIds: [activated!.notificationId],
      state: 'processed',
    });

    const invitationRowId = invitationAccepted!.notificationId.split(':').pop();
    const activatedRowId = activated!.notificationId.split(':').pop();
    const rows = await h.sql<{ topic: string; acknowledged_state: string | null }>(
      `select topic, acknowledged_state
       from member_notifications
       where id = any($1::text[])`,
      [[invitationRowId, activatedRowId]],
    );
    assert.deepEqual(
      rows.map((row) => row.acknowledged_state).sort(),
      ['processed', 'processed'],
    );
  });

  it('fires only membership.activated for cold cross-joins', async () => {
    const sourceOwner = await h.seedOwner('cold-source-club', 'Cold Source Club');
    const targetOwner = await h.seedOwner('cold-target-club', 'Cold Target Club');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Cold Cross Quinn');

    const application = await joinAndSubmitApplication({
      token: member.token,
      clubSlug: targetOwner.club.slug,
      email: 'cold-cross@example.com',
      name: 'Cold Cross Quinn',
      socials: '@coldcrossquinn',
      application: 'Joining another club without a sponsor.',
    });

    await h.apiOk(targetOwner.token, 'clubadmin.memberships.setStatus', {
      clubId: targetOwner.club.id,
      membershipId: application.membershipId,
      status: 'active',
      reason: 'accepted after review',
    });

    const sponsorNotifications = getNotifications(await h.apiOk(targetOwner.token, 'notifications.list', { limit: 20 }));
    assert.equal(sponsorNotifications.items.some((item) => item.kind === 'invitation.accepted'), false);

    const memberNotifications = getNotifications(await h.apiOk(member.token, 'notifications.list', { limit: 20 }));
    const activated = memberNotifications.items.find((item) => item.kind === 'membership.activated');
    assert.ok(activated, 'cross-joiner should still receive membership.activated');
    const payload = activated?.payload as Record<string, unknown>;
    assert.equal(payload.sponsorPublicName, undefined);
  });

  it('skips membership.activated for first-time cold admissions and leaves onboarding pending', async () => {
    const owner = await h.seedOwner('first-time-cold', 'First Time Cold');
    const applicant = await joinAndSubmitApplication({
      token: null,
      clubSlug: owner.club.slug,
      email: 'first-cold@example.com',
      name: 'First Cold Fiona',
      socials: '@firstcoldfiona',
      application: 'This should be surfaced by the ceremony, not a notification.',
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membershipId,
      status: 'active',
      reason: 'accepted after review',
    });

    const session = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(actorOnboardingPending(session), true);

    const sessionWithNotifications = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(actorNotifications(sessionWithNotifications).some((item) => item.kind === 'membership.activated'), false);
  });

  it('fires invitation.accepted but not membership.activated for first-time invited admissions', async () => {
    const owner = await h.seedOwner('first-time-invited', 'First Time Invited');
    const issued = await h.apiOk(owner.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Invited Ingrid',
      candidateEmail: 'invited-ingrid@example.com',
      reason: 'A trusted operator',
    });

    const applicant = await joinAndSubmitApplication({
      token: null,
      clubSlug: owner.club.slug,
      email: 'invited-ingrid@example.com',
      invitationCode: (issued.data as Record<string, unknown>).invitationCode as string,
      name: 'Invited Ingrid',
      socials: '@invitedingrid',
      application: 'Invitation-backed first admission.',
    });

    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: applicant.membershipId,
      status: 'active',
      reason: 'accepted after invitation',
    });

    const sponsorNotifications = getNotifications(await h.apiOk(owner.token, 'notifications.list', { limit: 20 }));
    assert.ok(sponsorNotifications.items.some((item) => item.kind === 'invitation.accepted'));

    const applicantSession = await h.apiOk(applicant.token, 'session.getContext', {});
    assert.equal(actorNotifications(applicantSession).some((item) => item.kind === 'membership.activated'), false);
  });

  it('fires sponsor and member fanout from the billing activation path, not from payment_pending', async () => {
    const admin = await h.seedSuperadmin('Billing Fanout Admin');
    const sourceOwner = await h.seedOwner('billing-fanout-source', 'Billing Fanout Source');
    const targetOwner = await h.seedOwner('billing-fanout-target', 'Billing Fanout Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Paid Path Parker');

    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: targetOwner.club.id,
      amount: 29,
      currency: 'USD',
    });

    const issued = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Paid Path Parker',
      candidateEmail: 'paid-path@example.com',
      reason: 'Already trusted elsewhere',
    });

    const application = await joinAndSubmitApplication({
      token: member.token,
      clubSlug: targetOwner.club.slug,
      email: 'paid-path@example.com',
      invitationCode: (issued.data as Record<string, unknown>).invitationCode as string,
      name: 'Paid Path Parker',
      socials: '@paidpathparker',
      application: 'I am ready to join after payment clears.',
    });

    await h.apiOk(targetOwner.token, 'clubadmin.memberships.setStatus', {
      clubId: targetOwner.club.id,
      membershipId: application.membershipId,
      status: 'payment_pending',
      reason: 'approved pending payment',
    });

    let notifications = getNotifications(await h.apiOk(targetOwner.token, 'notifications.list', { limit: 20 }));
    assert.equal(notifications.items.some((item) => item.kind === 'invitation.accepted'), false);
    notifications = getNotifications(await h.apiOk(member.token, 'notifications.list', { limit: 20 }));
    assert.equal(notifications.items.some((item) => item.kind === 'membership.activated'), false);

    await h.apiOk(admin.token, 'superadmin.billing.activateMembership', {
      membershipId: application.membershipId,
      paidThrough: '2026-07-01T00:00:00Z',
    });

    const sponsorNotifications = getNotifications(await h.apiOk(targetOwner.token, 'notifications.list', { limit: 20 }));
    assert.ok(sponsorNotifications.items.some((item) => item.kind === 'invitation.accepted'));

    const memberNotifications = getNotifications(await h.apiOk(member.token, 'notifications.list', { limit: 20 }));
    assert.ok(memberNotifications.items.some((item) => item.kind === 'membership.activated'));
  });

  it('surfaces admission-race sibling clubs during clubs.onboard', async () => {
    const ownerA = await h.seedOwner('race-club-a', 'Race Club A');
    const ownerB = await h.seedOwner('race-club-b', 'Race Club B');

    const first = await joinAndSubmitApplication({
      token: null,
      clubSlug: ownerA.club.slug,
      email: 'race@example.com',
      name: 'Race Riley',
      socials: '@raceriley',
      application: 'Submitting to two clubs before my first welcome runs.',
    });

    const second = await joinAndSubmitApplication({
      token: first.token,
      clubSlug: ownerB.club.slug,
      email: 'race@example.com',
      name: 'Race Riley',
      socials: '@raceriley',
      application: 'A second application before any onboarding happens.',
    });

    await h.apiOk(ownerA.token, 'clubadmin.memberships.setStatus', {
      clubId: ownerA.club.id,
      membershipId: first.membershipId,
      status: 'active',
      reason: 'accepted first',
    });
    await h.apiOk(ownerB.token, 'clubadmin.memberships.setStatus', {
      clubId: ownerB.club.id,
      membershipId: second.membershipId,
      status: 'active',
      reason: 'accepted second',
    });

    const beforeSession = await h.apiOk(first.token, 'session.getContext', {});
    assert.equal(actorNotifications(beforeSession).some((item) => item.kind === 'membership.activated'), false);

    const onboard = await h.apiOk(first.token, 'clubs.onboard', {});
    const onboardData = onboard.data as Record<string, unknown>;
    assert.equal((onboardData.club as Record<string, unknown>).id, ownerA.club.id);
    assert.equal(actorOnboardingPending(onboard), false);

    const after = getNotifications(await h.apiOk(first.token, 'notifications.list', { limit: 20 }));
    const sibling = after.items.find((item) => item.kind === 'membership.activated');
    assert.ok(sibling, 'clubs.onboard should emit a sibling activation notification');
    assert.equal((sibling?.payload as Record<string, unknown>).clubId, ownerB.club.id);
  });

  it('rolls back admin activation if notification fanout insert fails', async () => {
    const sourceOwner = await h.seedOwner('atomic-admin-source', 'Atomic Admin Source');
    const targetOwner = await h.seedOwner('atomic-admin-target', 'Atomic Admin Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Atomic Admin Annie');
    const issued = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Atomic Admin Annie',
      candidateEmail: 'atomic-admin@example.com',
      reason: 'Trusted operator',
    });

    const application = await joinAndSubmitApplication({
      token: member.token,
      clubSlug: targetOwner.club.slug,
      email: 'atomic-admin@example.com',
      invitationCode: (issued.data as Record<string, unknown>).invitationCode as string,
      name: 'Atomic Admin Annie',
      socials: '@atomicadminannie',
      application: 'This should stay submitted if fanout fails.',
    });

    const failure = await installNotificationFailureTrigger('invitation.accepted');
    try {
      const err = await h.apiErr(targetOwner.token, 'clubadmin.memberships.setStatus', {
        clubId: targetOwner.club.id,
        membershipId: application.membershipId,
        status: 'active',
        reason: 'attempted approval',
      });
      assert.equal(err.status, 500);
      assert.equal(err.code, 'internal_error');
    } finally {
      await dropNotificationFailureTrigger(failure);
    }

    const rows = await h.sql<{ status: string }>(
      `select status::text as status
       from current_club_memberships
       where id = $1`,
      [application.membershipId],
    );
    assert.equal(rows[0]?.status, 'submitted');
  });

  it('rolls back billing activation if notification fanout insert fails', async () => {
    const admin = await h.seedSuperadmin('Atomic Billing Admin');
    const sourceOwner = await h.seedOwner('atomic-billing-source', 'Atomic Billing Source');
    const targetOwner = await h.seedOwner('atomic-billing-target', 'Atomic Billing Target');
    const member = await h.seedCompedMember(sourceOwner.club.id, 'Atomic Billing Blair');

    await h.apiOk(admin.token, 'superadmin.billing.setClubPrice', {
      clubId: targetOwner.club.id,
      amount: 29,
      currency: 'USD',
    });

    const issued = await h.apiOk(targetOwner.token, 'invitations.issue', {
      clubId: targetOwner.club.id,
      candidateName: 'Atomic Billing Blair',
      candidateEmail: 'atomic-billing@example.com',
      reason: 'Trusted operator',
    });

    const application = await joinAndSubmitApplication({
      token: member.token,
      clubSlug: targetOwner.club.slug,
      email: 'atomic-billing@example.com',
      invitationCode: (issued.data as Record<string, unknown>).invitationCode as string,
      name: 'Atomic Billing Blair',
      socials: '@atomicbillingblair',
      application: 'This should stay payment_pending if fanout fails.',
    });

    await h.apiOk(targetOwner.token, 'clubadmin.memberships.setStatus', {
      clubId: targetOwner.club.id,
      membershipId: application.membershipId,
      status: 'payment_pending',
      reason: 'approved pending payment',
    });

    const failure = await installNotificationFailureTrigger('invitation.accepted');
    try {
      const err = await h.apiErr(admin.token, 'superadmin.billing.activateMembership', {
        membershipId: application.membershipId,
        paidThrough: '2026-07-01T00:00:00Z',
      });
      assert.equal(err.status, 500);
      assert.equal(err.code, 'internal_error');
    } finally {
      await dropNotificationFailureTrigger(failure);
    }

    const rows = await h.sql<{ status: string }>(
      `select status::text as status
       from current_club_memberships
       where id = $1`,
      [application.membershipId],
    );
    assert.equal(rows[0]?.status, 'payment_pending');
  });
});

describe('direct-mint onboarding semantics', () => {
  it('superadmin.accessTokens.create marks a never-onboarded target and bypasses the onboarding gate', async () => {
    const admin = await h.seedSuperadmin('Direct Mint Admin');
    const [target] = await h.sql<{ id: string }>(
      `insert into members (public_name, display_name, state)
       values ('Never Onboarded Nora', 'Never Onboarded Nora', 'active')
       returning id`,
    );

    const result = await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });
    const data = result.data as { bearerToken: string };

    const [row] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members where id = $1`,
      [target.id],
    );
    assert.ok(row?.onboarded_at, 'minting should set onboarded_at');

    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    assert.equal(actorOnboardingPending(session), false);

    const tokens = await h.apiOk(data.bearerToken, 'accessTokens.list', {});
    assert.ok(Array.isArray(((tokens.data as Record<string, unknown>).tokens)));
  });

  it('superadmin.accessTokens.create preserves an existing onboarded_at timestamp', async () => {
    const admin = await h.seedSuperadmin('Direct Mint Preserve Admin');
    const [target] = await h.sql<{ id: string }>(
      `insert into members (public_name, display_name, state, onboarded_at)
       values ('Already Onboarded Omar', 'Already Onboarded Omar', 'active', '2026-04-01T12:00:00Z')
       returning id`,
    );

    await h.apiOk(admin.token, 'superadmin.accessTokens.create', {
      memberId: target.id,
    });

    const [row] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members where id = $1`,
      [target.id],
    );
    assert.equal(Date.parse(row?.onboarded_at ?? ''), Date.parse('2026-04-01T12:00:00Z'));
  });

  it('superadmin.members.createWithAccessToken creates an already-onboarded member whose token works immediately', async () => {
    const admin = await h.seedSuperadmin('Create Member Direct Admin');

    const result = await h.apiOk(admin.token, 'superadmin.members.createWithAccessToken', {
      publicName: 'Direct Mint Dana',
    });
    const data = result.data as {
      member: { memberId: string };
      bearerToken: string;
    };

    const [row] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members where id = $1`,
      [data.member.memberId],
    );
    assert.ok(row?.onboarded_at, 'createWithAccessToken should set onboarded_at');

    const session = await h.apiOk(data.bearerToken, 'session.getContext', {});
    assert.equal(actorOnboardingPending(session), false);

    const tokens = await h.apiOk(data.bearerToken, 'accessTokens.list', {});
    assert.ok(Array.isArray(((tokens.data as Record<string, unknown>).tokens)));
  });

  it('member self-rotation preserves onboarded_at', async () => {
    const owner = await h.seedOwner('self-rotation-club', 'Self Rotation Club');
    const member = await h.seedCompedMember(owner.club.id, 'Self Rotation Rae');

    const [before] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members where id = $1`,
      [member.id],
    );

    await h.apiOk(member.token, 'accessTokens.create', { label: 'rotation' });

    const [after] = await h.sql<{ onboarded_at: string | null }>(
      `select onboarded_at::text as onboarded_at from members where id = $1`,
      [member.id],
    );
    assert.equal(after?.onboarded_at, before?.onboarded_at);
  });
});
