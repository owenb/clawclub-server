import type { LogApiRequestInput, LogLlmUsageInput, Repository } from './repository.ts';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type LogContext = Record<string, JsonValue | undefined>;

function normalizeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((nested) => normalizeValue(nested, seen));
  }
  if (value instanceof Error) {
    return serializeError(value, seen);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      normalized[key] = normalizeValue(nested, seen);
    }
    return normalized;
  }
  return String(value);
}

function serializeError(error: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (error instanceof Error) {
    if (seen.has(error)) return '[Circular]';
    seen.add(error);
    const serialized: Record<string, JsonValue> = {
      name: error.name,
      message: error.message,
    };
    const maybeCode = error as Error & { code?: unknown; kind?: unknown; cause?: unknown };
    if (typeof maybeCode.code === 'string') serialized.code = maybeCode.code;
    if (typeof maybeCode.kind === 'string') serialized.kind = maybeCode.kind;
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      serialized.stack = error.stack;
    }
    if (maybeCode.cause !== undefined) {
      serialized.cause = normalizeValue(maybeCode.cause, seen);
    }
    return serialized;
  }
  return normalizeValue(error, seen);
}

function emit(method: 'log' | 'warn' | 'error', record: Record<string, JsonValue | undefined>): void {
  const payload: Record<string, JsonValue> = {
    ts: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    payload[key] = value;
  }
  console[method](JSON.stringify(payload));
}

export const logger = {
  record(record: Record<string, JsonValue | undefined>, method: 'log' | 'warn' | 'error' = 'log'): void {
    emit(method, record);
  },

  info(message: string, context: LogContext = {}): void {
    emit('log', {
      level: 'info',
      message,
      ...context,
    });
  },

  warn(message: string, context: LogContext = {}): void {
    emit('warn', {
      level: 'warn',
      message,
      ...context,
    });
  },

  error(kind: string, error?: unknown, context: LogContext = {}): void {
    emit('error', {
      level: 'error',
      kind,
      ...context,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    });
  },
};

export function safeLogError(kind: string, error?: unknown, context: LogContext = {}): void {
  try {
    logger.error(kind, error, context);
  } catch {
    // Background log failure handlers must never become new unhandled rejections.
  }
}

export const STALE_CLIENT_LOG_ACTION = 'stale_client';

export function fireAndForgetRequestLog(repository: Repository, entry: LogApiRequestInput): void {
  const logApiRequest = (repository as Partial<Repository>).logApiRequest;
  if (typeof logApiRequest !== 'function') return;
  logApiRequest.call(repository, entry).catch((err) => {
    safeLogError('request_log_failure', err, { actionName: entry.actionName, memberId: entry.memberId });
  });
}

export function fireAndForgetLlmUsageLog(repository: Repository, entry: LogLlmUsageInput): void {
  const logLlmUsage = (repository as Partial<Repository>).logLlmUsage;
  if (typeof logLlmUsage !== 'function') return;
  logLlmUsage.call(repository, entry).catch((err) => {
    safeLogError('llm_usage_log_failure', err, { actionName: entry.actionName });
  });
}
