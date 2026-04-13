import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { QualityGateFn } from '../../../src/dispatch.ts';
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

function buildMentionBody(handles: string[], repeats = 1): string {
  return Array.from({ length: repeats }, () => handles.map((handle) => `@${handle}`).join(' ')).join(' ');
}

async function seedMentionTargets(
  clubId: string,
  count: number,
  prefix: string,
): Promise<Array<{ id: string; handle: string }>> {
  const targets: Array<{ id: string; handle: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const member = await h.seedCompedMember(
      clubId,
      `Mention Target ${prefix} ${index + 1}`,
      `${prefix}-${index + 1}`,
    );
    targets.push({ id: member.id, handle: member.handle });
  }
  return targets;
}

describe('content mentions', () => {
  it('hydrates mentions across thread reads, dedupes included members, and preserves authoredHandle across renames', async () => {
    const owner = await h.seedOwner('mention-thread-club', 'Mention Thread Club');
    const author = await h.seedCompedMember(owner.club.id, 'Mention Author', 'mention-author');
    const kilian = await h.seedCompedMember(owner.club.id, 'Kilian Mentioned', 'kilian-valdman-jl88rb');

    const rootResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Thanks @kilian-valdman-jl88rb',
      body: 'I also debated with @kilian-valdman-jl88rb whether we should build a frontend.',
    });
    const root = entity(rootResult);
    const rootMentions = versionMentions(root);
    assert.equal(rootMentions.title.length, 1);
    assert.equal(rootMentions.body.length, 1);
    assert.deepEqual(rootMentions.title[0], {
      memberId: kilian.id,
      authoredHandle: 'kilian-valdman-jl88rb',
      start: 7,
      end: 29,
    });
    assert.deepEqual(rootMentions.body[0], {
      memberId: kilian.id,
      authoredHandle: 'kilian-valdman-jl88rb',
      start: 20,
      end: 42,
    });
    assert.equal(included(rootResult)[kilian.id]?.handle, 'kilian-valdman-jl88rb');

    const replyResult = await h.apiOk(author.token, 'content.create', {
      threadId: root.contentThreadId as string,
      kind: 'post',
      body: 'Looping in @kilian-valdman-jl88rb again before we decide.',
    });
    const reply = entity(replyResult);

    const threadBeforeRename = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.contentThreadId as string,
      limit: 20,
    });
    const threadDataBeforeRename = threadBeforeRename.data as Record<string, unknown>;
    const threadBeforeRenameIncluded = included(threadBeforeRename);
    const firstEntity = ((threadDataBeforeRename.thread as Record<string, unknown>).firstEntity as Record<string, unknown>);
    const replyEntity = ((threadDataBeforeRename.entities as Array<Record<string, unknown>>)
      .find((row) => row.entityId === reply.entityId) as Record<string, unknown>);

    assert.deepEqual(Object.keys(threadBeforeRenameIncluded), [kilian.id]);
    assert.equal(threadBeforeRenameIncluded[kilian.id]?.handle, 'kilian-valdman-jl88rb');
    assert.equal(versionMentions(firstEntity).body[0]?.authoredHandle, 'kilian-valdman-jl88rb');
    assert.equal(versionMentions(replyEntity).body[0]?.authoredHandle, 'kilian-valdman-jl88rb');

    await h.apiOk(kilian.token, 'members.updateIdentity', {
      handle: 'kilian-renamed',
    });

    const threadAfterRename = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.contentThreadId as string,
      limit: 20,
    });
    const threadDataAfterRename = threadAfterRename.data as Record<string, unknown>;
    const firstEntityAfterRename = ((threadDataAfterRename.thread as Record<string, unknown>).firstEntity as Record<string, unknown>);
    const replyEntityAfterRename = ((threadDataAfterRename.entities as Array<Record<string, unknown>>)
      .find((row) => row.entityId === reply.entityId) as Record<string, unknown>);

    assert.equal(included(threadAfterRename)[kilian.id]?.handle, 'kilian-renamed');
    assert.equal(versionMentions(firstEntityAfterRename).title[0]?.authoredHandle, 'kilian-valdman-jl88rb');
    assert.equal(versionMentions(firstEntityAfterRename).body[0]?.authoredHandle, 'kilian-valdman-jl88rb');
    assert.equal(versionMentions(replyEntityAfterRename).body[0]?.authoredHandle, 'kilian-valdman-jl88rb');
  });

  it('carries forward unchanged mention fields across bans but rejects changed fields that keep stale mentions', async () => {
    const admin = await h.seedSuperadmin('Mention Admin', 'mention-admin');
    const owner = await h.seedOwner('mention-update-club', 'Mention Update Club');
    const author = await h.seedCompedMember(owner.club.id, 'Update Author', 'mention-update-author');
    const bob = await h.seedCompedMember(owner.club.id, 'Mention Bob', 'mention-update-bob');

    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Thanks @mention-update-bob',
      body: 'Working through this with @mention-update-bob.',
    });
    const createdEntity = entity(created);

    const adminList = await h.apiOk(admin.token, 'superadmin.content.list', {
      clubId: owner.club.id,
      limit: 10,
    });
    const adminData = adminList.data as Record<string, unknown>;
    const adminRow = ((adminData.content as Array<Record<string, unknown>>)
      .find((row) => row.entityId === createdEntity.entityId) as Record<string, unknown>);
    assert.deepEqual(adminRow.titleMentions, [{
      memberId: bob.id,
      authoredHandle: 'mention-update-bob',
      start: 7,
      end: 26,
    }]);
    assert.equal(included(adminList)[bob.id]?.handle, 'mention-update-bob');

    await h.apiOk(admin.token, 'superadmin.billing.banMember', {
      memberId: bob.id,
      reason: 'mention carry-forward test',
    });

    const expiresOnlyUpdate = await h.apiOk(author.token, 'content.update', {
      entityId: createdEntity.entityId as string,
      expiresAt: '2026-12-31T00:00:00Z',
    });
    const updatedEntity = entity(expiresOnlyUpdate);
    const updatedMentions = versionMentions(updatedEntity);
    assert.equal(updatedMentions.title[0]?.memberId, bob.id);
    assert.equal(updatedMentions.body[0]?.memberId, bob.id);
    assert.equal(updatedMentions.body[0]?.authoredHandle, 'mention-update-bob');

    const staleErr = await h.apiErr(author.token, 'content.update', {
      entityId: createdEntity.entityId as string,
      body: 'Working through this with @mention-update-bob again after the ban.',
    });
    assert.equal(staleErr.status, 400);
    assert.equal(staleErr.code, 'invalid_mentions');
    assert.match(staleErr.message, /@mention-update-bob/);
  });

  it('rejects mentions to pending members before running the quality gate', async () => {
    let gateCalls = 0;
    const failingGate: QualityGateFn = async () => {
      gateCalls += 1;
      return { status: 'failed', reason: 'provider_error' };
    };

    const isolated = await TestHarness.start({ qualityGate: failingGate });
    try {
      const owner = await isolated.seedOwner('mention-pending-club', 'Mention Pending Club');
      const author = await isolated.seedCompedMember(owner.club.id, 'Pending Author', 'mention-pending-author');
      const pending = await isolated.seedCompedMember(owner.club.id, 'Pending Mention', 'pending-mention-target');

      await isolated.sql(
        `update members
         set state = 'pending'
         where id = $1`,
        [pending.id],
      );

      const err = await isolated.apiErr(author.token, 'content.create', {
        clubId: owner.club.id,
        kind: 'post',
        body: 'Trying to ping @pending-mention-target before activation.',
      });

      assert.equal(err.status, 400);
      assert.equal(err.code, 'invalid_mentions');
      assert.match(err.message, /@pending-mention-target/);
      assert.equal(gateCalls, 0, 'invalid mentions should fail before the quality gate runs');
    } finally {
      await isolated.stop();
    }
  });

  it('clientKey replays bypass mention revalidation after the mentioned member is banned', async () => {
    const admin = await h.seedSuperadmin('Content Replay Admin', 'content-replay-admin');
    const owner = await h.seedOwner('content-replay-club', 'Content Replay Club');
    const author = await h.seedCompedMember(owner.club.id, 'Replay Author', 'content-replay-author');
    const target = await h.seedCompedMember(owner.club.id, 'Replay Target', 'content-replay-target');
    const clientKey = 'content-mention-replay';

    const first = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Thanks @content-replay-target',
      body: 'Checking with @content-replay-target before we publish.',
      clientKey,
    });
    const firstEntity = entity(first);

    await h.apiOk(admin.token, 'superadmin.billing.banMember', {
      memberId: target.id,
      reason: 'content mention replay test',
    });

    const replay = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Thanks @content-replay-target',
      body: 'Checking with @content-replay-target before we publish.',
      clientKey,
    });
    const replayEntity = entity(replay);

    assert.equal(replayEntity.entityId, firstEntity.entityId);
    assert.deepEqual(versionMentions(replayEntity), versionMentions(firstEntity));
  });

  it('enforces mention caps on create and update', async () => {
    const owner = await h.seedOwner('mention-cap-club', 'Mention Cap Club');
    const author = await h.seedCompedMember(owner.club.id, 'Cap Author', 'mention-cap-author');
    const targets = await seedMentionTargets(owner.club.id, 26, 'mention-cap-target');

    const hundredMentionBody = buildMentionBody(targets.slice(0, 25).map((target) => target.handle), 4);
    const created = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: hundredMentionBody,
    });
    const createdEntity = entity(created);
    assert.equal(versionMentions(createdEntity).body.length, 100);

    const tooManyUnique = await h.apiErr(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: buildMentionBody(targets.map((target) => target.handle)),
    });
    assert.equal(tooManyUnique.status, 400);
    assert.equal(tooManyUnique.code, 'invalid_input');
    assert.match(tooManyUnique.message, /25 unique mentions and 100 mention spans/i);

    const tooManySpans = await h.apiErr(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      body: Array.from({ length: 101 }, () => `@${targets[0]!.handle}`).join(' '),
    });
    assert.equal(tooManySpans.status, 400);
    assert.equal(tooManySpans.code, 'invalid_input');

    const updateErr = await h.apiErr(author.token, 'content.update', {
      entityId: createdEntity.entityId as string,
      body: `${hundredMentionBody} @${targets[0]!.handle}`,
    });
    assert.equal(updateErr.status, 400);
    assert.equal(updateErr.code, 'invalid_input');
  });

  it('suppresses mentions on removed content in member and admin reads', async () => {
    const admin = await h.seedSuperadmin('Content Remove Admin', 'content-remove-admin');
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
      title: 'Reply to @content-remove-target',
      body: 'This reply mentions @content-remove-target.',
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

    const adminList = await h.apiOk(admin.token, 'superadmin.content.list', {
      clubId: owner.club.id,
      limit: 20,
    });
    const removedAdminRow = (((adminList.data as Record<string, unknown>).content as Array<Record<string, unknown>>)
      .find((row) => row.entityId === entity(reply).entityId) as Record<string, unknown>);
    assert.equal(removedAdminRow.title, '[redacted]');
    assert.deepEqual(removedAdminRow.titleMentions, []);
    assert.deepEqual(included(adminList), {});
  });
});
