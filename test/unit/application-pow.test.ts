import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateApplicationPow } from '../../src/clubs/unified.ts';

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

test('validateApplicationPow accepts canonical trailing-zero proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'trailing');

  assert.equal(validateApplicationPow(challengeId, nonce, 3), true);
});

test('validateApplicationPow rejects leading-zero compatibility proofs', () => {
  const challengeId = '6t3kves5zeqg';
  const nonce = findNonce(challengeId, 3, 'leading_only');

  assert.equal(validateApplicationPow(challengeId, nonce, 3), false);
});

test('validateApplicationPow rejects non-matching proofs', () => {
  assert.equal(validateApplicationPow('6t3kves5zeqg', 'not-a-hit', 3), false);
});
