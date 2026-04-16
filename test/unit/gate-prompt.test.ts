import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickPrompt } from '../../src/gate.ts';

describe('pickPrompt', () => {
  it('selects the content prompt', () => {
    assert.match(pickPrompt('content'), /private members club thread/);
  });

  it('selects the event prompt', () => {
    assert.match(pickPrompt('event'), /sense-check for events/);
  });

  it('selects the profile prompt', () => {
    assert.match(pickPrompt('profile'), /club-scoped profile/);
  });

  it('selects the vouch prompt', () => {
    assert.match(pickPrompt('vouch'), /one member endorsing another/);
  });

  it('selects the invitation prompt', () => {
    assert.match(pickPrompt('invitation'), /invitation reason/);
  });
});
