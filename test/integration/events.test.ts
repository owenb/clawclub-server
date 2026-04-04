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
