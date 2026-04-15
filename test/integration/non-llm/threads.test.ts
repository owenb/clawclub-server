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

function entity(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).entity as Record<string, unknown>;
}

function threadData(result: Record<string, unknown>) {
  return result.data as Record<string, unknown>;
}

function threadEntities(result: Record<string, unknown>) {
  return (threadData(result).entities as Array<Record<string, unknown>>);
}

async function createPost(
  token: string,
  input: { clubId?: string; threadId?: string; title?: string; body: string; expiresAt?: string | null },
): Promise<Record<string, unknown>> {
  const result = await h.apiOk(token, 'content.create', {
    clubId: input.clubId,
    threadId: input.threadId,
    kind: 'post',
    title: input.title ?? null,
    body: input.body,
    expiresAt: input.expiresAt ?? undefined,
  });
  return entity(result);
}

async function createGift(token: string, clubId: string, title: string, body: string): Promise<Record<string, unknown>> {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'gift',
    title,
    body,
  });
  return entity(result);
}

describe('content.getThread', () => {
  it('reads by entityId or threadId and paginates newest-first windows in chronological order', async () => {
    const owner = await h.seedOwner('thread-read-page', 'Thread Read Page Club');
    const author = await h.seedCompedMember(owner.club.id, 'Thread Author');

    const root = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Root subject',
      body: 'Root body',
    });
    const reply1 = await createPost(author.token, {
      threadId: root.contentThreadId as string,
      body: 'Reply one',
    });
    const reply2 = await createPost(author.token, {
      threadId: root.contentThreadId as string,
      body: 'Reply two',
    });

    const firstPage = await h.apiOk(author.token, 'content.getThread', {
      entityId: reply2.entityId,
      limit: 2,
    });
    const firstPageData = threadData(firstPage as Record<string, unknown>);
    const firstPageThread = firstPageData.thread as Record<string, unknown>;
    const firstPageIds = threadEntities(firstPage as Record<string, unknown>).map(row => row.entityId);

    assert.equal(firstPageThread.threadId, root.contentThreadId);
    assert.equal((firstPageThread.firstEntity as Record<string, unknown>).entityId, root.entityId);
    assert.deepEqual(firstPageIds, [reply1.entityId, reply2.entityId]);
    assert.equal(firstPageData.hasMore, true);
    assert.ok(firstPageData.nextCursor);

    const secondPage = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.contentThreadId,
      limit: 2,
      cursor: firstPageData.nextCursor,
    });
    const secondPageIds = threadEntities(secondPage as Record<string, unknown>).map(row => row.entityId);

    assert.deepEqual(secondPageIds, [root.entityId]);
  });

  it('keeps removed entities redacted inline but hides threads whose entire history is removed', async () => {
    const owner = await h.seedOwner('thread-redact', 'Thread Redact Club');
    const author = await h.seedCompedMember(owner.club.id, 'Thread Remover');

    const root = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Thread root',
      body: 'Visible root',
    });
    const reply = await createPost(author.token, {
      threadId: root.contentThreadId as string,
      body: 'Reply to redact',
    });

    await h.apiOk(author.token, 'content.remove', { entityId: reply.entityId });

    const visibleThread = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.contentThreadId,
      limit: 20,
    });
    const redactedReply = threadEntities(visibleThread as Record<string, unknown>)
      .find(row => row.entityId === reply.entityId);

    assert.ok(redactedReply, 'removed reply should still occupy its slot');
    assert.equal((redactedReply!.version as Record<string, unknown>).state, 'removed');
    assert.equal((redactedReply!.version as Record<string, unknown>).title, '[redacted]');
    assert.equal((redactedReply!.version as Record<string, unknown>).body, '[redacted]');

    await h.apiOk(author.token, 'content.remove', { entityId: root.entityId });

    const err = await h.apiErr(author.token, 'content.getThread', {
      threadId: root.contentThreadId,
      limit: 20,
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('supports includeClosed for direct reads of closed thread subjects', async () => {
    const owner = await h.seedOwner('thread-closed-read', 'Thread Closed Read Club');
    const author = await h.seedCompedMember(owner.club.id, 'Closed Author');
    const viewer = await h.seedCompedMember(owner.club.id, 'Closed Viewer');

    const gift = await createGift(author.token, owner.club.id, 'Closed loop', 'No longer available');
    await h.apiOk(author.token, 'content.closeLoop', { entityId: gift.entityId });

    const hidden = await h.apiErr(viewer.token, 'content.getThread', {
      threadId: gift.contentThreadId,
      limit: 20,
    });
    assert.equal(hidden.status, 404);

    const visible = await h.apiOk(viewer.token, 'content.getThread', {
      threadId: gift.contentThreadId,
      includeClosed: true,
      limit: 20,
    });
    const visibleData = threadData(visible as Record<string, unknown>);
    const visibleIds = threadEntities(visible as Record<string, unknown>).map(row => row.entityId);

    assert.equal(((visibleData.thread as Record<string, unknown>).firstEntity as Record<string, unknown>).entityId, gift.entityId);
    assert.deepEqual(visibleIds, [gift.entityId]);
  });

  it('returns an expired firstEntity in the summary while omitting it from entities and counts only visible rows', async () => {
    const owner = await h.seedOwner('thread-expired-summary', 'Thread Expired Summary Club');
    const author = await h.seedCompedMember(owner.club.id, 'Expired Author');

    const expiredRoot = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Expired root',
      body: 'Old body',
    });
    await h.sql(
      `update entity_versions
       set effective_at = '2019-01-01T00:00:00Z',
           created_at = '2019-01-01T00:00:00Z',
           expires_at = '2020-01-01T00:00:00Z'
       where entity_id = $1
         and version_no = 1`,
      [expiredRoot.entityId],
    );
    const reply = await createPost(author.token, {
      threadId: expiredRoot.contentThreadId as string,
      body: 'Fresh reply',
    });

    const thread = await h.apiOk(author.token, 'content.getThread', {
      threadId: expiredRoot.contentThreadId,
      limit: 20,
    });
    const data = threadData(thread as Record<string, unknown>);
    const summary = data.thread as Record<string, unknown>;
    const ids = threadEntities(thread as Record<string, unknown>).map(row => row.entityId);

    assert.equal((summary.firstEntity as Record<string, unknown>).entityId, expiredRoot.entityId);
    assert.deepEqual(ids, [reply.entityId]);
    assert.equal((summary.thread as Record<string, unknown>).entityCount, 1);
  });
});

describe('content.create thread quota scoping', () => {
  it('returns not_found when threadId points to an inaccessible club', async () => {
    const owner = await h.seedOwner('thread-scope-owner', 'Thread Scope Owner Club');
    const author = await h.seedCompedMember(owner.club.id, 'Thread Scope Author');
    const outsider = await h.seedMember('Thread Outsider');
    const otherOwner = await h.seedOwner('thread-scope-other', 'Thread Scope Other Club');

    await h.seedCompedMembership(otherOwner.club.id, outsider.id);

    const threadRoot = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Scoped thread',
      body: 'Only club members may reply',
    });

    const err = await h.apiErr(outsider.token, 'content.create', {
      threadId: threadRoot.contentThreadId,
      kind: 'post',
      body: 'Unauthorized reply',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});
