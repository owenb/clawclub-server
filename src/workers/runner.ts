/**
 * Shared worker lifecycle harness.
 *
 * Provides pool management, graceful shutdown, health endpoint,
 * and the standard poll-sleep loop for background workers.
 *
 * Usage:
 *   import { createPools, runWorkerLoop } from './runner.ts';
 *
 *   const pools = createPools({ identity: true, clubs: true });
 *   await runWorkerLoop('my-worker', pools, process, { pollIntervalMs: 5000 });
 */
import { Pool } from 'pg';
import * as http from 'node:http';

// ── Types ─────────────────────────────────────────────────

export type WorkerPools = {
  identity: Pool;
  clubs: Pool;
  messaging?: Pool;
};

export type PoolConfig = {
  identity: boolean;
  clubs: boolean;
  messaging?: boolean;
  maxConnections?: number;
};

export type WorkerLoopOptions = {
  pollIntervalMs: number;
  healthPort?: number;
};

// ── Pool management ───────────────────────────────────────

export function createPools(config: PoolConfig): WorkerPools {
  const max = config.maxConnections ?? 3;

  const identityUrl = process.env.IDENTITY_DATABASE_URL;
  const clubsUrl = process.env.CLUBS_DATABASE_URL;

  if (config.identity && !identityUrl) {
    console.error('IDENTITY_DATABASE_URL must be set');
    process.exit(1);
  }
  if (config.clubs && !clubsUrl) {
    console.error('CLUBS_DATABASE_URL must be set');
    process.exit(1);
  }

  const pools: WorkerPools = {
    identity: new Pool({ connectionString: identityUrl, max }),
    clubs: new Pool({ connectionString: clubsUrl, max }),
  };

  if (config.messaging) {
    const messagingUrl = process.env.MESSAGING_DATABASE_URL;
    if (!messagingUrl) {
      console.error('MESSAGING_DATABASE_URL must be set');
      process.exit(1);
    }
    pools.messaging = new Pool({ connectionString: messagingUrl, max });
  }

  return pools;
}

export async function closePools(pools: WorkerPools): Promise<void> {
  await pools.identity.end();
  await pools.clubs.end();
  if (pools.messaging) await pools.messaging.end();
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
