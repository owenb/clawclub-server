/**
 * Legality gate integration tests.
 *
 * These tests require OPENAI_API_KEY to be set — the LLM evaluates content
 * and decides whether it is legal.
 *
 * Run with: npm run test:integration:with-llm
 * Or run this file directly after exporting OPENAI_API_KEY:
 * node --experimental-strip-types --test test/integration/with-llm/quality-gate.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Legality gate passes legal content ─────────────────────────────────────

describe('legality gate: passes legal content regardless of quality', () => {
  it('passes a post with no body (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-entity-1', 'QG Entity Club 1');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Hello',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a vague opportunity (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-entity-2', 'QG Entity Club 2');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'opportunity',
      title: 'Great role',
      body: 'Looking for someone.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a vague service listing (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-entity-3', 'QG Entity Club 3');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'service',
      title: 'Consulting',
      body: 'I do consulting.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a well-formed post', async () => {
    const owner = await h.seedOwner('qg-entity-4', 'QG Entity Club 4');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Three things I learned running a bakery for 10 years',
      body: 'First, never underestimate the importance of sourcing flour locally — it changed our margins by 30% and gave us a story customers cared about. Second, hiring for attitude over skill in food service pays off every time. Third, social media is overrated for local businesses; our best marketing was always free samples on Saturday mornings.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a generic filler summary in an event (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-event-2b', 'QG Event Club 2b');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Meetup',
      summary: 'Come hang out.',
      event: {
        location: 'Online',
        startsAt: '2026-05-15T18:00:00Z',
      },
    });
    const event = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(event.entityId);
  });

  it('passes a well-formed event', async () => {
    const owner = await h.seedOwner('qg-event-3', 'QG Event Club 3');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Monthly founders breakfast — May edition',
      summary: 'Casual breakfast at The Table in Shoreditch. We will go around the table and each share one thing we are stuck on and one thing that is working. Bring your own coffee order, food is covered.',
      event: {
        location: 'The Table, 83 Southwark Street, London SE1',
        startsAt: '2026-05-15T08:30:00Z',
        endsAt: '2026-05-15T10:00:00Z',
        timezone: 'Europe/London',
        capacity: 12,
      },
    });
    const event = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(event.entityId);
  });

  it('passes a generic filler tagline in profile (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-profile-1', 'QG Profile Club 1');
    const result = await h.apiOk(owner.token, 'profile.update', {
      clubId: owner.club.id,
      tagline: 'Experienced professional passionate about excellence',
    });
    const profile = result.data as Record<string, unknown>;
    assert.ok(profile.memberId);
  });

  it('passes a vague vouch reason (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-vouch-1', 'QG Vouch Club 1');
    const member = await h.seedClubMember(owner.club.id, 'Vouch Target', 'qg-vouch-target-1', { sponsorId: owner.id });

    const result = await h.apiOk(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: member.id,
      reason: 'Great person, highly recommend!',
    });
    const vouch = (result.data as Record<string, unknown>).vouch as Record<string, unknown>;
    assert.ok(vouch.edgeId);
  });

  it('passes a generic sponsorship reason (low quality but legal)', async () => {
    const owner = await h.seedOwner('qg-sponsor-1', 'QG Sponsor Club 1');
    const member = await h.seedClubMember(owner.club.id, 'Sponsor Member', 'qg-sponsor-member-1', { sponsorId: owner.id });

    const result = await h.apiOk(member.token, 'admissions.sponsorCandidate', {
      clubId: owner.club.id,
      name: 'Jane Doe',
      email: 'jane@example.com',
      socials: '@janedoe',
      reason: 'Amazing person, would be a great addition to the club!',
    });
    const admission = (result.data as Record<string, unknown>).admission as Record<string, unknown>;
    assert.ok(admission.admissionId);
  });
});

// ── Schema validation still catches missing required fields ─────────────────

describe('legality gate: schema validation still applies', () => {
  it('rejects an event missing required fields (no startsAt)', async () => {
    const owner = await h.seedOwner('qg-event-1', 'QG Event Club 1');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Meetup',
      summary: 'Come hang out.',
      event: {
        location: 'Online',
      },
    }, 'invalid_input');
    assert.equal(err.status, 400);
  });

  it('rejects an event missing required fields (no location)', async () => {
    const owner = await h.seedOwner('qg-event-2', 'QG Event Club 2');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Meetup',
      summary: 'Come hang out.',
      event: {
        startsAt: '2026-05-15T18:00:00Z',
      },
    }, 'invalid_input');
    assert.equal(err.status, 400);
  });
});

// ── Illegal content moderation ─────────────────────────────────────────────

describe('legality gate: rejects clearly illegal content', () => {
  it('rejects a post soliciting fraud', async () => {
    const owner = await h.seedOwner('qg-illegal-1', 'QG Illegal Club 1');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Need help with documents',
      body: 'Looking for someone who can produce convincing forged identity documents. Willing to pay well. Passports, driving licences, or national ID cards — any EU country works.',
    }, 'illegal_content');
    assert.equal(err.status, 422);
  });

  it('rejects a service offering drug trafficking', async () => {
    const owner = await h.seedOwner('qg-illegal-2', 'QG Illegal Club 2');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'service',
      title: 'Bulk supply available',
      body: 'I can source cocaine and MDMA in bulk at competitive prices. Discrete shipping anywhere in Europe. Minimum order 50g. DM for a price list.',
    }, 'illegal_content');
    assert.equal(err.status, 422);
  });

  it('rejects a post containing threats of violence', async () => {
    const owner = await h.seedOwner('qg-illegal-3', 'QG Illegal Club 3');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Had enough',
      body: 'If I see David Chen at the next event I am going to beat him until he cannot walk. This is not a joke. He knows what he did and he is going to pay for it.',
    }, 'illegal_content');
    assert.equal(err.status, 422);
  });
});

describe('legality gate: allows legal but edgy content', () => {
  it('passes a post with heavy profanity but a clear point', async () => {
    const owner = await h.seedOwner('qg-edgy-1', 'QG Edgy Club 1');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Fundraising is broken',
      body: 'I am so fucking tired of VCs who ghost founders after three meetings. Last month I had two partners at a top-tier firm string me along for six weeks, ask for a full data room, then go silent. No rejection, no feedback, just nothing. This industry runs on bullshit and cowardice. If you are going to pass, just say so.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a harsh critique of a public figure', async () => {
    const owner = await h.seedOwner('qg-edgy-2', 'QG Edgy Club 2');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Why I think Elon Musk is a terrible CEO',
      body: 'Musk has destroyed Twitter, tanked Tesla stock through distraction, and runs his companies like a narcissist who fires anyone who disagrees with him. The hero worship in tech is embarrassing. He is not a genius — he is a rich man who buys companies and takes credit for other people\'s engineering.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a politically extreme but legal opinion', async () => {
    const owner = await h.seedOwner('qg-edgy-3', 'QG Edgy Club 3');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Abolish all intellectual property law',
      body: 'Patents and copyright are state-enforced monopolies that strangle innovation and exist only to protect incumbents. Every study shows that patent trolls cost the economy more than patents generate. All IP law should be repealed entirely. Yes, all of it. Software, pharma, music — let the market figure out business models that do not depend on government-granted monopoly rents.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a sexually suggestive but legal post', async () => {
    const owner = await h.seedOwner('qg-edgy-4', 'QG Edgy Club 4');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Starting a dating app for kink-positive professionals',
      body: 'I have been working on a dating app specifically for professionals in the kink and sex-positive community. Existing apps are either sleazy or refuse to acknowledge that successful adults have sex lives. Looking for beta testers and a co-founder with mobile experience. The app handles consent negotiation, STI status sharing, and event discovery. DM me if interested.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });

  it('passes a post discussing legal recreational drug use', async () => {
    const owner = await h.seedOwner('qg-edgy-5', 'QG Edgy Club 5');
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Microdosing changed how I work',
      body: 'I have been microdosing psilocybin every three days for six months and the effect on my focus and creativity has been dramatic. I know this is still in a legal grey area in most places, but the research from Johns Hopkins and Imperial College is compelling. Anyone else here experimenting with this? Would love to compare protocols.',
    });
    const entity = (result.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId);
  });
});
