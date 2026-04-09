import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';
import { passthroughGate } from '../fixtures.ts';
import { findEntitiesViaEmbedding } from '../../src/clubs/index.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ qualityGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function makeVector(values: number[]): string {
  const full = new Array(1536).fill(0);
  for (let i = 0; i < values.length; i++) full[i] = values[i];
  return `[${full.join(',')}]`;
}

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

describe('gifts and open loops', () => {
  it('creates gifts with openLoop=true and posts with openLoop=null', async () => {
    const owner = await h.seedOwner('gift-create', 'Gift Create Club');
    const author = await h.seedClubMember(owner.club.id, 'Gift Author', 'gift-author', { sponsorId: owner.id });

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
        `insert into entities (club_id, kind, author_member_id, open_loop)
         values ($1, 'ask', $2, null)`,
        [owner.club.id, owner.id],
      ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        return pgErr.code === '23514' && pgErr.constraint === 'entities_open_loop_kind_check';
      },
    );

    await assert.rejects(
      h.sql(
        `insert into entities (club_id, kind, author_member_id, open_loop)
         values ($1, 'post', $2, true)`,
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
    const author = await h.seedClubMember(owner.club.id, 'Loop Author', 'loop-author', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Loop Viewer', 'loop-viewer', { sponsorId: owner.id });

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
    const defaultResults = (authorDefaultList.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(defaultResults.some((entity) => entity.entityId === gift.entityId), false);
    assert.equal(defaultResults.some((entity) => entity.entityId === post.entityId), true);

    const authorClosedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const closedResults = (authorClosedList.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(closedResults.some((entity) => entity.entityId === gift.entityId), true);
    assert.equal(closedResults.some((entity) => entity.entityId === post.entityId), true);

    const viewerClosedList = await h.apiOk(viewer.token, 'content.list', {
      clubId: owner.club.id,
      includeClosed: true,
    });
    const viewerResults = (viewerClosedList.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(viewerResults.some((entity) => entity.entityId === gift.entityId), false);
    assert.equal(viewerResults.some((entity) => entity.entityId === post.entityId), true);

    const reopened = await h.apiOk(author.token, 'content.reopenLoop', {
      entityId: gift.entityId,
    });
    assert.equal(((reopened.data as Record<string, unknown>).entity as Record<string, unknown>).openLoop, true);

    const reopenedList = await h.apiOk(author.token, 'content.list', {
      clubId: owner.club.id,
    });
    const reopenedResults = (reopenedList.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(reopenedResults.some((entity) => entity.entityId === gift.entityId), true);
  });

  it('closeLoop returns 404 for posts, removed gifts, and another member’s gift', async () => {
    const owner = await h.seedOwner('gift-errors', 'Gift Errors Club');
    const author = await h.seedClubMember(owner.club.id, 'Gift Owner', 'gift-owner', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Gift Viewer', 'gift-viewer', { sponsorId: owner.id });

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
    const author = await h.seedClubMember(owner.club.id, 'Search Author', 'search-author', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Search Viewer', 'search-viewer', { sponsorId: owner.id });

    const giftResult = await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'gift',
      title: 'Architecture teardown sessions',
      body: 'I will review a backend architecture with you and leave annotated recommendations.',
    });
    const gift = (giftResult.data as Record<string, unknown>).entity as Record<string, unknown>;
    await seedEntityEmbedding(gift.entityId as string, gift.entityVersionId as string, makeVector([1, 0, 0]));

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
