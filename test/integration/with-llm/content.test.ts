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

function findListedFirstEntity(
  listResult: Record<string, unknown>,
  entityId: string,
): Record<string, unknown> | undefined {
  const results = (listResult.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
  return results
    .map((thread) => thread.firstEntity as Record<string, unknown>)
    .find((entity) => entity.entityId === entityId);
}

// ── Entities ──────────────────────────────────────────────────────────────────

describe('entities', () => {
  it('member creates a post and sees it in content.list', async () => {
    const owner = await h.seedOwner('entity-club-1', 'EntityClub1');
    const author = await h.seedCompedMember(owner.club.id, 'Alice Author');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Three things I learned running a bakery for 10 years',
      body: 'First, never underestimate the importance of sourcing flour locally — it changed our margins by 30% and gave us a story customers cared about. Second, hiring for attitude over skill in food service pays off every time. Third, social media is overrated for local businesses; our best marketing was always free samples on Saturday mornings.',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId, 'entity should have entityId');
    assert.equal(entity.kind, 'post');
    const version = entity.version as Record<string, unknown>;
    assert.equal(version.title, 'Three things I learned running a bakery for 10 years');
    assert.equal(version.state, 'published');

    const list = await h.apiOk(author.token, 'content.list', { clubId: owner.club.id });
    const found = findListedFirstEntity(list as Record<string, unknown>, entity.entityId as string);
    assert.ok(found, 'created post should appear in content.list');
  });

  it('another club member also sees the post in their content.list', async () => {
    const owner = await h.seedOwner('entity-club-2', 'EntityClub2');
    const author = await h.seedCompedMember(owner.club.id, 'Bob Author');
    const viewer = await h.seedCompedMember(owner.club.id, 'Carol Viewer');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'How we cut onboarding time from two weeks to three days',
      body: 'We rewrote our onboarding guide as a series of small tasks instead of a wall of documentation. Each task had a clear deliverable and a mentor assigned. New hires started contributing to real tickets by day three. The key was making expectations explicit rather than implicit.',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;

    const list = await h.apiOk(viewer.token, 'content.list', { clubId: owner.club.id });
    const found = findListedFirstEntity(list as Record<string, unknown>, entity.entityId as string);
    assert.ok(found, 'club member should see post created by another member');
  });

  it('member not in the club cannot see the post', async () => {
    const owner = await h.seedOwner('entity-club-3', 'EntityClub3');
    const author = await h.seedCompedMember(owner.club.id, 'Dave Author');
    const outsider = await h.seedMember('Eve Outsider');

    // Add outsider to a different club so they have at least one membership
    const otherOwner = await h.seedOwner('entity-other-club-3', 'OtherClub3');
    await h.seedCompedMembership(otherOwner.club.id, outsider.id);

    await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Why we moved our entire backend from REST to event sourcing',
      body: 'After two years of fighting eventual consistency bugs in our REST API, we committed to event sourcing. The migration took four months, but now we have a complete audit trail, easy replay, and our data integrity issues have dropped to near zero. Here is what we did step by step.',
    });

    // Outsider requesting the specific club should be forbidden
    const err = await h.apiErr(outsider.token, 'content.list', { clubId: owner.club.id });
    assert.equal(err.code, 'forbidden');
  });

  it('author can update the post via content.update and change is visible in list', async () => {
    const owner = await h.seedOwner('entity-club-4', 'EntityClub4');
    const author = await h.seedCompedMember(owner.club.id, 'Frank Author');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Lessons from scaling our Postgres database to 500 million rows',
      body: 'Partitioning by date, aggressive vacuuming, and connection pooling with PgBouncer were the three biggest wins. We went from 12-second query times to under 200 milliseconds on our heaviest dashboard without upgrading hardware.',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    const entityId = entity.entityId as string;

    const updated = await h.apiOk(author.token, 'content.update', {
      entityId,
      title: 'Updated: Lessons from scaling Postgres to 500 million rows',
      summary: 'Partitioning, vacuuming, and connection pooling deep dive with real numbers',
      body: 'Partitioning by date was the single biggest win — it reduced our slowest query from 12 seconds to 180 milliseconds. We partition by month and auto-create future partitions via a cron job. Aggressive vacuuming (every 2 hours on hot tables) keeps bloat under control. PgBouncer in transaction mode handles connection pooling with minimal config.',
    });
    const updatedEntity = (updated.data as Record<string, unknown>).entity as Record<string, unknown>;
    const updatedVersion = updatedEntity.version as Record<string, unknown>;
    assert.equal(updatedVersion.title, 'Updated: Lessons from scaling Postgres to 500 million rows');
    assert.equal(updatedVersion.summary, 'Partitioning, vacuuming, and connection pooling deep dive with real numbers');

    const list = await h.apiOk(author.token, 'content.list', { clubId: owner.club.id });
    const found = findListedFirstEntity(list as Record<string, unknown>, entityId);
    assert.ok(found, 'updated entity should appear in list');
    const foundVersion = found!.version as Record<string, unknown>;
    assert.equal(foundVersion.title, 'Updated: Lessons from scaling Postgres to 500 million rows');
  });

  it('author archives the post and it disappears from list', async () => {
    const owner = await h.seedOwner('entity-club-5', 'EntityClub5');
    const author = await h.seedCompedMember(owner.club.id, 'Grace Author');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'How we automated our entire deployment pipeline in one sprint',
      body: 'We replaced our manual deployment checklist with a GitHub Actions workflow that runs tests, builds the Docker image, deploys to staging, runs smoke tests, and promotes to production. Total time from merge to live went from 45 minutes of manual work to 8 minutes fully automated.',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    const entityId = entity.entityId as string;

    await h.apiOk(author.token, 'content.remove', { entityId });

    const list = await h.apiOk(author.token, 'content.list', { clubId: owner.club.id });
    const found = findListedFirstEntity(list as Record<string, unknown>, entityId);
    assert.equal(found, undefined, 'removed post should not appear in content.list');
  });

  it('all entity kinds can be created: post, opportunity, service, ask', async () => {
    const owner = await h.seedOwner('entity-club-kinds', 'EntityClubKinds');
    const author = await h.seedCompedMember(owner.club.id, 'Hal Kinds');

    const kindPayloads: Record<string, { title: string; body: string }> = {
      post: {
        title: 'Three patterns for building reliable event-driven systems',
        body: 'After building event-driven systems for six years, three patterns consistently prove their worth. The outbox pattern ensures you never lose data when the broker is down. Idempotent consumers with deduplication keys prevent double-processing. Dead-letter queues with automated replay handle transient failures gracefully.',
      },
      opportunity: {
        title: 'Part-time backend engineer for climate data startup',
        body: 'We are building carbon tracking tools for small manufacturers. Looking for a backend engineer comfortable with TypeScript and PostgreSQL, 15-20 hours per week for 3 months. Remote-friendly, paid engagement. DM me or email jobs@example.com to start a conversation.',
      },
      service: {
        title: 'PostgreSQL performance audits for SaaS teams',
        body: 'I review your PostgreSQL setup, identify slow queries, missing indexes, and RLS bottlenecks. Typical engagement is one week: I instrument your workload, produce a prioritized findings report, and pair with your team to implement the top fixes. Previous clients include three YC-backed companies.',
      },
      ask: {
        title: 'Looking for introductions to seed-stage climate tech investors in the UK',
        body: 'We are raising a pre-seed round (targeting £500k) for our carbon tracking platform aimed at small UK manufacturers. We have 8 paying customers and £30k MRR. Ideal investors are climate-focused funds or angels with manufacturing sector experience. Happy to share our deck — DM me here or email founders@example.com and I will send it over.',
      },
    };

    const kinds = ['post', 'opportunity', 'service', 'ask'] as const;
    for (const kind of kinds) {
      const payload = kindPayloads[kind];
      const created = await h.apiOk(author.token, 'content.create', {
        clubId: owner.club.id,
        kind,
        title: payload.title,
        body: payload.body,
      });
      const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
      assert.equal(entity.kind, kind, `entity should have kind=${kind}`);
    }

    // Each kind should appear in a filtered list
    const list = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
      kinds: ['post', 'opportunity', 'service', 'ask'],
      limit: 20,
    });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const foundKinds = new Set(results.map((thread) => (thread.firstEntity as Record<string, unknown>).kind));
    for (const kind of kinds) {
      assert.ok(foundKinds.has(kind), `list should include kind=${kind}`);
    }
  });
});

// ── Events ────────────────────────────────────────────────────────────────────

describe('events', () => {
  it('member creates an event and sees it in events.list', async () => {
    const owner = await h.seedOwner('event-club-1', 'EventClub1');
    const member = await h.seedCompedMember(owner.club.id, 'Iris Events');

    const created = await h.apiOk(member.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Monthly founders breakfast — May edition',
      summary: 'Casual breakfast at The Table in Shoreditch. We will go around the room and each share one thing we are stuck on and one thing working well. Bring your own coffee order, food is covered.',
      event: {
        location: 'The Table, 83 Southwark Street, London SE1',
        startsAt: '2026-05-01T18:00:00Z',
        endsAt: '2026-05-01T20:00:00Z',
        timezone: 'Europe/London',
      },
    });
    const event = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(event.entityId, 'event should have entityId');
    const version = event.version as Record<string, unknown>;
    assert.equal(version.title, 'Monthly founders breakfast — May edition');
    const eventFields = event.event as Record<string, unknown>;
    assert.ok(eventFields.startsAt, 'startsAt should be present');
    assert.ok(eventFields.endsAt, 'endsAt should be present');
    assert.equal(eventFields.timezone, 'Europe/London');

    const list = await h.apiOk(member.token, 'events.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === event.entityId);
    assert.ok(found, 'created event should appear in events.list');
  });

  it('another member can RSVP and response is visible on the event', async () => {
    const owner = await h.seedOwner('event-club-2', 'EventClub2');
    const organizer = await h.seedCompedMember(owner.club.id, 'Jack Organizer');
    const attendee = await h.seedCompedMember(owner.club.id, 'Kim Attendee');

    const created = await h.apiOk(organizer.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'RSVP test event: design review and feedback session',
      summary: 'We will review the latest design mockups for the member dashboard, collect feedback, and prioritise the next sprint of UI work. Bring your laptop if you want to follow along in Figma. Link will be shared with confirmed attendees the day before.',
      event: {
        location: 'Zoom',
        startsAt: '2026-06-15T10:00:00Z',
        endsAt: '2026-06-15T11:30:00Z',
        timezone: 'Europe/London',
      },
    });
    const event = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    const eventEntityId = event.entityId as string;

    const rsvpResult = await h.apiOk(attendee.token, 'events.rsvp', {
      eventEntityId,
      response: 'yes',
    });
    const rsvpedEvent = (rsvpResult.data as Record<string, unknown>).entity as Record<string, unknown>;
    const rsvps = rsvpedEvent.rsvps as Record<string, unknown>;
    assert.equal(rsvps.viewerResponse, 'yes');
    const counts = rsvps.counts as Record<string, number>;
    assert.ok(counts.yes >= 1, 'yes count should be at least 1 after RSVP');
  });

  it('event listing shows the event to all club members', async () => {
    const owner = await h.seedOwner('event-club-3', 'EventClub3');
    const creator = await h.seedCompedMember(owner.club.id, 'Leo Creator');
    const viewer = await h.seedCompedMember(owner.club.id, 'Mia Viewer');

    const created = await h.apiOk(creator.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Open office hours: ask me anything about fundraising',
      summary: 'I raised a $2M seed round last year and am happy to share what I learned. Drop in with questions about pitch decks, term sheets, investor outreach, or anything else related to early-stage fundraising. Link will be shared with RSVPs.',
      event: {
        location: 'Google Meet',
        startsAt: '2026-07-01T14:00:00Z',
        endsAt: '2026-07-01T15:30:00Z',
        timezone: 'Europe/London',
      },
    });
    const event = (created.data as Record<string, unknown>).entity as Record<string, unknown>;

    const list = await h.apiOk(viewer.token, 'events.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === event.entityId);
    assert.ok(found, 'event should be visible to other club members');
  });

  it('events have proper fields: title, summary, startsAt, endsAt, timezone, capacity', async () => {
    const owner = await h.seedOwner('event-club-4', 'EventClub4');
    const member = await h.seedCompedMember(owner.club.id, 'Ned Fields');

    const created = await h.apiOk(member.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Full-day workshop: building production-ready APIs with TypeScript and Postgres',
      summary: 'Hands-on workshop covering schema design, connection pooling, RLS policies, and deployment. We will build a complete API from scratch by the end of the day.',
      body: 'This is a full-day intensive workshop for backend engineers who want to level up their API skills. We will cover schema design with row-level security, connection pooling with PgBouncer, testing strategies, and zero-downtime deployments. Lunch and snacks provided.',
      event: {
        location: 'WeWork, 115 Broadway, New York, NY 10006',
        startsAt: '2026-07-10T09:00:00Z',
        endsAt: '2026-07-10T17:00:00Z',
        timezone: 'America/New_York',
        capacity: 50,
      },
    });
    const event = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(event.entityId, 'should have entityId');
    assert.ok(event.clubId, 'should have clubId');
    assert.ok(event.author, 'should have author');
    assert.ok(event.createdAt, 'should have createdAt');

    const version = event.version as Record<string, unknown>;
    assert.equal(version.title, 'Full-day workshop: building production-ready APIs with TypeScript and Postgres');
    assert.equal(version.state, 'published');
    const eventFields = event.event as Record<string, unknown>;
    assert.ok(eventFields.startsAt, 'startsAt should be present');
    assert.ok(eventFields.endsAt, 'endsAt should be present');
    assert.equal(eventFields.timezone, 'America/New_York');
    assert.equal(eventFields.capacity, 50);

    const rsvps = event.rsvps as Record<string, unknown>;
    assert.ok(rsvps, 'should have rsvps block');
    assert.equal(rsvps.viewerResponse, null, 'creator has no RSVP yet');
    const counts = rsvps.counts as Record<string, number>;
    assert.ok(typeof counts.yes === 'number', 'rsvps.counts.yes should be a number');
    assert.ok(typeof counts.maybe === 'number', 'rsvps.counts.maybe should be a number');
    assert.ok(typeof counts.no === 'number', 'rsvps.counts.no should be a number');
    assert.ok(typeof counts.waitlist === 'number', 'rsvps.counts.waitlist should be a number');
  });
});
