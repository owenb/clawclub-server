import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { makeVector } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';
import { findEntitiesViaEmbedding } from '../../../src/clubs/index.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ qualityGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function seedEntityEmbedding(entityId: string, entityVersionId: string, vector: string): Promise<void> {
  await h.sql(
    `insert into entity_embeddings
       (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (entity_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [entityId, entityVersionId, vector],
  );
}

function listedFirstEntityIds(result: Record<string, unknown>): string[] {
  const threads = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
  return threads.map((thread) => ((thread.firstEntity as Record<string, unknown>).entityId as string));
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
    const gift = (giftResult.data as Record<string, unknown>).entity as Record<string, unknown>;
    assert.equal(gift.kind, 'gift');
    assert.equal(gift.openLoop, true);

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'What changed in our backend this month',
      body: 'A short update on reliability work and the monitoring changes that paid off.',
    });
    const post = (postResult.data as Record<string, unknown>).entity as Record<string, unknown>;
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
         insert into entities (club_id, kind, author_member_id, open_loop, content_thread_id)
         select $1, 'ask', $2, null, thread.id
         from thread`,
        [owner.club.id, owner.id],
      ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        return pgErr.code === '23514' && pgErr.constraint === 'entities_open_loop_kind_check';
      },
    );

    await assert.rejects(
      h.sql(
        `with thread as (
           insert into content_threads (club_id, created_by_member_id)
           values ($1, $2)
           returning id
         )
         insert into entities (club_id, kind, author_member_id, open_loop, content_thread_id)
         select $1, 'post', $2, true, thread.id
         from thread`,
        [owner.club.id, owner.id],
      ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        return pgErr.code === '23514' && pgErr.constraint === 'entities_open_loop_kind_check';
      },
    );
  });

  it('closeLoop is idempotent, hidden by default, private with includeClosed, and reopen makes the loop visible again', async () => {
    const owner = await h.seedOwner('gift-close', 'Gift Close Club');
    const author = await h.seedCompedMember(owner.club.id, 'Loop Author');
    const viewer = await h.seedCompedMember(owner.club.id, 'Loop Viewer');

    const giftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Warm introductions for founders',
      body: 'Happy to make introductions to operators and early-stage investors when there is a real fit.',
    });
    const gift = (giftResult.data as Record<string, unknown>).entity as Record<string, unknown>;

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Club dinner notes',
      body: 'A quick write-up from last night so people who missed it can catch up.',
    });
    const post = (postResult.data as Record<string, unknown>).entity as Record<string, unknown>;

    const closedOnce = await h.apiOk(author.token, 'content.closeLoop', {
      entityId: gift.entityId,
    });
    const closedTwice = await h.apiOk(author.token, 'content.closeLoop', {
      entityId: gift.entityId,
    });
    assert.equal(((closedOnce.data as Record<string, unknown>).entity as Record<string, unknown>).openLoop, false);
    assert.equal(((closedTwice.data as Record<string, unknown>).entity as Record<string, unknown>).openLoop, false);

    const authorDefaultList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
    });
    const defaultIds = listedFirstEntityIds(authorDefaultList as Record<string, unknown>);
    assert.equal(defaultIds.includes(gift.entityId as string), false);
    assert.equal(defaultIds.includes(post.entityId as string), true);

    const authorClosedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const closedIds = listedFirstEntityIds(authorClosedList as Record<string, unknown>);
    assert.equal(closedIds.includes(gift.entityId as string), true);
    assert.equal(closedIds.includes(post.entityId as string), true);

    const viewerClosedList = await h.apiOk(viewer.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const viewerIds = listedFirstEntityIds(viewerClosedList as Record<string, unknown>);
    assert.equal(viewerIds.includes(gift.entityId as string), false);
    assert.equal(viewerIds.includes(post.entityId as string), true);

    const reopened = await h.apiOk(author.token, 'content.reopenLoop', {
      entityId: gift.entityId,
    });
    assert.equal(((reopened.data as Record<string, unknown>).entity as Record<string, unknown>).openLoop, true);

    const reopenedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
    });
    const reopenedIds = listedFirstEntityIds(reopenedList as Record<string, unknown>);
    assert.equal(reopenedIds.includes(gift.entityId as string), true);
  });

  it('closeLoop returns 404 for posts, removed gifts, and another member’s gift', async () => {
    const owner = await h.seedOwner('gift-errors', 'Gift Errors Club');
    const author = await h.seedCompedMember(owner.club.id, 'Gift Owner');
    const viewer = await h.seedCompedMember(owner.club.id, 'Gift Viewer');

    const postResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'A normal post',
      body: 'This should not have loop semantics at all.',
    });
    const post = (postResult.data as Record<string, unknown>).entity as Record<string, unknown>;

    const postErr = await h.apiErr(author.token, 'content.closeLoop', {
      entityId: post.entityId,
    });
    assert.equal(postErr.code, 'not_found');

    const removedGiftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'One-time office hours',
      body: 'I can do one office-hours block this week for anyone debugging a launch.',
    });
    const removedGift = (removedGiftResult.data as Record<string, unknown>).entity as Record<string, unknown>;
    await h.apiOk(author.token, 'content.remove', { entityId: removedGift.entityId });

    const removedErr = await h.apiErr(author.token, 'content.closeLoop', {
      entityId: removedGift.entityId,
    });
    assert.equal(removedErr.code, 'not_found');

    const foreignGiftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Hiring review help',
      body: 'I can review hiring scorecards and interview loops for early-stage teams.',
    });
    const foreignGift = (foreignGiftResult.data as Record<string, unknown>).entity as Record<string, unknown>;

    const foreignErr = await h.apiErr(viewer.token, 'content.closeLoop', {
      entityId: foreignGift.entityId,
    });
    assert.equal(foreignErr.code, 'not_found');
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
    const gift = (giftResult.data as Record<string, unknown>).entity as Record<string, unknown>;
    const versionRows = await h.sql<{ id: string }>(
      `select id
       from current_entity_versions
       where entity_id = $1`,
      [gift.entityId as string],
    );
    await seedEntityEmbedding(gift.entityId as string, versionRows[0].id, makeVector([1, 0, 0]));

    const openResults = await findEntitiesViaEmbedding(h.pools.super, {
      actorMemberId: viewer.id,
      clubIds: [owner.club.id],
      queryEmbedding: makeVector([1, 0, 0]),
      kinds: ['gift'],
      limit: 10,
      cursor: null,
    });
    assert.equal(openResults.results.some((entity) => entity.entityId === gift.entityId), true);

    await h.apiOk(author.token, 'content.closeLoop', {
      entityId: gift.entityId,
    });

    const closedResults = await findEntitiesViaEmbedding(h.pools.super, {
      actorMemberId: viewer.id,
      clubIds: [owner.club.id],
      queryEmbedding: makeVector([1, 0, 0]),
      kinds: ['gift'],
      limit: 10,
      cursor: null,
    });
    assert.equal(closedResults.results.some((entity) => entity.entityId === gift.entityId), false);
  });
});
