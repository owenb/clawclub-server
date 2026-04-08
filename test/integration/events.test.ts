import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({
    qualityGate: async () => ({
      status: 'passed',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('events', () => {
  it('events.create with endsAt before startsAt returns 400', async () => {
    const owner = await h.seedOwner('evt-time', 'EvtTime');
    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Bad Event',
      summary: 'Time travel',
      location: 'Nowhere',
      startsAt: '2026-06-01T20:00:00Z',
      endsAt: '2026-06-01T18:00:00Z',
    });
    assert.equal(err.status, 400);
    assert.match(err.message, /endsAt/);
  });

  it('events.create happy path works', async () => {
    const owner = await h.seedOwner('evt-ok', 'EvtOk');
    const result = await h.apiOk(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Good Event',
      summary: 'All good',
      location: 'London',
      startsAt: '2026-06-01T18:00:00Z',
      endsAt: '2026-06-01T20:00:00Z',
    });
    assert.ok((result.data as Record<string, unknown>).event);
  });
});

// ── clientKey idempotency ───────────────────────────────────────────────────

describe('content.create clientKey', () => {
  it('same key + same payload returns the original entity', async () => {
    const owner = await h.seedOwner('ck-content-ok', 'CKContentOK');
    const payload = {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Idempotent post',
      body: 'Same body',
      clientKey: 'content-replay-1',
    };

    const first = await h.apiOk(owner.token, 'content.create', payload);
    const firstEntity = (first.data as Record<string, unknown>).entity as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'content.create', payload);
    const secondEntity = (second.data as Record<string, unknown>).entity as Record<string, unknown>;

    assert.equal(secondEntity.entityId, firstEntity.entityId, 'same clientKey + payload should return same entity');
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

  it('same key + reordered content JSON keys is accepted as replay', async () => {
    const owner = await h.seedOwner('ck-content-json', 'CKContentJSON');

    const first = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'JSON order post',
      body: 'Body',
      content: { alpha: 1, beta: 2 },
      clientKey: 'content-json-order-1',
    });
    const firstEntity = (first.data as Record<string, unknown>).entity as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'JSON order post',
      body: 'Body',
      content: { beta: 2, alpha: 1 },
      clientKey: 'content-json-order-1',
    });
    const secondEntity = (second.data as Record<string, unknown>).entity as Record<string, unknown>;

    assert.equal(secondEntity.entityId, firstEntity.entityId, 'reordered JSON keys should be treated as same payload');
  });
});

describe('events.create clientKey', () => {
  it('same key + same payload returns the original event', async () => {
    const owner = await h.seedOwner('ck-event-ok', 'CKEventOK');
    const payload = {
      clubId: owner.club.id,
      title: 'Idempotent event',
      summary: 'Same summary',
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      clientKey: 'event-replay-1',
    };

    const first = await h.apiOk(owner.token, 'events.create', payload);
    const firstEvent = (first.data as Record<string, unknown>).event as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'events.create', payload);
    const secondEvent = (second.data as Record<string, unknown>).event as Record<string, unknown>;

    assert.equal(secondEvent.entityId, firstEvent.entityId, 'same clientKey + payload should return same event');
  });

  it('same key + different payload returns 409 client_key_conflict', async () => {
    const owner = await h.seedOwner('ck-event-conflict', 'CKEventConflict');

    await h.apiOk(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Original event',
      summary: 'Original summary',
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      clientKey: 'event-conflict-1',
    });

    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Different event',
      summary: 'Different summary',
      location: 'Paris',
      startsAt: '2026-07-01T18:00:00Z',
      clientKey: 'event-conflict-1',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('same key + different startsAt returns 409', async () => {
    const owner = await h.seedOwner('ck-event-time', 'CKEventTime');

    await h.apiOk(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Timed event',
      summary: 'Summary',
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      clientKey: 'event-time-1',
    });

    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Timed event',
      summary: 'Summary',
      location: 'London',
      startsAt: '2026-08-01T18:00:00Z',
      clientKey: 'event-time-1',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('same key + different capacity returns 409', async () => {
    const owner = await h.seedOwner('ck-event-cap', 'CKEventCap');

    await h.apiOk(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Capped event',
      summary: 'Summary',
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      capacity: 50,
      clientKey: 'event-cap-1',
    });

    const err = await h.apiErr(owner.token, 'events.create', {
      clubId: owner.club.id,
      title: 'Capped event',
      summary: 'Summary',
      location: 'London',
      startsAt: '2026-07-01T18:00:00Z',
      capacity: 100,
      clientKey: 'event-cap-1',
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });
});
