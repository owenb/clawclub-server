import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../src/dispatch.ts';
import type { QuotaAllowance } from '../src/contract.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

test('quotas.getUsage returns quota allowances for all clubs', async () => {
  const quotas: QuotaAllowance[] = [
    { action: 'content.create', clubId: 'club-1', maxPerDay: 20, usedToday: 3, remaining: 17 },
    { action: 'events.create', clubId: 'club-1', maxPerDay: 10, usedToday: 0, remaining: 10 },
    { action: 'messages.send', clubId: 'club-1', maxPerDay: 100, usedToday: 5, remaining: 95 },
  ];

  const auth = makeAuthResult();
  const repository = makeRepository({
    async authenticateBearerToken() { return auth; },
    async getQuotaStatus() { return quotas; },
  });

  const dispatcher = buildDispatcher({ repository });
  const result: any = await dispatcher.dispatch({
    bearerToken: 'test-token',
    action: 'quotas.getUsage',
  });

  assert.equal(result.action, 'quotas.getUsage');
  assert.equal(result.data.quotas.length, 3);
  assert.deepEqual(result.data.quotas[0], quotas[0]);
});
