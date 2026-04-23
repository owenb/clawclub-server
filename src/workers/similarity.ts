/**
 * Vector similarity helpers.
 *
 * Each method loads a source embedding and queries for similar items.
 * These are worker-side helpers with no API surface. They take a single
 * DB pool as argument and are usable by any worker that needs similarity queries.
 *
 * All member-scoped queries use accessible_memberships to match
 * the current product visibility model (subscription-gated access).
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type SimilarityResult = {
  memberId: string;
  distance: number;
};

export type ContentMatchResult = {
  contentId: string;
  contentVersionId: string;
  authorMemberId: string;
  distance: number;
};

// ── Helpers ───────────────────────────────────────────────

/**
 * Load the embedding vector for a content item's current published version.
 * Returns null if no embedding exists for the current version.
 *
 * Only uses embeddings whose content_version_id matches the current
 * published version. If the content has been edited but the new
 * embedding isn't ready yet, returns null — preferring to skip
 * over matching on stale semantics.
 */
export async function loadCurrentContentVector(queryable: Queryable, contentId: string): Promise<string | null> {
  const result = await queryable.query<{ embedding: string }>(
    `select producer_contract.load_current_content_vector($1) as embedding`,
    [contentId],
  );
  return result.rows[0]?.embedding ?? null;
}

// ── Public API ────────────────────────────────────────────

/**
 * Find members whose profiles are semantically similar to a content item.
 *
 * Use case: "who might be able to help with this ask?"
 */
export async function findMembersMatchingContent(
  queryable: Queryable,
  contentId: string,
  clubId: string,
  excludeMemberId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const vector = await loadCurrentContentVector(queryable, contentId);
  if (!vector) return [];

  return findMembersMatchingVector(queryable, vector, clubId, excludeMemberId, limit);
}

export async function findMembersMatchingVector(
  queryable: Queryable,
  vector: string,
  clubId: string,
  excludeMemberId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const result = await queryable.query<{ member_id: string; distance: number }>(
    `select member_id, distance
       from producer_contract.find_members_matching_vector($1::vector, $2, $3, $4)`,
    [vector, clubId, excludeMemberId, limit],
  );

  return result.rows.map(r => ({ memberId: r.member_id, distance: r.distance }));
}

/**
 * Find members with similar profiles in the same club.
 *
 * Use case: "who should this member meet?"
 * DM thread existence filtering is done by the caller.
 */
export async function findSimilarMembers(
  queryable: Queryable,
  memberId: string,
  clubId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const result = await queryable.query<{ member_id: string; distance: number }>(
    `select member_id, distance
       from producer_contract.find_similar_members($1, $2, $3)`,
    [memberId, clubId, limit],
  );

  return result.rows.map(r => ({ memberId: r.member_id, distance: r.distance }));
}

/**
 * Find existing ask contents that a new offer (gift/service/opportunity) could fulfil.
 *
 * Use case: "does this new service match any existing asks?"
 * Returns the ask's author_member_id so the caller knows who to signal.
 */
export async function findAskMatchingOffer(
  queryable: Queryable,
  offerContentId: string,
  clubId: string,
  limit: number,
  excludeAuthorId?: string,
): Promise<ContentMatchResult[]> {
  const vector = await loadCurrentContentVector(queryable, offerContentId);
  if (!vector) return [];

  return findAskMatchingVector(queryable, vector, offerContentId, clubId, limit, excludeAuthorId);
}

export async function findAskMatchingVector(
  queryable: Queryable,
  vector: string,
  offerContentId: string,
  clubId: string,
  limit: number,
  excludeAuthorId?: string,
): Promise<ContentMatchResult[]> {
  const result = await queryable.query<{
    content_id: string; content_version_id: string; author_member_id: string; distance: number;
  }>(
    `select content_id, content_version_id, author_member_id, distance
       from producer_contract.find_asks_matching_vector($1::vector, $2, $3, $4, $5)`,
    [vector, offerContentId, clubId, limit, excludeAuthorId ?? null],
  );

  return result.rows.map(r => ({
    contentId: r.content_id,
    contentVersionId: r.content_version_id,
    authorMemberId: r.author_member_id,
    distance: r.distance,
  }));
}

// ── Batch interaction check ───────────────────────────────

/**
 * Check which member pairs already have DM threads.
 *
 * Takes pairs as parallel arrays of canonically-ordered member IDs
 * (member_a < member_b). Returns the set of pairs that have threads.
 *
 * Used by introduction matching to filter out already-connected members.
 */
export async function findExistingThreadPairs(
  pool: Pool | PoolClient,
  memberAIds: string[],
  memberBIds: string[],
): Promise<Set<string>> {
  if (memberAIds.length === 0) return new Set();

  const result = await pool.query<{ member_a_id: string; member_b_id: string }>(
    `select member_a_id, member_b_id
       from producer_contract.find_existing_thread_pairs($1::text[], $2::text[])`,
    [memberAIds, memberBIds],
  );

  const pairs = new Set<string>();
  for (const row of result.rows) {
    pairs.add(`${row.member_a_id}:${row.member_b_id}`);
  }
  return pairs;
}

/**
 * Helper to canonically order a member pair for thread lookup.
 * Returns [smaller_id, larger_id].
 */
export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
