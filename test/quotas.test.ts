import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../src/app-dispatch.ts';
import type { QuotaAllowance } from '../src/app-contract.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

test('quotas.status returns quota allowances for all clubs', async () => {
  const quotas: QuotaAllowance[] = [
    { action: 'entities.create', clubId: 'club-1', maxPerDay: 20, usedToday: 3, remaining: 17 },
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
    action: 'quotas.status',
  });

  assert.equal(result.action, 'quotas.status');
  assert.equal(result.data.quotas.length, 3);
  assert.deepEqual(result.data.quotas[0], quotas[0]);
});
