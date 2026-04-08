/**
 * Shared database helpers.
 */

import type { Pool, PoolClient } from 'pg';

// A database client — either a Pool (for single queries) or a PoolClient (for transactions).
export type DbClient = Pool | PoolClient;

export type MutationConfirmationInput = {
  actionName: string;
  confirmationKind: string;
  actorMemberId?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown>;
};

export type MutationConfirmation = {
  confirmationId: string;
  createdAt: string;
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

export async function recordMutationConfirmation(
  client: DbClient,
  input: MutationConfirmationInput,
): Promise<MutationConfirmation> {
  const result = await client.query<{ id: string; created_at: string }>(
    `insert into app.mutation_confirmations
       (action_name, confirmation_kind, actor_member_id, subject_id, metadata)
     values ($1, $2, $3, $4, $5::jsonb)
     returning id, created_at::text as created_at`,
    [
      input.actionName,
      input.confirmationKind,
      input.actorMemberId ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to record mutation confirmation for ${input.actionName}`);
  }

  return {
    confirmationId: row.id,
    createdAt: row.created_at,
  };
}
