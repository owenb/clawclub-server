import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';
import {
  findMembersMatchingEntity,
  findSimilarMembers,
  findAskMatchingOffer,
  findExistingThreadPairs,
  canonicalPair,
} from '../../src/workers/similarity.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

/**
 * Create a deterministic 1536-dim vector where the first N elements
 * are set to the given values and the rest are zero.
 * This gives us predictable cosine distances for testing.
 */
function makeVector(values: number[]): string {
  const full = new Array(1536).fill(0);
  for (let i = 0; i < values.length; i++) full[i] = values[i];
  return `[${full.join(',')}]`;
}

/** Seed a profile embedding for a member in the identity DB. */
async function seedProfileEmbedding(memberId: string, vector: string): Promise<void> {
  // Get or create a profile version
  const pvRows = await h.sql<{ id: string }>(
    `select id from app.current_member_profiles where member_id = $1`,
    [memberId],
  );
  let profileVersionId: string;
  if (pvRows.length > 0) {
    profileVersionId = pvRows[0].id;
  } else {
    const insertRows = await h.sql<{ id: string }>(
      `insert into app.member_profile_versions (member_id, version_no, display_name, created_by_member_id)
       values ($1, 1, 'test', $1) returning id`,
      [memberId],
    );
    profileVersionId = insertRows[0].id;
  }

  await h.sql(
    `insert into app.embeddings_member_profile_artifacts
       (member_id, profile_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (member_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [memberId, profileVersionId, vector],
  );
}

/** Seed an entity with an embedding in the clubs DB. */
async function seedEntityWithEmbedding(
  clubId: string,
  authorMemberId: string,
  kind: string,
  vector: string,
): Promise<string> {
  const entityRows = await h.sqlClubs<{ id: string }>(
    `insert into app.entities (club_id, kind, author_member_id)
     values ($1, $2::app.entity_kind, $3) returning id`,
    [clubId, kind, authorMemberId],
  );
  const entityId = entityRows[0].id;

  const versionRows = await h.sqlClubs<{ id: string }>(
    `insert into app.entity_versions (entity_id, version_no, state, title, summary)
     values ($1, 1, 'published', 'test entity', 'test summary') returning id`,
    [entityId],
  );
  const entityVersionId = versionRows[0].id;

  await h.sqlClubs(
    `insert into app.embeddings_entity_artifacts
       (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (entity_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [entityId, entityVersionId, vector],
  );

  return entityId;
}

describe('cross-plane similarity', () => {
  describe('findMembersMatchingEntity', () => {
    it('returns members ranked by cosine distance', async () => {
      const owner = await h.seedOwner('simclub1', 'SimClub1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim', 'alice-sim', { sponsorId: owner.id });
      const bob = await h.seedClubMember(owner.club.id, 'Bob Sim', 'bob-sim', { sponsorId: owner.id });

      // Entity vector: [1, 0, 0, ...]
      const entityId = await seedEntityWithEmbedding(
        owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      // Alice's profile is close to the entity: [0.9, 0.1, 0, ...]
      await seedProfileEmbedding(alice.id, makeVector([0.9, 0.1, 0]));

      // Bob's profile is further: [0.1, 0.9, 0, ...]
      await seedProfileEmbedding(bob.id, makeVector([0.1, 0.9, 0]));

      const results = await findMembersMatchingEntity(
        h.pools.clubs.super, h.pools.identity.super,
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
      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      const entityId = await seedEntityWithEmbedding(
        owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      const results = await findMembersMatchingEntity(
        h.pools.clubs.super, h.pools.identity.super,
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
      await seedProfileEmbedding(alice.id, makeVector([1, 0, 0]));
      const entityId = await seedEntityWithEmbedding(
        owner2.club.id, owner2.id, 'ask', makeVector([1, 0, 0]),
      );

      // Search in club 3b — Alice should NOT appear
      const results = await findMembersMatchingEntity(
        h.pools.clubs.super, h.pools.identity.super,
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
      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      // Alice is close: [0.95, 0.05, 0]
      await seedProfileEmbedding(alice.id, makeVector([0.95, 0.05, 0]));
      // Bob is further: [0.3, 0.7, 0]
      await seedProfileEmbedding(bob.id, makeVector([0.3, 0.7, 0]));

      const results = await findSimilarMembers(
        h.pools.identity.super,
        owner.id, owner.club.id, 10,
      );

      assert.ok(results.length >= 2);
      assert.equal(results[0].memberId, alice.id, 'Alice should be most similar');
      assert.equal(results[1].memberId, bob.id, 'Bob should be second');
    });

    it('excludes self', async () => {
      const owner = await h.seedOwner('simclub5', 'SimClub5');
      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));

      const results = await findSimilarMembers(
        h.pools.identity.super,
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
        owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]),
      );

      // Create a service (offer) entity with similar vector
      const serviceId = await seedEntityWithEmbedding(
        owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.clubs.super,
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
        owner.club.id, owner.id, 'post', makeVector([1, 0, 0]),
      );

      // Create a service (offer) to search from
      const serviceId = await seedEntityWithEmbedding(
        owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]),
      );

      const results = await findAskMatchingOffer(
        h.pools.clubs.super,
        serviceId, owner.club.id, 10,
      );

      // The post should not appear — only asks
      assert.equal(results.length, 0, 'should not return non-ask entities');
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
      const pairs = await findExistingThreadPairs(h.pools.messaging.super, [a], [b]);

      assert.equal(pairs.size, 1, 'should find the existing thread');
      assert.ok(pairs.has(`${a}:${b}`));
    });

    it('returns empty for pairs without threads', async () => {
      const owner = await h.seedOwner('simclub9', 'SimClub9');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Sim9', 'alice-sim9', { sponsorId: owner.id });

      const [a, b] = canonicalPair(owner.id, alice.id);
      const pairs = await findExistingThreadPairs(h.pools.messaging.super, [a], [b]);

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
});
