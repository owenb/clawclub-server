import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  computeInviteCodeMac,
  issuePowChallenge,
  validatePowSolution,
  verifyInviteCodeMac,
  verifyPowChallenge,
} from '../../src/pow-challenge.ts';

function findNonce(challengeId: string, difficulty: number, mode: 'trailing' | 'leading_only'): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 200_000; nonce++) {
    const hash = createHash('sha256').update(`${challengeId}:${nonce}`, 'utf8').digest('hex');
    if (mode === 'trailing' && hash.endsWith(zeros)) {
      return String(nonce);
    }
    if (mode === 'leading_only' && hash.startsWith(zeros) && !hash.endsWith(zeros)) {
      return String(nonce);
    }
  }
  throw new Error(`failed to find ${mode} nonce for difficulty ${difficulty}`);
}

function withPowKeys<T>(active: string, previous: string | undefined, fn: () => T): T {
  const priorActive = process.env.CLAWCLUB_POW_HMAC_KEY;
  const priorPrevious = process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS;
  process.env.CLAWCLUB_POW_HMAC_KEY = active;
  if (previous === undefined) {
    delete process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS;
  } else {
    process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS = previous;
  }
  try {
    return fn();
  } finally {
    if (priorActive === undefined) {
      delete process.env.CLAWCLUB_POW_HMAC_KEY;
    } else {
      process.env.CLAWCLUB_POW_HMAC_KEY = priorActive;
    }
    if (priorPrevious === undefined) {
      delete process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS;
    } else {
      process.env.CLAWCLUB_POW_HMAC_KEY_PREVIOUS = priorPrevious;
    }
  }
}

function decodeChallengePayload(challengeBlob: string): Record<string, unknown> {
  const [payloadPart] = challengeBlob.split('.');
  assert.ok(payloadPart);
  return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function tamperChallengePayload(challengeBlob: string, patch: Record<string, unknown>): string {
  const [payloadPart, signaturePart] = challengeBlob.split('.');
  assert.ok(payloadPart);
  assert.ok(signaturePart);
  const payload = decodeChallengePayload(challengeBlob);
  return `${Buffer.from(JSON.stringify({ ...payload, ...patch }), 'utf8').toString('base64url')}.${signaturePart}`;
}

test('validatePowSolution accepts canonical trailing-zero proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'trailing');

  assert.equal(validatePowSolution(challengeId, nonce, 3), true);
});

test('validatePowSolution rejects leading-zero compatibility proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'leading_only');

  assert.equal(validatePowSolution(challengeId, nonce, 3), false);
});

test('validatePowSolution rejects non-matching proofs', () => {
  assert.equal(validatePowSolution('6t3kves5zeqg', 'not-a-hit', 3), false);
});

test('issuePowChallenge omits invite binding from cold registration payloads', () => withPowKeys('pow-active', undefined, () => {
  const challenge = issuePowChallenge({
    clubId: '__account_register__',
    difficulty: 2,
    nowMs: 1_000,
  });
  const payload = decodeChallengePayload(challenge.challengeBlob);

  assert.equal('inviteCodeMac' in payload, false);
  assert.equal('email' in payload, false);
  const verified = verifyPowChallenge({
    challengeBlob: challenge.challengeBlob,
    expectedClubId: '__account_register__',
    nowMs: 1_001,
  });
  assert.equal(verified.ok, true);
}));

test('issuePowChallenge round-trips invite MAC and normalized email without storing the raw code', () => withPowKeys('pow-active', undefined, () => {
  const inviteCodeMac = computeInviteCodeMac('ABCD-2345');
  const challenge = issuePowChallenge({
    clubId: '__account_register__',
    difficulty: 2,
    nowMs: 1_000,
    inviteCodeMac,
    email: 'candidate@example.com',
  });
  const payload = decodeChallengePayload(challenge.challengeBlob);

  assert.equal(payload.inviteCodeMac, inviteCodeMac);
  assert.equal(payload.email, 'candidate@example.com');
  assert.equal(JSON.stringify(payload).includes('ABCD-2345'), false);
  const verified = verifyPowChallenge({
    challengeBlob: challenge.challengeBlob,
    expectedClubId: '__account_register__',
    nowMs: 1_001,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.inviteCodeMac, inviteCodeMac);
    assert.equal(verified.payload.email, 'candidate@example.com');
  }
}));

test('verifyInviteCodeMac accepts active and previous runtime keys only', () => {
  const previousMac = withPowKeys('pow-previous', undefined, () => computeInviteCodeMac('ABCD-2345'));

  withPowKeys('pow-active', 'pow-previous', () => {
    assert.equal(verifyInviteCodeMac('ABCD-2345', previousMac), true);
    assert.equal(verifyInviteCodeMac('WXYZ-9876', previousMac), false);
  });

  withPowKeys('pow-active', undefined, () => {
    assert.equal(verifyInviteCodeMac('ABCD-2345', previousMac), false);
  });
});

test('verifyPowChallenge rejects invite MAC tampering through the challenge signature', () => withPowKeys('pow-active', undefined, () => {
  const challenge = issuePowChallenge({
    clubId: '__account_register__',
    difficulty: 2,
    nowMs: 1_000,
    inviteCodeMac: computeInviteCodeMac('ABCD-2345'),
    email: 'candidate@example.com',
  });
  const tampered = tamperChallengePayload(challenge.challengeBlob, {
    inviteCodeMac: 'A'.repeat(43),
  });

  const verified = verifyPowChallenge({
    challengeBlob: tampered,
    expectedClubId: '__account_register__',
    nowMs: 1_001,
  });
  assert.deepEqual(verified, { ok: false, reason: 'invalid' });
}));
