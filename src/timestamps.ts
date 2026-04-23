function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTimestampKey(key: string): boolean {
  return key.endsWith('At') || key.endsWith('On') || key.endsWith('Until');
}

export function toIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp value: ${String(value)}`);
  }
  return date.toISOString();
}

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function toIsoFromMillis(ms: number): string {
  return new Date(ms).toISOString();
}

export function compareIsoTimestamp(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const leftCanonical = toIsoTimestamp(left);
  const rightCanonical = toIsoTimestamp(right);
  return leftCanonical.localeCompare(rightCanonical);
}

export function isCanonicalIsoTimestamp(value: string): boolean {
  try {
    return toIsoTimestamp(value) === value;
  } catch {
    return false;
  }
}

export function canonicalizeTimestampFields(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeTimestampFields(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && isTimestampKey(key)) {
      try {
        output[key] = isCanonicalIsoTimestamp(entry) ? entry : toIsoTimestamp(entry);
        continue;
      } catch {
        output[key] = entry;
        continue;
      }
    }
    output[key] = canonicalizeTimestampFields(entry);
  }
  return output;
}

export function findNonCanonicalTimestampPaths(
  value: unknown,
  path = '$',
): string[] {
  if (value instanceof Date) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findNonCanonicalTimestampPaths(entry, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    return [];
  }

  const failures: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (typeof entry === 'string' && isTimestampKey(key) && !isCanonicalIsoTimestamp(entry)) {
      failures.push(nextPath);
      continue;
    }
    failures.push(...findNonCanonicalTimestampPaths(entry, nextPath));
  }
  return failures;
}
