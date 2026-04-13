/**
 * Synchronicity worker: the first feature worker on the signal/match stack.
 *
 * Detects triggers (entity publications, profile changes, new memberships),
 * computes matches using embedding similarity queries, and delivers
 * matches as member signals through the standard update feed.
 *
 * Uses:
 *   - runner.ts for lifecycle
 *   - similarity.ts for vector queries
 *   - matches.ts for match lifecycle (create, deliver, expire, throttle)
 *   - signals for delivery
 *   - recompute_queue for debounced introduction recomputation
 *   - worker_state for cursor persistence
 *
 * Usage:
 *   node --experimental-strip-types src/workers/synchronicity.ts          # loop mode
 *   node --experimental-strip-types src/workers/synchronicity.ts --once   # one-shot
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
  type PendingMatch,
} from './matches.ts';

// ── Configuration ─────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.SYNCHRONICITY_POLL_INTERVAL_MS ?? '30000', 10);
const SIMILARITY_THRESHOLD = parseFloat(process.env.SYNCHRONICITY_SIMILARITY_THRESHOLD ?? '0.8');
const MAX_SIGNALS_PER_DAY = parseInt(process.env.SYNCHRONICITY_MAX_SIGNALS_PER_DAY ?? '3', 10);
const MAX_INTROS_PER_WEEK = parseInt(process.env.SYNCHRONICITY_MAX_INTROS_PER_WEEK ?? '2', 10);
const INTRO_WARMUP_HOURS = parseInt(process.env.SYNCHRONICITY_INTRO_WARMUP_HOURS ?? '24', 10);
const MATCH_CANDIDATES_LIMIT = 10;
const DELIVERY_BATCH_SIZE = 20;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// ── Per-kind match TTLs ──
// No pending match should live forever. Short TTLs for entity matches
// (asks and offers lose relevance quickly), longer for introductions
// (people don't change as fast as content).
const MATCH_TTL_MS: Record<string, number> = {
  ask_to_member: 5 * DAY_MS,
  offer_to_ask: 5 * DAY_MS,
  member_to_member: 21 * DAY_MS,
  event_to_member: 2 * DAY_MS,
};
const DEFAULT_MATCH_TTL_MS = 7 * DAY_MS;

// Freshness guard: even within TTL, matches older than this are suspect
// after an outage. Prevents a drip of stale recommendations on recovery.
const MAX_MATCH_AGE_MS = 3 * DAY_MS;

function matchExpiresAt(matchKind: string): string {
  const ttl = MATCH_TTL_MS[matchKind] ?? DEFAULT_MATCH_TTL_MS;
  return new Date(Date.now() + ttl).toISOString();
}

// ── Worker state helpers ──────────────────────────────────

async function getState(pool: Pool, key: string): Promise<string | null> {
  const result = await pool.query<{ state_value: string }>(
    `select state_value from worker_state
     where worker_id = 'synchronicity' and state_key = $1`,
    [key],
  );
  return result.rows[0]?.state_value ?? null;
}

async function setState(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `insert into worker_state (worker_id, state_key, state_value, updated_at)
     values ('synchronicity', $1, $2, now())
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
    `insert into signal_recompute_queue (queue_name, member_id, club_id, recompute_after)
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
    `update signal_recompute_queue
     set claimed_at = now()
     where id in (
       select id from signal_recompute_queue
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
  await pool.query(`delete from signal_recompute_queue where id = $1`, [entryId]);
}

/**
 * Expire all pending entity-sourced matches for a given source entity.
 * Called when an entity emits a new entity.version.published (edit/update),
 * so stale matches based on the old version don't get delivered.
 */
async function expirePendingMatchesForSource(pool: Pool, sourceEntityId: string): Promise<void> {
  await pool.query(
    `update signal_background_matches
     set state = 'expired'
     where source_id = $1 and state = 'pending'
       and match_kind in ('ask_to_member', 'offer_to_ask')`,
    [sourceEntityId],
  );
}

/**
 * Expire pending offer_to_ask matches that reference a specific ask entity.
 * Called when an ask is re-published (edited), so offer matches scored
 * against the old ask version don't deliver with stale semantics.
 */
async function expirePendingMatchesReferencingAsk(pool: Pool, askEntityId: string): Promise<void> {
  await pool.query(
    `update signal_background_matches
     set state = 'expired'
     where state = 'pending'
       and match_kind = 'offer_to_ask'
       and payload->>'matchedAskEntityId' = $1`,
    [askEntityId],
  );
}

/**
 * Expire pending matches that relied on a member's profile embedding.
 * Called when a profile re-embeds, since the similarity scores from the
 * old profile are no longer valid.
 */
async function expirePendingMatchesForProfileChange(pool: Pool, memberId: string): Promise<void> {
  await pool.query(
    `update signal_background_matches
     set state = 'expired'
     where state = 'pending'
       and (
         (match_kind = 'ask_to_member' and target_member_id = $1)
         or (match_kind = 'member_to_member' and (target_member_id = $1 or source_id = $1))
       )`,
    [memberId],
  );
}

// ── Entity-triggered matching ─────────────────────────────

/**
 * Process new entity publications from club_activity.
 * - ask -> find members who can help (ask_to_member)
 * - gift/service/opportunity -> find asks it fulfils (offer_to_ask)
 */
async function processEntityTriggers(pools: WorkerPools): Promise<number> {
  const lastSeq = await getState(pools.db, 'activity_seq');
  const afterSeq = lastSeq ? parseInt(lastSeq, 10) : null;

  // Seed on first run
  if (afterSeq === null) {
    const seedResult = await pools.db.query<{ max_seq: string }>(
      `select coalesce(max(seq), 0)::text as max_seq from club_activity`,
    );
    await setState(pools.db, 'activity_seq', seedResult.rows[0]?.max_seq ?? '0');
    return 0;
  }

  const result = await pools.db.query<{
    seq: string; club_id: string; entity_id: string | null;
    created_by_member_id: string | null;
  }>(
    `select seq::text as seq, club_id, entity_id, created_by_member_id
     from club_activity
     where seq > $1 and topic = 'entity.version.published'
     order by seq asc limit 50`,
    [afterSeq],
  );

  if (result.rows.length === 0) return 0;

  let matchCount = 0;

  for (const row of result.rows) {
    if (!row.entity_id) continue;

    // Look up entity kind and current version
    const entityResult = await pools.db.query<{
      kind: string; author_member_id: string; current_version_id: string; open_loop: boolean | null; is_thread_subject: boolean;
    }>(
      `select e.kind::text as kind,
              e.author_member_id,
              cev.id as current_version_id,
              e.open_loop,
              not exists (
                select 1
                from entities earlier
                where earlier.content_thread_id = e.content_thread_id
                  and earlier.archived_at is null
                  and earlier.deleted_at is null
                  and (
                    earlier.created_at < e.created_at
                    or (earlier.created_at = e.created_at and earlier.id < e.id)
                  )
              ) as is_thread_subject
       from entities e
       join current_entity_versions cev on cev.entity_id = e.id
       where e.id = $1 and e.deleted_at is null and cev.state = 'published'`,
      [row.entity_id],
    );
    const entity = entityResult.rows[0];
    if (!entity) continue;
    if (!entity.is_thread_subject) continue;
    if (entity.open_loop === false) continue;
    const kind = entity.kind;

    const authorId = row.created_by_member_id;
    if (!authorId) continue;

    if (kind === 'ask') {
      // Expire pending matches from a previous version of this ask (ask_to_member),
      // and also expire pending offer_to_ask matches that reference this ask,
      // since the ask content has changed and the match may no longer be valid.
      await expirePendingMatchesForSource(pools.db, row.entity_id);
      await expirePendingMatchesReferencingAsk(pools.db, row.entity_id);

      const candidates = await findMembersMatchingEntity(
        pools.db, row.entity_id, row.club_id, authorId, MATCH_CANDIDATES_LIMIT,
      );
      for (const c of candidates) {
        if (c.distance > SIMILARITY_THRESHOLD) continue;
        const id = await createMatch(pools.db, {
          clubId: row.club_id,
          matchKind: 'ask_to_member',
          sourceId: row.entity_id,
          targetMemberId: c.memberId,
          score: c.distance,
          expiresAt: matchExpiresAt('ask_to_member'),
          payload: { sourceVersionId: entity.current_version_id },
        });
        if (id) matchCount++;
      }
    } else if (kind === 'service' || kind === 'opportunity' || kind === 'gift') {
      // Expire any pending matches from a previous version of this offer
      await expirePendingMatchesForSource(pools.db, row.entity_id);

      const candidates = await findAskMatchingOffer(
        pools.db, row.entity_id, row.club_id, MATCH_CANDIDATES_LIMIT,
        authorId, // exclude self-matches: ask author == offer author
      );
      for (const c of candidates) {
        if (c.distance > SIMILARITY_THRESHOLD) continue;
        const id = await createMatch(pools.db, {
          clubId: row.club_id,
          matchKind: 'offer_to_ask',
          sourceId: row.entity_id,
          targetMemberId: c.authorMemberId,
          score: c.distance,
          expiresAt: matchExpiresAt('offer_to_ask'),
          payload: {
            matchedAskEntityId: c.entityId,
            matchedAskVersionId: c.entityVersionId,
            sourceVersionId: entity.current_version_id,
          },
        });
        if (id) matchCount++;
      }
    }
    // posts and events: skip (not matchable in this phase)
  }

  // Advance high-water mark
  const lastRow = result.rows[result.rows.length - 1];
  await setState(pools.db, 'activity_seq', lastRow.seq);

  return matchCount;
}

// ── Introduction triggers ─────────────────────────────────

/**
 * Detect profile embedding updates and enqueue intro recomputation.
 * Checks for newly completed/updated profile embeddings since our last scan.
 */
async function processProfileTriggers(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.db, 'profile_artifact_at');
  const lastMemberId = await getState(pools.db, 'profile_artifact_member_id');

  // Seed on first run
  if (!lastAt) {
    const seedResult = await pools.db.query<{ max_at: string }>(
      `select coalesce(max(updated_at), '1970-01-01T00:00:00Z')::text as max_at
       from member_profile_embeddings`,
    );
    await setState(pools.db, 'profile_artifact_at', seedResult.rows[0]?.max_at ?? '1970-01-01T00:00:00Z');
    await setState(pools.db, 'profile_artifact_member_id', '');
    return 0;
  }

  // Compound cursor: (updated_at, member_id) > ($1, $2)
  // Collapse club-scoped embeddings down to one trigger row per member so a
  // single profile edit does not create duplicate intro recompute work.
  // Join through profile_version_id to get the underlying profile change timestamp.
  // Skip delayed embedding completions where the profile change is too old —
  // prevents intro catch-up waves after embedding pipeline recovery.
  const result = await pools.db.query<{
    member_id: string; updated_at: string; profile_changed_at: string;
  }>(
    `with member_profile_changes as (
       select
         empa.member_id,
         max(empa.updated_at) as updated_at,
         max(mcp.created_at) as profile_changed_at
       from member_profile_embeddings empa
       join member_club_profile_versions mcp on mcp.id = empa.profile_version_id
       group by empa.member_id
     )
     select
       member_id,
       updated_at::text as updated_at,
       profile_changed_at::text as profile_changed_at
     from member_profile_changes
     where (updated_at, member_id) > ($1::timestamptz, $2)
     order by updated_at asc, member_id asc
     limit 50`,
    [lastAt, lastMemberId || ''],
  );

  if (result.rows.length === 0) return 0;

  let enqueueCount = 0;

  for (const row of result.rows) {
    // Staleness gate: if the underlying profile change is too old, the embedding
    // was delayed (e.g., OpenAI outage + recovery). Drop it rather than creating
    // a wave of stale intros. Use the same MAX_MATCH_AGE_MS as the delivery
    // freshness guard — if the profile change is older than that, it's not magical.
    const profileAge = Date.now() - Date.parse(row.profile_changed_at);
    if (profileAge > MAX_MATCH_AGE_MS) continue; // skip late completions

    // Expire pending matches that relied on this member's old profile:
    // - ask_to_member where this member was the target (profile similarity changed)
    // - member_to_member where this member is either side (profile similarity changed)
    // The matches will be recomputed from the new embedding.
    await expirePendingMatchesForProfileChange(pools.db, row.member_id);

    // Find all clubs this member is accessible in
    const clubsResult = await pools.db.query<{ club_id: string }>(
      `select club_id from accessible_club_memberships where member_id = $1`,
      [row.member_id],
    );

    for (const club of clubsResult.rows) {
      await enqueueIntroRecompute(pools.db, row.member_id, club.club_id);
      enqueueCount++;
    }
  }

  // Advance compound cursor
  const lastRow = result.rows[result.rows.length - 1];
  await setState(pools.db, 'profile_artifact_at', lastRow.updated_at);
  await setState(pools.db, 'profile_artifact_member_id', lastRow.member_id);

  return enqueueCount;
}

/**
 * Detect newly accessible members and enqueue intro recomputation with warm-up delay.
 *
 * Two sources of accessibility changes:
 *   1. Membership state transitions to 'active' (new members, reactivated members)
 *   2. Subscription changes (trial starts, reactivations, renewals) that make
 *      existing active memberships accessible via accessible_memberships
 *
 * Both are checked against accessible_memberships as the final arbiter.
 */
async function processMemberAccessibilityTriggers(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.db, 'membership_scan_at');

  // Seed on first run
  if (!lastAt) {
    await setState(pools.db, 'membership_scan_at', new Date().toISOString());
    return 0;
  }

  // Source 1: Membership state transitions to 'active'
  const membershipResult = await pools.db.query<{ member_id: string; club_id: string }>(
    `select cm.member_id, cm.club_id
     from club_membership_state_versions sv
     join club_memberships cm on cm.id = sv.membership_id
     where sv.status = 'active'
       and sv.created_at > $1::timestamptz
       and exists (
         select 1 from accessible_club_memberships acm
         where acm.member_id = cm.member_id and acm.club_id = cm.club_id
       )
     group by cm.member_id, cm.club_id`,
    [lastAt],
  );

  // Source 2: Subscriptions that started or were reactivated recently
  const subscriptionResult = await pools.db.query<{ member_id: string; club_id: string }>(
    `select cm.member_id, cm.club_id
     from club_subscriptions s
     join club_memberships cm on cm.id = s.membership_id
     where s.status in ('active', 'trialing')
       and s.started_at > $1::timestamptz
       and exists (
         select 1 from accessible_club_memberships acm
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
    await enqueueIntroRecompute(pools.db, row.member_id, row.club_id, warmupDelayMs);
    enqueueCount++;
  }

  await setState(pools.db, 'membership_scan_at', new Date().toISOString());
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
  const entries = await claimRecomputeEntries(pools.db, 20);
  if (entries.length === 0) return 0;

  let matchCount = 0;

  for (const entry of entries) {
    // Check member is still accessible in this club
    const accessResult = await pools.db.query<{ exists: boolean }>(
      `select exists(
         select 1 from accessible_club_memberships
         where member_id = $1 and club_id = $2
       ) as exists`,
      [entry.memberId, entry.clubId],
    );
    if (!accessResult.rows[0]?.exists) {
      await completeRecomputeEntry(pools.db, entry.id);
      continue;
    }

    const candidates = await findSimilarMembers(
      pools.db, entry.memberId, entry.clubId, MATCH_CANDIDATES_LIMIT,
    );

    if (candidates.length === 0) {
      await completeRecomputeEntry(pools.db, entry.id);
      continue;
    }

    // Batch-check DM threads
    const aIds: string[] = [];
    const bIds: string[] = [];
    for (const c of candidates) {
      const [a, b] = canonicalPair(entry.memberId, c.memberId);
      aIds.push(a);
      bIds.push(b);
    }
    const existingThreads = await findExistingThreadPairs(pools.db, aIds, bIds);

    for (const c of candidates) {
      if (c.distance > SIMILARITY_THRESHOLD) continue;

      // Check DM thread exists
      const [a, b] = canonicalPair(entry.memberId, c.memberId);
      if (existingThreads.has(`${a}:${b}`)) continue;

      // Stable intro identity: source_id = other_member, target = this member
      const id = await createMatch(pools.db, {
        clubId: entry.clubId,
        matchKind: 'member_to_member',
        sourceId: c.memberId,
        targetMemberId: entry.memberId,
        score: c.distance,
        expiresAt: matchExpiresAt('member_to_member'),
      });
      if (id) matchCount++;
    }

    // Lease fulfilled — delete the entry
    await completeRecomputeEntry(pools.db, entry.id);
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
  await expireStaleMatches(pools.db);

  // Read candidate match IDs (no lock — just a planning query)
  const candidateResult = await pools.db.query<{ id: string; match_kind: string; target_member_id: string }>(
    `select id, match_kind, target_member_id
     from signal_background_matches
     where state = 'pending'
       and (expires_at is null or expires_at > now())
     order by score asc, created_at asc
     limit $1`,
    [DELIVERY_BATCH_SIZE],
  );
  if (candidateResult.rows.length === 0) return 0;

  let delivered = 0;

  for (const candidate of candidateResult.rows) {
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
  const client = await pools.db.connect();
  try {
    await client.query('BEGIN');

    // Lock the match row. If another worker got it, SKIP LOCKED returns nothing.
    const lockResult = await client.query<{
      id: string; club_id: string; match_kind: string; source_id: string;
      target_member_id: string; score: number; payload: Record<string, unknown>;
      created_at: string;
    }>(
      `select id, club_id, match_kind, source_id, target_member_id, score, payload,
              created_at::text as created_at
       from signal_background_matches
       where id = $1 and state = 'pending'
       for update skip locked`,
      [matchId],
    );

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'skipped';
    }

    const match = lockResult.rows[0];

    // ── Per-recipient advisory lock ──
    // Serializes all delivery decisions for the same target member across
    // concurrent workers. Without this, two workers could each lock different
    // match rows for the same member, both read the same delivered count, and
    // both deliver — overshooting the cap. pg_advisory_xact_lock is released
    // automatically on COMMIT/ROLLBACK.
    // We hash target_member_id to a bigint for the advisory lock key.
    await client.query(
      `select pg_advisory_xact_lock(hashtext($1))`,
      [match.target_member_id],
    );

    // ── Throttle check (serialized by advisory lock) ──
    if (match.match_kind === 'member_to_member') {
      const introResult = await client.query<{ count: string }>(
        `select count(*)::text as count from signal_background_matches
         where target_member_id = $1 and match_kind = 'member_to_member'
           and state = 'delivered' and delivered_at > $2`,
        [match.target_member_id, new Date(Date.now() - WEEK_MS).toISOString()],
      );
      if (parseInt(introResult.rows[0]?.count ?? '0', 10) >= MAX_INTROS_PER_WEEK) {
        await client.query('ROLLBACK');
        return 'skipped';
      }
    } else {
      const totalResult = await client.query<{ count: string }>(
        `select count(*)::text as count from signal_background_matches
         where target_member_id = $1
           and state = 'delivered' and delivered_at > $2`,
        [match.target_member_id, new Date(Date.now() - DAY_MS).toISOString()],
      );
      if (parseInt(totalResult.rows[0]?.count ?? '0', 10) >= MAX_SIGNALS_PER_DAY) {
        await client.query('ROLLBACK');
        return 'skipped';
      }
    }

    // ── Freshness guard ──
    // Matches older than MAX_MATCH_AGE_MS are expired regardless of TTL.
    // Prevents stale recommendation drip after outage recovery.
    const matchAge = Date.now() - Date.parse(match.created_at);
    if (matchAge > MAX_MATCH_AGE_MS) {
      await expireAndCommit(client, match.id);
      return 'expired';
    }

    // ── Validity checks ──

    if (match.match_kind === 'member_to_member') {
      const [a, b] = canonicalPair(match.source_id, match.target_member_id);
      const threads = await findExistingThreadPairs(pools.db, [a], [b]);
      if (threads.size > 0) {
        await expireAndCommit(client, match.id);
        return 'expired';
      }

      const accessResult = await pools.db.query<{ count: string }>(
        `select count(*)::text as count from accessible_club_memberships
         where club_id = $1 and member_id = any($2::text[])`,
        [match.club_id, [match.source_id, match.target_member_id]],
      );
      if (parseInt(accessResult.rows[0]?.count ?? '0', 10) < 2) {
        await expireAndCommit(client, match.id);
        return 'expired';
      }
    }

    // For entity matches: verify recipient is still accessible in this club
    if (match.match_kind === 'ask_to_member' || match.match_kind === 'offer_to_ask') {
      const recipientAccessible = await pools.db.query<{ exists: boolean }>(
        `select exists(
           select 1 from accessible_club_memberships
           where member_id = $1 and club_id = $2
         ) as exists`,
        [match.target_member_id, match.club_id],
      );
      if (!recipientAccessible.rows[0]?.exists) {
        await expireAndCommit(client, match.id);
        return 'expired';
      }
    }

    if (match.match_kind === 'ask_to_member') {
      const valid = await isEntityPublished(client, match.source_id);
      const stillOpen = await isEntityLoopOpen(client, match.source_id);
      if (!valid || !stillOpen) { await expireAndCommit(client, match.id); return 'expired'; }

      const drifted = await hasEntityVersionDrifted(client, match.source_id, match.payload as Record<string, unknown>);
      if (drifted) { await expireAndCommit(client, match.id); return 'expired'; }
    }

    if (match.match_kind === 'offer_to_ask') {
      const payload = match.payload as Record<string, unknown>;
      const matchedAskId = payload.matchedAskEntityId as string | undefined;
      const offerValid = await isEntityPublished(client, match.source_id);
      const askValid = matchedAskId ? await isEntityPublished(client, matchedAskId) : false;
      const offerOpen = await isEntityLoopOpen(client, match.source_id);
      const askOpen = matchedAskId ? await isEntityLoopOpen(client, matchedAskId) : false;
      if (!offerValid || !askValid || !offerOpen || !askOpen) { await expireAndCommit(client, match.id); return 'expired'; }

      // Version drift: check both the offer and the matched ask
      const offerDrifted = await hasEntityVersionDrifted(client, match.source_id, payload);
      if (offerDrifted) { await expireAndCommit(client, match.id); return 'expired'; }

      if (matchedAskId) {
        const askDrifted = await hasAskVersionDrifted(client, matchedAskId, payload);
        if (askDrifted) { await expireAndCommit(client, match.id); return 'expired'; }
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
      `insert into member_notifications (club_id, recipient_member_id, topic, payload, entity_id, match_id)
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
        `select id from member_notifications where match_id = $1`,
        [match.id],
      );
      signalId = existing.rows[0]?.id;
    }

    if (signalId) {
      await client.query(
        `update signal_background_matches
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
    case 'ask_to_member': return 'synchronicity.ask_to_member';
    case 'offer_to_ask': return 'synchronicity.offer_to_ask';
    case 'member_to_member': return 'synchronicity.member_to_member';
    case 'event_to_member': return 'synchronicity.event_to_member';
    default: return `synchronicity.${kind}`;
  }
}

async function expireAndCommit(client: PoolClient, matchId: string): Promise<void> {
  await client.query(`update signal_background_matches set state = 'expired' where id = $1`, [matchId]);
  await client.query('COMMIT');
}

/**
 * Check if the current published version of an entity differs from the
 * version that was used when the match was computed. If the payload has
 * no sourceVersionId, we cannot verify — treat as drifted (conservative).
 */
async function hasEntityVersionDrifted(
  queryable: Pool | PoolClient,
  entityId: string,
  matchPayload: Record<string, unknown>,
): Promise<boolean> {
  const recordedVersionId = matchPayload.sourceVersionId as string | undefined;
  if (!recordedVersionId) return true; // no version recorded — assume stale

  const result = await queryable.query<{ id: string }>(
    `select cev.id from current_entity_versions cev
     where cev.entity_id = $1 and cev.state = 'published'`,
    [entityId],
  );
  const currentVersionId = result.rows[0]?.id;
  return currentVersionId !== recordedVersionId;
}

/**
 * Check if the matched ask's current published version differs from the
 * version recorded in matchedAskVersionId. Conservative: no recorded
 * version is treated as drifted.
 */
async function hasAskVersionDrifted(
  queryable: Pool | PoolClient,
  askEntityId: string,
  matchPayload: Record<string, unknown>,
): Promise<boolean> {
  const recordedVersionId = matchPayload.matchedAskVersionId as string | undefined;
  if (!recordedVersionId) return true; // no version recorded — assume stale

  const result = await queryable.query<{ id: string }>(
    `select cev.id from current_entity_versions cev
     where cev.entity_id = $1 and cev.state = 'published'`,
    [askEntityId],
  );
  const currentVersionId = result.rows[0]?.id;
  return currentVersionId !== recordedVersionId;
}

async function buildSignalPayload(
  pools: WorkerPools,
  match: { matchKind: string; sourceId: string; targetMemberId: string; clubId: string; score: number; payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  // Signal payloads are ID-first: stable identifiers + score + author identity.
  // No denormalized entity titles or summaries — agents fetch current details
  // via entity IDs. This prevents removed/edited entity content from leaking
  // through stale signal payloads.

  if (match.matchKind === 'ask_to_member') {
    const entity = await loadEntityInfo(pools.db, match.sourceId);
    const author = entity ? await loadMemberInfo(pools.db, entity.authorMemberId) : null;
    return {
      kind: 'synchronicity.ask_to_member',
      askEntityId: match.sourceId,
      askAuthor: author ? { memberId: author.memberId, publicName: author.publicName, handle: author.handle } : null,
      matchScore: match.score,
    };
  }

  if (match.matchKind === 'offer_to_ask') {
    const offerEntity = await loadEntityInfo(pools.db, match.sourceId);
    const offerAuthor = offerEntity ? await loadMemberInfo(pools.db, offerEntity.authorMemberId) : null;
    const matchedAskEntityId = match.payload.matchedAskEntityId as string | undefined;

    return {
      kind: 'synchronicity.offer_to_ask',
      offerEntityId: match.sourceId,
      offerAuthor: offerAuthor ? { memberId: offerAuthor.memberId, publicName: offerAuthor.publicName, handle: offerAuthor.handle } : null,
      yourAskEntityId: matchedAskEntityId ?? null,
      matchScore: match.score,
    };
  }

  if (match.matchKind === 'member_to_member') {
    const other = await loadMemberInfo(pools.db, match.sourceId);
    return {
      kind: 'synchronicity.member_to_member',
      otherMember: other ? { memberId: other.memberId, publicName: other.publicName, handle: other.handle } : null,
      matchScore: match.score,
    };
  }

  return {
    kind: `synchronicity.${match.matchKind}`,
    sourceId: match.sourceId,
    matchScore: match.score,
  };
}

async function isEntityPublished(queryable: Pool | PoolClient, entityId: string): Promise<boolean> {
  const result = await queryable.query<{ state: string }>(
    `select cev.state from current_entity_versions cev
     join entities e on e.id = cev.entity_id
     where e.id = $1 and e.deleted_at is null`,
    [entityId],
  );
  return result.rows[0]?.state === 'published';
}

async function isEntityLoopOpen(queryable: Pool | PoolClient, entityId: string): Promise<boolean> {
  const result = await queryable.query<{ open_loop: boolean | null }>(
    `select open_loop from entities where id = $1 and deleted_at is null`,
    [entityId],
  );
  return result.rows[0]?.open_loop === true;
}

async function loadEntityInfo(pool: Pool, entityId: string): Promise<{
  title: string | null; summary: string | null; kind: string; authorMemberId: string;
} | null> {
  const result = await pool.query<{
    title: string | null; summary: string | null; kind: string; author_member_id: string;
  }>(
    `select cev.title, cev.summary, e.kind::text as kind, e.author_member_id
     from current_entity_versions cev
     join entities e on e.id = cev.entity_id
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
    `select public_name, handle from members where id = $1`,
    [memberId],
  );
  return result.rows[0] ? {
    memberId,
    publicName: result.rows[0].public_name,
    handle: result.rows[0].handle,
  } : null;
}

// ── Periodic backstop sweep ───────────────────────────────

const BACKSTOP_INTERVAL_MS = parseInt(process.env.SYNCHRONICITY_BACKSTOP_INTERVAL_MS ?? String(7 * DAY_MS), 10);

/**
 * Periodic reconciliation sweep: enqueues intro recompute for all
 * accessible members across all clubs. Runs infrequently (default: weekly).
 * Serves as repair for missed reactive triggers and as bootstrap when
 * the feature is first enabled on an existing club.
 */
async function processBackstopSweep(pools: WorkerPools): Promise<number> {
  const lastAt = await getState(pools.db, 'backstop_sweep_at');
  const now = Date.now();

  if (lastAt && now - Date.parse(lastAt) < BACKSTOP_INTERVAL_MS) {
    return 0; // not due yet
  }

  // Get all distinct (member_id, club_id) pairs from accessible memberships
  const result = await pools.db.query<{ member_id: string; club_id: string }>(
    `select distinct member_id, club_id from accessible_club_memberships`,
  );

  let enqueued = 0;
  for (const row of result.rows) {
    await enqueueIntroRecompute(pools.db, row.member_id, row.club_id);
    enqueued++;
  }

  await setState(pools.db, 'backstop_sweep_at', new Date().toISOString());
  if (enqueued > 0) console.log(`Backstop sweep: enqueued ${enqueued} intro recomputes`);
  return enqueued;
}

// ── Main process function ─────────────────────────────────

async function processSynchronicity(pools: WorkerPools): Promise<number> {
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
  const pools = createPools();
  const healthPort = process.env.WORKER_HEALTH_PORT ? parseInt(process.env.WORKER_HEALTH_PORT, 10) : undefined;

  if (process.argv.includes('--once')) {
    await runWorkerOnce('synchronicity', pools, processSynchronicity);
  } else {
    await runWorkerLoop('synchronicity', pools, processSynchronicity, {
      pollIntervalMs: POLL_INTERVAL_MS,
      healthPort,
    });
  }
}

export { processSynchronicity, processEntityTriggers, processProfileTriggers, processMemberAccessibilityTriggers, processIntroRecompute, processBackstopSweep, deliverMatches };
