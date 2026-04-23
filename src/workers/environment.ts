import { Pool } from 'pg';

const DEFAULT_WORKER_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_WORKER_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_OUTBOUND_LLM_TIMEOUT_MS = 15_000;

export function createWorkerPool(options: {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
}): Pool {
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_WORKER_STATEMENT_TIMEOUT_MS;
  return new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 3,
    connectionTimeoutMillis: DEFAULT_WORKER_CONNECTION_TIMEOUT_MS,
    options: `-c statement_timeout=${statementTimeoutMs}`,
  });
}

export async function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function outboundLlmSignal(timeoutMs: number = DEFAULT_OUTBOUND_LLM_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
