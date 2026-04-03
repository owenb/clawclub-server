import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getHarness } from './setup.ts';
import type { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await getHarness();
}, { timeout: 30_000 });

// ── Entities ──────────────────────────────────────────────────────────────────

describe('entities', () => {
  it('member creates a post and sees it in entities.list', async () => {
    const owner = await h.seedOwner('entity-club-1', 'EntityClub1');
    const author = await h.seedClubMember(owner.club.id, 'Alice Author', 'alice-entity-1', { sponsorId: owner.id });

    const created = await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Hello World',
      summary: 'A test post',
      body: 'Some body text',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.ok(entity.entityId, 'entity should have entityId');
    assert.equal(entity.kind, 'post');
    const version = entity.version as Record<string, unknown>;
    assert.equal(version.title, 'Hello World');
    assert.equal(version.state, 'published');

    const list = await h.apiOk(author.token, 'entities.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === entity.entityId);
    assert.ok(found, 'created post should appear in entities.list');
  });

  it('another club member also sees the post in their entities.list', async () => {
    const owner = await h.seedOwner('entity-club-2', 'EntityClub2');
    const author = await h.seedClubMember(owner.club.id, 'Bob Author', 'bob-entity-2', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Carol Viewer', 'carol-entity-2', { sponsorId: owner.id });

    const created = await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Shared Post',
      summary: 'Visible to all members',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;

    const list = await h.apiOk(viewer.token, 'entities.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === entity.entityId);
    assert.ok(found, 'club member should see post created by another member');
  });

  it('member not in the club cannot see the post', async () => {
    const owner = await h.seedOwner('entity-club-3', 'EntityClub3');
    const author = await h.seedClubMember(owner.club.id, 'Dave Author', 'dave-entity-3', { sponsorId: owner.id });
    const outsider = await h.seedMember('Eve Outsider', 'eve-entity-3');

    // Add outsider to a different club so they have at least one membership
    const otherOwner = await h.seedOwner('entity-other-club-3', 'OtherClub3');
    await h.seedMembership(otherOwner.club.id, outsider.id, { sponsorId: otherOwner.id });

    await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Private Post',
    });

    // Outsider requesting the specific club should be forbidden
    const err = await h.apiErr(outsider.token, 'entities.list', { clubId: owner.club.id });
    assert.equal(err.code, 'forbidden');
  });

  it('author can update the post via entities.update and change is visible in list', async () => {
    const owner = await h.seedOwner('entity-club-4', 'EntityClub4');
    const author = await h.seedClubMember(owner.club.id, 'Frank Author', 'frank-entity-4', { sponsorId: owner.id });

    const created = await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Original Title',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    const entityId = entity.entityId as string;

    const updated = await h.apiOk(author.token, 'entities.update', {
      entityId,
      title: 'Updated Title',
      summary: 'Now with a summary',
    });
    const updatedEntity = (updated.data as Record<string, unknown>).entity as Record<string, unknown>;
    const updatedVersion = updatedEntity.version as Record<string, unknown>;
    assert.equal(updatedVersion.title, 'Updated Title');
    assert.equal(updatedVersion.summary, 'Now with a summary');

    const list = await h.apiOk(author.token, 'entities.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === entityId) as Record<string, unknown> | undefined;
    assert.ok(found, 'updated entity should appear in list');
    const foundVersion = found!.version as Record<string, unknown>;
    assert.equal(foundVersion.title, 'Updated Title');
  });

  it('author archives the post and it disappears from list', async () => {
    const owner = await h.seedOwner('entity-club-5', 'EntityClub5');
    const author = await h.seedClubMember(owner.club.id, 'Grace Author', 'grace-entity-5', { sponsorId: owner.id });

    const created = await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'To Be Archived',
    });
    const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
    const entityId = entity.entityId as string;

    await h.apiOk(author.token, 'entities.archive', { entityId });

    const list = await h.apiOk(author.token, 'entities.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === entityId);
    assert.equal(found, undefined, 'archived post should not appear in entities.list');
  });

  it('all entity kinds can be created: post, opportunity, service, ask', async () => {
    const owner = await h.seedOwner('entity-club-kinds', 'EntityClubKinds');
    const author = await h.seedClubMember(owner.club.id, 'Hal Kinds', 'hal-entity-kinds', { sponsorId: owner.id });

    const kinds = ['post', 'opportunity', 'service', 'ask'] as const;
    for (const kind of kinds) {
      const created = await h.apiOk(author.token, 'entities.create', {
        clubId: owner.club.id,
        kind,
        title: `A ${kind} entity`,
      });
      const entity = (created.data as Record<string, unknown>).entity as Record<string, unknown>;
      assert.equal(entity.kind, kind, `entity should have kind=${kind}`);
    }

    // Each kind should appear in a filtered list
    const list = await h.apiOk(author.token, 'entities.list', {
      clubId: owner.club.id,
      kinds: ['post', 'opportunity', 'service', 'ask'],
      limit: 20,
    });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const foundKinds = new Set(results.map((e) => e.kind));
    for (const kind of kinds) {
      assert.ok(foundKinds.has(kind), `list should include kind=${kind}`);
    }
  });
});

// ── Events ────────────────────────────────────────────────────────────────────

describe('events', () => {
  it('member creates an event and sees it in events.list', async () => {
    const owner = await h.seedOwner('event-club-1', 'EventClub1');
    const member = await h.seedClubMember(owner.club.id, 'Iris Events', 'iris-event-1', { sponsorId: owner.id });

    const created = await h.apiOk(member.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Monthly Meetup',
      summary: 'Come hang out',
      startsAt: '2026-05-01T18:00:00Z',
      endsAt: '2026-05-01T20:00:00Z',
      timezone: 'UTC',
    });
    const event = (created.data as Record<string, unknown>).event as Record<string, unknown>;
    assert.ok(event.entityId, 'event should have entityId');
    assert.ok(event.entityVersionId, 'event should have entityVersionId');
    const version = event.version as Record<string, unknown>;
    assert.equal(version.title, 'Monthly Meetup');
    assert.equal(version.summary, 'Come hang out');
    assert.ok(version.startsAt, 'startsAt should be present');
    assert.ok(version.endsAt, 'endsAt should be present');
    assert.equal(version.timezone, 'UTC');

    const list = await h.apiOk(member.token, 'events.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === event.entityId);
    assert.ok(found, 'created event should appear in events.list');
  });

  it('another member can RSVP and response is visible on the event', async () => {
    const owner = await h.seedOwner('event-club-2', 'EventClub2');
    const organizer = await h.seedClubMember(owner.club.id, 'Jack Organizer', 'jack-event-2', { sponsorId: owner.id });
    const attendee = await h.seedClubMember(owner.club.id, 'Kim Attendee', 'kim-event-2', { sponsorId: owner.id });

    const created = await h.apiOk(organizer.token, 'events.create', {
      clubId: owner.club.id,
      title: 'RSVP Test Event',
      startsAt: '2026-06-15T10:00:00Z',
    });
    const event = (created.data as Record<string, unknown>).event as Record<string, unknown>;
    const eventEntityId = event.entityId as string;

    const rsvpResult = await h.apiOk(attendee.token, 'events.rsvp', {
      eventEntityId,
      response: 'yes',
    });
    const rsvpedEvent = (rsvpResult.data as Record<string, unknown>).event as Record<string, unknown>;
    const rsvps = rsvpedEvent.rsvps as Record<string, unknown>;
    assert.equal(rsvps.viewerResponse, 'yes');
    const counts = rsvps.counts as Record<string, number>;
    assert.ok(counts.yes >= 1, 'yes count should be at least 1 after RSVP');
  });

  it('event listing shows the event to all club members', async () => {
    const owner = await h.seedOwner('event-club-3', 'EventClub3');
    const creator = await h.seedClubMember(owner.club.id, 'Leo Creator', 'leo-event-3', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Mia Viewer', 'mia-event-3', { sponsorId: owner.id });

    const created = await h.apiOk(creator.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Visible Event',
      summary: 'Everyone should see this',
    });
    const event = (created.data as Record<string, unknown>).event as Record<string, unknown>;

    const list = await h.apiOk(viewer.token, 'events.list', { clubId: owner.club.id });
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((e) => e.entityId === event.entityId);
    assert.ok(found, 'event should be visible to other club members');
  });

  it('events have proper fields: title, summary, startsAt, endsAt, timezone, capacity', async () => {
    const owner = await h.seedOwner('event-club-4', 'EventClub4');
    const member = await h.seedClubMember(owner.club.id, 'Ned Fields', 'ned-event-4', { sponsorId: owner.id });

    const created = await h.apiOk(member.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Full Fields Event',
      summary: 'An event with all fields',
      body: 'Join us for a great time.',
      startsAt: '2026-07-10T09:00:00Z',
      endsAt: '2026-07-10T17:00:00Z',
      timezone: 'America/New_York',
      capacity: 50,
    });
    const event = (created.data as Record<string, unknown>).event as Record<string, unknown>;
    assert.ok(event.entityId, 'should have entityId');
    assert.ok(event.entityVersionId, 'should have entityVersionId');
    assert.ok(event.clubId, 'should have clubId');
    assert.ok(event.author, 'should have author');
    assert.ok(event.createdAt, 'should have createdAt');

    const version = event.version as Record<string, unknown>;
    assert.equal(version.title, 'Full Fields Event');
    assert.equal(version.summary, 'An event with all fields');
    assert.equal(version.body, 'Join us for a great time.');
    assert.ok(version.startsAt, 'startsAt should be present');
    assert.ok(version.endsAt, 'endsAt should be present');
    assert.equal(version.timezone, 'America/New_York');
    assert.equal(version.capacity, 50);
    assert.equal(version.state, 'published');

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
