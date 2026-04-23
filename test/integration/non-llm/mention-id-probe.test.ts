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

describe('mention id probes', () => {
  it('does not distinguish inaccessible member ids from nonexistent ones', async () => {
    const clubX = await h.seedOwner('mention-probe-x', 'Mention Probe X');
    const clubY = await h.seedOwner('mention-probe-y', 'Mention Probe Y');
    const author = await h.seedCompedMember(clubX.club.id, 'Probe Author');
    const inaccessible = await h.seedCompedMember(clubY.club.id, 'Probe Inaccessible');
    const bogusId = 'zzzzzzzzzzzz';

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: clubX.club.id,
      kind: 'post',
      body: [
        mentionSpan('Probe Inaccessible', inaccessible.id),
        mentionSpan('Probe Ghost', bogusId),
      ].join(' '),
    });

    const createdContent = content(created);
    assert.deepEqual(versionMentions(createdContent).body, []);
    assert.deepEqual(included(created), {});
    assert.match(String((createdContent.version as Record<string, unknown>).body), new RegExp(inaccessible.id));
    assert.match(String((createdContent.version as Record<string, unknown>).body), new RegExp(bogusId));
  });
});
