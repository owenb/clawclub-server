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

describe('content mentions', () => {
  it('hydrates mentions across thread reads, dedupes included members, and preserves authoredHandle across renames', async () => {
    const owner = await h.seedOwner('mention-thread-club', 'Mention Thread Club');
    const author = await h.seedClubMember(owner.club.id, 'Mention Author', 'mention-author', { sponsorId: owner.id });
    const kilian = await h.seedClubMember(owner.club.id, 'Kilian Mentioned', 'kilian-valdman-jl88rb', { sponsorId: owner.id });

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
    const author = await h.seedClubMember(owner.club.id, 'Update Author', 'mention-update-author', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Mention Bob', 'mention-update-bob', { sponsorId: owner.id });

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
      const author = await isolated.seedClubMember(owner.club.id, 'Pending Author', 'mention-pending-author', { sponsorId: owner.id });
      const pending = await isolated.seedClubMember(owner.club.id, 'Pending Mention', 'pending-mention-target', { sponsorId: owner.id });

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
});
