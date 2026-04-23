export function normalizeErrorCode(err: unknown): string {
  if (err == null || typeof err !== 'object') return 'unknown';

  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.code === 'string') return anyErr.code;
  if (typeof anyErr.error === 'object' && anyErr.error != null) {
    const inner = anyErr.error as Record<string, unknown>;
    if (typeof inner.code === 'string') return inner.code;
    if (typeof inner.type === 'string') return inner.type;
  }
  if (typeof anyErr.status === 'number') return `http_${anyErr.status}`;
  if (typeof anyErr.statusCode === 'number') return `http_${anyErr.statusCode}`;
  if (typeof anyErr.name === 'string' && anyErr.name !== 'Error') return anyErr.name;
  return 'unknown';
}
