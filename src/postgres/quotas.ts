import type { Pool } from 'pg';
import type { QuotaAllowance, Repository } from '../app-contract.ts';
import { AppError } from '../app.ts';
import type { DbClient, WithActorContext } from './shared.ts';

const QUOTA_ACTIONS = ['entities.create', 'events.create', 'messages.send'] as const;

export const DEFAULT_QUOTAS: Record<string, number> = {
  'entities.create': 20,
  'events.create': 10,
  'messages.send': 100,
};

export async function resolveQuota(
  client: DbClient,
  actorMemberId: string,
  networkId: string,
  action: string,
): Promise<QuotaAllowance> {
  const policyResult = await client.query<{ max_per_day: number }>(
    `select max_per_day from app.network_quota_policies where network_id = $1 and action_name = $2`,
    [networkId, action],
  );
  const maxPerDay = policyResult.rows[0]?.max_per_day ?? DEFAULT_QUOTAS[action];

  const usageResult = await client.query<{ count: number }>(
    `select app.count_member_writes_today($1, $2, $3) as count`,
    [actorMemberId, networkId, action],
  );
  const usedToday = usageResult.rows[0]?.count ?? 0;

  return {
    action,
    networkId,
    maxPerDay,
    usedToday,
    remaining: Math.max(0, maxPerDay - usedToday),
  };
}

export async function enforceQuota(
  client: DbClient,
  actorMemberId: string,
  networkId: string,
  action: string,
): Promise<void> {
  const quota = await resolveQuota(client, actorMemberId, networkId, action);
  if (quota.remaining <= 0) {
    throw new AppError(
      429,
      'quota_exceeded',
      `Daily quota exceeded for ${action} in this network (${quota.usedToday}/${quota.maxPerDay})`,
    );
  }
}

export function buildQuotaRepository({
  pool,
  withActorContext,
}: {
  pool: Pool;
  withActorContext: WithActorContext;
}): Pick<Repository, 'getQuotaStatus'> {
  return {
    async getQuotaStatus(input) {
      return withActorContext(pool, input.actorMemberId, input.networkIds, async (client) => {
        const allowances: QuotaAllowance[] = [];

        for (const networkId of input.networkIds) {
          for (const action of QUOTA_ACTIONS) {
            allowances.push(await resolveQuota(client, input.actorMemberId, networkId, action));
          }
        }

        return allowances;
      });
    },
  };
}
