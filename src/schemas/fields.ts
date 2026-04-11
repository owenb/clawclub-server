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

// ── Enums ────────────────────────────────────────────────

export const entityKind = z.enum(['post', 'opportunity', 'service', 'ask', 'gift', 'event']);
export type EntityKind = z.infer<typeof entityKind>;

export const entityState = z.enum(['draft', 'published', 'removed']);
export type EntityState = z.infer<typeof entityState>;

export const membershipState = z.enum([
  'invited', 'pending_review', 'active',
  'paused', 'revoked', 'rejected',
  'payment_pending', 'renewal_pending', 'cancelled', 'banned', 'expired',
]);
export type MembershipState = z.infer<typeof membershipState>;

export const admissionStatus = z.enum([
  'draft', 'submitted', 'interview_scheduled',
  'interview_completed', 'accepted', 'declined', 'withdrawn',
]);
export type AdmissionStatus = z.infer<typeof admissionStatus>;

export const eventRsvpState = z.enum(['yes', 'maybe', 'no', 'waitlist']);
export type EventRsvpState = z.infer<typeof eventRsvpState>;

export const membershipRole = z.enum(['clubadmin', 'member']);
export type MembershipRole = z.infer<typeof membershipRole>;

export const membershipCreateRole = z.enum(['clubadmin', 'member']);

export const membershipCreateInitialStatus = z.enum(['invited', 'pending_review', 'active', 'payment_pending']);

export const intakeKind = z.enum(['fit_check', 'advice_call', 'other']);

export const updateReceiptState = z.enum(['processed', 'suppressed']);
export type UpdateReceiptState = z.infer<typeof updateReceiptState>;

export const messageRole = z.enum(['member', 'agent', 'system']);

export const admissionOrigin = z.enum(['self_applied', 'member_sponsored', 'owner_nominated']);

// ── Shared transforms ───────────────────────────────────

/** Strip null bytes that Postgres rejects with "invalid byte sequence for encoding UTF8: 0x00" */
function stripNullBytes(s: string): string {
  return s.replace(/\0/g, '');
}

/** Zod string base with null bytes stripped. Use as the starting point for all parse string schemas. */
const safeString = z.string().transform(stripNullBytes);

// ── Scalar field builders ────────────────────────────────

/**
 * Wire: limit is an optional integer.
 * The server clamps to 1–20 and defaults to 8.
 * Wire schema accepts any integer to match actual acceptance behavior.
 */
export const wireLimit = z.number().int().optional()
  .describe('Max results (default 8). Clamped to 1–20 by the server.');

/**
 * Parse: clamps to 1–20, defaults to 8.
 * Matches current normalizeLimit() behavior.
 */
export const parseLimit = z.number().int()
  .optional()
  .default(8)
  .transform(n => Math.min(Math.max(n, 1), 20));

/** Wire: non-negative integer offset for pagination */
export const wireOffset = z.number().int().min(0).optional()
  .describe('Pagination offset (default 0).');

/** Parse: defaults to 0 */
export const parseOffset = z.number().int().min(0).optional().default(0);

/** Wire: opaque pagination cursor from previous response */
export const wireCursor = z.string().nullable().optional()
  .describe('Opaque pagination cursor from previous response. Omit or null for first page.');

/** Parse: trims, nullable, defaults to null */
export const parseCursor = z.string().trim().min(1).nullable().optional().default(null);

// ── Shared cursor encode/decode ─────────────────────────────

import { AppError } from '../contract.ts';

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
    throw new AppError(400, 'invalid_input', 'Invalid pagination cursor');
  }
}

/**
 * Build a wire limit schema with a custom max.
 */
export function wireLimitOf(max: number) {
  return z.number().int().optional()
    .describe(`Max results. Clamped to 1–${max} by the server.`);
}

/**
 * Build a parse limit schema with custom default and max.
 */
export function parseLimitOf(defaultVal: number, max: number) {
  return z.number().int().optional()
    .default(defaultVal)
    .transform((n: number) => Math.min(Math.max(n, 1), max));
}

/**
 * Wire: optional string that may be null.
 * Empty strings are treated as null by the server.
 */
export const wireOptionalString = z.string().max(250_000).nullable().optional()
  .describe('Optional, max 250 000 characters. Empty strings are treated as null.');

/**
 * Parse: trims whitespace; empty string → null.
 * Preserves undefined (omitted) vs null (explicit clear) vs string (set).
 */
export const parseTrimmedNullableString = safeString.pipe(z.string().max(250_000).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/**
 * Wire: patch field (for update/patch actions).
 * Same as wireOptionalString — the three-state semantics are documented.
 */
export const wirePatchString = z.string().max(250_000).nullable().optional()
  .describe('Omit to leave unchanged, null to clear, string to set. Max 250 000 characters. Empty strings treated as null.');

/**
 * Parse: patch field preserving three-state: undefined (omit), null (clear), string (set).
 * Does NOT default — preserving undefined is critical for patch semantics.
 */
export const parsePatchString = safeString.pipe(z.string().max(250_000).trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional();

/** Wire: required string. Server trims whitespace and rejects empty results. */
export const wireRequiredString = z.string()
  .describe('Required. Server trims whitespace; whitespace-only strings are rejected.');

/** Parse: required non-empty string, trimmed */
export const parseRequiredString = safeString.pipe(z.string().trim().min(1));

/** Wire: ISO 8601 date or datetime string for billing/subscription fields. */
export const wireIsoDatetime = z.string()
  .describe('ISO 8601 date or datetime (e.g. "2025-12-31" or "2025-12-31T23:59:59Z").');

/** Parse: validates the string is a strict ISO 8601 date or datetime. */
export const parseIsoDatetime = safeString.pipe(z.string().trim().min(1))
  .refine(
    s => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !isNaN(Date.parse(s)),
    'Must be a valid ISO 8601 date or datetime (e.g. "2025-12-31" or "2025-12-31T23:59:59Z")',
  );

/** Wire: message text with a bounded max length */
export const wireMessageText = z.string().max(250_000)
  .describe('Required, max 250 000 characters. Server trims whitespace; whitespace-only strings are rejected.');

/** Parse: message text, trimmed, max 250 000 characters */
export const parseMessageText = safeString.pipe(z.string().trim().min(1).max(250_000));

/** Wire: string capped at 500 characters. Server trims whitespace. */
export const wireBoundedString = z.string().max(500)
  .describe('Required, max 500 characters. Server trims whitespace; whitespace-only strings are rejected.');

/** Parse: string capped at 500 characters, trimmed */
export const parseBoundedString = safeString.pipe(z.string().trim().min(1).max(500));

/** Wire: application text capped at 4000 characters. Server trims whitespace. */
export const wireApplicationText = z.string().max(4000)
  .describe('Required, max 4000 characters. Server trims whitespace; whitespace-only strings are rejected.');

/** Parse: application text capped at 4000 characters, trimmed */
export const parseApplicationText = safeString.pipe(z.string().trim().min(1).max(4000));

/** Wire: optional JSON object */
export const wireOptionalRecord = z.record(z.string(), z.unknown()).optional()
  .describe('Optional JSON object. Defaults to {} if omitted.');

/** Parse: optional JSON object, defaults to {} */
export const parseOptionalRecord = z.record(z.string(), z.unknown()).optional().default({});

/** Wire: required JSON object */
export const wireRequiredRecord = z.record(z.string(), z.unknown());

/**
 * Wire: handle format (lowercase alphanumeric with single hyphens).
 * Server trims whitespace and normalizes empty string to null.
 * After normalization, non-null values must match /^[a-z0-9]+(-[a-z0-9]+)*$/.
 */
export const wireHandle = z.string().nullable().optional()
  .describe('Lowercase alphanumeric with hyphens. Omit to leave unchanged, null or empty to clear. Server trims and validates format.');

/** Parse: validates handle format */
export const parseHandle = safeString.pipe(z.string().trim())
  .transform(s => s === '' ? null : s)
  .nullable()
  .optional()
  .refine(
    val => val === undefined || val === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(val),
    'handle must use lowercase letters, numbers, and single hyphens',
  );

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

/**
 * Wire: email address.
 * Server trims, lowercases, and validates contains @.
 */
export const wireEmail = z.string().max(500)
  .describe('Email address (must contain @, max 500 chars). Server trims and lowercases.');

/**
 * Parse: lowercases, validates contains @.
 * Matches normalizeCandidateEmail() behavior.
 */
export const parseEmail = safeString.pipe(z.string().trim().min(1).max(500))
  .transform(s => s.toLowerCase())
  .refine(s => s.includes('@'), 'Must look like an email address');

/**
 * Wire: entity kinds array filter
 */
export const wireEntityKinds = z.array(entityKind).min(1).optional()
  .describe('Filter by entity kind. Defaults to all kinds.');

/**
 * Parse: defaults to all kinds, deduplicates.
 */
export const parseEntityKinds = z.array(entityKind).min(1)
  .optional()
  .default(['post', 'opportunity', 'service', 'ask', 'gift', 'event'])
  .transform(kinds => [...new Set(kinds)]);

/**
 * Wire: membership states array filter
 */
export const wireMembershipStates = z.array(membershipState).min(1).optional();

/**
 * Parse: deduplicates.
 */
export const parseMembershipStates = (defaultStates: MembershipState[]) =>
  z.array(membershipState).min(1)
    .optional()
    .default(defaultStates)
    .transform(states => [...new Set(states)]);

/**
 * Wire: admission statuses array filter
 */
export const wireAdmissionStatuses = z.array(admissionStatus).min(1).optional();

/**
 * Parse: deduplicates. No default — undefined means "no filter".
 */
export const parseAdmissionStatuses = z.array(admissionStatus).min(1)
  .transform(statuses => [...new Set(statuses)])
  .optional();

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
  location: wireRequiredString.describe('Event location'),
  startsAt: wireRequiredString.describe('ISO 8601 event start time'),
  endsAt: wireOptionalString.describe('ISO 8601 event end time'),
  timezone: wireOptionalString.describe('IANA timezone (optional)'),
  recurrenceRule: wireOptionalString.describe('Recurrence rule (optional)'),
  capacity: wireOptionalPositiveInt.describe('Optional attendee cap'),
}).optional();

/** Parse: normalized event fields for content.create(kind='event') */
export const parseEventFieldsCreate = z.object({
  location: parseRequiredString,
  startsAt: parseRequiredString,
  endsAt: parseTrimmedNullableString.default(null),
  timezone: parseTrimmedNullableString.default(null),
  recurrenceRule: parseTrimmedNullableString.default(null),
  capacity: parseOptionalPositiveInt.default(null),
}).optional();

/** Wire: patch event fields for content.update */
export const wireEventFieldsPatch = z.object({
  location: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  startsAt: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  endsAt: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  timezone: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  recurrenceRule: wirePatchString.describe('Omit to leave unchanged, null to clear'),
  capacity: wireOptionalPositiveInt.describe('Optional attendee cap. Null to clear.'),
}).optional();

/** Parse: normalized patch event fields for content.update */
export const parseEventFieldsPatch = z.object({
  location: parsePatchString,
  startsAt: parsePatchString,
  endsAt: parsePatchString,
  timezone: parsePatchString,
  recurrenceRule: parsePatchString,
  capacity: parseOptionalPositiveInt,
}).optional();

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
 * Wire: slug format (same as handle).
 * Server trims and validates format after trimming.
 */
export const wireSlug = z.string()
  .describe('URL-safe slug (lowercase alphanumeric with hyphens). Server trims and validates format.');

/** Parse: validates slug format */
export const parseSlug = safeString.pipe(z.string().trim())
  .refine(
    s => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s),
    'slug must use lowercase letters, numbers, and single hyphens',
  );

// ── Nested object builders ───────────────────────────────

/** Wire: admission intake object */
export const wireIntake = z.object({
  kind: intakeKind.optional(),
  price: z.object({
    amount: wireMoneyAmount,
    currency: wireCurrencyCode,
  }).optional(),
  bookingUrl: wireOptionalString,
  bookedAt: wireOptionalString,
  completedAt: wireOptionalString,
}).optional().describe('Intake details. All fields optional.');

/** Parse: admission intake normalization */
export const parseIntake = z.object({
  kind: intakeKind.optional(),
  price: z.object({
    amount: parseMoneyAmount,
    currency: parseCurrencyCode,
  }).optional(),
  bookingUrl: parseTrimmedNullableString,
  bookedAt: parseTrimmedNullableString,
  completedAt: parseTrimmedNullableString,
}).optional();

/** Wire: update IDs array */
export const wireUpdateIds = z.array(z.string().min(1)).min(1)
  .describe('Non-empty array of update IDs.');

/** Parse: deduplicates */
export const parseUpdateIds = z.array(safeString.pipe(z.string().trim().min(1))).min(1)
  .transform(ids => [...new Set(ids)]);

/** Wire: links array for profile */
export const wireLinks = z.array(z.unknown()).optional()
  .describe('Array of link objects.');

/** Wire: profile freeform object */
export const wireProfileObject = z.record(z.string(), z.unknown()).optional()
  .describe('Freeform profile metadata.');
