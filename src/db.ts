/**
 * Shared database helpers.
 */

import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, type ErrorCode } from './errors.ts';

// A database client — either a Pool (for single queries) or a PoolClient (for transactions).
export type DbClient = Pool | PoolClient;
export type TransactionIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

type TransactionOptions = {
  isolationLevel?: TransactionIsolationLevel;
  retrySerializationFailures?: number;
};

export function matchesPgCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pgError = error as { code?: unknown };
  return pgError.code === code;
}

export function matchesPgConstraint(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === '23505' && pgError.constraint === constraint;
}

export function translate23505(
  error: unknown,
  constraintName: string,
  errorCode: ErrorCode,
): never | void {
  if (matchesPgConstraint(error, constraintName)) {
    throw new AppError(errorCode, 'This resource was modified concurrently. Retry.');
  }
}

export function translatePgCode(
  error: unknown,
  pgCode: string,
  errorCode: ErrorCode,
  message: string,
): never | void {
  if (matchesPgCode(error, pgCode)) {
    throw new AppError(errorCode, message);
  }
}

function beginStatement(options: TransactionOptions): string {
  if (!options.isolationLevel) {
    return 'BEGIN';
  }
  return `BEGIN ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`;
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const baseDelayMs = Math.min(25, attempt * 5);
  const jitterMs = Math.floor(Math.random() * 5);
  await sleep(baseDelayMs + jitterMs);
}

/**
 * Run a function inside a transaction. Handles BEGIN/COMMIT/ROLLBACK and client release.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retryLimit = Math.max(0, options.retrySerializationFailures ?? 0);
  let attempt = 0;

  for (;;) {
    const client = await pool.connect();
    let phase: 'before_begin' | 'open' | 'committing' | 'done' = 'before_begin';
    try {
      await client.query(beginStatement(options));
      phase = 'open';
      const result = await fn(client);
      phase = 'committing';
      await client.query('COMMIT');
      phase = 'done';
      return result;
    } catch (error) {
      if (phase === 'open' || (phase === 'committing' && !matchesPgCode(error, '40001'))) {
        await client.query('ROLLBACK');
      }
      if (matchesPgCode(error, '40001') && attempt < retryLimit) {
        attempt += 1;
        await waitBeforeRetry(attempt);
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
