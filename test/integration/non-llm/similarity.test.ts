import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { makeVector, seedEntityWithEmbedding, seedProfileEmbedding } from '../helpers.ts';
import {
  findMembersMatchingEntity,
  findSimilarMembers,
  findAskMatchingOffer,
  findExistingThreadPairs,
  canonicalPair,
} from '../../../src/workers/similarity.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('embedding similarity', () => {
  describe('findMembersMatchingEntity', () => {
    it('returns members ranked by cosine distance', async () => {
      const owner = await h.seedOwner('simclub1', 'SimClub1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim', 'alice-sim', { sponsorId: owner.id });
      const bob = await h.seedClubMember(owner.club.id, 'Bob Sim', 'bob-sim', { sponsorId: owner.id });

      // Entity vector: [1, 0, 0, ...]
      const entityId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      // Alice's profile is close to the entity: [0.9, 0.1, 0, ...]
      await seedProfileEmbedding(h, alice.id, makeVector([0.9, 0.1, 0]));

      // Bob's profile is further: [0.1, 0.9, 0, ...]
      await seedProfileEmbedding(h, bob.id, makeVector([0.1, 0.9, 0]));

      const results = await findMembersMatchingEntity(
        h.pools.super,
        entityId, owner.club.id, owner.id, 10,
      );

      assert.ok(results.length >= 2, `expected at least 2 results, got ${results.length}`);
      assert.equal(results[0].memberId, alice.id, 'Alice should be ranked first (closer vector)');
      assert.equal(results[1].memberId, bob.id, 'Bob should be ranked second');
      assert.ok(results[0].distance < results[1].distance, 'Alice distance should be less than Bob');
    });

    it('excludes the entity author', async () => {
      const owner = await h.seedOwner('simclub2', 'SimClub2');

      // Owner creates the entity and also has a profile embedding
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      const entityId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      const results = await findMembersMatchingEntity(
        h.pools.super,
        entityId, owner.club.id, owner.id, 10,
      );

      const ownerResult = results.find(r => r.memberId === owner.id);
      assert.equal(ownerResult, undefined, 'entity author should be excluded');
    });

    it('scopes to the specified club only', async () => {
      const owner1 = await h.seedOwner('simclub3a', 'SimClub3A');
      const owner2 = await h.seedOwner('simclub3b', 'SimClub3B');
      const alice = await h.seedClubMember(owner1.club.id, 'Alice Club3', 'alice-club3', { sponsorId: owner1.id });

      // Alice is only in club 3a, not 3b
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));
      const entityId = await seedEntityWithEmbedding(
        h, owner2.club.id, owner2.id, 'ask', makeVector([1, 0, 0]),
      );

      // Search in club 3b — Alice should NOT appear
      const results = await findMembersMatchingEntity(
        h.pools.super,
        entityId, owner2.club.id, owner2.id, 10,
      );

      const aliceResult = results.find(r => r.memberId === alice.id);
      assert.equal(aliceResult, undefined, 'member from different club should not appear');
    });
  });

  describe('findSimilarMembers', () => {
    it('returns similar members ranked by distance', async () => {
      const owner = await h.seedOwner('simclub4', 'SimClub4');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim4', 'alice-sim4', { sponsorId: owner.id });
      const bob = await h.seedClubMember(owner.club.id, 'Bob Sim4', 'bob-sim4', { sponsorId: owner.id });

      // Owner profile: [1, 0, 0]
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      // Alice is close: [0.95, 0.05, 0]
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));
      // Bob is further: [0.3, 0.7, 0]
      await seedProfileEmbedding(h, bob.id, makeVector([0.3, 0.7, 0]));

      const results = await findSimilarMembers(
        h.pools.super,
        owner.id, owner.club.id, 10,
      );

      assert.ok(results.length >= 2);
      assert.equal(results[0].memberId, alice.id, 'Alice should be most similar');
      assert.equal(results[1].memberId, bob.id, 'Bob should be second');
    });

    it('excludes self', async () => {
      const owner = await h.seedOwner('simclub5', 'SimClub5');
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));

      const results = await findSimilarMembers(
        h.pools.super,
        owner.id, owner.club.id, 10,
      );

      const selfResult = results.find(r => r.memberId === owner.id);
      assert.equal(selfResult, undefined, 'self should be excluded');
    });
  });

  describe('findAskMatchingOffer', () => {
    it('finds asks similar to an offer', async () => {
      const owner = await h.seedOwner('simclub6', 'SimClub6');

      // Create an ask entity
      const askId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      // Create a service (offer) entity with similar vector
      const serviceId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.super,
        serviceId, owner.club.id, 10,
      );

      assert.ok(results.length >= 1, 'should find the matching ask');
      assert.equal(results[0].entityId, askId);
      assert.equal(results[0].authorMemberId, owner.id);
    });

    it('only returns ask entities, not other kinds', async () => {
      const owner = await h.seedOwner('simclub7', 'SimClub7');

      // Create a post (not an ask) with similar vector
      await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'post', makeVector([1, 0, 0]),
      );

      // Create a service (offer) to search from
      const serviceId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.super,
        serviceId, owner.club.id, 10,
      );

      // The post should not appear — only asks
      assert.equal(results.length, 0, 'should not return non-ask entities');
    });

    it('excludes asks whose expires_at has already passed', async () => {
      const owner = await h.seedOwner('simclub7-expired', 'SimClub7 Expired');

      const askId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );
      await h.sql(
        `update entity_versions
         set effective_at = now() - interval '2 hours',
             expires_at = now() - interval '1 hour'
         where entity_id = $1 and version_no = 1`,
        [askId],
      );

      const serviceId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.super,
        serviceId, owner.club.id, 10,
      );

      assert.equal(results.some(r => r.entityId === askId), false,
        'expired asks must not be match candidates');
    });
  });

  describe('findExistingThreadPairs', () => {
    it('detects existing DM threads', async () => {
      const owner = await h.seedOwner('simclub8', 'SimClub8');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim8', 'alice-sim8', { sponsorId: owner.id });

      // Send a DM to create a thread
      await h.apiOk(owner.token, 'messages.send', {
        recipientMemberId: alice.id,
        messageText: 'hello',
      });

      const [a, b] = canonicalPair(owner.id, alice.id);
      const pairs = await findExistingThreadPairs(h.pools.super, [a], [b]);

      assert.equal(pairs.size, 1, 'should find the existing thread');
      assert.ok(pairs.has(`${a}:${b}`));
    });

    it('returns empty for pairs without threads', async () => {
      const owner = await h.seedOwner('simclub9', 'SimClub9');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim9', 'alice-sim9', { sponsorId: owner.id });

      const [a, b] = canonicalPair(owner.id, alice.id);
      const pairs = await findExistingThreadPairs(h.pools.super, [a], [b]);

      assert.equal(pairs.size, 0, 'should find no threads');
    });
  });

  describe('canonicalPair', () => {
    it('orders member IDs consistently', () => {
      assert.deepEqual(canonicalPair('aaa', 'bbb'), ['aaa', 'bbb']);
      assert.deepEqual(canonicalPair('bbb', 'aaa'), ['aaa', 'bbb']);
      assert.deepEqual(canonicalPair('xxx', 'xxx'), ['xxx', 'xxx']);
    });
  });

  describe('stale entity embeddings', () => {
    it('edited source entity with stale v1 embedding produces no match', async () => {
      const owner = await h.seedOwner('stale-src', 'StaleSourceClub');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Stale', 'alice-stale', { sponsorId: owner.id });

      // Alice has a profile embedding
      await seedProfileEmbedding(h, alice.id, makeVector([0.9, 0.1, 0]));

      // Create ask entity v1 with embedding
      const entityRows = await h.sql<{ id: string }>(
        `insert into entities (club_id, kind, author_member_id, open_loop) values ($1, 'ask', $2, true) returning id`,
        [owner.club.id, owner.id],
      );
      const entityId = entityRows[0].id;
      const v1Rows = await h.sql<{ id: string }>(
        `insert into entity_versions (entity_id, version_no, state, title, summary)
         values ($1, 1, 'published', 'v1 ask', 'old content') returning id`,
        [entityId],
      );
      const v1Id = v1Rows[0].id;
      await h.sql(
        `insert into entity_embeddings (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
         values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)`,
        [entityId, v1Id, makeVector([1, 0, 0])],
      );

      // Edit entity to v2 (no embedding yet)
      await h.sql(
        `insert into entity_versions (entity_id, version_no, state, title, summary, supersedes_version_id)
         values ($1, 2, 'published', 'v2 ask', 'new content', $2)`,
        [entityId, v1Id],
      );

      // loadEntityVector should return null (stale v1 embedding, v2 is current)
      const results = await findMembersMatchingEntity(
        h.pools.super, entityId, owner.club.id, owner.id, 10,
      );
      assert.equal(results.length, 0, 'stale source embedding should not produce matches');
    });

    it('edited candidate ask with stale embedding is not matched by offer', async () => {
      const owner = await h.seedOwner('stale-cand', 'StaleCandClub');

      // Create ask entity v1 with embedding
      const askRows = await h.sql<{ id: string }>(
        `insert into entities (club_id, kind, author_member_id, open_loop) values ($1, 'ask', $2, true) returning id`,
        [owner.club.id, owner.id],
      );
      const askId = askRows[0].id;
      const askV1 = await h.sql<{ id: string }>(
        `insert into entity_versions (entity_id, version_no, state, title, summary)
         values ($1, 1, 'published', 'original ask', 'help me') returning id`,
        [askId],
      );
      await h.sql(
        `insert into entity_embeddings (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
         values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)`,
        [askId, askV1[0].id, makeVector([1, 0, 0])],
      );

      // Edit ask to v2 (stale: no new embedding)
      await h.sql(
        `insert into entity_versions (entity_id, version_no, state, title, summary, supersedes_version_id)
         values ($1, 2, 'published', 'updated ask', 'different topic', $2)`,
        [askId, askV1[0].id],
      );

      // Create a fresh offer with a current-version embedding
      const offerId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.super, offerId, owner.club.id, 10,
      );
      // The ask should NOT be found because its only embedding is for v1, not current v2
      const staleMatch = results.find(r => r.entityId === askId);
      assert.equal(staleMatch, undefined, 'ask with stale v1 embedding should not appear as candidate');
    });

    it('fresh current-version embeddings still produce matches', async () => {
      const owner = await h.seedOwner('fresh-emb', 'FreshEmbClub');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Fresh', 'alice-fresh', { sponsorId: owner.id });
      await seedProfileEmbedding(h, alice.id, makeVector([0.9, 0.1, 0]));

      // Entity with current-version embedding (normal case)
      const entityId = await seedEntityWithEmbedding(
        h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      const results = await findMembersMatchingEntity(
        h.pools.super, entityId, owner.club.id, owner.id, 10,
      );
      assert.ok(results.length >= 1, 'fresh embedding should produce matches');
      assert.equal(results[0].memberId, alice.id);
    });
  });
});
