import { AppError } from './errors.ts';
import { decodeCursor, encodeCursor } from './schemas/fields.ts';

const COMPOSITE_RE = /^a(0|[1-9]\d*):i(0|[1-9]\d*)$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;

export type StreamResumeCursor = {
  activitySeq: number | null;
  inboxSeq: number | null;
};

function parseSafeNonNegativeInteger(raw: string): number | null {
  if (!DECIMAL_RE.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function composeStreamResumeId(activitySeq: number | null, inboxSeq: number | null): string {
  return `a${activitySeq ?? 0}:i${inboxSeq ?? 0}`;
}

export function parseStreamResumeId(value: string | null, options: { allowLegacyActivityCursor?: boolean } = {}): StreamResumeCursor | null {
  if (value === null || value === 'latest') {
    return { activitySeq: null, inboxSeq: null };
  }

  const composite = COMPOSITE_RE.exec(value);
  if (composite) {
    const activitySeq = parseSafeNonNegativeInteger(composite[1]!);
    const inboxSeq = parseSafeNonNegativeInteger(composite[2]!);
    if (activitySeq !== null && inboxSeq !== null) {
      return { activitySeq, inboxSeq };
    }
    return null;
  }

  if (!options.allowLegacyActivityCursor) {
    return null;
  }

  if (DECIMAL_RE.test(value)) {
    const activitySeq = parseSafeNonNegativeInteger(value);
    return activitySeq === null ? null : { activitySeq, inboxSeq: null };
  }

  try {
    const [rawSeq] = decodeCursor(value, 1);
    const activitySeq = parseSafeNonNegativeInteger(rawSeq);
    return activitySeq === null ? null : { activitySeq, inboxSeq: null };
  } catch {
    return null;
  }
}

export function parseRequiredStreamResumeId(value: string, message: string): StreamResumeCursor {
  const parsed = parseStreamResumeId(value, { allowLegacyActivityCursor: true });
  if (parsed === null) {
    throw new AppError('invalid_input', message);
  }
  return parsed;
}

export function encodeLegacyActivityCursor(seq: number | null): string | null {
  if (seq === null) {
    return null;
  }
  return encodeCursor([String(seq)]);
}
