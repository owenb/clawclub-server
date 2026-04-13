import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import {
  createMatch,
  claimPendingMatches,
  markDelivered,
  markExpired,
  expireStaleMatches,
  countRecentDeliveries,
  matchExists,
} from '../../../src/workers/matches.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('background_matches', () => {
  it('createMatch inserts a match and returns its ID', async () => {
    const owner = await h.seedOwner('matchclub1', 'MatchClub1');

    const matchId = await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_abc',
      targetMemberId: owner.id,
      score: 0.15,
      payload: { reason: 'test' },
    });

    assert.ok(matchId, 'should return a match ID');

    const rows = await h.sqlClubs<{ state: string; score: number }>(
      `select state, score from signal_background_matches where id = $1`,
      [matchId],
    );
    assert.equal(rows[0].state, 'pending');
    assert.equal(rows[0].score, 0.15);
  });

  it('createMatch skips duplicate (same kind + source + target)', async () => {
    const owner = await h.seedOwner('matchclub2', 'MatchClub2');

    const id1 = await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_dup',
      targetMemberId: owner.id,
      score: 0.1,
    });

    const id2 = await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_dup',
      targetMemberId: owner.id,
      score: 0.05,
    });

    assert.ok(id1, 'first insert should succeed');
    assert.equal(id2, null, 'duplicate should return null');
  });

  it('claimPendingMatches returns matches ordered by score', async () => {
    const owner = await h.seedOwner('matchclub3', 'MatchClub3');

    await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_worse',
      targetMemberId: owner.id,
      score: 0.5,
    });

    await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_better',
      targetMemberId: owner.id,
      score: 0.1,
    });

    const matches = await claimPendingMatches(h.pools.super, 10);
    const ours = matches.filter(m => m.targetMemberId === owner.id);

    assert.ok(ours.length >= 2);
    // Best score first
    const idx1 = ours.findIndex(m => m.sourceId === 'entity_better');
    const idx2 = ours.findIndex(m => m.sourceId === 'entity_worse');
    assert.ok(idx1 < idx2, 'better score should come first');
  });

  it('markDelivered transitions state and sets signal_id', async () => {
    const owner = await h.seedOwner('matchclub4', 'MatchClub4');

    const matchId = await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_deliver',
      targetMemberId: owner.id,
      score: 0.2,
    });

    // Create a materialized notification to link
    const signalRows = await h.sqlClubs<{ id: string }>(
      `insert into member_notifications (club_id, recipient_member_id, topic, payload)
       values ($1, $2, 'synchronicity.ask_to_member', '{}'::jsonb) returning id`,
      [owner.club.id, owner.id],
    );

    await markDelivered(h.pools.super, matchId!, signalRows[0].id);

    const rows = await h.sqlClubs<{ state: string; signal_id: string; delivered_at: string }>(
      `select state, signal_id, delivered_at::text as delivered_at
       from signal_background_matches where id = $1`,
      [matchId!],
    );
    assert.equal(rows[0].state, 'delivered');
    assert.equal(rows[0].signal_id, signalRows[0].id);
    assert.ok(rows[0].delivered_at, 'delivered_at should be set');
  });

  it('markExpired transitions state', async () => {
    const owner = await h.seedOwner('matchclub5', 'MatchClub5');

    const matchId = await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_expire',
      targetMemberId: owner.id,
      score: 0.3,
    });

    await markExpired(h.pools.super, matchId!);

    const rows = await h.sqlClubs<{ state: string }>(
      `select state from signal_background_matches where id = $1`,
      [matchId!],
    );
    assert.equal(rows[0].state, 'expired');
  });

  it('expireStaleMatches transitions past-due matches', async () => {
    const owner = await h.seedOwner('matchclub6', 'MatchClub6');

    // Insert a match with expires_at in the past
    await h.sqlClubs(
      `insert into signal_background_matches
         (club_id, match_kind, source_id, target_member_id, score, expires_at)
       values ($1, 'ask_to_member', 'entity_stale', $2, 0.1, now() - interval '1 hour')`,
      [owner.club.id, owner.id],
    );

    const expired = await expireStaleMatches(h.pools.super);
    assert.ok(expired >= 1, 'should expire at least one match');
  });

  it('countRecentDeliveries counts by kind', async () => {
    const owner = await h.seedOwner('matchclub7', 'MatchClub7');

    // Insert delivered matches of different kinds
    await h.sqlClubs(
      `insert into signal_background_matches
         (club_id, match_kind, source_id, target_member_id, score, state, delivered_at)
       values
         ($1, 'ask_to_member', 'e1', $2, 0.1, 'delivered', now()),
         ($1, 'ask_to_member', 'e2', $2, 0.1, 'delivered', now()),
         ($1, 'member_to_member', 'e3', $2, 0.1, 'delivered', now())`,
      [owner.club.id, owner.id],
    );

    const allCount = await countRecentDeliveries(
      h.pools.super, owner.id, 86400000,
    );
    assert.ok(allCount >= 3, 'should count all recent deliveries');

    const askCount = await countRecentDeliveries(
      h.pools.super, owner.id, 86400000, 'ask_to_member',
    );
    assert.ok(askCount >= 2, 'should count ask deliveries');

    const introCount = await countRecentDeliveries(
      h.pools.super, owner.id, 86400000, 'member_to_member',
    );
    assert.ok(introCount >= 1, 'should count intro deliveries');
  });

  it('matchExists detects existing matches', async () => {
    const owner = await h.seedOwner('matchclub8', 'MatchClub8');

    const exists1 = await matchExists(
      h.pools.super, 'ask_to_member', 'entity_exists_test', owner.id,
    );
    assert.equal(exists1, false, 'should not exist before creation');

    await createMatch(h.pools.super, {
      clubId: owner.club.id,
      matchKind: 'ask_to_member',
      sourceId: 'entity_exists_test',
      targetMemberId: owner.id,
      score: 0.1,
    });

    const exists2 = await matchExists(
      h.pools.super, 'ask_to_member', 'entity_exists_test', owner.id,
    );
    assert.equal(exists2, true, 'should exist after creation');
  });
});
