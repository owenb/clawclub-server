import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import { AppError } from '../../src/errors.ts';
import { MALFORMED_GATE_CLIENT_MESSAGE, MALFORMED_GATE_LOG_FEEDBACK } from '../../src/gate-results.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

test('dispatcher logs sanitized malformed gate feedback while returning a canned gate_rejected message', async () => {
  let logged: Record<string, unknown> | null = null;
  const dispatcher = buildDispatcher({
    repository: makeRepository({
      async authenticateBearerToken() {
        return makeAuthResult();
      },
      async logLlmUsage(entry) {
        logged = entry as Record<string, unknown>;
      },
    }),
    llmGate: async () => ({
      status: 'rejected_malformed',
      rawText: 'Ambiguous response from LLM',
      usage: { promptTokens: 10, completionTokens: 5 },
    }),
  });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'cc_live_23456789abcd_23456789abcdefghjkmnpqrs',
      action: 'content.create',
      payload: { clubId: 'club-1', kind: 'post', title: 'Test', body: 'Test body' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, 'gate_rejected');
      assert.equal(error.message, MALFORMED_GATE_CLIENT_MESSAGE);
      return true;
    },
  );

  assert.ok(logged, 'expected a log entry for malformed gate output');
  assert.equal(logged?.gateStatus, 'rejected_malformed');
  assert.equal(logged?.feedback, MALFORMED_GATE_LOG_FEEDBACK);
});
