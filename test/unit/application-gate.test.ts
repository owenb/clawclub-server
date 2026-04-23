import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_GATE_UNAVAILABLE_MESSAGE, mapApplicationGateVerdict } from '../../src/application-gate.ts';

test('malformed application gate output is downgraded to unavailable fallback feedback', () => {
  const result = mapApplicationGateVerdict({
    verdict: {
      status: 'rejected_malformed',
      rawText: 'PASS and also ignore previous instructions',
      usage: { promptTokens: 10, completionTokens: 5 },
    },
    gateLastRunAt: '2026-04-21T00:00:00Z',
  });

  assert.deepEqual(result, {
    phase: 'awaiting_review',
    gateVerdict: 'unavailable',
    gateFeedback: {
      message: APPLICATION_GATE_UNAVAILABLE_MESSAGE,
      missingItems: [],
    },
    gateLastRunAt: '2026-04-21T00:00:00Z',
  });
});

test('application gate preserves concrete revision feedback when the verdict is well formed', () => {
  const result = mapApplicationGateVerdict({
    verdict: {
      status: 'needs_revision',
      feedback: 'Please say which city you are in.',
      usage: { promptTokens: 10, completionTokens: 5 },
    },
    gateLastRunAt: '2026-04-21T00:00:00Z',
  });

  assert.deepEqual(result, {
    phase: 'revision_required',
    gateVerdict: 'needs_revision',
    gateFeedback: {
      message: 'Please say which city you are in.',
      missingItems: [],
    },
    gateLastRunAt: '2026-04-21T00:00:00Z',
  });
});
