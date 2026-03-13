import test from 'node:test';
import assert from 'node:assert/strict';
import { runAiSmoke } from '../src/ai-smoke.ts';

test('AI SDK smoke harness runs curated tool flows end-to-end through src/ai.ts', async () => {
  const result = await runAiSmoke();

  assert.equal(result.scenarios.length, 6);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.name),
    [
      'session describe',
      'admissions operator flow',
      'member search',
      'profile read + update',
      'message inbox + read + send',
      'event list + create',
    ],
  );
  assert.match(result.scenarios[1]?.text ?? '', /interview scheduled/);
  assert.match(result.scenarios[2]?.text ?? '', /Ava Builder/);
  assert.equal(result.scenarios[4]?.callLog.some((entry) => entry.startsWith('sendDirectMessage:')), true);
  assert.equal(result.scenarios[5]?.callLog.some((entry) => entry.startsWith('createEvent:')), true);
});
