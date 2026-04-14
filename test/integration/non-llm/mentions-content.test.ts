import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ qualityGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function entity(result: Record<string, unknown>): Record<string, unknown> {
  return (result.data as Record<string, unknown>).entity as Record<string, unknown>;
}

function included(result: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((result.data as Record<string, unknown>).included as Record<string, unknown>).membersById as Record<string, Record<string, unknown>>;
}

function versionMentions(entityResult: Record<string, unknown>): Record<string, Array<Record<string, unknown>>> {
  return ((entityResult.version as Record<string, unknown>).mentions as Record<string, Array<Record<string, unknown>>>);
}

function mentionSpan(label: string, memberId: string): string {
  return `[${label}|${memberId}]`;
}

describe('content mentions', () => {
  it('hydrates [Name|id] mentions with current display name across reads', async () => {
    const owner = await h.seedOwner('mention-thread-club', 'Mention Thread Club');
    const author = await h.seedCompedMember(owner.club.id, 'Mention Author', 'mention-author');
    const kilian = await h.seedCompedMember(owner.club.id, 'Kilian Valdman', 'kilian-valdman');

    const rootResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: `Thanks ${mentionSpan('Kilian Valdman', kilian.id)}`,
      body: `I debated with ${mentionSpan('Kilian Valdman', kilian.id)} whether we should build a frontend.`,
    });
    const root = entity(rootResult);
    const rootMentions = versionMentions(root);
    assert.equal(rootMentions.title.length, 1);
    assert.equal(rootMentions.body.length, 1);
    assert.equal(rootMentions.title[0]?.memberId, kilian.id);
    assert.equal(rootMentions.title[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(rootMentions.body[0]?.memberId, kilian.id);
    assert.equal(rootMentions.body[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(included(rootResult)[kilian.id]?.publicName, 'Kilian Valdman');

    // Update display name globally — hydrated display name follows, authoredLabel stays.
    await h.apiOk(kilian.token, 'members.updateIdentity', {
      displayName: 'Kilian (renamed)',
    });

    const thread = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.contentThreadId as string,
      limit: 20,
    });
    const firstEntity = ((thread.data as Record<string, unknown>).thread as Record<string, unknown>).firstEntity as Record<string, unknown>;
    assert.equal(versionMentions(firstEntity).title[0]?.authoredLabel, 'Kilian Valdman');
    assert.equal(included(thread)[kilian.id]?.displayName, 'Kilian (renamed)');
  });

  it('rejects mentions with unknown member ids', async () => {
    const owner = await h.seedOwner('mention-unknown-club', 'Mention Unknown Club');
    const author = await h.seedCompedMember(owner.club.id, 'Unknown Author', 'mention-unknown-author');

    const bogusId = 'zzzzzzzzzzzz'; // valid short_id format, does not exist
    const err = await h.apiErr(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Pinging ${mentionSpan('Ghost', bogusId)} about something.`,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_mentions');
    assert.match(err.message, new RegExp(bogusId));
  });

  it('allows mentioning members regardless of club scope or state (id existence only)', async () => {
    // Round 6/7: scope validation removed. Mentions resolve on id alone.
    const owner = await h.seedOwner('mention-scope-club', 'Mention Scope Club');
    const author = await h.seedCompedMember(owner.club.id, 'Scope Author', 'mention-scope-author');
    // target is not a member of this club
    const outsider = await h.seedMember('Outsider', 'outsider');

    const result = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: `Tagging ${mentionSpan('Outsider', outsider.id)}.`,
    });
    const createdEntity = entity(result);
    assert.equal(versionMentions(createdEntity).body[0]?.memberId, outsider.id);
  });

  it('enforces mention caps on create', async () => {
    const owner = await h.seedOwner('mention-cap-club', 'Mention Cap Club');
    const author = await h.seedCompedMember(owner.club.id, 'Cap Author', 'mention-cap-author');

    // 26 unique targets → over the 25 unique member cap.
    const targets: Array<{ id: string }> = [];
    for (let i = 0; i < 26; i += 1) {
      const m = await h.seedCompedMember(owner.club.id, `Target ${i}`, `mention-cap-${i}`);
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
    const author = await h.seedCompedMember(owner.club.id, 'Remove Author', 'content-remove-author');
    const target = await h.seedCompedMember(owner.club.id, 'Remove Target', 'content-remove-target');

    const root = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Visible root',
      body: 'No mentions here.',
    });
    const reply = await h.apiOk(author.token, 'content.create', {
      threadId: (entity(root).contentThreadId as string),
      kind: 'post',
      title: `Reply to ${mentionSpan('Remove Target', target.id)}`,
      body: `This reply mentions ${mentionSpan('Remove Target', target.id)}.`,
    });

    await h.apiOk(author.token, 'content.remove', {
      entityId: entity(reply).entityId as string,
    });

    const thread = await h.apiOk(author.token, 'content.getThread', {
      threadId: entity(root).contentThreadId as string,
      limit: 20,
    });
    const removedReply = (((thread.data as Record<string, unknown>).entities as Array<Record<string, unknown>>)
      .find((row) => row.entityId === entity(reply).entityId) as Record<string, unknown>);
    assert.deepEqual(versionMentions(removedReply), { title: [], summary: [], body: [] });
    assert.deepEqual(included(thread), {});
  });
});
