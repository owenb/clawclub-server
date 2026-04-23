import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import {
  activeMemberships,
  prepareAccountRegistration,
  registerWithPow,
  seedPublishedContent,
} from '../helpers.ts';
import { isCanonicalIsoTimestamp } from '../../../src/timestamps.ts';

let h: TestHarness;

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, 'string', `${label} should be a string timestamp`);
  assert.equal(
    isCanonicalIsoTimestamp(value),
    true,
    `${label} should be canonical ISO-8601 UTC, got ${String(value)}`,
  );
}

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('timestamp normalization', () => {
  it('canonicalizes registration, session, and polling timestamps', async () => {
    const owner = await h.seedOwner('timestamp-member-club', 'Timestamp Member Club');
    const member = await h.seedCompedMember(owner.club.id, 'Timestamp Member');

    const challenge = await prepareAccountRegistration(h, 'timestamp-register-discover');
    assertCanonicalTimestamp(challenge.expiresAt, 'accounts.register discover challenge.expiresAt');

    const registered = await registerWithPow(h, {
      name: 'Timestamp Registered',
      email: `timestamp-${Date.now()}@example.com`,
      clientKey: 'timestamp-register-submit',
    });
    const registeredMember = (((registered.body.data as Record<string, unknown>).member) ?? {}) as Record<string, unknown>;
    assertCanonicalTimestamp(registeredMember.registeredAt, 'accounts.register submit member.registeredAt');

    const session = await h.apiOk(member.token, 'session.getContext', {});
    const membership = activeMemberships(session).find((row) => row.clubId === owner.club.id);
    assert.ok(membership, 'session should include the seeded club membership');
    assertCanonicalTimestamp(membership?.joinedAt, 'session.getContext activeMemberships[].joinedAt');

    const updates = await h.getUpdates(member.token, {});
    const updatesData = updates.body.data as Record<string, unknown>;
    assertCanonicalTimestamp(updatesData.polledAt, 'updates.list polledAt');
  });

  it('canonicalizes content and application read timestamps', async () => {
    const owner = await h.seedOwner('timestamp-read-club', 'Timestamp Read Club');
    const reader = await h.seedCompedMember(owner.club.id, 'Timestamp Reader');
    const applicant = await h.seedMember('Timestamp Applicant');

    const eventContent = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'event',
      title: 'Timestamp Event',
      body: 'Event body',
      event: {
        startsAt: '2026-06-01T18:00:00Z',
        endsAt: '2026-06-01T20:00:00Z',
        timezone: 'UTC',
      },
    });

    const contentResult = await h.apiOk(reader.token, 'content.get', {
      contentId: eventContent.id,
      limit: 20,
    });
    const contentData = contentResult.data as Record<string, unknown>;
    const thread = (contentData.thread ?? {}) as Record<string, unknown>;
    const firstContent = (thread.firstContent ?? {}) as Record<string, unknown>;
    const version = (firstContent.version ?? {}) as Record<string, unknown>;
    const event = (firstContent.event ?? {}) as Record<string, unknown>;

    assertCanonicalTimestamp(thread.latestActivityAt, 'content.get thread.latestActivityAt');
    assertCanonicalTimestamp(firstContent.createdAt, 'content.get thread.firstContent.createdAt');
    assertCanonicalTimestamp(version.createdAt, 'content.get thread.firstContent.version.createdAt');
    assertCanonicalTimestamp(version.effectiveAt, 'content.get thread.firstContent.version.effectiveAt');
    assertCanonicalTimestamp(event.startsAt, 'content.get thread.firstContent.event.startsAt');
    assertCanonicalTimestamp(event.endsAt, 'content.get thread.firstContent.event.endsAt');

    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'declined',
      draftName: 'Timestamp Applicant',
      draftSocials: '@timestamp',
      draftApplication: 'Please verify timestamp normalization.',
      submittedAt: '2026-04-01T10:00:00Z',
      decidedAt: '2026-04-02T12:30:00Z',
      decidedByMemberId: owner.id,
    });

    const applicationResult = await h.apiOk(owner.token, 'clubadmin.applications.get', {
      clubId: owner.club.id,
      applicationId: application.id,
    });
    const applicationData = (((applicationResult.data as Record<string, unknown>).application) ?? {}) as Record<string, unknown>;
    const gate = (applicationData.gate ?? {}) as Record<string, unknown>;

    assertCanonicalTimestamp(applicationData.submittedAt, 'clubadmin.applications.get application.submittedAt');
    assertCanonicalTimestamp(applicationData.decidedAt, 'clubadmin.applications.get application.decidedAt');
    assertCanonicalTimestamp(gate.lastRunAt, 'clubadmin.applications.get application.gate.lastRunAt');
  });
});
