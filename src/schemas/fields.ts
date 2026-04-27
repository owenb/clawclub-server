/**
 * Shared Zod field schemas used across action contracts.
 *
 * Two flavors per concept:
 *   - wire*  — describes what the client sends (no transforms, used for docs/schema endpoint)
 *   - parse* — runtime normalization (trim, coerce, default; used by handlers)
 *
 * Where both are identical the field is exported once without a prefix.
 */
import { z } from 'zod';
import { normalizeEmail } from '../email.ts';
import { SLUG_REGEX } from '../identity/slugs.ts';

// ── Enums ────────────────────────────────────────────────

export const contentKind = z.enum(['post', 'opportunity', 'service', 'ask', 'gift', 'event']);
export type ContentKind = z.infer<typeof contentKind>;

export const contentState = z.enum(['draft', 'published', 'removed']);
export type ContentState = z.infer<typeof contentState>;

export const membershipState = z.enum([
  'active',
  'cancelled',
  'removed',
  'banned',
]);
export type MembershipState = z.infer<typeof membershipState>;

export const eventRsvpState = z.enum(['yes', 'maybe', 'no', 'waitlist']);
export type EventRsvpState = z.infer<typeof eventRsvpState>;

export const membershipRole = z.enum(['clubadmin', 'member']);
export type MembershipRole = z.infer<typeof membershipRole>;

export const membershipCreateInitialStatus = z.enum(['active']);
export type MembershipCreateInitialStatus = z.infer<typeof membershipCreateInitialStatus>;

export const updateReceiptState = z.enum(['processed', 'suppressed']);
export type UpdateReceiptState = z.infer<typeof updateReceiptState>;

export const messageRole = z.enum(['member', 'agent', 'system']);
export type MessageRole = z.infer<typeof messageRole>;

// ── Shared transforms ───────────────────────────────────

const FORBIDDEN_STRING_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Zod string base that rejects terminal controls and invalid UTF-16 before storage. */
const safeString = z.string().refine(
  (value) => !FORBIDDEN_STRING_CHARS.test(value),
  { message: 'Text contains forbidden control characters or invalid UTF-8' },
);
const OPAQUE_STRING_MAX_CHARS = 100_000;
export const CLAWCLUB_TIMESTAMP_META = 'timestamp';

export const timestampString = z.string().meta({ clawclubType: CLAWCLUB_TIMESTAMP_META });

// ── Scalar field builders ────────────────────────────────

/**
 * Wire: limit is an optional integer validated to the canonical 1–20 window.
 */
export const wireLimit = z.number().int().min(1).max(20).optional()
  .describe('Max results (default 8). Must be between 1 and 20.');

/**
 * Parse: validates 1–20, defaults to 8.
 */
export const parseLimit = z.number().int().min(1).max(20).optional().default(8);

/** Wire: opaque pagination cursor from previous response */
export const wireCursor = z.string().nullable().optional()
  .describe('Opaque pagination cursor from previous response. Omit or null for first page.');

/** Parse: trims, nullable, defaults to null */
export const parseCursor = z.string().trim().min(1).nullable().optional().default(null);

// ── Shared cursor encode/decode ─────────────────────────────

import { AppError } from '../errors.ts';

/**
 * Encode a keyset cursor from an arbitrary tuple of values.
 * All values must be strings (callers convert numbers/dates to string before encoding).
 */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

/**
 * Decode a keyset cursor into an array of string parts.
 * Validates that the cursor is a valid JSON array of strings.
 */
export function decodeCursor(cursor: string, expectedParts: number): string[] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== expectedParts) throw new Error();
    for (const p of parsed) {
      if (typeof p !== 'string') throw new Error();
    }
    return parsed as string[];
  } catch {
    throw new AppError('invalid_input', 'Invalid pagination cursor');
  }
}

export function decodeOptionalCursor<T>(
  cursor: string | null,
  expectedParts: number,
  map: (parts: string[]) => T,
): T | null {
  return cursor === null ? null : map(decodeCursor(cursor, expectedParts));
}

export function paginatedOutput<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    results: z.array(itemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  });
}

export type BoundedArrayOptions = {
  minItems?: number;
  maxItems?: number;
  description?: string;
  enforcedBy?: 'schema' | 'policy';
};

export function boundedArray<T extends z.ZodTypeAny>(
  itemSchema: T,
  options: BoundedArrayOptions,
) {
  const enforcedBy = options.enforcedBy ?? 'schema';
  let schema = z.array(itemSchema);
  if (options.minItems !== undefined) {
    schema = schema.min(options.minItems);
  }
  if (enforcedBy === 'schema') {
    if (options.maxItems === undefined) {
      throw new Error('boundedArray with schema enforcement requires maxItems');
    }
    schema = schema.max(options.maxItems);
  } else {
    schema = schema.meta({ clawclubEnforcedBy: 'policy' });
  }
  if (options.description) {
    schema = schema.describe(options.description);
  }
  return schema;
}

/**
 * Build a wire limit schema with a custom max.
 */
export function wireLimitOf(max: number) {
  return z.number().int().min(1).max(max).optional()
    .describe(`Max results. Must be between 1 and ${max}.`);
}

/**
 * Build a parse limit schema with custom default and max.
 */
export function parseLimitOf(defaultVal: number, max: number) {
  return z.number().int().min(1).max(max).optional().default(defaultVal);
}

export function paginationFields(
  { defaultLimit, maxLimit }: { defaultLimit: number; maxLimit: number },
) {
  return {
    wire: { limit: wireLimitOf(maxLimit), cursor: wireCursor },
    parse: { limit: parseLimitOf(defaultLimit, maxLimit), cursor: parseCursor },
  } as const;
}

const SMALL_TEXT_MAX_CHARS = 2_000;
const LARGE_TEXT_MAX_CHARS = 20_000;
const MAX_RECORD_BYTES = 4_000;
const MAX_RECORD_KEYS = 50;

function hasHttpUrlScheme(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Wire: optional string that may be null.
 * Empty strings are treated as null by the server.
 */
export const wireOptionalString = z.string().max(SMALL_TEXT_MAX_CHARS).nullable().optional()
  .describe(`Optional, max ${SMALL_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Empty strings are treated as null.`);

/**
 * Parse: trims whitespace; empty string → null.
 * Preserves undefined (omitted) vs null (explicit clear) vs string (set).
 */
export const parseTrimmedNullableString = safeString.pipe(z.string().max(SMALL_TEXT_MAX_CHARS).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/** Wire: optional opaque string (ids, keys, tokens). Empty strings are treated as null. */
export const wireOptionalOpaqueString = z.string().nullable().optional()
  .describe('Optional opaque string. Empty strings are treated as null.');

/** Parse: trims whitespace; empty string → null. No length cap for opaque values. */
export const parseTrimmedNullableOpaqueString = safeString.pipe(z.string().trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/** Wire: optional large string that may be null. Empty strings are treated as null. */
export const wireLargeOptionalString = z.string().max(LARGE_TEXT_MAX_CHARS).nullable().optional()
  .describe(`Optional, max ${LARGE_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Empty strings are treated as null.`);

/** Parse: trims whitespace; empty string → null. Used for larger human-entered bodies. */
export const parseLargeTrimmedNullableString = safeString.pipe(z.string().max(LARGE_TEXT_MAX_CHARS).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/**
 * Wire: patch field (for update/patch actions).
 * Same as wireOptionalString — the three-state semantics are documented.
 */
export const wirePatchString = z.string().max(SMALL_TEXT_MAX_CHARS).nullable().optional()
  .describe(`Omit to leave unchanged, null to clear, string to set. Max ${SMALL_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Empty strings treated as null.`);

/**
 * Parse: patch field preserving three-state: undefined (omit), null (clear), string (set).
 * Does NOT default — preserving undefined is critical for patch semantics.
 */
export const parsePatchString = safeString.pipe(z.string().max(SMALL_TEXT_MAX_CHARS).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/** Wire: URL patch field restricted to http/https. */
export const wirePatchHttpUrl = z.string().url().max(500)
  .refine(hasHttpUrlScheme, 'Must use an http or https URL')
  .nullable()
  .optional()
  .describe('Omit to leave unchanged, null to clear, string to set. Must use http or https. Max 500 characters. Empty strings treated as null.');

/** Parse: URL patch field preserving undefined/null/set semantics, restricted to http/https. */
export const parsePatchHttpUrl = safeString.pipe(z.string().trim().max(500))
  .transform(s => s === '' ? null : s)
  .refine(
    (value) => value === null || safeHttpUrl.safeParse(value).success,
    'Must use an http or https URL',
  )
  .nullable()
  .optional();

/** Wire: large patch field for bodies or other longer human-entered text. */
export const wireLargePatchString = z.string().max(LARGE_TEXT_MAX_CHARS).nullable().optional()
  .describe(`Omit to leave unchanged, null to clear, string to set. Max ${LARGE_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Empty strings treated as null.`);

/** Parse: large patch field preserving undefined/null/set semantics. */
export const parseLargePatchString = safeString.pipe(z.string().max(LARGE_TEXT_MAX_CHARS).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/** Wire: required string. Server trims whitespace and rejects empty results. */
export const wireRequiredString = z.string()
  .max(OPAQUE_STRING_MAX_CHARS)
  .describe(`Required, max ${OPAQUE_STRING_MAX_CHARS.toLocaleString('en-GB')} characters. Server trims whitespace; whitespace-only strings are rejected.`);

/** Parse: required non-empty string, trimmed */
export const parseRequiredString = safeString.pipe(z.string().trim().min(1).max(OPAQUE_STRING_MAX_CHARS));

/** Wire: required human-entered string with a 2 000 character cap. */
export const wireHumanRequiredString = z.string().max(SMALL_TEXT_MAX_CHARS)
  .describe(`Required, max ${SMALL_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Server trims whitespace; whitespace-only strings are rejected.`);

/** Parse: required human-entered string, trimmed, capped at 2 000 characters. */
export const parseHumanRequiredString = safeString.pipe(z.string().trim().min(1).max(SMALL_TEXT_MAX_CHARS));

export function describePublicClubSlug(purpose: string): string {
  return `${purpose} The caller supplies the clubSlug they already know (from an invitation or operator); there is no public directory to discover it from. Public and pre-membership surfaces take clubSlug, not clubId.`;
}

export function describeScopedClubId(purpose: string): string {
  return `${purpose} Use the stable clubId from session.getContext.activeMemberships; scoped and post-membership surfaces take clubId, not clubSlug.`;
}

export function describeOptionalScopedClubId(purpose: string): string {
  return `${purpose} Use the stable clubId from session.getContext.activeMemberships when you want one club; omit it to work across all accessible clubs. Scoped and post-membership surfaces take clubId, not clubSlug.`;
}

export function describeClientKey(purpose = 'Idempotency key.'): string {
  return `${purpose} Any non-empty string you generate. Scope it per-caller per-call. Retrying with the same key and the same payload replays the stored response.`;
}

export const APPLICATION_SOCIALS_DESCRIPTION = 'Freeform context — handles, URLs, portfolio notes. Empty is fine if you have nothing public to link.';
export const APPLICATION_SUBMISSION_PATH_DESCRIPTION = '`cold` (self-initiated) or `invitation` (invite-redeemed). Historical metadata; every accepted application produces an identical membership regardless.';

/** Wire: ISO 8601 date or datetime string. */
export const wireIsoDatetime = z.string()
  .describe('ISO 8601 date or datetime (e.g. "2025-12-31" or "2025-12-31T23:59:59Z").');

/** Parse: validates the string is a strict ISO 8601 date or datetime. */
export const parseIsoDatetime = safeString.pipe(z.string().trim().min(1))
  .refine(
    (s) => {
      const isoRegex = /^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      if (!isoRegex.test(s) || Number.isNaN(Date.parse(s))) {
        return false;
      }
      const offset = s.match(/([+-])(\d{2}):?(\d{2})$/);
      if (!offset) {
        return true;
      }
      const sign = offset[1] === '+' ? 1 : -1;
      const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3]));
      return minutes >= -720 && minutes <= 840;
    },
    'Must be a valid ISO 8601 datetime with a real-world UTC offset',
  );

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export const parseFutureIsoDatetime = parseIsoDatetime
  .refine((s) => Date.parse(s) > Date.now(), 'Must be in the future')
  .refine((s) => Date.parse(s) <= Date.now() + FIVE_YEARS_MS, 'Must be within 5 years')
  .nullable()
  .optional();

/** Wire: message text with a bounded max length */
export const wireMessageText = z.string().max(LARGE_TEXT_MAX_CHARS)
  .describe(`Required, max ${LARGE_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Server trims whitespace; whitespace-only strings are rejected.`);

/** Parse: message text, trimmed, max 20 000 characters */
export const parseMessageText = safeString.pipe(z.string().trim().min(1).max(LARGE_TEXT_MAX_CHARS));

/** Wire: string capped at 500 characters. Server trims whitespace. */
export const wireBoundedString = z.string().max(500)
  .describe('Required, max 500 characters. Server trims whitespace; whitespace-only strings are rejected.');

/** Parse: string capped at 500 characters, trimmed */
export const parseBoundedString = safeString.pipe(z.string().trim().min(1).max(500));

/** Wire: string capped at 500 characters; empty is allowed after server trimming. */
export const wireOptionalEmptyBoundedString = z.string().max(500)
  .describe(APPLICATION_SOCIALS_DESCRIPTION);

/** Parse: string capped at 500 characters, trimmed, with empty preserved as "" */
export const parseOptionalEmptyBoundedString = safeString.pipe(z.string().trim().max(500));

/** Wire: application text capped at 20 000 characters. Server trims whitespace. */
export const wireApplicationText = z.string().max(LARGE_TEXT_MAX_CHARS)
  .describe(`Required, max ${LARGE_TEXT_MAX_CHARS.toLocaleString('en-GB')} characters. Server trims whitespace; whitespace-only strings are rejected.`);

/** Parse: application text capped at 20 000 characters, trimmed */
export const parseApplicationText = safeString.pipe(z.string().trim().min(1).max(LARGE_TEXT_MAX_CHARS));

/** Wire: optional JSON object */
export const wireOptionalRecord = z.record(z.string(), z.unknown()).optional()
  .describe(`Optional JSON object. Defaults to {} if omitted. Max ${MAX_RECORD_KEYS} keys and ${MAX_RECORD_BYTES.toLocaleString('en-GB')} UTF-8 bytes.`);

/** Parse: optional JSON object, defaults to {} */
export const parseOptionalRecord = z.record(z.string(), z.unknown())
  .optional()
  .default({})
  .refine(
    (value) => Object.keys(value).length <= MAX_RECORD_KEYS,
    `Record may not exceed ${MAX_RECORD_KEYS} keys`,
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RECORD_BYTES,
    `Record serialized length must be ≤ ${MAX_RECORD_BYTES} bytes`,
  );

/** Shared typed club-profile link shape for wire/docs and responses */
export const safeHttpUrl = z.string().trim().url().max(500)
  .refine(hasHttpUrlScheme, 'Must use an http or https URL');

/** Shared typed club-profile link shape for wire/docs and responses */
export const profileLink = z.object({
  url: safeHttpUrl,
  label: z.string().max(100).nullable(),
}).strict();
export type ClubProfileLink = z.infer<typeof profileLink>;

/** Parse: trims URL/label and normalizes empty label to null */
export const parseProfileLink = z.object({
  url: safeString.pipe(safeHttpUrl),
  label: safeString.pipe(z.string().trim().max(100))
    .transform(value => value === '' ? null : value)
    .nullable(),
}).strict();

/**
 * Wire: full name (at least two words).
 * Server trims whitespace and normalizes internal whitespace.
 */
export const wireFullName = z.string().max(500)
  .describe('Full name (first and last name required, max 500 chars). Server trims whitespace.');

/**
 * Parse: normalizes whitespace, validates at least two words.
 * Matches normalizeCandidateFullName() behavior.
 */
export const parseFullName = safeString.pipe(z.string().trim().min(1).max(500))
  .transform(s => s.split(/\s+/).filter(Boolean).join(' '))
  .refine(
    s => s.split(' ').length >= 2,
    'Must be a full name (first and last name)',
  );

export const wirePublicName = z.string().max(120)
  .describe('Public display name, max 120 chars. Server trims whitespace; whitespace-only strings are rejected.');

export const parsePublicName = safeString.pipe(z.string().trim().min(1).max(120));

/**
 * Wire: email address.
 * Server trims, lowercases, and validates address shape.
 */
export const wireEmail = z.string().max(500)
  .describe('Email address (must look like name@example.com, max 500 chars). Server trims and lowercases.');

/**
 * Parse: lowercases, validates address shape.
 * Matches normalizeCandidateEmail() behavior.
 */
export const parseEmail = safeString.pipe(z.string().trim().min(1).max(500))
  .transform(normalizeEmail)
  .refine(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), 'Must look like an email address');

/**
 * Wire: content kinds array filter
 */
export const wireContentKinds = boundedArray(contentKind, { minItems: 1, maxItems: 6 }).optional()
  .describe('Filter by content kind. Defaults to all kinds.');

/**
 * Parse: defaults to all kinds, deduplicates.
 */
export const parseContentKinds = boundedArray(contentKind, { minItems: 1, maxItems: 6 })
  .optional()
  .default(['post', 'opportunity', 'service', 'ask', 'gift', 'event'])
  .transform(kinds => [...new Set(kinds)]);

/**
 * Wire: membership states array filter
 */
export const wireMembershipStates = boundedArray(membershipState, { minItems: 1, maxItems: 4 }).optional();

/**
 * Parse: deduplicates.
 */
export const parseMembershipStates = (defaultStates: MembershipState[]) =>
  boundedArray(membershipState, { minItems: 1, maxItems: 4 })
    .optional()
    .default(defaultStates)
    .transform(states => [...new Set(states)]);

/**
 * Wire: optional positive integer (nullable)
 */
export const wireOptionalPositiveInt = z.number().int().min(1).nullable().optional()
  .describe('Optional positive integer. Null to clear.');

/**
 * Parse: validates positive integer if present
 */
export const parseOptionalPositiveInt = z.number().int().min(1).nullable().optional();

/** Wire: event fields for content.create(kind='event') */
export const wireEventFieldsCreate = z.object({
  location: wireHumanRequiredString.describe('Event location'),
  startsAt: wireIsoDatetime.describe('ISO 8601 event start time'),
  endsAt: wireIsoDatetime.nullable().optional().describe('ISO 8601 event end time'),
  timezone: wireOptionalString.describe('IANA timezone (optional)'),
  recurrenceRule: wireOptionalString.describe('Recurrence rule (optional)'),
  capacity: wireOptionalPositiveInt.describe('Optional attendee cap'),
}).strict().optional();

/** Parse: normalized event fields for content.create(kind='event') */
export const parseEventFieldsCreate = z.object({
  location: parseHumanRequiredString,
  startsAt: parseIsoDatetime,
  endsAt: parseIsoDatetime.nullable().optional().default(null),
  timezone: parseTrimmedNullableString.default(null),
  recurrenceRule: parseTrimmedNullableString.default(null),
  capacity: parseOptionalPositiveInt.default(null),
}).strict().optional();

/** Wire: patch event fields for content.update */
export const wireEventFieldsPatch = z.object({
  location: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  startsAt: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  endsAt: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  timezone: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  recurrenceRule: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  capacity: wireOptionalPositiveInt.describe('Optional attendee cap. Null to clear.'),
}).strict().optional();

/** Parse: normalized patch event fields for content.update */
export const parseEventFieldsPatch = z.object({
  location: parsePatchString,
  startsAt: parsePatchString,
  endsAt: parsePatchString,
  timezone: parsePatchString,
  recurrenceRule: parsePatchString,
  capacity: parseOptionalPositiveInt,
}).strict().optional();

/**
 * Wire: optional non-negative money amount
 */
export const wireMoneyAmount = z.number().min(0).nullable().optional()
  .describe('Non-negative amount or null.');

/** Parse: same validation */
export const parseMoneyAmount = z.number().min(0).nullable().optional();

/**
 * Wire: 3-letter ISO currency code. Server uppercases before validating.
 */
export const wireCurrencyCode = z.string().nullable().optional()
  .describe('3-letter ISO currency code (e.g. "USD" or "usd"). Server uppercases. Null to clear.');

/**
 * Parse: uppercases and validates
 */
export const parseCurrencyCode = safeString.pipe(z.string().trim())
  .transform(s => s.toUpperCase())
  .refine(s => /^[A-Z]{3}$/.test(s), 'Must be a 3-letter ISO currency code')
  .nullable()
  .optional();

/**
 * Wire: boolean flag
 */
export const wireOptionalBoolean = z.boolean().optional()
  .describe('Optional boolean flag.');

/**
 * Wire: slug format.
 * Server trims and validates format after trimming.
 */
export const wireSlug = z.string()
  .max(63)
  .describe('URL-safe slug (lowercase alphanumeric with hyphens). Server trims and validates format.');

/** Parse: validates slug format */
export const parseSlug = safeString.pipe(z.string().trim().max(63))
  .refine(
    s => SLUG_REGEX.test(s),
    'slug must use lowercase letters, numbers, and single hyphens',
  );

// ── Nested object builders ───────────────────────────────

/** Wire: update IDs array */
export const wireUpdateIds = boundedArray(z.string().min(1), { minItems: 1, maxItems: 100 })
  .describe('Non-empty array of update IDs.');

/** Parse: deduplicates */
export const parseUpdateIds = boundedArray(safeString.pipe(z.string().trim().min(1)), { minItems: 1, maxItems: 100 })
  .transform(ids => [...new Set(ids)]);
