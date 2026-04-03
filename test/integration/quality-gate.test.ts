/**
 * Quality gate integration tests.
 *
 * These tests require OPENAI_API_KEY to be set — the LLM evaluates content
 * and decides whether to pass or reject it. Skip this file when running
 * without a key (npm run test:integration skips it by default).
 *
 * Run with: OPENAI_API_KEY=sk-... node --experimental-strip-types --test test/integration/quality-gate.test.ts
 */

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

// ── entities.create ─────────────────────────────────────────────────────────

describe('quality gate: entities.create', () => {
  it('rejects a post with no body', async () => {
    const owner = await h.seedOwner('qg-entity-1', 'QG Entity Club 1');
    const err = await h.apiErr(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Hello',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
    assert.ok(err.message.length > 10, 'feedback should explain what is missing');
  });

  it('rejects an opportunity missing how to engage', async () => {
    const owner = await h.seedOwner('qg-entity-2', 'QG Entity Club 2');
    const err = await h.apiErr(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'opportunity',
      title: 'Great role',
      body: 'Looking for someone.',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('rejects a service that is just a vague placeholder', async () => {
    const owner = await h.seedOwner('qg-entity-3', 'QG Entity Club 3');
    const err = await h.apiErr(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'service',
      title: 'Consulting',
      body: 'I do consulting.',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('passes a well-formed post with a clear point', async () => {
    const owner = await h.seedOwner('qg-entity-4', 'QG Entity Club 4');
    const result = await h.apiOk(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Three things I learned running a bakery for 10 years',
      body: 'First, never underestimate the importance of sourcing flour locally — it changed our margins by 30% and gave us a story customers cared about. Second, hiring for attitude over skill in food service pays off every time. Third, social media is overrated for local businesses; our best marketing was always free samples on Saturday mornings.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a well-formed opportunity with role, audience, and how to engage', async () => {
    const owner = await h.seedOwner('qg-entity-5', 'QG Entity Club 5');
    const result = await h.apiOk(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'opportunity',
      title: 'Part-time product designer for early-stage climate tech startup',
      body: 'We are building a carbon tracking tool for small manufacturers. Looking for a product designer who can do 15-20 hrs/week for 3 months, working async with our engineering team. Experience with B2B SaaS preferred but not required. Paid engagement. DM me here or email jobs@example.com to chat.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });
});

// ── entities.update ─────────────────────────────────────────────────────────

describe('quality gate: entities.update', () => {
  it('rejects an update that empties the body to a vague stub', async () => {
    const owner = await h.seedOwner('qg-update-1', 'QG Update Club 1');
    // Create a good post first (gate is skipped if no key, but we have one here)
    const created = await h.apiOk(owner.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Substantive post to be gutted',
      body: 'Local food sourcing changed our bakery margins by 30 percent. We switched to a local flour mill and discovered that customers paid a premium because they valued the story. Seasonal menus further reduced waste — we cut food costs by 20 percent in the first quarter after switching.',
    });
    const entityId = ((created.data as Record<string, unknown>).entity as Record<string, unknown>).entityId as string;

    const err = await h.apiErr(owner.token, 'entities.update', {
      entityId,
      body: 'Updated.',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });
});

// ── events.create ───────────────────────────────────────────────────────────

describe('quality gate: events.create', () => {
  it('rejects an event with no start time', async () => {
    const owner = await h.seedOwner('qg-event-1', 'QG Event Club 1');
    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Meetup',
      summary: 'Come hang out.',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('rejects an event with no description', async () => {
    const owner = await h.seedOwner('qg-event-2', 'QG Event Club 2');
    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Meetup',
      startsAt: '2026-05-15T18:00:00Z',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('passes an event with title, start time, and description', async () => {
    const owner = await h.seedOwner('qg-event-3', 'QG Event Club 3');
    const result = await h.apiOk(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Monthly founders breakfast — May edition',
      summary: 'Casual breakfast at The Table in Shoreditch. We will go around the table and each share one thing we are stuck on and one thing that is working. Bring your own coffee order, food is covered.',
      startsAt: '2026-05-15T08:30:00Z',
      endsAt: '2026-05-15T10:00:00Z',
      timezone: 'Europe/London',
      capacity: 12,
    });
    const event = (result.data as Record<string, unknown>).event as Record<string, unknown>;
    assert.ok(event.entityId);
  });
});

// ── profile.update ──────────────────────────────────────────────────────────

describe('quality gate: profile.update', () => {
  it('rejects generic filler in tagline', async () => {
    const owner = await h.seedOwner('qg-profile-1', 'QG Profile Club 1');
    const err = await h.apiErr(owner.token, 'profile.update', {
      tagline: 'Experienced professional passionate about excellence',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('passes a specific, substantive profile update', async () => {
    const owner = await h.seedOwner('qg-profile-2', 'QG Profile Club 2');
    const result = await h.apiOk(owner.token, 'profile.update', {
      tagline: 'Backend engineer building carbon tracking tools for small manufacturers',
      summary: 'I spent 8 years at logistics companies building warehouse management systems, then moved into climate tech. Currently freelance, helping early-stage startups get their data pipelines right.',
      whatIDo: 'Design and build backend systems in Go and TypeScript. Specialise in event-driven architectures and Postgres-heavy stacks.',
    });
    const profile = result.data as Record<string, unknown>;
    assert.ok(profile.memberId);
  });
});

// ── vouches.create ──────────────────────────────────────────────────────────

describe('quality gate: vouches.create', () => {
  it('rejects vague praise with no firsthand evidence', async () => {
    const owner = await h.seedOwner('qg-vouch-1', 'QG Vouch Club 1');
    const member = await h.seedClubMember(owner.club.id, 'Vouch Target', 'qg-vouch-target-1', { sponsorId: owner.id });

    const err = await h.apiErr(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: member.id,
      reason: 'Great person, highly recommend!',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });

  it('passes a vouch with concrete firsthand evidence', async () => {
    const owner = await h.seedOwner('qg-vouch-2', 'QG Vouch Club 2');
    const member = await h.seedClubMember(owner.club.id, 'Vouch Target Good', 'qg-vouch-target-2', { sponsorId: owner.id });

    const result = await h.apiOk(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: member.id,
      reason: 'I worked with Sarah on the Greenfield carbon audit project for 6 months last year. She restructured our entire data pipeline in half the time we estimated, and when the client changed scope mid-project she handled the re-scoping call herself and kept us on track. Extremely sharp and reliable.',
    });
    const vouch = (result.data as Record<string, unknown>).vouch as Record<string, unknown>;
    assert.ok(vouch.edgeId);
  });
});

// ── admissions.sponsor ──────────────────────────────────────────────────────

describe('quality gate: admissions.sponsor', () => {
  it('rejects a generic sponsorship reason', async () => {
    const owner = await h.seedOwner('qg-sponsor-1', 'QG Sponsor Club 1');
    const member = await h.seedClubMember(owner.club.id, 'Sponsor Member', 'qg-sponsor-member-1', { sponsorId: owner.id });

    const err = await h.apiErr(member.token, 'admissions.sponsor', {
      clubId: owner.club.id,
      name: 'Jane Doe',
      email: 'jane@example.com',
      socials: '@janedoe',
      reason: 'Amazing person, would be a great addition to the club!',
    }, 'quality_check_failed');
    assert.equal(err.status, 422);
  });
});
