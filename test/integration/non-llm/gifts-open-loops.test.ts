import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { makeVector } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';
import { findContentViaEmbedding } from '../../../src/clubs/index.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function seedContentEmbedding(id: string, contentVersionId: string, vector: string): Promise<void> {
  await h.sql(
    `insert into content_embeddings
       (content_id, content_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (content_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [id, contentVersionId, vector],
  );
}

function listedFirstContentIds(result: Record<string, unknown>): string[] {
  const threads = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
  return threads.map((thread) => ((thread.firstContent as Record<string, unknown>).id as string));
}

describe('gifts and open loops', () => {
  it('creates gifts with openLoop=true and posts with openLoop=null', async () => {
    const owner = await h.seedOwner('gift-create', 'Gift Create Club');
    const author = await h.seedCompedMember(owner.club.id, 'Gift Author');

    const giftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Free code review sessions',
      body: 'I will spend an hour reviewing architecture and code for early-stage teams in the club.',
    });
    const gift = (giftResult.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.equal(gift.kind, 'gift');
    assert.equal(gift.openLoop, true);

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'What changed in our backend this month',
      body: 'A short update on reliability work and the monitoring changes that paid off.',
    });
    const post = (postResult.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.equal(post.kind, 'post');
    assert.equal(post.openLoop, null);
  });

  it('enforces open_loop consistency at the database level', async () => {
    const owner = await h.seedOwner('gift-check', 'Gift Check Club');

    await assert.rejects(
      h.sql(
        `with thread as (
           insert into content_threads (club_id, created_by_member_id)
           values ($1, $2)
           returning id
         )
         insert into contents (club_id, kind, author_member_id, open_loop, thread_id)
         select $1, 'ask', $2, null, thread.id
         from thread`,
        [owner.club.id, owner.id],
      ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        return pgErr.code === '23514' && pgErr.constraint === 'contents_open_loop_kind_check';
      },
    );

    await assert.rejects(
      h.sql(
        `with thread as (
           insert into content_threads (club_id, created_by_member_id)
           values ($1, $2)
           returning id
         )
         insert into contents (club_id, kind, author_member_id, open_loop, thread_id)
         select $1, 'post', $2, true, thread.id
         from thread`,
        [owner.club.id, owner.id],
      ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        return pgErr.code === '23514' && pgErr.constraint === 'contents_open_loop_kind_check';
      },
    );
  });

  it('closeLoop is idempotent, hidden by default, visible with includeClosed, and reopen makes the loop visible again', async () => {
    const owner = await h.seedOwner('gift-close', 'Gift Close Club');
    const author = await h.seedCompedMember(owner.club.id, 'Loop Author');
    const viewer = await h.seedCompedMember(owner.club.id, 'Loop Viewer');

    const giftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Warm introductions for founders',
      body: 'Happy to make introductions to operators and early-stage investors when there is a real fit.',
    });
    const gift = (giftResult.data as Record<string, unknown>).content as Record<string, unknown>;

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Club dinner notes',
      body: 'A quick write-up from last night so people who missed it can catch up.',
    });
    const post = (postResult.data as Record<string, unknown>).content as Record<string, unknown>;

    const closedOnce = await h.apiOk(author.token, 'content.setLoopState', {
      id: gift.id,
      state: 'closed',
    });
    const closedTwice = await h.apiOk(author.token, 'content.setLoopState', {
      id: gift.id,
      state: 'closed',
    });
    assert.equal(((closedOnce.data as Record<string, unknown>).content as Record<string, unknown>).openLoop, false);
    assert.equal(((closedTwice.data as Record<string, unknown>).content as Record<string, unknown>).openLoop, false);

    const authorDefaultList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
    });
    const defaultIds = listedFirstContentIds(authorDefaultList as Record<string, unknown>);
    assert.equal(defaultIds.includes(gift.id as string), false);
    assert.equal(defaultIds.includes(post.id as string), true);

    const authorClosedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const closedIds = listedFirstContentIds(authorClosedList as Record<string, unknown>);
    assert.equal(closedIds.includes(gift.id as string), true);
    assert.equal(closedIds.includes(post.id as string), true);

    const viewerDefaultList = await h.apiOk(viewer.token, 'content.list', {
      clubId: owner.club.id,
    });
    const viewerDefaultIds = listedFirstContentIds(viewerDefaultList as Record<string, unknown>);
    assert.equal(viewerDefaultIds.includes(gift.id as string), false);
    assert.equal(viewerDefaultIds.includes(post.id as string), true);

    const viewerClosedList = await h.apiOk(viewer.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const viewerIds = listedFirstContentIds(viewerClosedList as Record<string, unknown>);
    assert.equal(viewerIds.includes(gift.id as string), true);
    assert.equal(viewerIds.includes(post.id as string), true);

    const reopened = await h.apiOk(author.token, 'content.setLoopState', {
      id: gift.id,
      state: 'open',
    });
    assert.equal(((reopened.data as Record<string, unknown>).content as Record<string, unknown>).openLoop, true);

    const reopenedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
    });
    const reopenedIds = listedFirstContentIds(reopenedList as Record<string, unknown>);
    assert.equal(reopenedIds.includes(gift.id as string), true);
  });

  it('closeLoop returns precise errors for posts, removed gifts, and another member’s gift', async () => {
    const owner = await h.seedOwner('gift-errors', 'Gift Errors Club');
    const author = await h.seedCompedMember(owner.club.id, 'Gift Owner');
    const viewer = await h.seedCompedMember(owner.club.id, 'Gift Viewer');

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'A normal post',
      body: 'This should not have loop semantics at all.',
    });
    const post = (postResult.data as Record<string, unknown>).content as Record<string, unknown>;

    const postErr = await h.api(author.token, 'content.setLoopState', {
      id: post.id,
      state: 'closed',
    });
    assert.equal(postErr.status, 409);
    assert.equal(postErr.body.ok, false);
    const postError = postErr.body.error as Record<string, unknown>;
    assert.equal(postError.code, 'invalid_state');
    const postDetails = postError.details as Record<string, unknown>;
    assert.equal((postDetails.content as Record<string, unknown>).id, post.id);

    const removedGiftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'One-time office hours',
      body: 'I can do one office-hours block this week for anyone debugging a launch.',
    });
    const removedGift = (removedGiftResult.data as Record<string, unknown>).content as Record<string, unknown>;
    await h.apiOk(author.token, 'content.remove', { id: removedGift.id });

    const removedErr = await h.apiErr(author.token, 'content.setLoopState', {
      id: removedGift.id,
      state: 'closed',
    });
    assert.equal(removedErr.status, 404);
    assert.equal(removedErr.code, 'content_not_found');

    const foreignGiftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Hiring review help',
      body: 'I can review hiring scorecards and interview loops for early-stage teams.',
    });
    const foreignGift = (foreignGiftResult.data as Record<string, unknown>).content as Record<string, unknown>;

    const foreignErr = await h.apiErr(viewer.token, 'content.setLoopState', {
      id: foreignGift.id,
      state: 'closed',
    });
    assert.equal(foreignErr.status, 403);
    assert.equal(foreignErr.code, 'forbidden_scope');
  });

  it('closed loops are excluded from embedding search results', async () => {
    const owner = await h.seedOwner('gift-search', 'Gift Search Club');
    const author = await h.seedCompedMember(owner.club.id, 'Search Author');
    const viewer = await h.seedCompedMember(owner.club.id, 'Search Viewer');

    const giftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Architecture teardown sessions',
      body: 'I will review a backend architecture with you and leave annotated recommendations.',
    });
    const gift = (giftResult.data as Record<string, unknown>).content as Record<string, unknown>;
    const versionRows = await h.sql<{ id: string }>(
      `select id
       from current_content_versions
       where content_id = $1`,
      [gift.id as string],
    );
    await seedContentEmbedding(gift.id as string, versionRows[0].id, makeVector([1, 0, 0]));

    const openResults = await findContentViaEmbedding(h.pools.super, {
      actorMemberId: viewer.id,
      clubIds: [owner.club.id],
      queryEmbedding: makeVector([1, 0, 0]),
      kinds: ['gift'],
      limit: 10,
      cursor: null,
    });
    assert.equal(openResults.results.some((content) => content.id === gift.id), true);

    await h.apiOk(author.token, 'content.setLoopState', {
      id: gift.id,
      state: 'closed',
    });

    const closedResults = await findContentViaEmbedding(h.pools.super, {
      actorMemberId: viewer.id,
      clubIds: [owner.club.id],
      queryEmbedding: makeVector([1, 0, 0]),
      kinds: ['gift'],
      limit: 10,
      cursor: null,
    });
    assert.equal(closedResults.results.some((content) => content.id === gift.id), false);
  });
});
