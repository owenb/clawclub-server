import { createHash } from 'node:crypto';
import { randomCrockfordString } from './crockford.ts';

const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOKEN_ID_LENGTH = 12;
const TOKEN_SECRET_LENGTH = 24;
const INVITATION_CODE_LENGTH = 8;
const INVITATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const TOKEN_PREFIX = 'clawclub';
const LEGACY_BEARER_TOKEN_PREFIXES = ['cc_live'] as const;
const TOKEN_ID_PATTERN = `[${TOKEN_ALPHABET}]{${TOKEN_ID_LENGTH}}`;
const TOKEN_SECRET_PATTERN = `[${TOKEN_ALPHABET}]{${TOKEN_SECRET_LENGTH}}`;
const TOKEN_BODY_PATTERN = new RegExp(`^(${TOKEN_ID_PATTERN})_(${TOKEN_SECRET_PATTERN})$`);
const INVITATION_CODE_PATTERN = /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/;

function randomTokenPart(length: number): string {
  return randomCrockfordString(length);
}

export function generateTokenId(): string {
  return randomTokenPart(TOKEN_ID_LENGTH);
}

export function generateTokenSecret(): string {
  return randomTokenPart(TOKEN_SECRET_LENGTH);
}

export function buildBearerToken(parts?: { tokenId?: string; secret?: string }): {
  tokenId: string;
  secret: string;
  bearerToken: string;
  tokenHash: string;
} {
  const tokenId = parts?.tokenId ?? generateTokenId();
  const secret = parts?.secret ?? generateTokenSecret();
  const bearerToken = `${TOKEN_PREFIX}_${tokenId}_${secret}`;

  return {
    tokenId,
    secret,
    bearerToken,
    tokenHash: hashTokenSecret(secret),
  };
}

export function buildInvitationCode(): string {
  let raw = '';

  while (raw.length < INVITATION_CODE_LENGTH) {
    const candidate = randomCrockfordString(1).toUpperCase();
    if (INVITATION_CODE_ALPHABET.includes(candidate)) {
      raw += candidate;
    }
  }

  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function parsePrefixedToken(value: string, prefixes: readonly string[]): { tokenId: string; secret: string } | null {
  const trimmed = value.trim();

  for (const prefix of prefixes) {
    const prefixWithSeparator = `${prefix}_`;
    if (!trimmed.startsWith(prefixWithSeparator)) {
      continue;
    }
    const match = trimmed.slice(prefixWithSeparator.length).match(TOKEN_BODY_PATTERN);
    if (!match) {
      return null;
    }
    return {
      tokenId: match[1]!,
      secret: match[2]!,
    };
  }

  return null;
}

export function parseBearerToken(value: string): { tokenId: string; secret: string } | null {
  return parsePrefixedToken(value, [TOKEN_PREFIX, ...LEGACY_BEARER_TOKEN_PREFIXES]);
}

export function normalizeInvitationCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return INVITATION_CODE_PATTERN.test(normalized) ? normalized : null;
}
