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
import type { Pool } from 'pg';

export type SimilarityResult = {
  memberId: string;
  distance: number;
};

export type EntityMatchResult = {
  entityId: string;
  entityVersionId: string;
  authorMemberId: string;
  distance: number;
};

// ── Helpers ───────────────────────────────────────────────

/**
 * Load the latest embedding vector for an entity.
 * Returns null if no embedding exists.
 */
async function loadEntityVector(pool: Pool, entityId: string): Promise<string | null> {
  const result = await pool.query<{ embedding: string }>(
    `select eea.embedding::text as embedding
     from app.entity_embeddings eea
     join app.current_entity_versions cev
       on cev.entity_id = eea.entity_id and cev.state = 'published'
     where eea.entity_id = $1
     order by eea.updated_at desc
     limit 1`,
    [entityId],
  );
  return result.rows[0]?.embedding ?? null;
}

/**
 * Load the embedding vector for a member's CURRENT profile version.
 * Returns null if no embedding exists for the current version.
 *
 * Only uses embeddings whose profile_version_id matches the current
 * profile version. If the member has updated their profile but the
 * new embedding isn't ready yet, returns null — preferring to skip
 * the member over matching on stale semantics.
 */
async function loadProfileVector(pool: Pool, memberId: string): Promise<string | null> {
  const result = await pool.query<{ embedding: string }>(
    `select empa.embedding::text as embedding
     from app.profile_embeddings empa
     join app.current_profiles cmp
       on cmp.id = empa.profile_version_id and cmp.member_id = empa.member_id
     where empa.member_id = $1
     limit 1`,
    [memberId],
  );
  return result.rows[0]?.embedding ?? null;
}

// ── Public API ────────────────────────────────────────────

/**
 * Find members whose profiles are semantically similar to an entity.
 *
 * Use case: "who might be able to help with this ask?"
 */
export async function findMembersMatchingEntity(
  pool: Pool,
  entityId: string,
  clubId: string,
  excludeMemberId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const vector = await loadEntityVector(pool, entityId);
  if (!vector) return [];

  // Only match against embeddings for the current profile version.
  // Members whose profile has advanced but whose new embedding isn't ready
  // are skipped — prefer missing a match over matching on stale semantics.
  const result = await pool.query<{ member_id: string; distance: number }>(
    `select empa.member_id, min(empa.embedding <=> $1::vector) as distance
     from app.profile_embeddings empa
     join app.current_profiles cmp
       on cmp.id = empa.profile_version_id and cmp.member_id = empa.member_id
     join app.accessible_memberships acm
       on acm.member_id = empa.member_id
       and acm.club_id = $2
     where empa.member_id <> $3
     group by empa.member_id
     order by distance asc
     limit $4`,
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
  pool: Pool,
  memberId: string,
  clubId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const vector = await loadProfileVector(pool, memberId);
  if (!vector) return [];

  // Only match against current-version embeddings for target members too.
  const result = await pool.query<{ member_id: string; distance: number }>(
    `select empa.member_id, min(empa.embedding <=> $1::vector) as distance
     from app.profile_embeddings empa
     join app.current_profiles cmp
       on cmp.id = empa.profile_version_id and cmp.member_id = empa.member_id
     join app.accessible_memberships acm
       on acm.member_id = empa.member_id
       and acm.club_id = $2
     where empa.member_id <> $3
     group by empa.member_id
     order by distance asc
     limit $4`,
    [vector, clubId, memberId, limit],
  );

  return result.rows.map(r => ({ memberId: r.member_id, distance: r.distance }));
}

/**
 * Find existing ask entities that a new offer (service/opportunity) could fulfil.
 *
 * Use case: "does this new service match any existing asks?"
 * Returns the ask's author_member_id so the caller knows who to signal.
 */
export async function findAskMatchingOffer(
  pool: Pool,
  offerEntityId: string,
  clubId: string,
  limit: number,
  excludeAuthorId?: string,
): Promise<EntityMatchResult[]> {
  const vector = await loadEntityVector(pool, offerEntityId);
  if (!vector) return [];

  const result = await pool.query<{
    entity_id: string; entity_version_id: string; author_member_id: string; distance: number;
  }>(
    `select eea.entity_id,
            cev.id as entity_version_id,
            e.author_member_id,
            min(eea.embedding <=> $1::vector) as distance
     from app.entity_embeddings eea
     join app.current_entity_versions cev
       on cev.entity_id = eea.entity_id and cev.state = 'published'
     join app.entities e on e.id = eea.entity_id
     where e.club_id = $2
       and e.kind = 'ask'
       and e.id <> $3
       and e.deleted_at is null
       and ($5::text is null or e.author_member_id <> $5)
     group by eea.entity_id, cev.id, e.author_member_id
     order by distance asc
     limit $4`,
    [vector, clubId, offerEntityId, limit, excludeAuthorId ?? null],
  );

  return result.rows.map(r => ({
    entityId: r.entity_id,
    entityVersionId: r.entity_version_id,
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
  pool: Pool,
  memberAIds: string[],
  memberBIds: string[],
): Promise<Set<string>> {
  if (memberAIds.length === 0) return new Set();

  const result = await pool.query<{ member_a_id: string; member_b_id: string }>(
    `select member_a_id, member_b_id
     from app.threads
     where archived_at is null
       and (member_a_id, member_b_id) in (
         select * from unnest($1::text[], $2::text[])
       )`,
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
