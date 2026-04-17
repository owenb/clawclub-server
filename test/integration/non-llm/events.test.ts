import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({
    llmGate: async () => ({
      status: 'passed',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function createEvent(token: string, clubId: string, overrides: Record<string, unknown> = {}) {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'event',
    title: 'Club Event',
    summary: 'Event summary',
    body: 'Event body',
    event: {
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      endsAt: '2026-07-01T20:00:00Z',
      timezone: 'Europe/London',
      recurrenceRule: null,
      capacity: 50,
    },
    ...overrides,
  });
  return (result.data as Record<string, unknown>).content as Record<string, unknown>;
}

describe('events', () => {
  it('content.create kind=event with endsAt before startsAt returns 400', async () => {
    const owner = await h.seedOwner('evt-time', 'EvtTime');
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Bad Event',
      summary: 'Time travel',
      event: {
        location: 'Nowhere',
        startsAt: '2026-06-01T20:00:00Z',
        endsAt: '2026-06-01T18:00:00Z',
      },
    });
    assert.equal(err.status, 400);
    assert.match(err.message, /event\.endsAt/);
  });

  it('content.create kind=event returns event content and events.list finds it', async () => {
    const owner = await h.seedOwner('evt-ok', 'EvtOk');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Good Event',
      summary: 'All good',
      event: {
        location: 'London',
        startsAt: '2026-06-01T18:00:00Z',
        endsAt: '2026-06-01T20:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 25,
      },
    });

    assert.equal(created.kind, 'event');
    assert.ok(created.threadId);
    const event = created.event as Record<string, unknown>;
    assert.equal(event.location, 'London');
    assert.equal(event.timezone, 'Europe/London');
    assert.equal(event.recurrenceRule, null);
    assert.equal(event.capacity, 25);
    assert.equal(new Date(event.startsAt as string).toISOString(), '2026-06-01T18:00:00.000Z');
    assert.equal(new Date(event.endsAt as string).toISOString(), '2026-06-01T20:00:00.000Z');
    assert.deepEqual(created.rsvps, {
      viewerResponse: null,
      counts: { yes: 0, maybe: 0, no: 0, waitlist: 0 },
      attendees: [],
    });

    const listed = await h.apiOk(owner.token, 'events.list', {
      clubId: owner.club.id,
      limit: 20,
      cursor: null,
    });

    const results = (listed.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const match = results.find(result => result.id === created.id);
    assert.ok(match, 'events.list should include the created event');
    assert.equal(match?.kind, 'event');
  });

  it('events.rsvp and events.cancelRsvp update the public event view', async () => {
    const owner = await h.seedOwner('evt-rsvp-owner', 'EvtRsvpOwner');
    const attendee = await h.seedCompedMember(owner.club.id, 'Rsvp Attendee');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'RSVP Event',
      event: {
        location: 'Manchester',
        startsAt: '2026-08-01T18:00:00Z',
        endsAt: '2026-08-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 10,
      },
    });

    const afterYes = await h.apiOk(attendee.token, 'events.rsvp', {
      eventId: created.id,
      response: 'yes',
      note: 'Count me in',
    });
    const yesEntity = (afterYes.data as Record<string, unknown>).event as Record<string, unknown>;
    assert.equal((yesEntity.rsvps as Record<string, unknown>).viewerResponse, 'yes');
    assert.deepEqual((yesEntity.rsvps as Record<string, unknown>).counts, {
      yes: 1,
      maybe: 0,
      no: 0,
      waitlist: 0,
    });
    assert.equal(((yesEntity.rsvps as Record<string, unknown>).attendees as Array<unknown>).length, 1);

    const afterCancel = await h.apiOk(attendee.token, 'events.cancelRsvp', {
      eventId: created.id,
    });
    const cancelledEntity = (afterCancel.data as Record<string, unknown>).event as Record<string, unknown>;
    assert.equal((cancelledEntity.rsvps as Record<string, unknown>).viewerResponse, null);
    assert.deepEqual((cancelledEntity.rsvps as Record<string, unknown>).counts, {
      yes: 0,
      maybe: 0,
      no: 0,
      waitlist: 0,
    });
    assert.deepEqual((cancelledEntity.rsvps as Record<string, unknown>).attendees, []);
  });
});

describe('content.create clientKey', () => {
  it('same key + same payload returns the original content', async () => {
    const owner = await h.seedOwner('ck-content-ok', 'CKContentOK');
    const payload = {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Idempotent post',
      body: 'Same body',
      clientKey: 'content-replay-1',
    };

    const first = await h.apiOk(owner.token, 'content.create', payload);
    const firstContent = (first.data as Record<string, unknown>).content as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'content.create', payload);
    const secondContent = (second.data as Record<string, unknown>).content as Record<string, unknown>;

    assert.equal(secondContent.id, firstContent.id, 'same clientKey + payload should return the same content');
  });

  it('same key + different payload returns 409 client_key_conflict', async () => {
    const owner = await h.seedOwner('ck-content-conflict', 'CKContentConflict');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Original title',
      body: 'Original body',
      clientKey: 'content-conflict-1',
    });

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Different title',
      body: 'Different body',
      clientKey: 'content-conflict-1',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('same key + different expiresAt returns 409', async () => {
    const owner = await h.seedOwner('ck-content-exp', 'CKContentExp');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Expiring post',
      body: 'Body',
      expiresAt: '2026-12-01T00:00:00Z',
      clientKey: 'content-expires-1',
    });

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Expiring post',
      body: 'Body',
      expiresAt: '2027-01-01T00:00:00Z',
      clientKey: 'content-expires-1',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

});

describe('content.create(kind=event) clientKey', () => {
  it('same key + same payload returns the original event', async () => {
    const owner = await h.seedOwner('ck-event-ok', 'CKEventOK');
    const payload = {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Idempotent event',
      summary: 'Same summary',
      clientKey: 'event-replay-1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
        endsAt: null,
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: null,
      },
    };

    const first = await h.apiOk(owner.token, 'content.create', payload);
    const firstEvent = (first.data as Record<string, unknown>).content as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'content.create', payload);
    const secondEvent = (second.data as Record<string, unknown>).content as Record<string, unknown>;

    assert.equal(secondEvent.id, firstEvent.id, 'same clientKey + payload should return same event');
  });

  it('same key + different payload returns 409 client_key_conflict', async () => {
    const owner = await h.seedOwner('ck-event-conflict', 'CKEventConflict');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Original event',
      summary: 'Original summary',
      clientKey: 'event-conflict-1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Different event',
      summary: 'Different summary',
      clientKey: 'event-conflict-1',
      event: {
        location: 'Paris',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('same key + different startsAt returns 409', async () => {
    const owner = await h.seedOwner('ck-event-time', 'CKEventTime');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Timed event',
      summary: 'Summary',
      clientKey: 'event-time-1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
      },
    });

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Timed event',
      summary: 'Summary',
      clientKey: 'event-time-1',
      event: {
        location: 'London',
        startsAt: '2026-08-01T18:00:00Z',
      },
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('same key + different capacity returns 409', async () => {
    const owner = await h.seedOwner('ck-event-cap', 'CKEventCap');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Capped event',
      summary: 'Summary',
      clientKey: 'event-cap-1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
        capacity: 50,
      },
    });

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Capped event',
      summary: 'Summary',
      clientKey: 'event-cap-1',
      event: {
        location: 'London',
        startsAt: '2026-07-01T18:00:00Z',
        capacity: 100,
      },
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });
});
