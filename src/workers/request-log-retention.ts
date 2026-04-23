import type { Pool } from 'pg';
import type { WorkerPools } from './runner.ts';
import { logger } from '../logger.ts';

const API_REQUEST_LOG_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_LOG_RETENTION_WORKER_ID = 'request_log_retention';

async function getRetentionState(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ state_value: string }>(
    `select state_value
       from worker_state
      where worker_id = $1
        and state_key = 'api_request_log_retention_at'`,
    [REQUEST_LOG_RETENTION_WORKER_ID],
  );
  return result.rows[0]?.state_value ?? null;
}

async function setRetentionState(pool: Pool, value: string): Promise<void> {
  await pool.query(
    `insert into worker_state (worker_id, state_key, state_value, updated_at)
     values ($1, 'api_request_log_retention_at', $2, now())
     on conflict (worker_id, state_key) do update
       set state_value = excluded.state_value,
           updated_at = now()`,
    [REQUEST_LOG_RETENTION_WORKER_ID, value],
  );
}

async function getDatabaseNowText(pool: Pool): Promise<string> {
  const result = await pool.query<{ now_text: string }>(`select now()::text as now_text`);
  return result.rows[0]?.now_text ?? new Date().toISOString();
}

export async function processApiRequestLogRetention(pools: WorkerPools): Promise<number> {
  const lastAt = await getRetentionState(pools.db);

  let nowText: string;
  if (lastAt) {
    const dueResult = await pools.db.query<{ is_due: boolean; now_text: string }>(
      `select
         $1::timestamptz <= now() - ($2::double precision * interval '1 millisecond') as is_due,
         now()::text as now_text`,
      [lastAt, API_REQUEST_LOG_RETENTION_INTERVAL_MS],
    );
    nowText = dueResult.rows[0]?.now_text ?? await getDatabaseNowText(pools.db);
    if (!dueResult.rows[0]?.is_due) {
      return 0;
    }
  } else {
    nowText = await getDatabaseNowText(pools.db);
  }

  const deleted = await pools.db.query<{ deleted: number }>(
    `with victim as (
       delete from public.api_request_log
       where created_at < now() - interval '90 days'
       returning 1
     )
     select count(*)::int as deleted from victim`,
  );
  const count = deleted.rows[0]?.deleted ?? 0;
  await setRetentionState(pools.db, nowText);
  if (count > 0) {
    logger.info('api_request_log_retention_swept', { deleted: count });
  }
  return count;
}
