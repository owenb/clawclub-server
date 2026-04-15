import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getNotifications, makeVector, seedEntityWithEmbedding, seedProfileEmbedding } from '../helpers.ts';
import {
  processEntityTriggers,
  processProfileTriggers,
  processIntroRecompute,
  deliverMatches,
  enqueueIntroRecompute,
  processMemberAccessibilityTriggers,
} from '../../../src/workers/synchronicity.ts';
import type { WorkerPools } from '../../../src/workers/runner.ts';

let h: TestHarness;

/** Map test harness pools to WorkerPools shape. */
function workerPools(): WorkerPools {
  return {
    db: h.pools.super,
  };
}

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

/** Publish an activity entry for an entity (simulates entity creation). */
async function publishActivity(clubId: string, entityId: string, authorMemberId: string): Promise<void> {
  await h.sqlClubs(
    `insert into club_activity (club_id, entity_id, topic, created_by_member_id)
     values ($1, $2, 'entity.version.published', $3)`,
    [clubId, entityId, authorMemberId],
  );
}

/** Get all materialized notifications for a member. */
async function getSignals(memberId: string): Promise<Array<Record<string, unknown>>> {
  return h.sqlClubs(
    `select * from member_notifications where recipient_member_id = $1 order by seq asc`,
    [memberId],
  );
}

/** Get all matches for a member. */
async function getMatches(memberId: string): Promise<Array<Record<string, unknown>>> {
  return h.sqlClubs(
    `select * from signal_background_matches where target_member_id = $1 order by created_at asc`,
    [memberId],
  );
}

// ── Tests ─────────────────────────────────────────────────

describe('synchronicity worker', () => {

  describe('entity-triggered matching', () => {
    it('ask publication creates ask_to_member matches and delivers signals', async () => {
      const owner = await h.seedOwner('sw-ask1', 'SW Ask1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice SW1');

      // Alice has a profile embedding close to the ask
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      // Seed the worker's activity cursor first
      const pools = workerPools();
      await processEntityTriggers(pools);

      // Now publish an ask with a similar embedding
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      // Run entity triggers → creates matches
      const matchCount = await processEntityTriggers(pools);
      assert.ok(matchCount >= 1, 'should create at least one match');

      // Run delivery → creates signals
      const deliveredCount = await deliverMatches(pools);
      assert.ok(deliveredCount >= 1, 'should deliver at least one signal');

      // Verify signal was created for Alice
      const signals = await getSignals(alice.id);
      const askSignals = signals.filter(s => s.topic === 'synchronicity.ask_to_member');
      assert.ok(askSignals.length >= 1, 'Alice should receive an ask_to_member notification');

      const payload = askSignals[0].payload as Record<string, unknown>;
      assert.equal(payload.kind, 'synchronicity.ask_to_member');
      assert.equal(payload.askEntityId, askId);
    });

    it('service publication creates offer_to_ask matches', async () => {
      const owner = await h.seedOwner('sw-offer1', 'SW Offer1');

      // Owner has an existing ask
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));

      // Another member publishes a service with similar embedding
      const bob = await h.seedCompedMember(owner.club.id, 'Bob SW1');
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));
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
          `insert into club_activity (club_id, entity_id, topic, created_by_member_id)
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
      const offerSignals = signals.filter(s => s.topic === 'synchronicity.offer_to_ask');
      assert.ok(offerSignals.length >= 1, 'owner should receive an offer_to_ask notification');
    });

    it('gift publication creates offer_to_ask matches', async () => {
      const owner = await h.seedOwner('sw-gift1', 'SW Gift1');
      const giver = await h.seedCompedMember(owner.club.id, 'Gift Giver');

      await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools);

      const giftId = await seedEntityWithEmbedding(h, owner.club.id, giver.id, 'gift', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, giftId, giver.id);

      const matchCount = await processEntityTriggers(pools);
      assert.ok(matchCount >= 1, 'gift should create offer_to_ask matches');

      await deliverMatches(pools);
      const signals = await getSignals(owner.id);
      const offerSignals = signals.filter(s => s.topic === 'synchronicity.offer_to_ask');
      assert.ok(offerSignals.length >= 1, 'gift should deliver an offer_to_ask notification');
    });

    it('closed gifts do not create matches at trigger time', async () => {
      const owner = await h.seedOwner('sw-gift-closed', 'SW Gift Closed');
      const giver = await h.seedCompedMember(owner.club.id, 'Closed Gift Giver');

      await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const giftId = await seedEntityWithEmbedding(h, owner.club.id, giver.id, 'gift', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools);

      await h.apiOk(giver.token, 'content.closeLoop', { entityId: giftId });
      await publishActivity(owner.club.id, giftId, giver.id);
      await processEntityTriggers(pools);

      const matches = await getMatches(owner.id);
      const giftMatches = matches.filter(m => m.match_kind === 'offer_to_ask' && m.source_id === giftId);
      assert.equal(giftMatches.length, 0, 'closed gift must not trigger offer matching');
    });

    it('pending gift matches expire instead of delivering after the gift is closed', async () => {
      const owner = await h.seedOwner('sw-gift-delivery-close', 'SW Gift Delivery Close');
      const giver = await h.seedCompedMember(owner.club.id, 'Delivery Giver');

      await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const giftId = await seedEntityWithEmbedding(h, owner.club.id, giver.id, 'gift', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools);
      await publishActivity(owner.club.id, giftId, giver.id);
      await processEntityTriggers(pools);

      const pendingBeforeClose = (await getMatches(owner.id)).find(
        m => m.match_kind === 'offer_to_ask' && m.source_id === giftId,
      );
      assert.equal(pendingBeforeClose?.state, 'pending');

      await h.apiOk(giver.token, 'content.closeLoop', { entityId: giftId });
      await deliverMatches(pools);

      const matchAfterDelivery = (await getMatches(owner.id)).find(
        m => m.match_kind === 'offer_to_ask' && m.source_id === giftId,
      );
      assert.equal(matchAfterDelivery?.state, 'expired',
        'closing the source gift must expire the pending match before delivery');

      const signals = await getSignals(owner.id);
      assert.equal(signals.filter(s => s.topic === 'synchronicity.offer_to_ask').length, 0,
        'no offer_to_ask notification should be delivered for a closed gift');
    });

    it('reopening a gift clears historical matches so the same recipient can be matched again', async () => {
      const owner = await h.seedOwner('sw-gift-reopen', 'SW Gift Reopen');
      const giver = await h.seedCompedMember(owner.club.id, 'Reopen Giver');

      await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const giftId = await seedEntityWithEmbedding(h, owner.club.id, giver.id, 'gift', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools);
      await publishActivity(owner.club.id, giftId, giver.id);
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      const firstSignals = await getSignals(owner.id);
      assert.equal(firstSignals.filter(s => s.topic === 'synchronicity.offer_to_ask').length, 1);

      await h.apiOk(giver.token, 'content.closeLoop', { entityId: giftId });
      await h.apiOk(giver.token, 'content.reopenLoop', { entityId: giftId });

      await publishActivity(owner.club.id, giftId, giver.id);
      const rematchCount = await processEntityTriggers(pools);
      assert.ok(rematchCount >= 1, 'reopened gift should be able to create a fresh match');

      await deliverMatches(pools);
      const secondSignals = await getSignals(owner.id);
      assert.equal(secondSignals.filter(s => s.topic === 'synchronicity.offer_to_ask').length, 2,
        'the same recipient should be matchable again after reopen');
    });

    it('post publication does not create matches', async () => {
      const owner = await h.seedOwner('sw-post1', 'SW Post1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Post1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const postId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'post', makeVector([0.95, 0.05, 0]));
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
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Intro1');

      // Both have embeddings close to each other
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      // Directly enqueue intro recompute (simulates profile trigger)
      const pools = workerPools();
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);

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
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Dedup1');

      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // First recompute
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Second recompute (e.g., after another profile edit)
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
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
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Warmup1');

      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // Enqueue with a 1-hour delay (simulates new member warmup)
      await enqueueIntroRecompute(pools.db, alice.id, owner.club.id, 3600_000);

      // Try to process — should find nothing ready
      const matchCount = await processIntroRecompute(pools);
      assert.equal(matchCount, 0, 'should not process entries with future recompute_after');

      // Verify the entry exists in the queue
      const queueRows = await h.sqlClubs<{ recompute_after: string }>(
        `select recompute_after::text as recompute_after from signal_recompute_queue
         where member_id = $1 and club_id = $2`,
        [alice.id, owner.club.id],
      );
      assert.equal(queueRows.length, 1, 'queue entry should exist');
    });

    it('DM thread existence invalidates pending intro matches at delivery', async () => {
      const owner = await h.seedOwner('sw-dmthread1', 'SW DmThread1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice DmThread1');

      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // Create intro match
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
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
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);

      const queueRows = await h.sqlClubs<{ id: string }>(
        `select id from signal_recompute_queue
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
        const m = await h.seedCompedMember(owner.club.id, `Throttle${i}`);
        // Each member slightly different vector
        await seedProfileEmbedding(h, m.id, makeVector([0.9 - i * 0.1, 0.1 + i * 0.1, 0]));
        members.push(m);
      }
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));

      // Create intro matches for all members
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
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
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Invalid1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      // Publish an ask and create activity
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      const pools = workerPools();
      await processEntityTriggers(pools);

      // Remove the entity before delivery
      await h.sqlClubs(
        `update entity_versions set state = 'removed' where entity_id = $1`,
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
    it('full ask pipeline: publish → match → deliver → notification appears in notifications.list', async () => {
      const owner = await h.seedOwner('sw-e2e1', 'SW E2E1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice E2E1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const initial = getNotifications(await h.apiOk(alice.token, 'notifications.list', { limit: 50 }));
      const cursor = initial.nextAfter;

      // Publish ask with embedding
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);

      // Run full pipeline
      const pools = workerPools();
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      const poll = getNotifications(await h.apiOk(alice.token, 'notifications.list', { after: cursor, limit: 50 }));
      const signalItems = poll.items.filter((u) => u.kind === 'synchronicity.ask_to_member');

      assert.ok(signalItems.length >= 1, 'Alice should see ask_to_member in notifications.list');
      const payload = signalItems[0].payload as Record<string, unknown>;
      assert.equal(payload.askEntityId, askId);
    });
  });

  describe('crash-retry idempotency', () => {
    it('duplicate signal insert is prevented by unique match_id index', async () => {
      const owner = await h.seedOwner('sw-idem1', 'SW Idem1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Idem1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools);

      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // Deliver once
      await deliverMatches(pools);

      const signals1 = await getSignals(alice.id);
      const askSignals1 = signals1.filter(s => s.topic === 'synchronicity.ask_to_member');
      assert.equal(askSignals1.length, 1, 'should have exactly one signal');

      // Simulate crash-retry: manually insert a second signal with the same match_id
      const matchRows = await h.sqlClubs<{ id: string }>(
        `select id from signal_background_matches where target_member_id = $1 and match_kind = 'ask_to_member'`,
        [alice.id],
      );
      assert.ok(matchRows.length >= 1);

      // The unique index should prevent this
      const dupResult = await h.sqlClubs<{ id: string }>(
        `insert into member_notifications (club_id, recipient_member_id, topic, payload, match_id)
         values ($1, $2, 'synchronicity.ask_to_member', '{}'::jsonb, $3)
         on conflict ((match_id)) where match_id is not null do nothing
         returning id`,
        [owner.club.id, alice.id, matchRows[0].id],
      );
      assert.equal(dupResult.length, 0, 'duplicate signal should be silently skipped');

      // Still only one signal
      const signals2 = await getSignals(alice.id);
      const askSignals2 = signals2.filter(s => s.topic === 'synchronicity.ask_to_member');
      assert.equal(askSignals2.length, 1, 'should still have exactly one signal');
    });
  });

  describe('offer_to_ask payload', () => {
    it('offer_to_ask notification includes yourAskEntityId', async () => {
      const owner = await h.seedOwner('sw-offpay1', 'SW OffPay1');
      const bob = await h.seedCompedMember(owner.club.id, 'Bob OffPay1');

      // Owner has an ask
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));

      // Bob publishes a service that matches the ask
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      const signals = await getSignals(owner.id);
      const offerSignals = signals.filter(s => s.topic === 'synchronicity.offer_to_ask');
      assert.ok(offerSignals.length >= 1, 'owner should receive offer_to_ask notification');

      const payload = offerSignals[0].payload as Record<string, unknown>;
      assert.equal(payload.kind, 'synchronicity.offer_to_ask');
      assert.equal(payload.offerEntityId, serviceId);
      assert.equal(payload.yourAskEntityId, askId, 'should include the matched ask entity ID');
    });
  });

  describe('zero-candidate queue cleanup', () => {
    it('recompute entry is deleted even when no candidates found', async () => {
      // Create a member with no other members in the club (no candidates)
      const owner = await h.seedOwner('sw-zerocand1', 'SW ZeroCand1');
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);

      // Verify entry exists
      const before = await h.sqlClubs<{ id: string }>(
        `select id from signal_recompute_queue where member_id = $1 and club_id = $2`,
        [owner.id, owner.club.id],
      );
      assert.equal(before.length, 1, 'queue entry should exist before processing');

      // Process — no other members, so zero candidates
      await processIntroRecompute(pools);

      // Entry should be cleaned up, not stuck as a stale lease
      const after = await h.sqlClubs<{ id: string }>(
        `select id from signal_recompute_queue where member_id = $1 and club_id = $2`,
        [owner.id, owner.club.id],
      );
      assert.equal(after.length, 0, 'queue entry should be deleted after zero-candidate processing');
    });
  });

  describe('backstop sweep', () => {
    it('enqueues all accessible members for intro recompute', async () => {
      const owner = await h.seedOwner('sw-backstop1', 'SW Backstop1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Backstop1');

      const pools = workerPools();

      // Clear any backstop state so the sweep runs
      await h.sqlClubs(
        `delete from worker_state where worker_id = 'synchronicity' and state_key = 'backstop_sweep_at'`,
      );

      const { processBackstopSweep } = await import('../../../src/workers/synchronicity.ts');
      const enqueued = await processBackstopSweep(pools);

      assert.ok(enqueued >= 2, `should enqueue at least 2 members (owner + alice), got ${enqueued}`);

      // Verify queue entries exist
      const queueRows = await h.sqlClubs<{ member_id: string }>(
        `select member_id from signal_recompute_queue where queue_name = 'introductions' and club_id = $1`,
        [owner.club.id],
      );
      const memberIds = queueRows.map(r => r.member_id);
      assert.ok(memberIds.includes(owner.id), 'owner should be in recompute queue');
      assert.ok(memberIds.includes(alice.id), 'alice should be in recompute queue');
    });
  });

  // ── User promise tests ────────────────────────────────────
  // These test the specific guarantees we make to users about
  // signal quality and correctness.

  describe('user promises', () => {
    it('no self offer->ask signal: member never gets matched to their own ask', async () => {
      const owner = await h.seedOwner('sw-selfmatch', 'SW SelfMatch');

      // Owner posts both an ask and a service with similar embeddings
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor
      await publishActivity(owner.club.id, serviceId, owner.id);
      await processEntityTriggers(pools);

      // Owner should NOT have an offer_to_ask match targeting themselves
      const matches = await getMatches(owner.id);
      const selfMatches = matches.filter(
        m => m.match_kind === 'offer_to_ask' && m.source_id === serviceId,
      );
      assert.equal(selfMatches.length, 0, 'member must never get matched to their own ask');
    });

    it('stale pending match does not deliver after TTL', async () => {
      const owner = await h.seedOwner('sw-ttl1', 'SW TTL1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice TTL1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // Verify match was created with expires_at
      const matches = await getMatches(alice.id);
      const askMatch = matches.find(m => m.match_kind === 'ask_to_member' && m.source_id === askId);
      assert.ok(askMatch, 'match should exist');
      assert.ok(askMatch.expires_at, 'match should have an expires_at');

      // Artificially age the match past its TTL
      await h.sqlClubs(
        `update signal_background_matches
         set created_at = now() - interval '10 days',
             expires_at = now() - interval '1 hour'
         where id = $1`,
        [askMatch.id],
      );

      // Delivery should expire it, not deliver it
      await deliverMatches(pools);

      const matchAfter = (await getMatches(alice.id)).find(m => m.id === askMatch.id);
      assert.equal(matchAfter?.state, 'expired', 'TTL-expired match must not be delivered');

      const signals = await getSignals(alice.id);
      const askSignals = signals.filter(s => s.topic === 'synchronicity.ask_to_member' && (s.payload as Record<string, unknown>).askEntityId === askId);
      assert.equal(askSignals.length, 0, 'no signal should exist for TTL-expired match');
    });

    it('edited ask invalidates old pending match', async () => {
      const owner = await h.seedOwner('sw-drift1', 'SW Drift1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Drift1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      // Create ask v1
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      const matchesBefore = await getMatches(alice.id);
      const matchBefore = matchesBefore.find(m => m.match_kind === 'ask_to_member' && m.source_id === askId);
      assert.ok(matchBefore, 'match v1 should exist');
      assert.equal(matchBefore.state, 'pending');

      // "Edit" the ask: create a new version (simulates entity update)
      await h.sqlClubs(
        `insert into entity_versions (entity_id, version_no, state, title, summary)
         values ($1, 2, 'published', 'edited ask', 'different content now')`,
        [askId],
      );

      // Publish the edit as a new activity entry
      await publishActivity(owner.club.id, askId, owner.id);
      // Process triggers — this should expire old pending matches for this entity
      await processEntityTriggers(pools);

      // The old match should now be expired
      const matchAfter = (await getMatches(alice.id)).find(m => m.id === matchBefore.id);
      assert.equal(matchAfter?.state, 'expired', 'old version match must be expired on re-publish');
    });

    it('edited offer invalidates old pending offer_to_ask match', async () => {
      const owner = await h.seedOwner('sw-drift2', 'SW Drift2');
      const bob = await h.seedCompedMember(owner.club.id, 'Bob Drift2');

      // Owner has an ask, Bob publishes a matching service
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);

      const matchesBefore = await getMatches(owner.id);
      const matchBefore = matchesBefore.find(m => m.match_kind === 'offer_to_ask');
      assert.ok(matchBefore, 'offer_to_ask match should exist');

      // "Edit" the service
      await h.sqlClubs(
        `insert into entity_versions (entity_id, version_no, state, title, summary)
         values ($1, 2, 'published', 'edited service', 'different offering now')`,
        [serviceId],
      );

      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);

      const matchAfter = (await getMatches(owner.id)).find(m => m.id === matchBefore.id);
      assert.equal(matchAfter?.state, 'expired', 'old offer match must be expired on re-publish');
    });

    it('removed entity never appears in a signal payload', async () => {
      const owner = await h.seedOwner('sw-removed1', 'SW Removed1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Removed1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // Remove the entity before delivery
      await h.sqlClubs(
        `update entity_versions set state = 'removed' where entity_id = $1`,
        [askId],
      );

      await deliverMatches(pools);

      // No signal should reference the removed entity
      const signals = await getSignals(alice.id);
      for (const s of signals) {
        const payload = s.payload as Record<string, unknown>;
        assert.notEqual(payload.askEntityId, askId, 'removed entity must not appear in signal payload');
      }
    });

    it('no duplicate intro after profile re-embedding', async () => {
      const owner = await h.seedOwner('sw-reembed1', 'SW Reembed1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Reembed1');

      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();

      // Drain any leftover recompute entries from previous tests
      await h.sqlClubs(`delete from signal_recompute_queue where queue_name = 'introductions'`);

      // First recompute: creates intro match
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      const matches1 = await getMatches(owner.id);
      const intros1 = matches1.filter(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.equal(intros1.length, 1, 'should have exactly one intro match');

      // Simulate profile re-embedding and recompute again
      await seedProfileEmbedding(h, owner.id, makeVector([0.99, 0.01, 0]));
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Should still have exactly one match — dedup prevents duplicates
      const matches2 = await getMatches(owner.id);
      const intros2 = matches2.filter(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.equal(intros2.length, 1, 'must not create duplicate intro match after re-embedding');
    });

    it('edited matched ask invalidates pending offer_to_ask match', async () => {
      const owner = await h.seedOwner('sw-askdrift1', 'SW AskDrift1');
      const bob = await h.seedCompedMember(owner.club.id, 'Bob AskDrift1');

      // Owner has an ask, Bob publishes a matching service
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);

      // Verify offer_to_ask match exists
      const matchesBefore = await getMatches(owner.id);
      const matchBefore = matchesBefore.find(m => m.match_kind === 'offer_to_ask');
      assert.ok(matchBefore, 'offer_to_ask match should exist');
      assert.equal(matchBefore.state, 'pending');

      // Now edit the ASK (new version)
      await h.sqlClubs(
        `insert into entity_versions (entity_id, version_no, state, title, summary)
         values ($1, 2, 'published', 'edited ask', 'totally different need now')`,
        [askId],
      );
      // Re-publish the ask
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // The old offer_to_ask match should be expired
      const matchAfter = (await getMatches(owner.id)).find(m => m.id === matchBefore.id);
      assert.equal(matchAfter?.state, 'expired',
        'offer_to_ask match must be expired when the matched ask is edited');
    });

    it('delayed profile embedding does not create intro messages', async () => {
      const owner = await h.seedOwner('sw-delayed1', 'SW Delayed1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Delayed1');

      const pools = workerPools();

      // Seed the profile trigger cursor
      await processProfileTriggers(pools);

      // Simulate a delayed embedding: the profile was changed 5 days ago
      // but the embedding was just completed now (e.g., OpenAI outage recovery)
      const membershipRows = await h.sql<{ membership_id: string }>(
        `select id as membership_id
           from club_memberships
          where member_id = $1 and club_id = $2
          limit 1`,
        [alice.id, owner.club.id],
      );
      const membershipId = membershipRows[0]!.membership_id;
      const r = await h.sql<{ id: string }>(
        `insert into member_club_profile_versions
           (membership_id, member_id, club_id, version_no, created_by_member_id, generation_source, created_at)
         values (
           $1::short_id,
           $2::short_id,
           $3::short_id,
           (
             select coalesce(max(version_no), 0) + 1
             from member_club_profile_versions
             where member_id = $2::short_id and club_id = $3::short_id
           ),
           $2::short_id,
           'membership_seed',
           now() - interval '5 days'
         )
         returning id`,
        [membershipId, alice.id, owner.club.id],
      );
      const pvId = r[0]!.id;

      // Insert the embedding artifact as if it just completed now
      await h.sql(
        `insert into member_profile_embeddings
           (member_id, club_id, profile_version_id, model, dimensions, source_version,
            chunk_index, source_text, source_hash, embedding, updated_at)
         values ($1, $2, $3, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'delayed',
                 $4::vector, now())
         on conflict (member_id, club_id, model, dimensions, source_version, chunk_index)
         do update set embedding = excluded.embedding,
                       profile_version_id = excluded.profile_version_id,
                       source_hash = excluded.source_hash,
                       updated_at = now()`,
        [alice.id, owner.club.id, pvId, makeVector([0.9, 0.1, 0])],
      );

      // Process profile triggers — should skip this delayed embedding
      const enqueued = await processProfileTriggers(pools);

      // Verify no recompute was enqueued for this member
      const queueRows = await h.sqlClubs<{ id: string }>(
        `select id from signal_recompute_queue
         where queue_name = 'introductions' and member_id = $1 and club_id = $2`,
        [alice.id, owner.club.id],
      );
      assert.equal(queueRows.length, 0,
        'delayed profile embedding must not enqueue intro recompute');
    });

    it('freshness guard: very old match does not deliver after outage', async () => {
      const owner = await h.seedOwner('sw-fresh1', 'SW Fresh1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice Fresh1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // Artificially age the match beyond the freshness cutoff but within TTL
      await h.sqlClubs(
        `update signal_background_matches
         set created_at = now() - interval '4 days'
         where target_member_id = $1 and match_kind = 'ask_to_member'`,
        [alice.id],
      );

      // Delivery should expire it due to freshness guard
      await deliverMatches(pools);

      const match = (await getMatches(alice.id)).find(m => m.match_kind === 'ask_to_member' && m.source_id === askId);
      assert.equal(match?.state, 'expired', 'match older than freshness cutoff must not deliver');
    });

    it('removed entity content does not surface through delivered signal', async () => {
      const owner = await h.seedOwner('sw-removesig1', 'SW RemoveSig1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice RemoveSig1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const initial = getNotifications(await h.apiOk(alice.token, 'notifications.list', { limit: 50 }));
      const cursor = initial.nextAfter;

      // Create and deliver an ask signal
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      // Now remove the entity AFTER signal delivery but BEFORE read
      await h.sqlClubs(
        `update entity_versions set state = 'removed' where entity_id = $1`,
        [askId],
      );

      const poll = getNotifications(await h.apiOk(alice.token, 'notifications.list', { after: cursor, limit: 50 }));
      const entitySignals = poll.items.filter((u) => u.ref.entityId === askId);
      assert.equal(entitySignals.length, 0,
        'notification for removed entity must not appear in notifications.list');
    });

    it('pending ask_to_member expires when recipient profile changes', async () => {
      const owner = await h.seedOwner('sw-profask1', 'SW ProfAsk1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice ProfAsk1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor
      await processProfileTriggers(pools); // seed profile cursor

      // Create ask match for alice
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      const matchBefore = (await getMatches(alice.id)).find(m => m.match_kind === 'ask_to_member');
      assert.ok(matchBefore, 'ask_to_member match should exist');
      assert.equal(matchBefore.state, 'pending');

      // Alice updates her profile (simulated via embedding update)
      await seedProfileEmbedding(h, alice.id, makeVector([0.1, 0.9, 0]));

      // Process profile triggers — should expire pending matches for alice
      await processProfileTriggers(pools);

      const matchAfter = (await getMatches(alice.id)).find(m => m.id === matchBefore.id);
      assert.equal(matchAfter?.state, 'expired',
        'pending ask_to_member must expire when recipient profile changes');
    });

    it('pending introduction expires when either member profile changes', async () => {
      const owner = await h.seedOwner('sw-profintro1', 'SW ProfIntro1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice ProfIntro1');

      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processProfileTriggers(pools); // seed profile cursor

      // Drain leftover recompute entries
      await h.sqlClubs(`delete from signal_recompute_queue where queue_name = 'introductions'`);

      // Create intro match
      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      const matchBefore = (await getMatches(owner.id)).find(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.ok(matchBefore, 'intro match should exist');
      assert.equal(matchBefore.state, 'pending');

      // Alice updates her profile — the intro match based on her old profile is stale
      await seedProfileEmbedding(h, alice.id, makeVector([0.1, 0.9, 0]));
      await processProfileTriggers(pools);

      const matchAfter = (await getMatches(owner.id)).find(m => m.id === matchBefore.id);
      assert.equal(matchAfter?.state, 'expired',
        'pending intro must expire when either member profile changes');
    });

    it('recipient loses access before ask_to_member delivery => no signal', async () => {
      const owner = await h.seedOwner('sw-noaccess1', 'SW NoAccess1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice NoAccess1');
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      // Remove Alice's access: revoke membership state + end subscription
      const membershipRows = await h.sql<{ id: string }>(
        `select id from club_memberships where member_id = $1 and club_id = $2`,
        [alice.id, owner.club.id],
      );
      const membershipId = membershipRows[0]!.id;
      await h.sql(
        `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
         values ($1, 'removed', 'test', 99, $2)`,
        [membershipId, owner.id],
      );
      await h.sql(
        `update club_subscriptions set status = 'canceled', ended_at = now()
         where membership_id = $1`,
        [membershipId],
      );

      await deliverMatches(pools);

      const matchAfter = (await getMatches(alice.id)).find(m => m.match_kind === 'ask_to_member');
      assert.equal(matchAfter?.state, 'expired',
        'ask_to_member match must expire when recipient loses access');

      const signals = await getSignals(alice.id);
      assert.equal(signals.filter(s => s.topic === 'synchronicity.ask_to_member').length, 0,
        'no notification should be delivered to inaccessible recipient');
    });

    it('recipient loses access before offer_to_ask delivery => no signal', async () => {
      const owner = await h.seedOwner('sw-noaccess2', 'SW NoAccess2');
      // Alice is a regular member (not clubadmin) who posts an ask
      const alice = await h.seedCompedMember(owner.club.id, 'Alice NoAccess2');
      // Bob publishes a matching service
      const bob = await h.seedCompedMember(owner.club.id, 'Bob NoAccess2');

      const askId = await seedEntityWithEmbedding(h, owner.club.id, alice.id, 'ask', makeVector([1, 0, 0]));
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor
      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);

      // Revoke Alice's access before delivery
      const membershipRows = await h.sql<{ id: string }>(
        `select id from club_memberships where member_id = $1 and club_id = $2`,
        [alice.id, owner.club.id],
      );
      await h.sql(
        `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
         values ($1, 'removed', 'test', 99, $2)`,
        [membershipRows[0]!.id, owner.id],
      );
      await h.sql(
        `update club_subscriptions set status = 'canceled', ended_at = now()
         where membership_id = $1`,
        [membershipRows[0]!.id],
      );

      await deliverMatches(pools);

      const matchAfter = (await getMatches(alice.id)).find(m => m.match_kind === 'offer_to_ask');
      assert.equal(matchAfter?.state, 'expired',
        'offer_to_ask match must expire when recipient loses access');

      const signals = await getSignals(alice.id);
      assert.equal(signals.filter(s => s.topic === 'synchronicity.offer_to_ask').length, 0,
        'no notification should be delivered to inaccessible recipient');
    });

    it('stale profile embedding: profile advances without new embedding => no ask_to_member match', async () => {
      const owner = await h.seedOwner('sw-staleprof1', 'SW StaleProf1');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice StaleProf1');

      // Alice has v1 profile embedding
      await seedProfileEmbedding(h, alice.id, makeVector([1, 0, 0]));

      // Alice updates her profile to v2 (no new embedding yet — simulates pending embedding job)
      const membershipRows = await h.sql<{ membership_id: string }>(
        `select id as membership_id
           from club_memberships
          where member_id = $1 and club_id = $2
          limit 1`,
        [alice.id, owner.club.id],
      );
      await h.sql(
        `insert into member_club_profile_versions (
           membership_id, member_id, club_id, version_no, created_by_member_id, generation_source
         )
         values ($1, $2, $3, 2, $2, 'manual')`,
        [membershipRows[0]!.membership_id, alice.id, owner.club.id],
      );

      // Now her current_profiles.id is v2, but her embedding is for v1
      // Publish an ask — Alice should NOT be matched because her embedding is stale
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor
      await publishActivity(owner.club.id, askId, owner.id);
      await processEntityTriggers(pools);

      const matches = await getMatches(alice.id);
      const askMatches = matches.filter(m => m.match_kind === 'ask_to_member' && m.source_id === askId);
      assert.equal(askMatches.length, 0,
        'member with stale profile embedding must not be matched to asks');
    });

    it('stale profile embedding: profile advances without new embedding => no intro match', async () => {
      const owner = await h.seedOwner('sw-staleprof2', 'SW StaleProf2');
      const alice = await h.seedCompedMember(owner.club.id, 'Alice StaleProf2');

      // Owner has current embedding
      await seedProfileEmbedding(h, owner.id, makeVector([1, 0, 0]));

      // Alice has v1 embedding
      await seedProfileEmbedding(h, alice.id, makeVector([0.95, 0.05, 0]));

      // Alice updates her profile to v2 (embedding still for v1)
      const membershipRows = await h.sql<{ membership_id: string }>(
        `select id as membership_id
           from club_memberships
          where member_id = $1 and club_id = $2
          limit 1`,
        [alice.id, owner.club.id],
      );
      await h.sql(
        `insert into member_club_profile_versions (
           membership_id, member_id, club_id, version_no, created_by_member_id, generation_source
         )
         values ($1, $2, $3, 2, $2, 'manual')`,
        [membershipRows[0]!.membership_id, alice.id, owner.club.id],
      );

      const pools = workerPools();
      await h.sqlClubs(`delete from signal_recompute_queue where queue_name = 'introductions'`);

      await enqueueIntroRecompute(pools.db, owner.id, owner.club.id);
      await processIntroRecompute(pools);

      // Owner should not get an intro match for Alice because Alice's embedding is stale
      const matches = await getMatches(owner.id);
      const introMatches = matches.filter(
        m => m.match_kind === 'member_to_member' && m.source_id === alice.id,
      );
      assert.equal(introMatches.length, 0,
        'intro must not match against member with stale profile embedding');
    });

    it('removed matched ask hides delivered offer_to_ask notification from notifications.list', async () => {
      const owner = await h.seedOwner('sw-askremove1', 'SW AskRemove1');
      const bob = await h.seedCompedMember(owner.club.id, 'Bob AskRemove1');

      // Owner posts an ask, Bob posts a matching service
      const askId = await seedEntityWithEmbedding(h, owner.club.id, owner.id, 'ask', makeVector([1, 0, 0]));
      const serviceId = await seedEntityWithEmbedding(h, owner.club.id, bob.id, 'service', makeVector([0.95, 0.05, 0]));

      const pools = workerPools();
      await processEntityTriggers(pools); // seed cursor

      const initial = getNotifications(await h.apiOk(owner.token, 'notifications.list', { limit: 50 }));
      const cursor = initial.nextAfter;

      await publishActivity(owner.club.id, serviceId, bob.id);
      await processEntityTriggers(pools);
      await deliverMatches(pools);

      // Verify signal was delivered
      const signalsBefore = await getSignals(owner.id);
      assert.ok(
        signalsBefore.some(s => s.topic === 'synchronicity.offer_to_ask'),
        'offer_to_ask notification should be delivered',
      );

      // Now remove the matched ASK (not the offer)
      await h.sqlClubs(
        `update entity_versions set state = 'removed' where entity_id = $1`,
        [askId],
      );

      const poll = getNotifications(await h.apiOk(owner.token, 'notifications.list', { after: cursor, limit: 50 }));
      const offerSignals = poll.items.filter((u) => u.kind === 'synchronicity.offer_to_ask');
      assert.equal(offerSignals.length, 0,
        'offer_to_ask notification must not appear when matched ask is removed');
    });
  });
});
