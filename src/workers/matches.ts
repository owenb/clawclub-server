/**
 * Background match lifecycle helpers.
 *
 * Provides create (with dedup), deliver, expire, and throttle-check
 * operations on the background_matches table.
 *
 * These are worker-side helpers with no API surface.
 */
import type { Pool } from 'pg';

export type MatchInput = {
  clubId: string;
  matchKind: string;
  sourceId: string;
  targetMemberId: string;
  score: number;
  payload?: Record<string, unknown>;
  expiresAt?: string | null;
};

export type PendingMatch = {
  id: string;
  clubId: string;
  matchKind: string;
  sourceId: string;
  targetMemberId: string;
  score: number;
  payload: Record<string, unknown>;
};

/**
 * Insert a match row, skipping silently on unique constraint violation.
 * Returns the match ID if inserted, null if duplicate.
 */
export async function createMatch(pool: Pool, input: MatchInput): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `insert into app.background_matches
       (club_id, match_kind, source_id, target_member_id, score, payload, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
     on conflict (match_kind, source_id, target_member_id) do nothing
     returning id`,
    [
      input.clubId,
      input.matchKind,
      input.sourceId,
      input.targetMemberId,
      input.score,
      JSON.stringify(input.payload ?? {}),
      input.expiresAt ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Claim pending matches for delivery, ordered by best score first.
 * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent workers.
 */
export async function claimPendingMatches(pool: Pool, limit: number): Promise<PendingMatch[]> {
  const result = await pool.query<{
    id: string; club_id: string; match_kind: string; source_id: string;
    target_member_id: string; score: number; payload: Record<string, unknown>;
  }>(
    `select id, club_id, match_kind, source_id, target_member_id, score, payload
     from app.background_matches
     where state = 'pending'
       and (expires_at is null or expires_at > now())
     order by score asc, created_at asc
     limit $1
     for update skip locked`,
    [limit],
  );

  return result.rows.map(r => ({
    id: r.id,
    clubId: r.club_id,
    matchKind: r.match_kind,
    sourceId: r.source_id,
    targetMemberId: r.target_member_id,
    score: r.score,
    payload: r.payload,
  }));
}

/**
 * Transition a match to 'delivered' and link it to the signal that was created.
 */
export async function markDelivered(pool: Pool, matchId: string, signalId: string): Promise<void> {
  await pool.query(
    `update app.background_matches
     set state = 'delivered', delivered_at = now(), signal_id = $2
     where id = $1 and state = 'pending'`,
    [matchId, signalId],
  );
}

/**
 * Transition a match to 'expired'.
 */
export async function markExpired(pool: Pool, matchId: string): Promise<void> {
  await pool.query(
    `update app.background_matches
     set state = 'expired'
     where id = $1 and state = 'pending'`,
    [matchId],
  );
}

/**
 * Expire all pending matches that have passed their expires_at.
 * Returns the count of expired matches.
 */
export async function expireStaleMatches(pool: Pool): Promise<number> {
  const result = await pool.query(
    `update app.background_matches
     set state = 'expired'
     where state = 'pending' and expires_at is not null and expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

/**
 * Count signals delivered to a member within a time window,
 * optionally filtered by match kind.
 *
 * Used for throttle checks before delivery.
 * Different match kinds can have different caps (e.g., introductions: 1/day).
 */
export async function countRecentDeliveries(
  pool: Pool,
  targetMemberId: string,
  windowMs: number,
  matchKind?: string,
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();

  if (matchKind) {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count from app.background_matches
       where target_member_id = $1 and match_kind = $2
         and state = 'delivered' and delivered_at > $3`,
      [targetMemberId, matchKind, since],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from app.background_matches
     where target_member_id = $1
       and state = 'delivered' and delivered_at > $2`,
    [targetMemberId, since],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Check if a match already exists (pending or delivered) for this kind + source + target.
 * Used for pre-flight dedup checks without relying on constraint violations.
 */
export async function matchExists(
  pool: Pool,
  matchKind: string,
  sourceId: string,
  targetMemberId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `select exists(
       select 1 from app.background_matches
       where match_kind = $1 and source_id = $2 and target_member_id = $3
     ) as exists`,
    [matchKind, sourceId, targetMemberId],
  );
  return result.rows[0]?.exists ?? false;
}
