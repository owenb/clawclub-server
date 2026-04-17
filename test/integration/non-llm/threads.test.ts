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

function content(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).content as Record<string, unknown>;
}

function threadData(result: Record<string, unknown>) {
  return result.data as Record<string, unknown>;
}

function threadEntities(result: Record<string, unknown>) {
  return (threadData(result).contents as Array<Record<string, unknown>>);
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
  return content(result);
}

async function createGift(token: string, clubId: string, title: string, body: string): Promise<Record<string, unknown>> {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'gift',
    title,
    body,
  });
  return content(result);
}

describe('content.getThread', () => {
  it('reads by contentId or threadId and paginates newest-first windows in chronological order', async () => {
    const owner = await h.seedOwner('thread-read-page', 'Thread Read Page Club');
    const author = await h.seedCompedMember(owner.club.id, 'Thread Author');

    const root = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Root subject',
      body: 'Root body',
    });
    const reply1 = await createPost(author.token, {
      threadId: root.threadId as string,
      body: 'Reply one',
    });
    const reply2 = await createPost(author.token, {
      threadId: root.threadId as string,
      body: 'Reply two',
    });

    const firstPage = await h.apiOk(author.token, 'content.getThread', {
      contentId: reply2.id,
      limit: 2,
    });
    const firstPageData = threadData(firstPage as Record<string, unknown>);
    const firstPageThread = firstPageData.thread as Record<string, unknown>;
    const firstPageIds = threadEntities(firstPage as Record<string, unknown>).map(row => row.id);

    assert.equal(firstPageThread.id, root.threadId);
    assert.equal((firstPageThread.firstContent as Record<string, unknown>).id, root.id);
    assert.deepEqual(firstPageIds, [reply1.id, reply2.id]);
    assert.equal(firstPageData.hasMore, true);
    assert.ok(firstPageData.nextCursor);

    const secondPage = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.threadId,
      limit: 2,
      cursor: firstPageData.nextCursor,
    });
    const secondPageIds = threadEntities(secondPage as Record<string, unknown>).map(row => row.id);

    assert.deepEqual(secondPageIds, [root.id]);
  });

  it('keeps removed contents redacted inline but hides threads whose entire history is removed', async () => {
    const owner = await h.seedOwner('thread-redact', 'Thread Redact Club');
    const author = await h.seedCompedMember(owner.club.id, 'Thread Remover');

    const root = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Thread root',
      body: 'Visible root',
    });
    const reply = await createPost(author.token, {
      threadId: root.threadId as string,
      body: 'Reply to redact',
    });

    await h.apiOk(author.token, 'content.remove', { id: reply.id });

    const visibleThread = await h.apiOk(author.token, 'content.getThread', {
      threadId: root.threadId,
      limit: 20,
    });
    const redactedReply = threadEntities(visibleThread as Record<string, unknown>)
      .find(row => row.id === reply.id);

    assert.ok(redactedReply, 'removed reply should still occupy its slot');
    assert.equal((redactedReply!.version as Record<string, unknown>).state, 'removed');
    assert.equal((redactedReply!.version as Record<string, unknown>).title, '[redacted]');
    assert.equal((redactedReply!.version as Record<string, unknown>).body, '[redacted]');

    await h.apiOk(author.token, 'content.remove', { id: root.id });

    const err = await h.apiErr(author.token, 'content.getThread', {
      threadId: root.threadId,
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
    await h.apiOk(author.token, 'content.closeLoop', { id: gift.id });

    const hidden = await h.apiErr(viewer.token, 'content.getThread', {
      threadId: gift.threadId,
      limit: 20,
    });
    assert.equal(hidden.status, 404);

    const visible = await h.apiOk(viewer.token, 'content.getThread', {
      threadId: gift.threadId,
      includeClosed: true,
      limit: 20,
    });
    const visibleData = threadData(visible as Record<string, unknown>);
    const visibleIds = threadEntities(visible as Record<string, unknown>).map(row => row.id);

    assert.equal(((visibleData.thread as Record<string, unknown>).firstContent as Record<string, unknown>).id, gift.id);
    assert.deepEqual(visibleIds, [gift.id]);
  });

  it('returns an expired firstContent in the summary while omitting it from contents and counts only visible rows', async () => {
    const owner = await h.seedOwner('thread-expired-summary', 'Thread Expired Summary Club');
    const author = await h.seedCompedMember(owner.club.id, 'Expired Author');

    const expiredRoot = await createPost(author.token, {
      clubId: owner.club.id,
      title: 'Expired root',
      body: 'Old body',
    });
    await h.sql(
      `update content_versions
       set effective_at = '2019-01-01T00:00:00Z',
           created_at = '2019-01-01T00:00:00Z',
           expires_at = '2020-01-01T00:00:00Z'
       where content_id = $1
         and version_no = 1`,
      [expiredRoot.id],
    );
    const reply = await createPost(author.token, {
      threadId: expiredRoot.threadId as string,
      body: 'Fresh reply',
    });

    const thread = await h.apiOk(author.token, 'content.getThread', {
      threadId: expiredRoot.threadId,
      limit: 20,
    });
    const data = threadData(thread as Record<string, unknown>);
    const summary = data.thread as Record<string, unknown>;
    const ids = threadEntities(thread as Record<string, unknown>).map(row => row.id);

    assert.equal((summary.firstContent as Record<string, unknown>).id, expiredRoot.id);
    assert.deepEqual(ids, [reply.id]);
    assert.equal(summary.contentCount, 1);
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
      threadId: threadRoot.threadId,
      kind: 'post',
      body: 'Unauthorized reply',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });
});
