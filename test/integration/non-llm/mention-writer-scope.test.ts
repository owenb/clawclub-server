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

describe('content mention writer scope', () => {
  it('rejects mentions outside the writer scope without distinguishing why they failed', async () => {
    const owner = await h.seedOwner('mention-writer-club', 'Mention Writer Club');
    const author = await h.seedCompedMember(owner.club.id, 'Writer Scope Author');
    const outsider = await h.seedMember('Writer Scope Outsider');
    const span = mentionSpan('Writer Scope Outsider', outsider.id);

    const { status, body } = await h.api(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${span} for context.`,
    });

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_mentions');
    assert.deepEqual((error.details as Record<string, unknown>).invalidSpans, [{
      mentionText: span,
      memberId: outsider.id,
      reason: 'not_resolvable',
    }]);
  });
});
