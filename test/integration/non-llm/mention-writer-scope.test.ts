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

function content(result: Record<string, unknown>): Record<string, unknown> {
  return (result.data as Record<string, unknown>).content as Record<string, unknown>;
}

function included(result: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((result.data as Record<string, unknown>).included as Record<string, unknown>).membersById as Record<string, Record<string, unknown>>;
}

function versionMentions(contentResult: Record<string, unknown>): Record<string, Array<Record<string, unknown>>> {
  return ((contentResult.version as Record<string, unknown>).mentions as Record<string, Array<Record<string, unknown>>>);
}

function mentionSpan(label: string, memberId: string): string {
  return `[${label}|${memberId}]`;
}

describe('content mention writer scope', () => {
  it('accepts the write but does not resolve mentions outside the writer scope', async () => {
    const owner = await h.seedOwner('mention-writer-club', 'Mention Writer Club');
    const author = await h.seedCompedMember(owner.club.id, 'Writer Scope Author');
    const outsider = await h.seedMember('Writer Scope Outsider');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${mentionSpan('Writer Scope Outsider', outsider.id)} for context.`,
    });

    const createdContent = content(created);
    assert.deepEqual(versionMentions(createdContent).body, []);
    assert.equal(included(created)[outsider.id], undefined);
    assert.match(String((createdContent.version as Record<string, unknown>).body), new RegExp(outsider.id));
  });
});
