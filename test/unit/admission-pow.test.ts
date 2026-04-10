import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateAdmissionPow } from '../../src/clubs/admissions.ts';

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

test('validateAdmissionPow accepts canonical trailing-zero proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'trailing');

  assert.equal(validateAdmissionPow(challengeId, nonce, 3), 'canonical_trailing');
});

test('validateAdmissionPow accepts leading-zero compatibility proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'leading_only');

  assert.equal(validateAdmissionPow(challengeId, nonce, 3), 'compat_leading');
});

test('validateAdmissionPow rejects non-matching proofs', () => {
  assert.equal(validateAdmissionPow('6t3kves5zeqg', 'not-a-hit', 3), null);
});
