/**
 * Shared database helpers.
 */

import type { Pool, PoolClient } from 'pg';

// A database client — either a Pool (for single queries) or a PoolClient (for transactions).
export type DbClient = Pool | PoolClient;

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
