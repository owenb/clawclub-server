import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatcher } from '../../src/dispatch.ts';
import type { QuotaAllowance } from '../../src/repository.ts';
import { makeAuthResult, makeRepository } from './fixtures.ts';

test('quotas.getUsage returns quota allowances for all clubs', async () => {
  const quotas: QuotaAllowance[] = [
    {
      action: 'content.create',
      metric: 'requests',
      scope: 'per_club_member',
      clubId: 'club-1',
      windows: [
        { window: 'day', max: 90, used: 3, remaining: 87 },
        { window: 'week', max: 405, used: 5, remaining: 400 },
        { window: 'month', max: 1620, used: 8, remaining: 1612 },
      ],
    },
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
  assert.equal(result.data.quotas.length, 1);
  assert.deepEqual(result.data.quotas[0], quotas[0]);
});
