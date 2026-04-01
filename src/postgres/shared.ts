import type { Pool, PoolClient } from 'pg';

export type DbClient = Pool | PoolClient;

export type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: Record<string, never>,
) => Promise<void>;

export type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;
