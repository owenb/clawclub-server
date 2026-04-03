import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperatorSmoke } from '../src/ai-operator-smoke.ts';

test('operator AI chat runner smoke path exercises a realistic operator turn', async () => {
  const result = await runOperatorSmoke();

  assert.match(result.text, /activated the membership/);
  assert.equal(result.callLog.some((entry) => entry.startsWith('listMembershipReviews:')), true);
  assert.equal(result.callLog.some((entry) => entry.startsWith('listAdmissions:')), true);
  assert.equal(result.callLog.some((entry) => entry.startsWith('transitionAdmission:')), true);
});
