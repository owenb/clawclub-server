/**
 * Shared database helpers for the three-pool architecture.
 *
 * Each plane (identity, messages, clubs) gets its own Pool.
 * This module provides the shared types and utilities they all use.
 */

import type { Pool, PoolClient } from 'pg';

// A database client — either a Pool (for single queries) or a PoolClient (for transactions).
export type DbClient = Pool | PoolClient;

// Member display info resolved from the identity database for cross-plane enrichment.
export type MemberDisplay = {
  id: string;
  publicName: string;
  handle: string | null;
};

/**
 * Run a function inside a transaction. Handles BEGIN/COMMIT/ROLLBACK and client release.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Batch-fetch member display info from the identity pool.
 * Returns a Map keyed by member ID. Missing IDs are omitted.
 */
export async function fetchMemberDisplayBatch(
  identityPool: Pool,
  memberIds: string[],
): Promise<Map<string, MemberDisplay>> {
  const unique = [...new Set(memberIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const result = await identityPool.query<{ id: string; public_name: string; handle: string | null }>(
    `SELECT id, public_name, handle FROM app.members WHERE id = ANY($1) AND state = 'active'`,
    [unique],
  );

  const map = new Map<string, MemberDisplay>();
  for (const row of result.rows) {
    map.set(row.id, { id: row.id, publicName: row.public_name, handle: row.handle });
  }
  return map;
}

/** Lookup a single member display. Returns null if not found. */
export function lookupMember(members: Map<string, MemberDisplay>, id: string | null): MemberDisplay | null {
  if (!id) return null;
  return members.get(id) ?? null;
}

/** Lookup a member display with a fallback for unknown members. */
export function requireMember(members: Map<string, MemberDisplay>, id: string, fallbackName = 'Unknown'): MemberDisplay {
  return members.get(id) ?? { id, publicName: fallbackName, handle: null };
}
