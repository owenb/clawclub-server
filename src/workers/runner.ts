/**
 * Shared worker lifecycle harness.
 *
 * Provides pool management, graceful shutdown, health endpoint,
 * and the standard poll-sleep loop for background workers.
 *
 * Usage:
 *   import { createPools, runWorkerLoop } from './runner.ts';
 *
 *   const pools = createPools();
 *   await runWorkerLoop('my-worker', pools, process, { pollIntervalMs: 5000 });
 */
import { Pool } from 'pg';
import * as http from 'node:http';
import { basename } from 'node:path';

// ── Types ─────────────────────────────────────────────────

export type WorkerPools = {
  db: Pool;
};

export type PoolConfig = {
  maxConnections?: number;
  name?: string;
};

export type WorkerLoopOptions = {
  pollIntervalMs: number;
  healthPort?: number;
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

export function createPools(config: PoolConfig = {}): WorkerPools {
  const max = config.maxConnections ?? 3;
  const name = config.name ?? getDefaultWorkerName();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }

  const db = new Pool({ connectionString: databaseUrl, max });
  db.on('error', createWorkerPoolErrorHandler(name));

  return { db };
}

export async function closePools(pools: WorkerPools): Promise<void> {
  await pools.db.end();
}

// ── Health endpoint ───────────────────────────────────────

function startHealthServer(port: number, name: string): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ worker: name, status: 'running' }));
  });
  server.listen(port, () => {
    console.log(`Health endpoint for ${name} on :${port}`);
  });
  return server;
}

// ── Loop harness ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  installWorkerProcessHandlers(name);
  const health = opts.healthPort ? startHealthServer(opts.healthPort, name) : null;
  console.log(`Worker ${name} started (loop mode)`);

  let shutdownRequested = false;
  const requestShutdown = () => { shutdownRequested = true; };
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);

  while (!shutdownRequested) {
    try {
      const processed = await processFn(pools);
      if (processed === 0 && !shutdownRequested) {
        await sleep(opts.pollIntervalMs);
      }
    } catch (err) {
      console.error(`Worker ${name} error:`, err);
      if (!shutdownRequested) await sleep(opts.pollIntervalMs);
    }
  }

  console.log(`Worker ${name} shutting down`);
  if (health) {
    health.close();
  }
  await closePools(pools);
}

/**
 * Run a worker in one-shot mode: call processFn until it returns 0,
 * then exit. Used for testing, manual runs, and cron-triggered work.
 */
export async function runWorkerOnce(
  name: string,
  pools: WorkerPools,
  processFn: (pools: WorkerPools) => Promise<number>,
): Promise<void> {
  installWorkerProcessHandlers(name);
  console.log(`Worker ${name} started (one-shot mode)`);
  let total = 0;
  while (true) {
    const processed = await processFn(pools);
    total += processed;
    if (processed === 0) break;
  }
  console.log(`Worker ${name} one-shot complete: ${total} items processed`);
  await closePools(pools);
}
