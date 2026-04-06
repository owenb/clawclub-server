/**
 * Serendipity worker: the first feature worker on the signal/match stack.
 *
 * Detects triggers (entity publications, profile changes, new memberships),
 * computes matches using cross-plane similarity queries, and delivers
 * matches as member signals through the standard update feed.
 *
 * Uses:
 *   - runner.ts for lifecycle
 *   - similarity.ts for cross-plane vector queries
 *   - matches.ts for match lifecycle (create, deliver, expire, throttle)
 *   - member_signals for delivery
 *   - recompute_queue for debounced introduction recomputation
 *   - worker_state for cursor persistence
 *
 * Usage:
 *   node --experimental-strip-types src/workers/serendipity.ts          # loop mode
 *   node --experimental-strip-types src/workers/serendipity.ts --once   # one-shot
 */
import type { Pool, PoolClient } from 'pg';
import { createPools, runWorkerLoop, runWorkerOnce, type WorkerPools } from './runner.ts';
import {
  findMembersMatchingEntity,
  findSimilarMembers,
  findAskMatchingOffer,
  findExistingThreadPairs,
  canonicalPair,
} from './similarity.ts';
import {
  createMatch,
  expireStaleMatches,
  countRecentDeliveries,
  type PendingMatch,
} from './matches.ts';

// ── Configuration ─────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.SERENDIPITY_POLL_INTERVAL_MS ?? '30000', 10);
const SIMILARITY_THRESHOLD = parseFloat(process.env.SERENDIPITY_SIMILARITY_THRESHOLD ?? '0.8');
const MAX_SIGNALS_PER_DAY = parseInt(process.env.SERENDIPITY_MAX_SIGNALS_PER_DAY ?? '3', 10);
const MAX_INTROS_PER_WEEK = parseInt(process.env.SERENDIPITY_MAX_INTROS_PER_WEEK ?? '2', 10);
const INTRO_WARMUP_HOURS = parseInt(process.env.SERENDIPITY_INTRO_WARMUP_HOURS ?? '24', 10);
const MATCH_CANDIDATES_LIMIT = 10;
const DELIVERY_BATCH_SIZE = 20;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// ── Worker state helpers ──────────────────────────────────

async function getState(pool: Pool, key: string): Promise<string | null> {
  const result = await pool.query<{ state_value: string }>(
    `select state_value from app.worker_state
     where worker_id = 'serendipity' and state_key = $1`,
    [key],
  );
  return result.rows[0]?.state_value ?? null;
}

async function setState(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `insert into app.worker_state (worker_id, state_key, state_value, updated_at)
     values ('serendipity', $1, $2, now())
     on conflict (worker_id, state_key) do update
       set state_value = excluded.state_value, updated_at = now()`,
    [key, value],
  );
}

// ── Recompute queue helpers ───────────────────────────────

/**
 * Enqueue a member for introduction recomputation.
 * Deduplicates naturally: one pending entry per (queue_name, member_id, club_id).
 */
export async function enqueueIntroRecompute(
  pool: Pool,
  memberId: string,
  clubId: string,
  delayMs: number = 0,
): Promise<void> {
  const recomputeAfter = delayMs > 0
    ? new Date(Date.now() + delayMs).toISOString()
    : new Date().toISOString();
  await pool.query(
    `insert into app.recompute_queue (queue_name, member_id, club_id, recompute_after)
     values ('introductions', $1, $2, $3::timestamptz)
     on conflict (queue_name, member_id, club_id) do nothing`,
    [memberId, clubId, recomputeAfter],
  );
}

/** Lease duration for recompute queue entries. Stale leases are reclaimable after this. */
const RECOMPUTE_LEASE_MS = 300_000; // 5 minutes

/**
 * Claim ready recompute entries via lease (UPDATE claimed_at).
 * Entries with stale leases (claimed_at older than RECOMPUTE_LEASE_MS) are reclaimable.
 */
async function claimRecomputeEntries(pool: Pool, limit: number): Promise<Array<{ id: string; memberId: string; clubId: string }>> {
  const staleThreshold = new Date(Date.now() - RECOMPUTE_LEASE_MS).toISOString();
  const result = await pool.query<{ id: string; member_id: string; club_id: string }>(
    `update app.recompute_queue
     set claimed_at = now()
     where id in (
       select id from app.recompute_queue
       where queue_name = 'introductions'
         and recompute_after <= now()
         and (claimed_at is null or claimed_at < $2::timestamptz)
       order by recompute_after asc
       limit $1
       for update skip locked
     )
     returning id, member_id, club_id`,
    [limit, staleThreshold],
  );
  return result.rows.map(r => ({ id: r.id, memberId: r.member_id, clubId: r.club_id }));
}

/**
 * Complete a recompute entry by deleting it. Called after successful processing.
 */
async function completeRecomputeEntry(pool: Pool, entryId: string): Promise<void> {
  await pool.query(`delete from app.recompute_queue where id = $1`, [entryId]);
}

// ── Entity-triggered matching ─────────────────────────────

/**
 * Process new entity publications from club_activity.
 * - ask -> find members who can help (ask_to_member)
 * - service/opportunity -> find asks it fulfils (offer_to_ask)
 */
async function processEntityTriggers(pools: WorkerPools): Promise<number> {
  const lastSeq = await getState(pools.clubs, 'activity_seq');
  const afterSeq = lastSeq ? parseInt(lastSeq, 10) : null;

  // Seed on first run
  if (afterSeq === null) {
    const seedResult = await pools.clubs.query<{ max_seq: string }>(
      `select coalesce(max(seq), 0)::text as max_seq from app.club_activity`,
    );
    await setState(pools.clubs, 'activity_seq', seedResult.rows[0]?.max_seq ?? '0');
    return 0;
  }

  const result = await pools.clubs.query<{
    seq: string; club_id: string; entity_id: string | null;
    created_by_member_id: string | null;
  }>(
    `select seq::text as seq, club_id, entity_id, created_by_member_id
     from app.club_activity
     where seq > $1 and topic = 'entity.version.published'
     order by seq asc limit 50`,
    [afterSeq],
  );

  if (result.rows.length === 0) return 0;

  let matchCount = 0;

  for (const row of result.rows) {
    if (!row.entity_id) continue;

    // Look up entity kind
    const entityResult = await pools.clubs.query<{ kind: string }>(
      `select kind::text as kind from app.entities where id = $1`,
      [row.entity_id],
    );
    const kind = entityResult.rows[0]?.kind;
    if (!kind) continue;

    const authorId = row.created_by_member_id;
    if (!authorId) continue;

    if (kind === 'ask') {
      const candidates = await findMembersMatchingEntity(
        pools.clubs, pools.identity, row.entity_id, row.club_id, authorId, MATCH_CANDIDATES_LIMIT,
      );
      for (const c of candidates) {
        if (c.distance > SIMILARITY_THRESHOLD) continue;
        const id = await createMatch(pools.clubs, {
          clubId: row.club_id,
          matchKind: 'ask_to_member',
          sourceId: row.entity_id,
          targetMemberId: c.memberId,
          score: c.distance,
        });
        if (id) matchCount++;
      }
    } else if (kind === 'service' || kind === 'opportunity') {
      const candidates = await findAskMatchingOffer(
        pools.clubs, row.entity_id, row.club_id, MATCH_CANDIDATES_LIMIT,
      );
      for (const c of candidates) {
        if (c.distance > SIMILARITY_THRESHOLD) continue;
        const id = await createMatch(pools.clubs, {
          clubId: row.club_id,
          matchKind: 'offer_to_ask',
          sourceId: row.entity_id,
          targetMemberId: c.authorMemberId,
          score: c.distance,
          payload: { matchedAskEntityId: c.entityId },
        });
        if (id) matchCount++;
      }
    }
    // posts and events: skip (not matchable in this phase)
  }

  // Advance high-water mark
  const lastRow = result.rows[result.rows.length - 1];
  await setState(pools.clubs, 'activity_seq', lastRow.seq);

  return matchCount;
}

// ── Introduction triggers ─────────────────────────────────

/**
 * Detect profile embedding updates and enqueue intro recomputation.
 * Checks for newly completed/updated profile embeddings since our last scan.
 */
async function processProfileTriggers(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.clubs, 'profile_artifact_at');
  const lastMemberId = await getState(pools.clubs, 'profile_artifact_member_id');

  // Seed on first run
  if (!lastAt) {
    const seedResult = await pools.identity.query<{ max_at: string }>(
      `select coalesce(max(updated_at), '1970-01-01T00:00:00Z')::text as max_at
       from app.embeddings_member_profile_artifacts`,
    );
    await setState(pools.clubs, 'profile_artifact_at', seedResult.rows[0]?.max_at ?? '1970-01-01T00:00:00Z');
    await setState(pools.clubs, 'profile_artifact_member_id', '');
    return 0;
  }

  // Compound cursor: (updated_at, member_id) > ($1, $2)
  const result = await pools.identity.query<{ member_id: string; updated_at: string }>(
    `select member_id, updated_at::text as updated_at
     from app.embeddings_member_profile_artifacts
     where (updated_at, member_id) > ($1::timestamptz, $2)
     order by updated_at asc, member_id asc
     limit 50`,
    [lastAt, lastMemberId || ''],
  );

  if (result.rows.length === 0) return 0;

  let enqueueCount = 0;

  for (const row of result.rows) {
    // Find all clubs this member is accessible in
    const clubsResult = await pools.identity.query<{ club_id: string }>(
      `select club_id from app.accessible_club_memberships where member_id = $1`,
      [row.member_id],
    );

    for (const club of clubsResult.rows) {
      await enqueueIntroRecompute(pools.clubs, row.member_id, club.club_id);
      enqueueCount++;
    }
  }

  // Advance compound cursor
  const lastRow = result.rows[result.rows.length - 1];
  await setState(pools.clubs, 'profile_artifact_at', lastRow.updated_at);
  await setState(pools.clubs, 'profile_artifact_member_id', lastRow.member_id);

  return enqueueCount;
}

/**
 * Detect newly accessible members and enqueue intro recomputation with warm-up delay.
 *
 * Two sources of accessibility changes:
 *   1. Membership state transitions to 'active' (new members, reactivated members)
 *   2. Subscription changes (trial starts, reactivations, renewals) that make
 *      existing active memberships accessible via accessible_club_memberships
 *
 * Both are checked against accessible_club_memberships as the final arbiter.
 */
async function processMemberAccessibilityTriggers(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.clubs, 'membership_scan_at');

  // Seed on first run
  if (!lastAt) {
    await setState(pools.clubs, 'membership_scan_at', new Date().toISOString());
    return 0;
  }

  // Source 1: Membership state transitions to 'active'
  const membershipResult = await pools.identity.query<{ member_id: string; club_id: string }>(
    `select cm.member_id, cm.club_id
     from app.club_membership_state_versions sv
     join app.club_memberships cm on cm.id = sv.membership_id
     where sv.status = 'active'
       and sv.created_at > $1::timestamptz
       and exists (
         select 1 from app.accessible_club_memberships acm
         where acm.member_id = cm.member_id and acm.club_id = cm.club_id
       )
     group by cm.member_id, cm.club_id`,
    [lastAt],
  );

  // Source 2: Subscriptions that started or were reactivated recently
  const subscriptionResult = await pools.identity.query<{ member_id: string; club_id: string }>(
    `select cm.member_id, cm.club_id
     from app.subscriptions s
     join app.club_memberships cm on cm.id = s.membership_id
     where s.status in ('active', 'trialing')
       and s.started_at > $1::timestamptz
       and exists (
         select 1 from app.accessible_club_memberships acm
         where acm.member_id = cm.member_id and acm.club_id = cm.club_id
       )
     group by cm.member_id, cm.club_id`,
    [lastAt],
  );

  // Deduplicate across both sources
  const seen = new Set<string>();
  let enqueueCount = 0;
  const warmupDelayMs = INTRO_WARMUP_HOURS * 3600_000;

  for (const row of [...membershipResult.rows, ...subscriptionResult.rows]) {
    const key = `${row.member_id}:${row.club_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await enqueueIntroRecompute(pools.clubs, row.member_id, row.club_id, warmupDelayMs);
    enqueueCount++;
  }

  await setState(pools.clubs, 'membership_scan_at', new Date().toISOString());
  return enqueueCount;
}

// ── Introduction recompute ────────────────────────────────

/**
 * Process pending introduction recompute entries.
 * For each dirty (member_id, club_id) pair:
 *   1. Find similar members
 *   2. Filter out existing DM threads
 *   3. Filter out existing intro matches (pending or delivered)
 *   4. Create new intro matches with stable identity
 */
async function processIntroRecompute(pools: WorkerPools): Promise<number> {
  if (!pools.messaging) return 0;

  const entries = await claimRecomputeEntries(pools.clubs, 20);
  if (entries.length === 0) return 0;

  let matchCount = 0;

  for (const entry of entries) {
    // Check member is still accessible in this club
    const accessResult = await pools.identity.query<{ exists: boolean }>(
      `select exists(
         select 1 from app.accessible_club_memberships
         where member_id = $1 and club_id = $2
       ) as exists`,
      [entry.memberId, entry.clubId],
    );
    if (!accessResult.rows[0]?.exists) {
      await completeRecomputeEntry(pools.clubs, entry.id);
      continue;
    }

    const candidates = await findSimilarMembers(
      pools.identity, entry.memberId, entry.clubId, MATCH_CANDIDATES_LIMIT,
    );

    if (candidates.length === 0) continue;

    // Batch-check DM threads
    const aIds: string[] = [];
    const bIds: string[] = [];
    for (const c of candidates) {
      const [a, b] = canonicalPair(entry.memberId, c.memberId);
      aIds.push(a);
      bIds.push(b);
    }
    const existingThreads = await findExistingThreadPairs(pools.messaging, aIds, bIds);

    for (const c of candidates) {
      if (c.distance > SIMILARITY_THRESHOLD) continue;

      // Check DM thread exists
      const [a, b] = canonicalPair(entry.memberId, c.memberId);
      if (existingThreads.has(`${a}:${b}`)) continue;

      // Stable intro identity: source_id = other_member, target = this member
      const id = await createMatch(pools.clubs, {
        clubId: entry.clubId,
        matchKind: 'member_to_member',
        sourceId: c.memberId,
        targetMemberId: entry.memberId,
        score: c.distance,
      });
      if (id) matchCount++;
    }

    // Lease fulfilled — delete the entry
    await completeRecomputeEntry(pools.clubs, entry.id);
  }

  return matchCount;
}

// ── Delivery ──────────────────────────────────────────────

/**
 * Deliver pending matches as member signals.
 * - Best-first ordering (lowest distance first)
 * - Per-kind throttling (stricter for introductions)
 * - Validity checks before delivery
 *
 * Each delivery is atomic: lock match row, insert signal, transition match
 * all within a single transaction. The unique index on member_signals.match_id
 * prevents duplicate signals on crash-retry.
 */
async function deliverMatches(pools: WorkerPools): Promise<number> {
  // Expire stale matches first
  await expireStaleMatches(pools.clubs);

  // Read candidate match IDs (no lock — just a planning query)
  const candidateResult = await pools.clubs.query<{ id: string; match_kind: string; target_member_id: string }>(
    `select id, match_kind, target_member_id
     from app.background_matches
     where state = 'pending'
       and (expires_at is null or expires_at > now())
     order by score asc, created_at asc
     limit $1`,
    [DELIVERY_BATCH_SIZE],
  );
  if (candidateResult.rows.length === 0) return 0;

  let delivered = 0;

  for (const candidate of candidateResult.rows) {
    // ── Throttle check (outside transaction — read-only, ok to race) ──
    if (candidate.match_kind === 'member_to_member') {
      const introCount = await countRecentDeliveries(
        pools.clubs, candidate.target_member_id, WEEK_MS, 'member_to_member',
      );
      if (introCount >= MAX_INTROS_PER_WEEK) continue; // stays pending
    } else {
      const totalCount = await countRecentDeliveries(
        pools.clubs, candidate.target_member_id, DAY_MS,
      );
      if (totalCount >= MAX_SIGNALS_PER_DAY) continue; // stays pending
    }

    // ── Atomic delivery: lock + validate + signal + transition ──
    const result = await deliverOneMatch(pools, candidate.id);
    if (result === 'delivered') delivered++;
  }

  return delivered;
}

/**
 * Deliver a single match atomically within a transaction.
 * Returns 'delivered', 'expired', or 'skipped'.
 */
async function deliverOneMatch(
  pools: WorkerPools,
  matchId: string,
): Promise<'delivered' | 'expired' | 'skipped'> {
  const client = await pools.clubs.connect();
  try {
    await client.query('BEGIN');

    // Lock the match row. If another worker got it, SKIP LOCKED returns nothing.
    const lockResult = await client.query<{
      id: string; club_id: string; match_kind: string; source_id: string;
      target_member_id: string; score: number; payload: Record<string, unknown>;
    }>(
      `select id, club_id, match_kind, source_id, target_member_id, score, payload
       from app.background_matches
       where id = $1 and state = 'pending'
       for update skip locked`,
      [matchId],
    );

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'skipped';
    }

    const match = lockResult.rows[0];

    // ── Validity checks (read from other planes, outside the clubs transaction) ──

    if (match.match_kind === 'member_to_member' && pools.messaging) {
      const [a, b] = canonicalPair(match.source_id, match.target_member_id);
      const threads = await findExistingThreadPairs(pools.messaging, [a], [b]);
      if (threads.size > 0) {
        await client.query(
          `update app.background_matches set state = 'expired' where id = $1`,
          [match.id],
        );
        await client.query('COMMIT');
        return 'expired';
      }

      const accessResult = await pools.identity.query<{ count: string }>(
        `select count(*)::text as count from app.accessible_club_memberships
         where club_id = $1 and member_id = any($2::text[])`,
        [match.club_id, [match.source_id, match.target_member_id]],
      );
      if (parseInt(accessResult.rows[0]?.count ?? '0', 10) < 2) {
        await client.query(
          `update app.background_matches set state = 'expired' where id = $1`,
          [match.id],
        );
        await client.query('COMMIT');
        return 'expired';
      }
    }

    if (match.match_kind === 'ask_to_member') {
      // Verify the ask entity is still published
      const valid = await isEntityPublished(client, match.source_id);
      if (!valid) {
        await client.query(`update app.background_matches set state = 'expired' where id = $1`, [match.id]);
        await client.query('COMMIT');
        return 'expired';
      }
    }

    if (match.match_kind === 'offer_to_ask') {
      // Verify both the offer and the matched ask are still published
      const matchedAskId = (match.payload as Record<string, unknown>).matchedAskEntityId as string | undefined;
      const offerValid = await isEntityPublished(client, match.source_id);
      const askValid = matchedAskId ? await isEntityPublished(client, matchedAskId) : false;
      if (!offerValid || !askValid) {
        await client.query(`update app.background_matches set state = 'expired' where id = $1`, [match.id]);
        await client.query('COMMIT');
        return 'expired';
      }
    }

    // ── Build payload ──
    const matchForPayload: PendingMatch = {
      id: match.id,
      clubId: match.club_id,
      matchKind: match.match_kind,
      sourceId: match.source_id,
      targetMemberId: match.target_member_id,
      score: match.score,
      payload: match.payload,
    };
    const payload = await buildSignalPayload(pools, matchForPayload);

    // ── Insert signal + transition match atomically ──
    // ON CONFLICT DO NOTHING on match_id: idempotent on crash-retry.
    const signalResult = await client.query<{ id: string }>(
      `insert into app.member_signals (club_id, recipient_member_id, topic, payload, entity_id, match_id)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict ((match_id)) where match_id is not null do nothing
       returning id`,
      [
        match.club_id,
        match.target_member_id,
        topicForMatchKind(match.match_kind),
        JSON.stringify(payload),
        match.match_kind === 'ask_to_member' || match.match_kind === 'offer_to_ask' ? match.source_id : null,
        match.id,
      ],
    );

    // Get the signal ID (either just inserted or already exists from prior crash)
    let signalId = signalResult.rows[0]?.id;
    if (!signalId) {
      const existing = await client.query<{ id: string }>(
        `select id from app.member_signals where match_id = $1`,
        [match.id],
      );
      signalId = existing.rows[0]?.id;
    }

    if (signalId) {
      await client.query(
        `update app.background_matches
         set state = 'delivered', delivered_at = now(), signal_id = $2
         where id = $1 and state = 'pending'`,
        [match.id, signalId],
      );
    }

    await client.query('COMMIT');
    return 'delivered';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function topicForMatchKind(kind: string): string {
  switch (kind) {
    case 'ask_to_member': return 'signal.ask_match';
    case 'offer_to_ask': return 'signal.offer_match';
    case 'member_to_member': return 'signal.introduction';
    case 'event_to_member': return 'signal.event_suggestion';
    default: return `signal.${kind}`;
  }
}

async function buildSignalPayload(
  pools: WorkerPools,
  match: { matchKind: string; sourceId: string; targetMemberId: string; clubId: string; score: number; payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  if (match.matchKind === 'ask_to_member') {
    const entity = await loadEntityInfo(pools.clubs, match.sourceId);
    const author = entity ? await loadMemberInfo(pools.identity, entity.authorMemberId) : null;
    return {
      kind: 'ask_match',
      askEntityId: match.sourceId,
      askTitle: entity?.title ?? null,
      askSummary: entity?.summary ?? null,
      askAuthor: author ? { memberId: author.memberId, publicName: author.publicName, handle: author.handle } : null,
      matchScore: match.score,
    };
  }

  if (match.matchKind === 'offer_to_ask') {
    const offerEntity = await loadEntityInfo(pools.clubs, match.sourceId);
    const offerAuthor = offerEntity ? await loadMemberInfo(pools.identity, offerEntity.authorMemberId) : null;

    // The matched ask entity ID is stored in the match payload
    const matchedAskEntityId = match.payload.matchedAskEntityId as string | undefined;
    const askEntity = matchedAskEntityId ? await loadEntityInfo(pools.clubs, matchedAskEntityId) : null;

    return {
      kind: 'offer_match',
      offerEntityId: match.sourceId,
      offerKind: offerEntity?.kind ?? null,
      offerTitle: offerEntity?.title ?? null,
      offerAuthor: offerAuthor ? { memberId: offerAuthor.memberId, publicName: offerAuthor.publicName, handle: offerAuthor.handle } : null,
      yourAskEntityId: matchedAskEntityId ?? null,
      yourAskTitle: askEntity?.title ?? null,
      matchScore: match.score,
    };
  }

  if (match.matchKind === 'member_to_member') {
    const other = await loadMemberInfo(pools.identity, match.sourceId);
    return {
      kind: 'introduction',
      otherMember: other ? { memberId: other.memberId, publicName: other.publicName, handle: other.handle } : null,
      matchScore: match.score,
    };
  }

  return { kind: match.matchKind, sourceId: match.sourceId, matchScore: match.score };
}

async function isEntityPublished(queryable: Pool | PoolClient, entityId: string): Promise<boolean> {
  const result = await queryable.query<{ state: string }>(
    `select cev.state from app.current_entity_versions cev
     join app.entities e on e.id = cev.entity_id
     where e.id = $1`,
    [entityId],
  );
  return result.rows[0]?.state === 'published';
}

async function loadEntityInfo(pool: Pool, entityId: string): Promise<{
  title: string | null; summary: string | null; kind: string; authorMemberId: string;
} | null> {
  const result = await pool.query<{
    title: string | null; summary: string | null; kind: string; author_member_id: string;
  }>(
    `select cev.title, cev.summary, e.kind::text as kind, e.author_member_id
     from app.current_entity_versions cev
     join app.entities e on e.id = cev.entity_id
     where e.id = $1 and cev.state = 'published'`,
    [entityId],
  );
  return result.rows[0] ? {
    title: result.rows[0].title,
    summary: result.rows[0].summary,
    kind: result.rows[0].kind,
    authorMemberId: result.rows[0].author_member_id,
  } : null;
}

async function loadMemberInfo(pool: Pool, memberId: string): Promise<{
  memberId: string; publicName: string; handle: string | null;
} | null> {
  const result = await pool.query<{ public_name: string; handle: string | null }>(
    `select public_name, handle from app.members where id = $1`,
    [memberId],
  );
  return result.rows[0] ? {
    memberId,
    publicName: result.rows[0].public_name,
    handle: result.rows[0].handle,
  } : null;
}

// ── Periodic backstop sweep ───────────────────────────────

const BACKSTOP_INTERVAL_MS = parseInt(process.env.SERENDIPITY_BACKSTOP_INTERVAL_MS ?? String(7 * DAY_MS), 10);

/**
 * Periodic reconciliation sweep: enqueues intro recompute for all
 * accessible members across all clubs. Runs infrequently (default: weekly).
 * Serves as repair for missed reactive triggers and as bootstrap when
 * the feature is first enabled on an existing club.
 */
async function processBackstopSweep(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.clubs, 'backstop_sweep_at');
  const now = Date.now();

  if (lastAt && now - Date.parse(lastAt) < BACKSTOP_INTERVAL_MS) {
    return 0; // not due yet
  }

  // Get all distinct (member_id, club_id) pairs from accessible memberships
  const result = await pools.identity.query<{ member_id: string; club_id: string }>(
    `select distinct member_id, club_id from app.accessible_club_memberships`,
  );

  let enqueued = 0;
  for (const row of result.rows) {
    await enqueueIntroRecompute(pools.clubs, row.member_id, row.club_id);
    enqueued++;
  }

  await setState(pools.clubs, 'backstop_sweep_at', new Date().toISOString());
  if (enqueued > 0) console.log(`Backstop sweep: enqueued ${enqueued} intro recomputes`);
  return enqueued;
}

// ── Main process function ─────────────────────────────────

async function processSerendipity(pools: WorkerPools): Promise<number> {
  let total = 0;

  // 1. Entity-triggered matching (reactive)
  total += await processEntityTriggers(pools);

  // 2. Profile embedding triggers → enqueue intro recompute (reactive)
  total += await processProfileTriggers(pools);

  // 3. Membership accessibility triggers → enqueue intro recompute with warmup (reactive)
  total += await processMemberAccessibilityTriggers(pools);

  // 4. Periodic backstop sweep → enqueue intro recompute for reconciliation
  total += await processBackstopSweep(pools);

  // 5. Process intro recompute queue (debounced)
  total += await processIntroRecompute(pools);

  // 6. Deliver pending matches (all types)
  total += await deliverMatches(pools);

  return total;
}

// ── Entry point ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const pools = createPools({ identity: true, clubs: true, messaging: true });
  const healthPort = process.env.WORKER_HEALTH_PORT ? parseInt(process.env.WORKER_HEALTH_PORT, 10) : undefined;

  if (process.argv.includes('--once')) {
    await runWorkerOnce('serendipity', pools, processSerendipity);
  } else {
    await runWorkerLoop('serendipity', pools, processSerendipity, {
      pollIntervalMs: POLL_INTERVAL_MS,
      healthPort,
    });
  }
}

export { processSerendipity, processEntityTriggers, processProfileTriggers, processMemberAccessibilityTriggers, processIntroRecompute, processBackstopSweep, deliverMatches };
