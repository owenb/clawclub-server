import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getNotifications } from '../helpers.ts';

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

async function createPost(token: string, clubId: string) {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'post',
    title: 'Not an event',
    body: 'This content is visible but cannot accept RSVPs.',
  });
  return (result.data as Record<string, unknown>).content as Record<string, unknown>;
}

async function withInsertDelay<T>(table: 'event_rsvps', run: () => Promise<T>): Promise<T> {
  const suffix = table.replace(/[^a-z0-9_]/g, '_');
  const functionName = `test_delay_${suffix}_insert`;
  const triggerName = `${functionName}_trigger`;
  await h.sql(
    `create or replace function ${functionName}() returns trigger
     language plpgsql
     as $$
     begin
       perform pg_sleep(0.2);
       return new;
     end;
     $$;`,
  );
  await h.sql(`drop trigger if exists ${triggerName} on ${table}`);
  await h.sql(
    `create trigger ${triggerName}
     before insert on ${table}
     for each row
     execute function ${functionName}()`,
  );

  try {
    return await run();
  } finally {
    await h.sql(`drop trigger if exists ${triggerName} on ${table}`);
    await h.sql(`drop function if exists ${functionName}()`);
  }
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

  it('events.setRsvp updates and clears the public event view', async () => {
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

    const afterYes = await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: 'yes',
      note: 'Count me in',
    });
    assert.equal(Object.hasOwn(afterYes.data as Record<string, unknown>, 'event'), false);
    const yesEntity = (afterYes.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.equal((yesEntity.rsvps as Record<string, unknown>).viewerResponse, 'yes');
    assert.deepEqual((yesEntity.rsvps as Record<string, unknown>).counts, {
      yes: 1,
      maybe: 0,
      no: 0,
      waitlist: 0,
    });
    assert.equal(((yesEntity.rsvps as Record<string, unknown>).attendees as Array<unknown>).length, 1);

    const afterCancel = await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: null,
    });
    assert.equal(Object.hasOwn(afterCancel.data as Record<string, unknown>, 'event'), false);
    const cancelledEntity = (afterCancel.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.equal((cancelledEntity.rsvps as Record<string, unknown>).viewerResponse, null);
    assert.deepEqual((cancelledEntity.rsvps as Record<string, unknown>).counts, {
      yes: 0,
      maybe: 0,
      no: 0,
      waitlist: 0,
    });
    assert.deepEqual((cancelledEntity.rsvps as Record<string, unknown>).attendees, []);
  });

  it('events.setRsvp auto-waitlists yes RSVPs once capacity is full', async () => {
    const owner = await h.seedOwner('evt-rsvp-capacity', 'EvtRsvpCapacity');
    const firstAttendee = await h.seedCompedMember(owner.club.id, 'Capacity First');
    const secondAttendee = await h.seedCompedMember(owner.club.id, 'Capacity Second');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Capacity Event',
      event: {
        location: 'Manchester',
        startsAt: '2026-08-02T18:00:00Z',
        endsAt: '2026-08-02T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 1,
      },
    });

    await h.apiOk(firstAttendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: 'yes',
      note: 'First confirmed attendee',
    });

    const waitlisted = await h.apiOk(secondAttendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: 'yes',
      note: 'Second attendee should waitlist',
    });
    const event = (waitlisted.data as Record<string, unknown>).content as Record<string, unknown>;
    const rsvps = event.rsvps as Record<string, unknown>;
    assert.equal(rsvps.viewerResponse, 'waitlist');
    assert.deepEqual(rsvps.counts, {
      yes: 1,
      maybe: 0,
      no: 0,
      waitlist: 1,
    });
  });

  it('events.setRsvp preserves an explicit waitlist RSVP even when seats remain', async () => {
    const owner = await h.seedOwner('evt-rsvp-explicit-waitlist', 'EvtRsvpExplicitWaitlist');
    const attendee = await h.seedCompedMember(owner.club.id, 'Explicit Waitlist');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Explicit Waitlist Event',
      event: {
        location: 'Manchester',
        startsAt: '2026-08-03T18:00:00Z',
        endsAt: '2026-08-03T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 5,
      },
    });

    const waitlisted = await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: 'waitlist',
      note: 'Opt me into the waitlist',
    });
    const event = (waitlisted.data as Record<string, unknown>).content as Record<string, unknown>;
    const rsvps = event.rsvps as Record<string, unknown>;
    assert.equal(rsvps.viewerResponse, 'waitlist');
    assert.deepEqual(rsvps.counts, {
      yes: 0,
      maybe: 0,
      no: 0,
      waitlist: 1,
    });
  });

  it('events.setRsvp rejects non-null RSVPs after the event has started', async () => {
    const owner = await h.seedOwner('evt-rsvp-closed', 'EvtRsvpClosed');
    const attendee = await h.seedCompedMember(owner.club.id, 'Late RSVP');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Started Event',
      event: {
        location: 'Bristol',
        startsAt: '2020-01-01T18:00:00Z',
        endsAt: '2020-01-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 10,
      },
    });

    const err = await h.apiErr(attendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: 'yes',
      note: 'Too late',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'event_rsvp_closed');
  });

  it('events.setRsvp rejects cancellations after the event has started', async () => {
    const owner = await h.seedOwner('evt-rsvp-cancel-closed', 'EvtRsvpCancelClosed');
    const attendee = await h.seedCompedMember(owner.club.id, 'Late Canceller');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Started Event For Cancel',
      event: {
        location: 'Bristol',
        startsAt: '2020-01-01T18:00:00Z',
        endsAt: '2020-01-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 10,
      },
    });

    await h.sql(
      `insert into event_rsvps (
         event_content_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id, created_at
       ) values ($1, $2, 'yes', null, 1, null, $3, '2019-12-31T18:00:00Z')`,
      [created.id, attendee.membership.id, attendee.id],
    );

    const err = await h.apiErr(attendee.token, 'events.setRsvp', {
      eventId: created.id,
      response: null,
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'event_rsvp_closed');
  });

  it('events.setRsvp returns invalid_state for visible non-event content', async () => {
    const owner = await h.seedOwner('evt-rsvp-non-event', 'Evt Rsvp Non Event');
    const attendee = await h.seedCompedMember(owner.club.id, 'Non Event RSVP Attendee');
    const post = await createPost(owner.token, owner.club.id);

    const result = await h.api(attendee.token, 'events.setRsvp', {
      eventId: post.id,
      response: 'yes',
    });

    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    const error = result.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_state');
    const details = error.details as Record<string, unknown>;
    assert.equal((details.content as Record<string, unknown>).id, post.id);
  });

  it('concurrent last-seat RSVPs settle cleanly to one yes and the rest waitlist', async () => {
    const owner = await h.seedOwner('evt-rsvp-race', 'EvtRsvpRace');
    const firstAttendee = await h.seedCompedMember(owner.club.id, 'Race First');
    const secondAttendee = await h.seedCompedMember(owner.club.id, 'Race Second');
    const thirdAttendee = await h.seedCompedMember(owner.club.id, 'Race Third');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Race Event',
      event: {
        location: 'Leeds',
        startsAt: '2026-10-02T18:00:00Z',
        endsAt: '2026-10-02T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 1,
      },
    });

    await withInsertDelay('event_rsvps', async () => {
      const responses = await Promise.all([
        h.api(firstAttendee.token, 'events.setRsvp', {
          eventId: created.id,
          response: 'yes',
          note: 'Race first',
        }),
        h.api(secondAttendee.token, 'events.setRsvp', {
          eventId: created.id,
          response: 'yes',
          note: 'Race second',
        }),
        h.api(thirdAttendee.token, 'events.setRsvp', {
          eventId: created.id,
          response: 'yes',
          note: 'Race third',
        }),
      ]);

      assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
      assert.deepEqual(responses.map(response => response.body.ok), [true, true, true]);

      const viewerResponses = responses.map((response) => {
        const data = response.body.data as Record<string, unknown>;
        const content = data.content as Record<string, unknown>;
        const rsvps = content.rsvps as Record<string, unknown>;
        return rsvps.viewerResponse;
      });
      assert.deepEqual(viewerResponses.sort(), ['waitlist', 'waitlist', 'yes']);
    });

    const ownerView = await h.apiOk(owner.token, 'content.get', { contentId: created.id });
    const contents = ((ownerView.data as Record<string, unknown>).contents as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const event = contents[0]!;
    const rsvps = event.rsvps as Record<string, unknown>;
    assert.deepEqual(rsvps.counts, {
      yes: 1,
      maybe: 0,
      no: 0,
      waitlist: 2,
    });
  });

  it('events.setRsvp notifies the event author for both create and clear', async () => {
    const owner = await h.seedOwner('evt-rsvp-notif', 'EvtRsvpNotif');
    const attendee = await h.seedCompedMember(owner.club.id, 'Rsvp Notifier');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Notification Event',
      event: {
        location: 'Bristol',
        startsAt: '2026-09-01T18:00:00Z',
        endsAt: '2026-09-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 12,
      },
    });
    const eventId = created.id as string;

    await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId,
      response: 'yes',
      note: 'See you there',
    });
    await h.apiOk(attendee.token, 'events.setRsvp', { eventId, response: null });

    const ownerNotifications = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
    const attendeeNotifications = getNotifications((await h.getNotifications(attendee.token, { limit: 20 })).body);

    const rsvpItems = ownerNotifications.results.filter((item) => item.topic === 'event.rsvp.updated');
    assert.equal(attendeeNotifications.results.some((item) => item.topic === 'event.rsvp.updated'), false);
    assert.equal(rsvpItems.length, 2, 'event author should see one notification for RSVP and one for cancellation');

    const yesItem = rsvpItems.find((item) => (item.payload as Record<string, unknown>).response === 'yes');
    const cancelledItem = rsvpItems.find((item) => (item.payload as Record<string, unknown>).response === 'cancelled');
    assert.ok(yesItem, 'event author should receive a yes RSVP notification');
    assert.ok(cancelledItem, 'event author should receive a cancelled RSVP notification');

    assert.equal(yesItem?.clubId, owner.club.id);
    const yesPayload = yesItem?.payload as Record<string, unknown>;
    assert.equal((yesPayload.event as Record<string, unknown>).contentId, eventId);
    assert.equal((yesPayload.event as Record<string, unknown>).title, 'Notification Event');
    assert.equal((yesPayload.club as Record<string, unknown>).clubId, owner.club.id);
    assert.equal((yesPayload.attendee as Record<string, unknown>).memberId, attendee.id);
    assert.equal((yesPayload.attendee as Record<string, unknown>).membershipId, attendee.membership.id);
    assert.equal((yesPayload.attendee as Record<string, unknown>).publicName, attendee.publicName);
    assert.equal(yesPayload.previousResponse, null);
    assert.equal(yesPayload.note, 'See you there');

    const yesRefs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [yesItem?.notificationId],
    );
    assert.deepEqual(yesRefs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: attendee.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'content', ref_id: eventId },
      { ref_role: 'target', ref_kind: 'membership', ref_id: attendee.membership.id },
    ]);

    const cancelledPayload = cancelledItem?.payload as Record<string, unknown>;
    assert.equal(cancelledPayload.previousResponse, 'yes');
    assert.equal(cancelledPayload.note, null);
  });

  it('an RSVP invalidates the event author notification seed over SSE', async () => {
    const owner = await h.seedOwner('evt-rsvp-sse', 'EvtRsvpSse');
    const attendee = await h.seedCompedMember(owner.club.id, 'Rsvp Streamer');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'SSE Event',
      event: {
        location: 'Leeds',
        startsAt: '2026-10-01T18:00:00Z',
        endsAt: '2026-10-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 8,
      },
    });
    const eventId = created.id as string;

    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]?.event, 'ready');

      await h.apiOk(attendee.token, 'events.setRsvp', {
        eventId,
        response: 'maybe',
        note: 'Likely yes',
      });

      await stream.waitForEvents(2);
      const dirty = stream.events.find((event) => event.event === 'notifications_dirty');
      assert.ok(dirty, 'event RSVP should invalidate the author notification seed');

      const notifications = getNotifications((await h.getNotifications(owner.token, { limit: 20 })).body);
      const item = notifications.results.find((entry) =>
        entry.topic === 'event.rsvp.updated'
        && (entry.payload as Record<string, unknown>).response === 'maybe',
      );
      assert.ok(item, 'event author should be able to fetch the RSVP notification after the dirty wakeup');
    } finally {
      stream.close();
    }
  });

  it('content.update on an event notifies current attendees', async () => {
    const owner = await h.seedOwner('evt-update-notif', 'EvtUpdateNotif');
    const attendee = await h.seedCompedMember(owner.club.id, 'Event Updater');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Original Event Title',
      event: {
        location: 'London',
        startsAt: '2026-11-01T18:00:00Z',
        endsAt: '2026-11-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 25,
      },
    });
    const eventId = created.id as string;

    await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId,
      response: 'yes',
      note: 'Booked',
    });

    await h.apiOk(owner.token, 'content.update', {
      id: eventId,
      title: 'Updated Event Title',
      event: {
        location: 'Birmingham',
        startsAt: '2026-11-01T19:00:00Z',
      },
    });

    const attendeeNotifications = getNotifications((await h.getNotifications(attendee.token, { limit: 20 })).body);
    const updateItem = attendeeNotifications.results.find((item) => item.topic === 'event.updated');
    assert.ok(updateItem, 'attendee should receive an event.updated notification');
    assert.equal(updateItem?.clubId, owner.club.id);

    const payload = updateItem?.payload as Record<string, unknown>;
    assert.equal((payload.event as Record<string, unknown>).contentId, eventId);
    assert.equal((payload.event as Record<string, unknown>).title, 'Updated Event Title');
    assert.equal((payload.event as Record<string, unknown>).location, 'Birmingham');
    assert.equal(
      new Date(String((payload.event as Record<string, unknown>).startsAt)).toISOString(),
      '2026-11-01T19:00:00.000Z',
    );
    assert.equal((payload.club as Record<string, unknown>).clubId, owner.club.id);
    assert.equal(payload.changedByMemberId, owner.id);

    const updateRefs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [updateItem?.notificationId],
    );
    assert.deepEqual(updateRefs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: owner.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'content', ref_id: eventId },
    ]);
  });

  it('content.remove on an event notifies current attendees and remains visible after removal', async () => {
    const owner = await h.seedOwner('evt-remove-notif', 'EvtRemoveNotif');
    const attendee = await h.seedCompedMember(owner.club.id, 'Event Remover');

    const created = await createEvent(owner.token, owner.club.id, {
      title: 'Removed Event',
      event: {
        location: 'Glasgow',
        startsAt: '2026-12-01T18:00:00Z',
        endsAt: '2026-12-01T19:00:00Z',
        timezone: 'Europe/London',
        recurrenceRule: null,
        capacity: 30,
      },
    });
    const eventId = created.id as string;

    await h.apiOk(attendee.token, 'events.setRsvp', {
      eventId,
      response: 'maybe',
      note: 'Will confirm later',
    });

    await h.apiOk(owner.token, 'content.remove', {
      id: eventId,
      reason: 'Venue unavailable',
    });

    const attendeeNotifications = getNotifications((await h.getNotifications(attendee.token, { limit: 20 })).body);
    const removedItem = attendeeNotifications.results.find((item) => item.topic === 'event.removed');
    assert.ok(removedItem, 'attendee should receive an event.removed notification');

    const payload = removedItem?.payload as Record<string, unknown>;
    assert.equal((payload.event as Record<string, unknown>).contentId, eventId);
    assert.equal((payload.event as Record<string, unknown>).title, 'Removed Event');
    assert.equal((payload.event as Record<string, unknown>).location, 'Glasgow');
    assert.equal(payload.reason, 'Venue unavailable');
    assert.equal(payload.changedByMemberId, owner.id);

    const removedRefs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select ref_role, ref_kind, ref_id
         from notification_refs
        where notification_id = $1
        order by ref_role, ref_kind, ref_id`,
      [removedItem?.notificationId],
    );
    assert.deepEqual(removedRefs, [
      { ref_role: 'actor', ref_kind: 'member', ref_id: owner.id },
      { ref_role: 'club_context', ref_kind: 'club', ref_id: owner.club.id },
      { ref_role: 'subject', ref_kind: 'content', ref_id: eventId },
    ]);
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
