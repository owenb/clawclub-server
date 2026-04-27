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

function firstThreadContent(result: Record<string, unknown>): Record<string, unknown> {
  const contents = ((result.data as Record<string, unknown>).contents as Record<string, unknown>).results as Array<Record<string, unknown>>;
  const first = contents[0];
  assert.ok(first, 'content.get should return at least one content item');
  return first;
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

describe('content mention reader scope', () => {
  it('hides cross-club mention hydration from readers who do not share that club', async () => {
    const clubX = await h.seedOwner('mention-reader-x', 'Mention Reader X');
    const clubY = await h.seedOwner('mention-reader-y', 'Mention Reader Y');
    const author = await h.seedCompedMember(clubX.club.id, 'Reader Scope Author');
    const reader = await h.seedCompedMember(clubX.club.id, 'Reader Scope Reader');
    const target = await h.seedCompedMember(clubY.club.id, 'Reader Scope Target');

    await h.seedClubMembership(clubY.club.id, author.id, { status: 'active', access: 'comped' });

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: clubX.club.id,
      kind: 'post',
      body: `Please talk to ${mentionSpan('Reader Scope Target', target.id)}.`,
    });
    assert.equal(included(created)[target.id]?.publicName, 'Reader Scope Target');

    const thread = await h.apiOk(reader.token, 'content.get', {
      threadId: content(created).threadId as string,
      limit: 20,
    });
    const threadContent = firstThreadContent(thread);
    assert.deepEqual(versionMentions(threadContent).body, []);
    assert.equal(included(thread)[target.id], undefined);
    assert.match(String((threadContent.version as Record<string, unknown>).body), new RegExp(target.id));
  });
});
