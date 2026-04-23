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

describe('content mentions', () => {
  it('hydrates [Name|id] mentions with current display name across reads', async () => {
    const owner = await h.seedOwner('mention-thread-club', 'Mention Thread Club');
    const author = await h.seedCompedMember(owner.club.id, 'Mention Author');
    const kilian = await h.seedCompedMember(owner.club.id, 'Kilian Valdman');

    const rootResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: `Thanks ${mentionSpan('Kilian Valdman', kilian.id)}`,
      body: `I debated with ${mentionSpan('Kilian Valdman', kilian.id)} whether we should build a frontend.`,
    });
    const root = content(rootResult);
    const rootMentions = versionMentions(root);
    assert.equal(rootMentions.title.length, 1);
    assert.equal(rootMentions.body.length, 1);
    assert.equal(rootMentions.title[0]?.memberId, kilian.id);
    assert.equal(rootMentions.title[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(rootMentions.body[0]?.memberId, kilian.id);
    assert.equal(rootMentions.body[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(included(rootResult)[kilian.id]?.publicName, 'Kilian Valdman');

    // Update display name globally — hydrated display name follows, authoredLabel stays.
    await h.apiOk(kilian.token, 'accounts.updateIdentity', {
      displayName: 'Kilian (renamed)',
    });

    const thread = await h.apiOk(author.token, 'content.get', {
      threadId: root.threadId as string,
      limit: 20,
    });
    const firstContent = ((thread.data as Record<string, unknown>).thread as Record<string, unknown>).firstContent as Record<string, unknown>;
    assert.equal(versionMentions(firstContent).title[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(included(thread)[kilian.id]?.displayName, 'Kilian (renamed)');
  });

  it('silently omits mentions with unknown member ids', async () => {
    const owner = await h.seedOwner('mention-unknown-club', 'Mention Unknown Club');
    const author = await h.seedCompedMember(owner.club.id, 'Unknown Author');

    const bogusId = 'zzzzzzzzzzzz'; // valid short_id format, does not exist
    const result = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Pinging ${mentionSpan('Ghost', bogusId)} about something.`,
    });
    const createdContent = content(result);
    assert.deepEqual(versionMentions(createdContent).body, []);
    assert.deepEqual(included(result), {});
    assert.match(String((createdContent.version as Record<string, unknown>).body), new RegExp(bogusId));
  });

  it('canonicalises caller-supplied mention labels to the member publicName on write', async () => {
    const owner = await h.seedOwner('mention-canon-write-club', 'Mention Canon Write Club');
    const author = await h.seedCompedMember(owner.club.id, 'Canon Content Author');
    const target = await h.seedCompedMember(owner.club.id, 'Canon Content Target');

    const result = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${mentionSpan('Wrong Label', target.id)}.`,
    });
    const createdContent = content(result);
    const mentions = versionMentions(createdContent).body;

    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, target.id);
    assert.equal(mentions[0]?.authoredLabel, target.publicName);
  });

  it('canonicalises persisted spoofed mention labels on read', async () => {
    const owner = await h.seedOwner('mention-canon-read-club', 'Mention Canon Read Club');
    const author = await h.seedCompedMember(owner.club.id, 'Canon Read Author');
    const target = await h.seedCompedMember(owner.club.id, 'Canon Read Target');

    const result = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${mentionSpan('Canon Read Target', target.id)}.`,
    });
    const createdContent = content(result);
    const contentId = createdContent.id as string;
    const threadId = createdContent.threadId as string;

    await h.sql(
      `update content_version_mentions cvm
          set authored_label = 'Spoofed Content Label'
         from content_versions cv
        where cv.id = cvm.content_version_id
          and cv.content_id = $1`,
      [contentId],
    );

    const readResult = await h.apiOk(author.token, 'content.get', { threadId });
    const firstContent = ((readResult.data as Record<string, unknown>).thread as Record<string, unknown>).firstContent as Record<string, unknown>;
    const mentions = versionMentions(firstContent).body;

    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, target.id);
    assert.equal(mentions[0]?.authoredLabel, target.publicName);
  });

  it('omits mentions for members outside the writer scope', async () => {
    const owner = await h.seedOwner('mention-scope-club', 'Mention Scope Club');
    const author = await h.seedCompedMember(owner.club.id, 'Scope Author');
    const outsider = await h.seedMember('Outsider');

    const result = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${mentionSpan('Outsider', outsider.id)}.`,
    });
    const createdContent = content(result);
    assert.deepEqual(versionMentions(createdContent).body, []);
    assert.deepEqual(included(result), {});
  });

  it('enforces mention caps on create', async () => {
    const owner = await h.seedOwner('mention-cap-club', 'Mention Cap Club');
    const author = await h.seedCompedMember(owner.club.id, 'Cap Author');

    // 26 unique targets → over the 25 unique member cap.
    const targets: Array<{ id: string }> = [];
    for (let i = 0; i < 26; i += 1) {
      const m = await h.seedCompedMember(owner.club.id, `Target ${i}`);
      targets.push({ id: m.id });
    }

    const body = targets.map((t) => mentionSpan('T', t.id)).join(' ');
    const err = await h.apiErr(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /25 unique mentions and 100 mention spans/i);
  });

  it('suppresses mentions on removed content', async () => {
    const owner = await h.seedOwner('content-remove-club', 'Content Remove Club');
    const author = await h.seedCompedMember(owner.club.id, 'Remove Author');
    const target = await h.seedCompedMember(owner.club.id, 'Remove Target');

    const root = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Visible root',
      body: 'No mentions here.',
    });
    const reply = await h.apiOk(author.token, 'content.create', {
      threadId: (content(root).threadId as string),
      kind: 'post',
      title: `Reply to ${mentionSpan('Remove Target', target.id)}`,
      body: `This reply mentions ${mentionSpan('Remove Target', target.id)}.`,
    });

    await h.apiOk(author.token, 'content.remove', {
      id: content(reply).id as string,
    });

    const thread = await h.apiOk(author.token, 'content.get', {
      threadId: content(root).threadId as string,
      limit: 20,
    });
    const threadContents = ((thread.data as Record<string, unknown>).contents as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const removedReply = threadContents.find((row) => row.id === content(reply).id) as Record<string, unknown>;
    assert.deepEqual(versionMentions(removedReply), { title: [], summary: [], body: [] });
    assert.deepEqual(included(thread), {});
  });
});
