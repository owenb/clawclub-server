import { createHash } from 'node:crypto';
import { Client, type ClientConfig, type Pool } from 'pg';
import type { DbClient } from './db.ts';
import { AppError } from './errors.ts';

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

type IdempotencyLookupResult<T> =
  | { status: 'miss' }
  | { status: 'hit'; responseValue: T };

export async function lookupIdempotency<T>(
  client: DbClient,
  input: {
    clientKey: string;
    actorContext: string;
    requestValue: unknown;
  },
): Promise<IdempotencyLookupResult<T>> {
  const requestHash = hashRequest(input.requestValue);
  const existing = await client.query<{
    actor_context: string;
    request_hash: string;
    response_envelope: T;
  }>(
    `select actor_context, request_hash, response_envelope
     from idempotency_keys
     where actor_context = $1
       and client_key = $2
     limit 1`,
    [input.actorContext, input.clientKey],
  );

  const row = existing.rows[0];
  if (!row) {
    return { status: 'miss' };
  }

  if (row.actor_context !== input.actorContext || row.request_hash !== requestHash) {
    throw new AppError('client_key_conflict', 'This clientKey was already used for a different request.');
  }

  await client.query(
    `update idempotency_keys
     set last_seen_at = now()
     where actor_context = $1
       and client_key = $2`,
    [input.actorContext, input.clientKey],
  );

  return {
    status: 'hit',
    responseValue: row.response_envelope,
  };
}

export async function withIdempotency<T>(
  client: DbClient,
  input: {
    clientKey: string;
    actorContext: string;
    requestValue: unknown;
    execute: () => Promise<{ responseValue: T; storedValue?: unknown }>;
  },
): Promise<T> {
  const scopedClientKey = `${input.actorContext}:${input.clientKey}`;
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [scopedClientKey]);
  const existing = await lookupIdempotency<T>(client, {
    clientKey: input.clientKey,
    actorContext: input.actorContext,
    requestValue: input.requestValue,
  });
  if (existing.status === 'hit') {
    return existing.responseValue;
  }

  const requestHash = hashRequest(input.requestValue);
  const executed = await input.execute();
  await client.query(
    `insert into idempotency_keys (client_key, actor_context, request_hash, response_envelope)
     values ($1, $2, $3, $4::jsonb)`,
    [
      input.clientKey,
      input.actorContext,
      requestHash,
      JSON.stringify(executed.storedValue ?? executed.responseValue),
    ],
  );

  return executed.responseValue;
}

export async function withClientKeyBarrier<T>(pool: Pool, input: {
  clientKey: string;
  actorContext: string;
  execute: () => Promise<T>;
}): Promise<T> {
  const barrierKey = `client-key-barrier:${input.actorContext}:${input.clientKey}`;
  const client = new Client(getBarrierClientConfig(pool));
  try {
    await client.connect();
    await client.query(`select pg_advisory_lock(hashtext($1))`, [barrierKey]);
    return await input.execute();
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(hashtext($1))`, [barrierKey]);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

export function getBarrierClientConfig(pool: Pool): ClientConfig {
  if (pool.options.connectionString) {
    return {
      connectionString: pool.options.connectionString,
      connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
      options: pool.options.options,
    };
  }

  return {
    host: pool.options.host,
    port: pool.options.port,
    database: pool.options.database,
    user: pool.options.user,
    password: pool.options.password,
    ssl: pool.options.ssl,
    connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
    options: pool.options.options,
  };
}
