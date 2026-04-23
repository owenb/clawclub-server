import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('vouch scope', () => {
  it('returns one opaque rejection body for every inaccessible vouchee case', async () => {
    const clubX = await h.seedOwner('vouch-scope-x', 'Vouch Scope X');
    const clubY = await h.seedOwner('vouch-scope-y', 'Vouch Scope Y');
    const actor = await h.seedCompedMember(clubX.club.id, 'Vouch Scope Actor');
    const actorOnlyY = await h.seedCompedMember(clubY.club.id, 'Vouch Scope Y Actor');
    const targetInX = await h.seedCompedMember(clubX.club.id, 'Vouch Scope Target X');
    const targetInY = await h.seedCompedMember(clubY.club.id, 'Vouch Scope Target Y');

    await h.seedClubMembership(clubY.club.id, actor.id, { status: 'active', access: 'comped' });

    const success = await h.apiOk(actor.token, 'vouches.create', {
      clubId: clubX.club.id,
      memberId: targetInX.id,
      reason: 'I watched them run three shipping-critical launches and they handled each one cleanly.',
    });
    assert.ok((success.data as Record<string, unknown>).vouch, 'expected the shared-club vouch to succeed');

    const otherClubBody = await h.api(actor.token, 'vouches.create', {
      clubId: clubX.club.id,
      memberId: targetInY.id,
      reason: 'They delivered every launch review on time and with concrete detail.',
    });
    const inaccessibleClubBody = await h.api(actorOnlyY.token, 'vouches.create', {
      clubId: clubX.club.id,
      memberId: targetInX.id,
      reason: 'They delivered every launch review on time and with concrete detail.',
    });
    const nonexistentBody = await h.api(actor.token, 'vouches.create', {
      clubId: clubX.club.id,
      memberId: 'zzzzzzzzzzzz',
      reason: 'They delivered every launch review on time and with concrete detail.',
    });
    const selfBody = await h.api(actor.token, 'vouches.create', {
      clubId: clubX.club.id,
      memberId: actor.id,
      reason: 'They delivered every launch review on time and with concrete detail.',
    });

    for (const response of [otherClubBody, inaccessibleClubBody, nonexistentBody, selfBody]) {
      assert.equal(response.status, 404);
      assert.equal(response.body.ok, false);
    }
    assert.deepEqual(inaccessibleClubBody, otherClubBody);
    assert.deepEqual(nonexistentBody, otherClubBody);
    assert.deepEqual(selfBody, otherClubBody);
    assert.deepEqual(otherClubBody.body, {
      ok: false,
      error: {
        code: 'vouchee_not_accessible',
        message: 'This member is not vouchable.',
      },
    });
  });
});
