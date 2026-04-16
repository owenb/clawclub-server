import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickPrompt } from '../../src/gate.ts';

describe('pickPrompt', () => {
  it('selects the top-level content prompt for non-replies', () => {
    assert.match(pickPrompt({
      kind: 'content',
      entityKind: 'post',
      isReply: false,
      title: 'Title',
      summary: null,
      body: 'Body',
    }), /quality check for text posts in a private members club thread/);
  });

  it('selects the reply prompt for replies', () => {
    assert.match(pickPrompt({
      kind: 'content',
      entityKind: 'post',
      isReply: true,
      title: null,
      summary: null,
      body: 'yes',
    }), /legality check for a reply inside a private members club thread/);
  });

  it('selects the event prompt', () => {
    assert.match(pickPrompt({
      kind: 'event',
      title: 'Event',
      summary: null,
      body: null,
      location: 'Online',
      startsAt: '2026-01-01T10:00:00Z',
      endsAt: null,
      timezone: null,
    }), /sense-check for events/);
  });

  it('selects the profile prompt', () => {
    assert.match(pickPrompt({
      kind: 'profile',
      tagline: null,
      summary: null,
      whatIDo: null,
      knownFor: null,
      servicesSummary: null,
      websiteUrl: null,
      links: [],
    }), /club-scoped profile/);
  });

  it('selects the vouch prompt', () => {
    assert.match(pickPrompt({
      kind: 'vouch',
      reason: 'Reason',
    }), /one member endorsing another/);
  });

  it('selects the invitation prompt', () => {
    assert.match(pickPrompt({
      kind: 'invitation',
      reason: 'Reason',
    }), /invitation reason/);
  });
});
