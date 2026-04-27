import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomCrockfordString } from './crockford.ts';
import { getConfig } from './config/index.ts';
import { logger } from './logger.ts';
import { toIsoFromMillis } from './timestamps.ts';

const POW_CHALLENGE_ID_LENGTH = 20;
const INVITE_CODE_MAC_CONTEXT = 'registration-invite-code:';
const INVITE_CODE_MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_CODE_MAC_BYTES = 32;
const BOUND_INVITE_EMAIL_MAX_CHARS = 500;

type PowChallengePayload = {
  v: 1;
  id: string;
  clubId: string;
  difficulty: number;
  expiresAt: number;
  inviteCodeMac?: string;
  email?: string;
};

let devFallbackPowKey: Buffer | null = null;
let loggedDevFallbackWarning = false;

function getPositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function getRuntimePowKeys(): { active: Buffer; previous: Buffer | null } {
  const activeRaw = process.env.CLAWCLUB_POW_HMAC_KEY?.trim();
  const previousRaw = process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS?.trim();

  if (activeRaw && activeRaw.length > 0) {
    return {
      active: Buffer.from(activeRaw, 'utf8'),
      previous: previousRaw && previousRaw.length > 0 ? Buffer.from(previousRaw, 'utf8') : null,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('CLAWCLUB_POW_HMAC_KEY is required in production');
  }

  if (!devFallbackPowKey) {
    devFallbackPowKey = randomBytes(32);
  }
  if (!loggedDevFallbackWarning) {
    loggedDevFallbackWarning = true;
    logger.warn('pow_challenge_fallback_key', {
      message: 'CLAWCLUB_POW_HMAC_KEY is not set; using a per-process fallback key for non-production PoW challenge signing.',
    });
  }
  return { active: devFallbackPowKey, previous: null };
}

function randomChallengePart(length: number): string {
  return randomCrockfordString(length);
}

function signChallengePayload(rawPayload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(rawPayload, 'utf8').digest();
}

function computeInviteCodeMacBytes(normalizedCode: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(`${INVITE_CODE_MAC_CONTEXT}${normalizedCode}`, 'utf8').digest();
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString('base64url') : Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function parseChallengePayload(rawPayload: string): PowChallengePayload | null {
  try {
    const parsed = JSON.parse(rawPayload) as Partial<PowChallengePayload>;
    const difficulty = parsed.difficulty;
    const expiresAt = parsed.expiresAt;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
    if (typeof parsed.clubId !== 'string' || parsed.clubId.length === 0) return null;
    if (typeof difficulty !== 'number' || !Number.isInteger(difficulty) || difficulty < 1) return null;
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < 1) return null;
    const hasInviteCodeMac = parsed.inviteCodeMac !== undefined;
    const hasEmail = parsed.email !== undefined;
    if (hasInviteCodeMac !== hasEmail) return null;
    if (hasInviteCodeMac) {
      if (typeof parsed.inviteCodeMac !== 'string' || !INVITE_CODE_MAC_PATTERN.test(parsed.inviteCodeMac)) return null;
      if (
        typeof parsed.email !== 'string'
        || parsed.email.length === 0
        || parsed.email.length > BOUND_INVITE_EMAIL_MAX_CHARS
      ) return null;
    }
    return {
      v: 1,
      id: parsed.id,
      clubId: parsed.clubId,
      difficulty,
      expiresAt,
      ...(hasInviteCodeMac ? { inviteCodeMac: parsed.inviteCodeMac, email: parsed.email } : {}),
    };
  } catch {
    return null;
  }
}

export function getColdApplicationDifficulty(): number {
  return getPositiveIntegerEnv('CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY') ?? getConfig().policy.pow.registrationDifficulty;
}

export function getInvitedRegistrationDifficulty(): number {
  return getPositiveIntegerEnv('CLAWCLUB_TEST_INVITED_REGISTRATION_DIFFICULTY') ?? getConfig().policy.pow.invitedRegistrationDifficulty;
}

export function getPowChallengeTtlMs(): number {
  return getConfig().policy.pow.challengeTtlMs;
}

export function ensurePowChallengeConfig(): void {
  getRuntimePowKeys();
}

export function computeInviteCodeMac(normalizedCode: string): string {
  const { active } = getRuntimePowKeys();
  return encodeBase64Url(computeInviteCodeMacBytes(normalizedCode, active));
}

export function verifyInviteCodeMac(normalizedCode: string, inviteCodeMac: string): boolean {
  if (!INVITE_CODE_MAC_PATTERN.test(inviteCodeMac)) {
    return false;
  }

  let supplied: Buffer;
  try {
    supplied = decodeBase64Url(inviteCodeMac);
  } catch {
    return false;
  }
  if (supplied.length !== INVITE_CODE_MAC_BYTES) {
    return false;
  }

  const { active, previous } = getRuntimePowKeys();
  const candidates = [active, previous].filter((key): key is Buffer => key !== null);
  return candidates.some((key) => {
    const expected = computeInviteCodeMacBytes(normalizedCode, key);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
}

export function issuePowChallenge(input: {
  clubId: string;
  difficulty?: number;
  nowMs?: number;
  inviteCodeMac?: string;
  email?: string;
}): {
  challengeBlob: string;
  challengeId: string;
  hashInput: '${challengeId}:${nonce}';
  hashDigest: 'sha256-hex';
  successCondition: 'trailing_hex_zeroes';
  difficultyUnit: 'hex_nibbles';
  difficulty: number;
  expiresAt: string;
} {
  const { active } = getRuntimePowKeys();
  const difficulty = input.difficulty ?? getColdApplicationDifficulty();
  const challengeId = randomChallengePart(POW_CHALLENGE_ID_LENGTH);
  const expiresAtMs = (input.nowMs ?? Date.now()) + getPowChallengeTtlMs();
  const hasInviteBinding = input.inviteCodeMac !== undefined || input.email !== undefined;
  if (hasInviteBinding && (!input.inviteCodeMac || !input.email)) {
    throw new Error('inviteCodeMac and email must be supplied together');
  }
  const payload: PowChallengePayload = {
    v: 1,
    id: challengeId,
    clubId: input.clubId,
    difficulty,
    expiresAt: expiresAtMs,
    ...(hasInviteBinding ? { inviteCodeMac: input.inviteCodeMac, email: input.email } : {}),
  };
  const rawPayload = JSON.stringify(payload);
  const signature = signChallengePayload(rawPayload, active);
  return {
    challengeBlob: `${encodeBase64Url(rawPayload)}.${encodeBase64Url(signature)}`,
    challengeId,
    hashInput: '${challengeId}:${nonce}',
    hashDigest: 'sha256-hex',
    successCondition: 'trailing_hex_zeroes',
    difficultyUnit: 'hex_nibbles',
    difficulty,
    expiresAt: toIsoFromMillis(expiresAtMs),
  };
}

export function verifyPowChallenge(input: {
  challengeBlob: string;
  expectedClubId: string;
  nowMs?: number;
}): { ok: true; payload: PowChallengePayload } | { ok: false; reason: 'invalid' | 'expired' } {
  const separator = input.challengeBlob.indexOf('.');
  if (separator <= 0 || separator >= input.challengeBlob.length - 1) {
    return { ok: false, reason: 'invalid' };
  }

  const payloadPart = input.challengeBlob.slice(0, separator);
  const signaturePart = input.challengeBlob.slice(separator + 1);

  let rawPayload: string;
  let signature: Buffer;
  try {
    rawPayload = decodeBase64Url(payloadPart).toString('utf8');
    signature = decodeBase64Url(signaturePart);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const payload = parseChallengePayload(rawPayload);
  if (!payload || payload.clubId !== input.expectedClubId) {
    return { ok: false, reason: 'invalid' };
  }

  const { active, previous } = getRuntimePowKeys();
  const candidates = [active, previous].filter((key): key is Buffer => key !== null);
  const signatureValid = candidates.some((key) => {
    const expected = signChallengePayload(rawPayload, key);
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  });
  if (!signatureValid) {
    return { ok: false, reason: 'invalid' };
  }
  if (payload.expiresAt <= (input.nowMs ?? Date.now())) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

export function validatePowSolution(challengeId: string, nonce: string, difficulty: number): boolean {
  const hash = createHash('sha256').update(`${challengeId}:${nonce}`, 'utf8').digest('hex');
  return hash.endsWith('0'.repeat(difficulty));
}
