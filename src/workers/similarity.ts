/**
 * Cross-plane vector similarity helpers.
 *
 * Each method follows a two-step pattern:
 *   1. Load the source embedding from its owning DB plane
 *   2. Query the target plane by vector similarity
 *
 * These are worker-side helpers with no API surface. They take DB pools
 * as arguments and are usable by any worker that needs similarity queries.
 *
 * All member-scoped queries use accessible_club_memberships to match
 * the current product visibility model (subscription-gated access).
 */
import type { Pool } from 'pg';

export type SimilarityResult = {
  memberId: string;
  distance: number;
};

export type EntityMatchResult = {
  entityId: string;
  authorMemberId: string;
  distance: number;
};

// ── Helpers ───────────────────────────────────────────────

/**
 * Load the latest embedding vector for an entity from the clubs DB.
 * Returns null if no embedding exists.
 */
async function loadEntityVector(clubsPool: Pool, entityId: string): Promise<string | null> {
  const result = await clubsPool.query<{ embedding: string }>(
    `select eea.embedding::text as embedding
     from app.embeddings_entity_artifacts eea
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
 * Load the latest embedding vector for a member's profile from the identity DB.
 * Returns null if no embedding exists.
 */
async function loadProfileVector(identityPool: Pool, memberId: string): Promise<string | null> {
  const result = await identityPool.query<{ embedding: string }>(
    `select empa.embedding::text as embedding
     from app.embeddings_member_profile_artifacts empa
     where empa.member_id = $1
     order by empa.updated_at desc
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
 * Step 1: load entity vector from clubs DB
 * Step 2: query identity DB for similar profiles in the same club
 */
export async function findMembersMatchingEntity(
  clubsPool: Pool,
  identityPool: Pool,
  entityId: string,
  clubId: string,
  excludeMemberId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const vector = await loadEntityVector(clubsPool, entityId);
  if (!vector) return [];

  const result = await identityPool.query<{ member_id: string; distance: number }>(
    `select empa.member_id, min(empa.embedding <=> $1::vector) as distance
     from app.embeddings_member_profile_artifacts empa
     join app.accessible_club_memberships acm
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
 * Step 1: load member's profile vector from identity DB
 * Step 2: query identity DB for similar profiles in the same club
 *
 * DM thread existence filtering is done by the caller (requires messaging DB).
 */
export async function findSimilarMembers(
  identityPool: Pool,
  memberId: string,
  clubId: string,
  limit: number,
): Promise<SimilarityResult[]> {
  const vector = await loadProfileVector(identityPool, memberId);
  if (!vector) return [];

  const result = await identityPool.query<{ member_id: string; distance: number }>(
    `select empa.member_id, min(empa.embedding <=> $1::vector) as distance
     from app.embeddings_member_profile_artifacts empa
     join app.accessible_club_memberships acm
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
 * Step 1: load offer entity vector from clubs DB
 * Step 2: query clubs DB for similar ask entities in the same club
 *
 * Returns the ask's author_member_id so the caller knows who to signal.
 */
export async function findAskMatchingOffer(
  clubsPool: Pool,
  offerEntityId: string,
  clubId: string,
  limit: number,
): Promise<EntityMatchResult[]> {
  const vector = await loadEntityVector(clubsPool, offerEntityId);
  if (!vector) return [];

  const result = await clubsPool.query<{
    entity_id: string; author_member_id: string; distance: number;
  }>(
    `select eea.entity_id,
            e.author_member_id,
            min(eea.embedding <=> $1::vector) as distance
     from app.embeddings_entity_artifacts eea
     join app.current_entity_versions cev
       on cev.entity_id = eea.entity_id and cev.state = 'published'
     join app.entities e on e.id = eea.entity_id
     where e.club_id = $2
       and e.kind = 'ask'
       and e.id <> $3
       and e.deleted_at is null
     group by eea.entity_id, e.author_member_id
     order by distance asc
     limit $4`,
    [vector, clubId, offerEntityId, limit],
  );

  return result.rows.map(r => ({
    entityId: r.entity_id,
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
  messagingPool: Pool,
  memberAIds: string[],
  memberBIds: string[],
): Promise<Set<string>> {
  if (memberAIds.length === 0) return new Set();

  const result = await messagingPool.query<{ member_a_id: string; member_b_id: string }>(
    `select member_a_id, member_b_id
     from app.messaging_threads
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
