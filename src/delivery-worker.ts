import { Pool } from 'pg';
import { buildApp, type DeliveryExecutionResult } from './app.ts';
import { createPostgresRepository } from './postgres.ts';

type WorkerFlags = {
  bearerToken?: string;
  workerKey?: string;
  maxRuns?: number;
};

export type DeliveryWorkerRun = {
  iteration: number;
  outcome: DeliveryExecutionResult['outcome'];
  deliveryId: string | null;
};

export type DeliveryWorkerSummary = {
  reason: 'idle' | 'safety_limit';
  runs: DeliveryWorkerRun[];
};

export type DeliveryWorkerDependencies = {
  executeOnce: (payload: { workerKey?: string }) => Promise<DeliveryExecutionResult>;
  log?: (message: string) => void;
};

const DEFAULT_MAX_RUNS = 10;

function usage(): never {
  console.error(`usage:
  node --experimental-strip-types src/delivery-worker.ts --token <bearer_token> [--worker-key <key>] [--max-runs <n>]

flags:
  --token        ClawClub bearer token used to call deliveries.execute
  --worker-key   Optional worker identity written onto claimed attempts
  --max-runs     Safety cap for one worker pass (default: ${DEFAULT_MAX_RUNS})

env fallback:
  CLAWCLUB_BEARER_TOKEN can be used instead of --token`);
  process.exit(1);
}

function parseFlags(argv: string[]): WorkerFlags {
  const flags: WorkerFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--token':
        flags.bearerToken = next;
        index += 1;
        break;
      case '--worker-key':
        flags.workerKey = next;
        index += 1;
        break;
      case '--max-runs': {
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error('--max-runs must be a positive integer');
          process.exit(1);
        }
        flags.maxRuns = parsed;
        index += 1;
        break;
      }
      default:
        usage();
    }
  }

  return flags;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set for this command');
    process.exit(1);
  }
  return databaseUrl;
}

function requireBearerToken(flags: WorkerFlags): string {
  const bearerToken = flags.bearerToken ?? process.env.CLAWCLUB_BEARER_TOKEN;
  if (!bearerToken) {
    console.error('A bearer token is required via --token or CLAWCLUB_BEARER_TOKEN');
    process.exit(1);
  }
  return bearerToken;
}

export async function runDeliveryWorker(
  dependencies: DeliveryWorkerDependencies,
  options: { workerKey?: string; maxRuns?: number } = {},
): Promise<DeliveryWorkerSummary> {
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const log = dependencies.log ?? (() => {});
  const runs: DeliveryWorkerRun[] = [];

  for (let iteration = 1; iteration <= maxRuns; iteration += 1) {
    const execution = await dependencies.executeOnce({ workerKey: options.workerKey });
    const deliveryId = execution.claimed?.delivery.deliveryId ?? null;
    runs.push({ iteration, outcome: execution.outcome, deliveryId });

    if (execution.outcome === 'idle') {
      log(`delivery worker idle after ${iteration} iteration${iteration === 1 ? '' : 's'}`);
      return { reason: 'idle', runs };
    }

    log(`delivery worker iteration ${iteration}: ${execution.outcome}${deliveryId ? ` ${deliveryId}` : ''}`);
  }

  log(`delivery worker stopped at safety limit (${maxRuns})`);
  return { reason: 'safety_limit', runs };
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const bearerToken = requireBearerToken(flags);
  const pool = new Pool({ connectionString: requireDatabaseUrl() });

  try {
    const repository = createPostgresRepository({ pool });
    const app = buildApp({ repository });
    const summary = await runDeliveryWorker(
      {
        executeOnce: async ({ workerKey }) => {
          const result = await app.handleAction({
            bearerToken,
            action: 'deliveries.execute',
            payload: workerKey ? { workerKey } : {},
          });
          return result.data.execution;
        },
        log: (message) => console.log(message),
      },
      { workerKey: flags.workerKey, maxRuns: flags.maxRuns },
    );

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
