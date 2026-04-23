/**
 * Shared worker lifecycle harness.
 *
 * Provides pool management, graceful shutdown, and the standard
 * poll-sleep loop for background workers.
 *
 * Usage:
 *   import { createPools, runWorkerLoop } from './runner.ts';
 *
 *   const pools = createPools();
 *   await runWorkerLoop('my-worker', pools, process, { pollIntervalMs: 5000 });
 */
import { Client, Pool } from 'pg';
import { basename } from 'node:path';
import { AppError } from '../errors.ts';
import { hasInitializedConfig, initializeConfigFromFile } from '../config/index.ts';
import { logger as runtimeLogger } from '../logger.ts';
import { assertStartupConfig } from '../startup-check.ts';
import { cancellableSleep, createWorkerPool } from './environment.ts';

// ── Types ─────────────────────────────────────────────────

export type WorkerPools = {
  db: Pool;
};

export type PoolConfig = {
  databaseUrlEnv?: string;
  databaseUrlOverride?: string;
  maxConnections?: number;
  name?: string;
  requiredEnv?: readonly string[];
};

export type WorkerLoopOptions = {
  pollIntervalMs: number;
  consecutiveFailureLimit?: number;
  logger?: WorkerLogger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  terminate?: (exitCode: number) => void;
};

export type WorkerOnceOptions = {
  logger?: WorkerLogger;
  terminate?: (exitCode: number) => void;
};

export type ExclusiveLockResult =
  | { acquired: true; client: Client }
  | { acquired: false; attempts: number };

export type AcquireExclusiveWorkerLockOptions = {
  databaseUrl?: string;
  logger?: WorkerLogger;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clientFactory?: (databaseUrl: string) => Client;
};

// ── Pool management ───────────────────────────────────────

type WorkerLogger = (...args: unknown[]) => void;
type WorkerProcessHandlerOptions = {
  logger?: WorkerLogger;
  terminate?: () => void;
};

let workerProcessHandlersInstalled = false;
let installedUnhandledRejectionHandler: ((reason: unknown) => void) | null = null;
let installedUncaughtExceptionHandler: ((error: unknown) => void) | null = null;

const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 3;
const FATAL_POSTGRES_ERROR_CODES = new Set(['42P01', '42703', '28P01', '42501']);

function getDefaultWorkerName(): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) return 'worker';
  return basename(entrypoint).replace(/\.[^.]+$/, '') || 'worker';
}

export function createWorkerPoolErrorHandler(name: string, options: { logger?: WorkerLogger } = {}): (error: unknown) => void {
  const logger = options.logger ?? console.error;
  return (error: unknown) => {
    logger(`[${name}] [pool error]`, error);
  };
}

export function createWorkerUnhandledRejectionHandler(name: string, options: { logger?: WorkerLogger } = {}): (reason: unknown) => void {
  const logger = options.logger ?? console.error;
  return (reason: unknown) => {
    logger(`[${name}] [unhandled rejection]`, reason);
  };
}

export function createWorkerUncaughtExceptionHandler(
  name: string,
  options: WorkerProcessHandlerOptions = {},
): (error: unknown) => void {
  const logger = options.logger ?? console.error;
  const terminate = options.terminate ?? (() => process.exit(1));
  return (error: unknown) => {
    logger(`[${name}] [uncaught exception]`, error);
    terminate();
  };
}

export function installWorkerProcessHandlers(name: string, options: WorkerProcessHandlerOptions = {}): void {
  if (workerProcessHandlersInstalled) return;
  installedUnhandledRejectionHandler = createWorkerUnhandledRejectionHandler(name, options);
  installedUncaughtExceptionHandler = createWorkerUncaughtExceptionHandler(name, options);
  process.on('unhandledRejection', installedUnhandledRejectionHandler);
  process.on('uncaughtException', installedUncaughtExceptionHandler);
  workerProcessHandlersInstalled = true;
}

export function resetInstalledWorkerProcessHandlersForTests(): void {
  if (installedUnhandledRejectionHandler) {
    process.off('unhandledRejection', installedUnhandledRejectionHandler);
    installedUnhandledRejectionHandler = null;
  }
  if (installedUncaughtExceptionHandler) {
    process.off('uncaughtException', installedUncaughtExceptionHandler);
    installedUncaughtExceptionHandler = null;
  }
  workerProcessHandlersInstalled = false;
}

function defaultTerminate(exitCode: number): void {
  process.exit(exitCode);
}

type ErrorWithCode = {
  code?: unknown;
  kind?: unknown;
};

export function workerFatalError(message: string, options?: { cause?: unknown }): AppError {
  return new AppError('worker_fatal', message, {
    kind: 'worker_fatal',
    cause: options?.cause,
  });
}

export function isFatalWorkerError(error: unknown): boolean {
  if (error instanceof AppError && error.kind === 'worker_fatal') {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as ErrorWithCode).code;
  return typeof code === 'string' && FATAL_POSTGRES_ERROR_CODES.has(code);
}

export async function acquireExclusiveWorkerLock(
  lockKey: string,
  options: AcquireExclusiveWorkerLockOptions = {},
): Promise<ExclusiveLockResult> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set');
  }

  const logger = options.logger ?? console.error;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 30);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 2000);
  const sleep = options.sleep ?? cancellableSleep;
  const clientFactory = options.clientFactory ?? ((url: string) => new Client({ connectionString: url }));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = clientFactory(databaseUrl);
    try {
      await client.connect();
      const result = await client.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtext($1)) as acquired`,
        [lockKey],
      );
      if (result.rows[0]?.acquired) {
        return { acquired: true, client };
      }
    } catch (error) {
      // Connection / query errors propagate intentionally — the retry loop
      // covers lock contention only, not infrastructure failure. Wrapping
      // this in retry would mask DB outages and delay Railway restart.
      await client.end().catch(() => {});
      throw error;
    }

    await client.end().catch(() => {});
    if (attempt === 1) {
      logger(`[${lockKey}] lock held by another instance, retrying up to ${maxAttempts} times every ${retryDelayMs}ms...`);
    }
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return { acquired: false, attempts: maxAttempts };
}

export function createPools(config: PoolConfig = {}): WorkerPools {
  const databaseUrlEnv = config.databaseUrlEnv ?? 'DATABASE_URL';
  assertStartupConfig({
    entrypoint: `worker:${config.name ?? getDefaultWorkerName()}`,
    requiredDatabaseEnv: databaseUrlEnv,
    required: config.requiredEnv,
  });
  if (!hasInitializedConfig()) {
    initializeConfigFromFile();
  }
  const max = config.maxConnections ?? 3;
  const name = config.name ?? getDefaultWorkerName();

  const databaseUrl = config.databaseUrlOverride ?? process.env[databaseUrlEnv];
  if (!databaseUrl) {
    runtimeLogger.error('worker_database_url_missing', { env: databaseUrlEnv });
    process.exit(1);
  }

  const db = createWorkerPool({
    connectionString: databaseUrl,
    maxConnections: max,
  });
  db.on('error', createWorkerPoolErrorHandler(name));

  return { db };
}

export async function closePools(pools: WorkerPools): Promise<void> {
  await pools.db.end();
}

export async function assertWorkerSchemaReady(
  name: string,
  pools: WorkerPools,
  requiredMigrationFilename: string,
): Promise<void> {
  const tableResult = await pools.db.query<{ exists: boolean }>(
    `select exists (
       select 1
       from information_schema.tables
       where table_schema = 'public'
         and table_name = 'schema_migrations'
     ) as exists`,
  );

  if (!tableResult.rows[0]?.exists) {
    throw workerFatalError(
      `[${name}] required migration ${requiredMigrationFilename} is missing because public.schema_migrations does not exist`,
    );
  }

  const migrationResult = await pools.db.query<{ has_required: boolean; latest: string | null }>(
    `select
       exists(select 1 from public.schema_migrations where filename = $1) as has_required,
       (select max(filename) from public.schema_migrations) as latest`,
    [requiredMigrationFilename],
  );

  const row = migrationResult.rows[0];
  if (!row?.has_required) {
    throw workerFatalError(
      `[${name}] requires migration ${requiredMigrationFilename} but database latest is ${row?.latest ?? 'none'}`,
    );
  }
}

// ── Loop harness ──────────────────────────────────────────

/**
 * Run a worker in loop mode: call processFn repeatedly, sleeping
 * when no work is found. Exits gracefully on SIGTERM/SIGINT.
 */
export async function runWorkerLoop(
  name: string,
  pools: WorkerPools,
  processFn: (pools: WorkerPools) => Promise<number>,
  opts: WorkerLoopOptions,
): Promise<void> {
  const logger = opts.logger ?? console.error;
  const terminate = opts.terminate ?? defaultTerminate;
  const sleepFn = opts.sleep ?? cancellableSleep;
  const consecutiveFailureLimit = Math.max(1, opts.consecutiveFailureLimit ?? DEFAULT_CONSECUTIVE_FAILURE_LIMIT);

  installWorkerProcessHandlers(name, { logger, terminate: () => terminate(1) });
  runtimeLogger.info('worker_loop_started', { worker: name });

  const shutdownController = new AbortController();
  let exitCode: number | null = null;
  let consecutiveFailures = 0;
  const requestShutdown = () => { shutdownController.abort(); };
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);

  try {
    while (!shutdownController.signal.aborted) {
      try {
        const processed = await processFn(pools);
        consecutiveFailures = 0;
        if (processed === 0 && !shutdownController.signal.aborted) {
          await sleepFn(opts.pollIntervalMs, shutdownController.signal);
        }
      } catch (err) {
        consecutiveFailures += 1;
        logger(`Worker ${name} error (${consecutiveFailures}/${consecutiveFailureLimit}):`, err);

        if (isFatalWorkerError(err)) {
          logger(`Worker ${name} encountered a fatal error and will exit 1`);
          exitCode = 1;
          shutdownController.abort();
          continue;
        }

        if (consecutiveFailures >= consecutiveFailureLimit) {
          logger(`Worker ${name} reached ${consecutiveFailures} consecutive failures and will exit 1`);
          exitCode = 1;
          shutdownController.abort();
          continue;
        }

        if (!shutdownController.signal.aborted) {
          await sleepFn(opts.pollIntervalMs, shutdownController.signal);
        }
      }
    }
  } finally {
    process.off('SIGTERM', requestShutdown);
    process.off('SIGINT', requestShutdown);
    runtimeLogger.info('worker_loop_stopped', { worker: name });
    await closePools(pools);
  }

  if (exitCode !== null) {
    terminate(exitCode);
  }
}

/**
 * Run a worker in one-shot mode: call processFn until it returns 0,
 * then exit. Used for testing, manual runs, and cron-triggered work.
 */
export async function runWorkerOnce(
  name: string,
  pools: WorkerPools,
  processFn: (pools: WorkerPools) => Promise<number>,
  opts: WorkerOnceOptions = {},
): Promise<void> {
  const logger = opts.logger ?? console.error;
  const terminate = opts.terminate ?? defaultTerminate;

  installWorkerProcessHandlers(name, { logger, terminate: () => terminate(1) });
  runtimeLogger.info('worker_once_started', { worker: name });
  let total = 0;
  let exitCode: number | null = null;

  try {
    while (true) {
      const processed = await processFn(pools);
      total += processed;
      if (processed === 0) break;
    }
    runtimeLogger.info('worker_once_completed', { worker: name, processedItems: total });
  } catch (error) {
    logger(`Worker ${name} error:`, error);
    exitCode = 1;
  } finally {
    await closePools(pools);
  }

  if (exitCode !== null) {
    terminate(exitCode);
  }
}
