import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';
import {
  processEntityTriggers,
  processProfileTriggers,
  processIntroRecompute,
  deliverMatches,
  enqueueIntroRecompute,
  processMemberAccessibilityTriggers,
} from '../../src/workers/serendipity.ts';
import type { WorkerPools } from '../../src/workers/runner.ts';

let h: TestHarness;

/** Map test harness pools to WorkerPools shape. */
function workerPools(): WorkerPools {
  return {
    identity: h.pools.identity.super,
    clubs: h.pools.clubs.super,
    messaging: h.pools.messaging.super,
  };
}

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Embedding helpers ─────────────────────────────────────

function makeVector(values: number[]): string {
  const full = new Array(1536).fill(0);
  for (let i = 0; i < values.length; i++) full[i] = values[i];
  return `[${full.join(',')}]`;
}

async function seedProfileEmbedding(memberId: string, vector: string): Promise<void> {
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

async function seedEntityWithEmbedding(
  clubId: string, authorMemberId: string, kind: string, vector: string,
): Promise<string> {
  const entityRows = await h.sqlClubs<{ id: string }>(
    `insert into app.entities (club_id, kind, author_member_id)
     values ($1, $2::app.entity_kind, $3) returning id`,
    [clubId, kind, authorMemberId],
  );
  const entityId = entityRows[0].id;
  const versionRows = await h.sqlClubs<{ id: string }>(
    `insert into app.entity_versions (entity_id, version_no, state, title, summary)
     values ($1, 1, 'published', 'test', 'test summary') returning id`,
    [entityId],
  );
  await h.sqlClubs(
    `insert into app.embeddings_entity_artifacts
       (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (entity_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [entityId, versionRows[0].id, vector],
  );
  return entityId;
}

/** Publish a club_activity entry for an entity (simulates entity creation). */
async function publishActivity(clubId: string, entityId: string, authorMemberId: string): Promise<void> {
  await h.sqlClubs(
    `insert into app.club_activity (club_id, entity_id, topic, created_by_member_id)
     values ($1, $2, 'entity.version.published', $3)`,
    [clubId, entityId, authorMemberId],
  );
}

/** Get all signals for a member. */
async function getSignals(memberId: string): Promise<Array<Record<string, unknown>>> {
  return h.sqlClubs(
    `select * from app.member_signals where recipient_member_id = $1 order by seq asc`,
    [memberId],
  );
}

/** Get all matches for a member. */
async function getMatches(memberId: string): Promise<Array<Record<string, unknown>>> {
  return h.sqlClubs(
    `select * from app.background_matches where target_member_id = $1 order by created_at asc`,
    [memberId],
  );
}

// ── Tests ─────────────────────────────────────────────────

describe('serendipity worker', () => {

  describe('entity-triggered matching', () => {
    it('ask publication creates ask_to_member matches and delivers signals', async () => {
      const owner = await h.seedOwner('sw-ask1', 'SW Ask1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice SW1', 'alice-sw1', { sponsorId: owner.id });

      // Alice has a profile embedding close to the ask
      await seedProfileEmbedding(alice.id, makeVector([1, 0, 0]));

      // Seed the worker's activity cursor first
      const pools = workerPools();
      await processEntityTriggers(pools);

      // Now publish an ask with a similar embedding
      const askId = await seedEntityWithEmbedding(owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      // Run entity triggers → creates matches
      const matchCount = await processEntityTriggers(pools);
      assert.ok(matchCount >= 1, 'should create at least one match');

      // Run delivery → creates signals
      const deliveredCount = await deliverMatches(pools);
      assert.ok(deliveredCount >= 1, 'should deliver at least one signal');

      // Verify signal was created for Alice
      const signals = await getSignals(alice.id);
      const askSignals = signals.filter(s => s.topic === 'signal.ask_match');
      assert.ok(askSignals.length >= 1, 'Alice should receive an ask_match signal');

      const payload = askSignals[0].payload as Record<string, unknown>;
      assert.equal(payload.kind, 'ask_match');
      assert.equal(payload.askEntityId, askId);
    });

    it('service publication creates offer_to_ask matches', async () => {
      const owner = await h.seedOwner('sw-offer1', 'SW Offer1');

      // Owner has an existing ask
      const askId = await seedEntityWithEmbedding(owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));

      // Another member publishes a service with similar embedding
      const bob = await h.seedClubMember(owner.club.id, 'Bob SW1', 'bob-sw1', { sponsorId: owner.id });
      const serviceId = await seedEntityWithEmbedding(owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, serviceId, bob.id);

      const pools = workerPools();
      // Seed the activity cursor first (skip existing activity)
      await processEntityTriggers(pools);
      // Publish the service activity after seeding
      await publishActivity(owner.club.id, serviceId, bob.id);
      // Process the new activity
      // Note: we need to re-publish because the first processEntityTriggers consumed the one we already posted
      // Actually the first call seeded + consumed. Let's just verify matches exist.

      const matches = await getMatches(owner.id);
      const offerMatches = matches.filter(m => m.match_kind === 'offer_to_ask');
      // The offer_to_ask match targets the ask author (owner)
      if (offerMatches.length === 0) {
        // Need another activity entry since we consumed the first one
        await h.sqlClubs(
          `insert into app.club_activity (club_id, entity_id, topic, created_by_member_id)
           values ($1, $2, 'entity.version.published', $3)`,
          [owner.club.id, serviceId, bob.id],
        );
        await processEntityTriggers(pools);
      }

      const matchesAfter = await getMatches(owner.id);
      const offerMatchesAfter = matchesAfter.filter(m => m.match_kind === 'offer_to_ask');
      assert.ok(offerMatchesAfter.length >= 1, 'owner should have an offer_to_ask match');

      // Deliver
      await deliverMatches(pools);
      const signals = await getSignals(owner.id);
      const offerSignals = signals.filter(s => s.topic === 'signal.offer_match');
      assert.ok(offerSignals.length >= 1, 'owner should receive an offer_match signal');
    });

    it('post publication does not create matches', async () => {
      const owner = await h.seedOwner('sw-post1', 'SW Post1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Post1', 'alice-post1', { sponsorId: owner.id });
      await seedProfileEmbedding(alice.id, makeVector([1, 0, 0]));

      const postId = await seedEntityWithEmbedding(owner.club.id, owner.id, 'post', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, postId, owner.id);

      const pools = workerPools();
      await processEntityTriggers(pools);

      const matches = await getMatches(alice.id);
      assert.equal(matches.length, 0, 'posts should not create matches');
    });
  });

  describe('introduction matching', () => {
    it('profile update enqueues recompute and produces intro matches', async () => {
      const owner = await h.seedOwner('sw-intro1', 'SW Intro1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Intro1', 'alice-intro1', { sponsorId: owner.id });

      // Both have embeddings close to each other
      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(alice.id, makeVector([0.95, 0.05, 0]));

      // Directly enqueue intro recompute (simulates profile trigger)
      const pools = workerPools();
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);

      // Process recompute queue
      const matchCount = await processIntroRecompute(pools);
      assert.ok(matchCount >= 1, 'should create intro matches');

      // Verify match identity
      const matches = await getMatches(owner.id);
      const introMatches = matches.filter(m => m.match_kind === 'member_to_member');
      assert.ok(introMatches.length >= 1, 'owner should have an intro match');
      assert.equal(introMatches[0].source_id, alice.id, 'source_id should be the other member');
      assert.equal(introMatches[0].target_member_id, owner.id, 'target should be the recomputed member');
    });

    it('duplicate intro matches are prevented', async () => {
      const owner = await h.seedOwner('sw-dedup1', 'SW Dedup1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Dedup1', 'alice-dedup1', { sponsorId: owner.id });

      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // First recompute
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Second recompute (e.g., after another profile edit)
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Should still have exactly one intro match for this pair
      const matches = await getMatches(owner.id);
      const introMatches = matches.filter(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.equal(introMatches.length, 1, 'should not duplicate intro match');
    });

    it('warm-up delay prevents immediate recompute for new members', async () => {
      const owner = await h.seedOwner('sw-warmup1', 'SW Warmup1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Warmup1', 'alice-warmup1', { sponsorId: owner.id });

      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // Enqueue with a 1-hour delay (simulates new member warmup)
      await enqueueIntroRecompute(pools.clubs, alice.id, owner.club.id, 3600_000);

      // Try to process — should find nothing ready
      const matchCount = await processIntroRecompute(pools);
      assert.equal(matchCount, 0, 'should not process entries with future recompute_after');

      // Verify the entry exists in the queue
      const queueRows = await h.sqlClubs<{ recompute_after: string }>(
        `select recompute_after::text as recompute_after from app.recompute_queue
         where member_id = $1 and club_id = $2`,
        [alice.id, owner.club.id],
      );
      assert.equal(queueRows.length, 1, 'queue entry should exist');
    });

    it('DM thread existence invalidates pending intro matches at delivery', async () => {
      const owner = await h.seedOwner('sw-dmthread1', 'SW DmThread1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice DmThread1', 'alice-dmthread1', { sponsorId: owner.id });

      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // Create intro match
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Verify match exists and is pending
      const matchesBefore = await getMatches(owner.id);
      const introMatchBefore = matchesBefore.find(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.ok(introMatchBefore, 'intro match should exist');
      assert.equal(introMatchBefore.state, 'pending');

      // Now create a DM thread between them (they connected on their own)
      await h.apiOk(owner.token, 'messages.send', {
        recipientMemberId: alice.id,
        messageText: 'hey!',
      });

      // Try to deliver — this match should be expired
      await deliverMatches(pools);

      // Verify this specific match was expired
      const matchesAfter = await getMatches(owner.id);
      const introMatchAfter = matchesAfter.find(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.ok(introMatchAfter, 'intro match should still exist');
      assert.equal(introMatchAfter.state, 'expired', 'match should be expired due to DM thread');
    });

    it('recompute queue deduplicates entries', async () => {
      const owner = await h.seedOwner('sw-qdedub1', 'SW QDedup1');
      const pools = workerPools();

      // Enqueue the same pair twice
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);

      const queueRows = await h.sqlClubs<{ id: string }>(
        `select id from app.recompute_queue
         where member_id = $1 and club_id = $2 and queue_name = 'introductions'`,
        [owner.id, owner.club.id],
      );
      assert.equal(queueRows.length, 1, 'should have exactly one queue entry');
    });
  });

  describe('delivery and throttling', () => {
    it('per-kind throttling caps introductions more strictly', async () => {
      const owner = await h.seedOwner('sw-throttle1', 'SW Throttle1');
      const pools = workerPools();

      // Seed several members with embeddings
      const members = [];
      for (let i = 0; i < 5; i++) {
        const m = await h.seedClubMember(owner.club.id, `Throttle${i}`, `throttle-${i}`, { sponsorId: owner.id });
        // Each member slightly different vector
        await seedProfileEmbedding(m.id, makeVector([0.9 - i * 0.1, 0.1 + i * 0.1, 0]));
        members.push(m);
      }
      await seedProfileEmbedding(owner.id, makeVector([1, 0, 0]));

      // Create intro matches for all members
      await enqueueIntroRecompute(pools.clubs, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Deliver — should be throttled at MAX_INTROS_PER_WEEK (default 2)
      const delivered1 = await deliverMatches(pools);
      assert.ok(delivered1 <= 2, `should deliver at most 2 intros, got ${delivered1}`);

      // Try delivering again — should be throttled
      const delivered2 = await deliverMatches(pools);
      assert.equal(delivered2, 0, 'should not deliver more intros this week');
    });

    it('entity-removed invalidates pending matches at delivery', async () => {
      const owner = await h.seedOwner('sw-invalid1', 'SW Invalid1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice Invalid1', 'alice-invalid1', { sponsorId: owner.id });
      await seedProfileEmbedding(alice.id, makeVector([1, 0, 0]));

      // Publish an ask and create activity
      const askId = await seedEntityWithEmbedding(owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      const pools = workerPools();
      await processEntityTriggers(pools);

      // Remove the entity before delivery
      await h.sqlClubs(
        `update app.entity_versions set state = 'removed' where entity_id = $1`,
        [askId],
      );

      // Delivery should expire the match
      const delivered = await deliverMatches(pools);
      assert.equal(delivered, 0, 'should not deliver match for removed entity');

      const matches = await getMatches(alice.id);
      const askMatches = matches.filter(m => m.match_kind === 'ask_to_member' && m.source_id === askId);
      assert.ok(askMatches.length >= 1);
      assert.equal(askMatches[0].state, 'expired');
    });
  });

  describe('end-to-end pipeline', () => {
    it('full ask pipeline: publish → match → deliver → signal appears in updates', async () => {
      const owner = await h.seedOwner('sw-e2e1', 'SW E2E1');
      const alice = await h.seedClubMember(owner.club.id, 'Alice E2E1', 'alice-e2e1', { sponsorId: owner.id });
      await seedProfileEmbedding(alice.id, makeVector([1, 0, 0]));

      // Seed cursor for Alice's updates
      const initial = await h.apiOk(alice.token, 'updates.list', { limit: 50 });
      const cursor = ((initial.data as Record<string, unknown>).updates as { nextAfter: string }).nextAfter;

      // Publish ask with embedding
      const askId = await seedEntityWithEmbedding(owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      // Run full pipeline
      const pools = workerPools();
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      // Alice polls updates — should see the signal
      const poll = await h.apiOk(alice.token, 'updates.list', { after: cursor, limit: 50 });
      const items = ((poll.data as Record<string, unknown>).updates as { items: Array<Record<string, unknown>> }).items;
      const signalItems = items.filter(u => u.source === 'signal' && u.topic === 'signal.ask_match');

      assert.ok(signalItems.length >= 1, 'Alice should see ask_match signal in her update feed');
      const payload = signalItems[0].payload as Record<string, unknown>;
      assert.equal(payload.askEntityId, askId);
    });
  });
});
