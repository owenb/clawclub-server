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

function mentionSpan(label: string, memberId: string): string {
  return `[${label}|${memberId}]`;
}

describe('mention id probes', () => {
  it('does not distinguish inaccessible member ids from nonexistent ones', async () => {
    const clubX = await h.seedOwner('mention-probe-x', 'Mention Probe X');
    const clubY = await h.seedOwner('mention-probe-y', 'Mention Probe Y');
    const author = await h.seedCompedMember(clubX.club.id, 'Probe Author');
    const inaccessible = await h.seedCompedMember(clubY.club.id, 'Probe Inaccessible');
    const bogusId = 'zzzzzzzzzzzz';

    const result = await h.api(author.token, 'content.create', {
      clubId: clubX.club.id,
      kind: 'post',
      body: [
        mentionSpan('Probe Inaccessible', inaccessible.id),
        mentionSpan('Probe Ghost', bogusId),
      ].join(' '),
    });

    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    const error = result.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_mentions');
    const details = error.details as Record<string, unknown>;
    const invalidSpans = details.invalidSpans as Array<Record<string, unknown>>;
    assert.deepEqual(
      invalidSpans.map((span) => ({
        memberId: span.memberId,
        reason: span.reason,
      })),
      [
        { memberId: inaccessible.id, reason: 'not_resolvable' },
        { memberId: bogusId, reason: 'not_resolvable' },
      ],
    );
  });
});
