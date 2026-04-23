import type { Pool } from 'pg';
import { AppError } from './repository.ts';
import { withTransaction, type DbClient } from './db.ts';
import { deriveQuotaWindowMaxes, getConfig } from './config/index.ts';
import {
  QUOTA_ACTIONS,
  QUOTA_METRICS,
  QUOTA_SCOPES,
  getQuotaActionMeta,
  type SupportedQuotaAction,
} from './quota-metadata.ts';
export { QUOTA_ACTIONS, QUOTA_METRICS, QUOTA_SCOPES } from './quota-metadata.ts';

export const QUOTA_WINDOWS = ['day', 'week', 'month'] as const;
export type QuotaWindowName = typeof QUOTA_WINDOWS[number];

const LLM_OUTPUT_RESERVATION_TTL_MS = 10 * 60 * 1000;

const CONTENT_CREATE_KINDS = ['post', 'opportunity', 'service', 'ask', 'gift', 'event'] as const;

export type QuotaActorInfo = {
  role: 'member' | 'clubadmin';
  isOwner: boolean;
};

export type QuotaWindowUsage = {
  window: QuotaWindowName;
  max: number;
  used: number;
  remaining: number;
};

export type StructuredQuotaAllowance = {
  action: SupportedQuotaAction;
  metric: (typeof QUOTA_METRICS)[keyof typeof QUOTA_METRICS];
  scope: (typeof QUOTA_SCOPES)[keyof typeof QUOTA_SCOPES];
  clubId: string | null;
  windows: QuotaWindowUsage[];
};

export type LlmOutputBudgetReservation = {
  reservationId: string;
  quota: StructuredQuotaAllowance;
};

type WindowCounts = Record<QuotaWindowName, number>;

type RequestQuotaAction =
  | typeof QUOTA_ACTIONS.contentCreate
  | typeof QUOTA_ACTIONS.messagesSend
  | typeof QUOTA_ACTIONS.embeddingQuery
  | typeof QUOTA_ACTIONS.clubsApply
  | typeof QUOTA_ACTIONS.clubsCreate;

function effectiveMultiplier(actor: QuotaActorInfo): number {
  const multipliers = getConfig().policy.quotas.actions[QUOTA_ACTIONS.contentCreate].roleMultipliers;
  if (actor.isOwner) return multipliers.clubOwner;
  if (actor.role === 'clubadmin') return multipliers.clubadmin;
  return multipliers.member;
}

function deriveWindowMaxes(dailyMax: number): Record<QuotaWindowName, number> {
  return deriveQuotaWindowMaxes(dailyMax);
}

function makeWindowUsage(maxes: Record<QuotaWindowName, number>, counts: WindowCounts): QuotaWindowUsage[] {
  return QUOTA_WINDOWS.map((window) => ({
    window,
    max: maxes[window],
    used: counts[window],
    remaining: Math.max(0, maxes[window] - counts[window]),
  }));
}

function buildAllowance(input: {
  action: SupportedQuotaAction;
  metric: (typeof QUOTA_METRICS)[keyof typeof QUOTA_METRICS];
  scope: (typeof QUOTA_SCOPES)[keyof typeof QUOTA_SCOPES];
  clubId: string | null;
  dailyMax: number;
  counts: WindowCounts;
}): StructuredQuotaAllowance {
  return {
    action: input.action,
    metric: input.metric,
    scope: input.scope,
    clubId: input.clubId,
    windows: makeWindowUsage(deriveWindowMaxes(input.dailyMax), input.counts),
  };
}

function quotaExceededError(action: SupportedQuotaAction, allowance: StructuredQuotaAllowance, reserveAmount = 0): AppError {
  const exceeded = allowance.windows.find((window) => window.used + reserveAmount > window.max);
  if (!exceeded) {
    return new AppError('quota_exceeded', `Quota exceeded for ${action}`);
  }

  const unit = allowance.metric === QUOTA_METRICS.outputTokens ? 'output tokens' : 'requests';
  return new AppError('quota_exceeded',
    `Rolling ${exceeded.window} quota of ${exceeded.max} ${unit} reached for ${action}`,
  );
}

async function lockQuotaScope(client: DbClient, action: SupportedQuotaAction, memberId: string, clubId: string | null): Promise<void> {
  const scopeKey = `${action}:${clubId ?? 'global'}:${memberId}`;
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`quota:${scopeKey}`]);
}

async function loadContentQuotaActorInfo(client: DbClient, memberId: string, clubId: string): Promise<QuotaActorInfo> {
  const result = await client.query<{ role: 'member' | 'clubadmin'; is_owner: boolean }>(
    `select
       acm.role::text as role,
       (c.owner_member_id = $1) as is_owner
     from accessible_club_memberships acm
     join clubs c on c.id = acm.club_id
     where acm.member_id = $1
       and acm.club_id = $2
     limit 1`,
    [memberId, clubId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('club_not_found', 'Club not found inside the actor scope');
  }
  return {
    role: row.role,
    isOwner: row.is_owner,
  };
}

async function countContentCreateUsage(client: DbClient, memberId: string, clubId: string): Promise<WindowCounts> {
  const result = await client.query<{ used_day: number; used_week: number; used_month: number }>(
    `select
       count(*) filter (where created_at >= now() - interval '24 hours')::int as used_day,
       count(*) filter (where created_at >= now() - interval '7 days')::int as used_week,
       count(*) filter (where created_at >= now() - interval '30 days')::int as used_month
     from contents
     where author_member_id = $1
       and club_id = $2
       and kind::text = any($3::text[])`,
    [memberId, clubId, [...CONTENT_CREATE_KINDS]],
  );
  const row = result.rows[0];
  return {
    day: row?.used_day ?? 0,
    week: row?.used_week ?? 0,
    month: row?.used_month ?? 0,
  };
}

async function countMessagesSendUsage(client: DbClient, memberId: string): Promise<WindowCounts> {
  const result = await client.query<{ used_day: number; used_week: number; used_month: number }>(
    `select
       count(*) filter (where created_at >= now() - interval '24 hours')::int as used_day,
       count(*) filter (where created_at >= now() - interval '7 days')::int as used_week,
       count(*) filter (where created_at >= now() - interval '30 days')::int as used_month
     from dm_messages
     where sender_member_id = $1`,
    [memberId],
  );
  const row = result.rows[0];
  return {
    day: row?.used_day ?? 0,
    week: row?.used_week ?? 0,
    month: row?.used_month ?? 0,
  };
}

async function countQuotaEventUsage(client: DbClient, memberId: string, actionName: string): Promise<WindowCounts> {
  const result = await client.query<{ used_day: number; used_week: number; used_month: number }>(
    `select
       count(*) filter (where created_at >= now() - interval '24 hours')::int as used_day,
       count(*) filter (where created_at >= now() - interval '7 days')::int as used_week,
       count(*) filter (where created_at >= now() - interval '30 days')::int as used_month
     from ai_quota_event_log
     where member_id = $1
       and action_name = $2`,
    [memberId, actionName],
  );
  const row = result.rows[0];
  return {
    day: row?.used_day ?? 0,
    week: row?.used_week ?? 0,
    month: row?.used_month ?? 0,
  };
}

async function countLlmOutputUsage(client: DbClient, memberId: string, clubId: string): Promise<WindowCounts> {
  const result = await client.query<{ used_day: number; used_week: number; used_month: number }>(
    `select
       coalesce(sum(case
         when created_at >= now() - interval '24 hours' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_day,
       coalesce(sum(case
         when created_at >= now() - interval '7 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_week,
       coalesce(sum(case
         when created_at >= now() - interval '30 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_month
     from ai_llm_quota_reservations
     where member_id = $1
       and club_id = $2`,
    [memberId, clubId],
  );
  const row = result.rows[0];
  return {
    day: row?.used_day ?? 0,
    week: row?.used_week ?? 0,
    month: row?.used_month ?? 0,
  };
}

async function countClubLlmOutputUsage(client: DbClient, clubId: string): Promise<WindowCounts> {
  const result = await client.query<{ used_day: number; used_week: number; used_month: number }>(
    `select
       coalesce(sum(case
         when created_at >= now() - interval '24 hours' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_day,
       coalesce(sum(case
         when created_at >= now() - interval '7 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_week,
       coalesce(sum(case
         when created_at >= now() - interval '30 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_output_tokens
             when status = 'finalized' then actual_output_tokens
             else 0
           end
         else 0
       end), 0)::int as used_month
     from ai_llm_quota_reservations
     where club_id = $1`,
    [clubId],
  );
  const row = result.rows[0];
  return {
    day: row?.used_day ?? 0,
    week: row?.used_week ?? 0,
    month: row?.used_month ?? 0,
  };
}

export async function enforceActionQuota(client: DbClient, input: {
  action: RequestQuotaAction;
  memberId: string;
  clubId?: string | null;
  actorInfo?: QuotaActorInfo;
}): Promise<StructuredQuotaAllowance> {
  if (input.action === QUOTA_ACTIONS.contentCreate) {
    const clubId = input.clubId ?? null;
    if (!clubId) {
      throw new AppError('invalid_data', 'content.create quota enforcement requires a clubId');
    }

    await lockQuotaScope(client, input.action, input.memberId, clubId);
    const actorInfo = input.actorInfo ?? await loadContentQuotaActorInfo(client, input.memberId, clubId);
    const baseQuota = await resolveContentCreateBaseQuota(client, clubId);

    const allowance = buildAllowance({
      action: input.action,
      ...getQuotaActionMeta(input.action),
      clubId,
      dailyMax: baseQuota * effectiveMultiplier(actorInfo),
      counts: await countContentCreateUsage(client, input.memberId, clubId),
    });

    if (allowance.windows.some((window) => window.used >= window.max)) {
      throw quotaExceededError(input.action, allowance);
    }
    return allowance;
  }

  if (
    input.action === QUOTA_ACTIONS.embeddingQuery
    || input.action === QUOTA_ACTIONS.clubsApply
    || input.action === QUOTA_ACTIONS.clubsCreate
  ) {
    const dailyMax = getGlobalRequestDailyMax(input.action);
    await lockQuotaScope(client, input.action, input.memberId, null);
    const allowance = buildAllowance({
      action: input.action,
      ...getQuotaActionMeta(input.action),
      clubId: null,
      dailyMax,
      counts: await countQuotaEventUsage(client, input.memberId, input.action),
    });
    if (allowance.windows.some((window) => window.used >= window.max)) {
      throw quotaExceededError(input.action, allowance);
    }
    await client.query(
      `insert into ai_quota_event_log (member_id, action_name) values ($1, $2)`,
      [input.memberId, input.action],
    );
    return allowance;
  }

  await lockQuotaScope(client, input.action, input.memberId, null);
  const allowance = buildAllowance({
    action: input.action,
    ...getQuotaActionMeta(input.action),
    clubId: null,
    dailyMax: getGlobalRequestDailyMax(QUOTA_ACTIONS.messagesSend),
    counts: await countMessagesSendUsage(client, input.memberId),
  });
  if (allowance.windows.some((window) => window.used >= window.max)) {
    throw quotaExceededError(input.action, allowance);
  }
  return allowance;
}

export async function enforceDurableGlobalEventQuota(pool: Pool, input: {
  action: typeof QUOTA_ACTIONS.embeddingQuery | typeof QUOTA_ACTIONS.clubsApply;
  memberId: string;
}): Promise<StructuredQuotaAllowance> {
  return withTransaction(pool, async (client) => {
    return enforceActionQuota(client, input);
  });
}

export async function enforceEmbeddingQueryQuota(pool: Pool, memberId: string): Promise<StructuredQuotaAllowance> {
  return enforceDurableGlobalEventQuota(pool, {
    action: QUOTA_ACTIONS.embeddingQuery,
    memberId,
  });
}

export async function enforceContentCreateQuota(pool: Pool, input: {
  memberId: string;
  clubId: string;
}): Promise<StructuredQuotaAllowance> {
  return withTransaction(pool, async (client) => {
    return enforceActionQuota(client, {
      action: QUOTA_ACTIONS.contentCreate,
      memberId: input.memberId,
      clubId: input.clubId,
    });
  });
}

export async function reserveLlmOutputBudget(pool: Pool, input: {
  memberId: string;
  clubId: string;
  actionName: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
}): Promise<LlmOutputBudgetReservation> {
  return withTransaction(pool, async (client) => {
    await lockQuotaScope(client, QUOTA_ACTIONS.llmOutputTokens, input.memberId, input.clubId);

    const dailyMax = getConfig().policy.quotas.actions[QUOTA_ACTIONS.llmOutputTokens].dailyMax;
    const counts = await countLlmOutputUsage(client, input.memberId, input.clubId);
    const allowance = buildAllowance({
      action: QUOTA_ACTIONS.llmOutputTokens,
      ...getQuotaActionMeta(QUOTA_ACTIONS.llmOutputTokens),
      clubId: input.clubId,
      dailyMax,
      counts,
    });
    if (allowance.windows.some((window) => window.used + input.maxOutputTokens > window.max)) {
      throw quotaExceededError(QUOTA_ACTIONS.llmOutputTokens, allowance, input.maxOutputTokens);
    }

    const inserted = await client.query<{ id: string }>(
      `insert into ai_llm_quota_reservations (
         member_id, club_id, action_name, provider, model, status,
         reserved_output_tokens, actual_output_tokens, expires_at, finalized_at
       ) values ($1, $2, $3, $4, $5, 'pending', $6, null, $7, null)
       returning id`,
      [
        input.memberId,
        input.clubId,
        input.actionName,
        input.provider,
        input.model,
        input.maxOutputTokens,
        new Date(Date.now() + LLM_OUTPUT_RESERVATION_TTL_MS).toISOString(),
      ],
    );

    return {
      reservationId: inserted.rows[0]!.id,
      quota: buildAllowance({
        action: QUOTA_ACTIONS.llmOutputTokens,
        ...getQuotaActionMeta(QUOTA_ACTIONS.llmOutputTokens),
        clubId: input.clubId,
        dailyMax,
        counts: {
          day: counts.day + input.maxOutputTokens,
          week: counts.week + input.maxOutputTokens,
          month: counts.month + input.maxOutputTokens,
        },
      }),
    };
  });
}

export async function finalizeLlmOutputBudget(pool: Pool, input: {
  reservationId: string;
  actualOutputTokens: number;
}): Promise<void> {
  const status = input.actualOutputTokens > 0 ? 'finalized' : 'released';
  await pool.query(
    `update ai_llm_quota_reservations
     set status = $2,
         actual_output_tokens = $3,
         finalized_at = now()
     where id = $1
       and status = 'pending'`,
    [input.reservationId, status, Math.max(0, input.actualOutputTokens)],
  );
}

export async function getQuotaStatus(pool: Pool, input: {
  actorMemberId: string;
  clubIds: string[];
  memberships: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }>;
}): Promise<StructuredQuotaAllowance[]> {
  const allowances: StructuredQuotaAllowance[] = [];
  const clubIds = [...new Set(input.clubIds)].sort();
  const membershipsByClub = new Map<string, QuotaActorInfo>();
  for (const membership of input.memberships) {
    membershipsByClub.set(membership.clubId, { role: membership.role, isOwner: membership.isOwner });
  }

  allowances.push(buildAllowance({
    action: QUOTA_ACTIONS.messagesSend,
    ...getQuotaActionMeta(QUOTA_ACTIONS.messagesSend),
    clubId: null,
    dailyMax: getGlobalRequestDailyMax(QUOTA_ACTIONS.messagesSend),
    counts: await countMessagesSendUsage(pool, input.actorMemberId),
  }));

  allowances.push(buildAllowance({
    action: QUOTA_ACTIONS.embeddingQuery,
    ...getQuotaActionMeta(QUOTA_ACTIONS.embeddingQuery),
    clubId: null,
    dailyMax: getGlobalRequestDailyMax(QUOTA_ACTIONS.embeddingQuery),
    counts: await countQuotaEventUsage(pool, input.actorMemberId, QUOTA_ACTIONS.embeddingQuery),
  }));

  allowances.push(buildAllowance({
    action: QUOTA_ACTIONS.clubsApply,
    ...getQuotaActionMeta(QUOTA_ACTIONS.clubsApply),
    clubId: null,
    dailyMax: getGlobalRequestDailyMax(QUOTA_ACTIONS.clubsApply),
    counts: await countQuotaEventUsage(pool, input.actorMemberId, QUOTA_ACTIONS.clubsApply),
  }));

  allowances.push(buildAllowance({
    action: QUOTA_ACTIONS.clubsCreate,
    ...getQuotaActionMeta(QUOTA_ACTIONS.clubsCreate),
    clubId: null,
    dailyMax: getGlobalRequestDailyMax(QUOTA_ACTIONS.clubsCreate),
    counts: await countQuotaEventUsage(pool, input.actorMemberId, QUOTA_ACTIONS.clubsCreate),
  }));

  for (const clubId of clubIds) {
    const actorInfo = membershipsByClub.get(clubId) ?? { role: 'member' as const, isOwner: false };
    const baseQuota = await resolveContentCreateBaseQuota(pool, clubId);
    allowances.push(buildAllowance({
      action: QUOTA_ACTIONS.contentCreate,
      ...getQuotaActionMeta(QUOTA_ACTIONS.contentCreate),
      clubId,
      dailyMax: baseQuota * effectiveMultiplier(actorInfo),
      counts: await countContentCreateUsage(pool, input.actorMemberId, clubId),
    }));

    const llmOutputDailyMax = getConfig().policy.quotas.actions[QUOTA_ACTIONS.llmOutputTokens].dailyMax;
    allowances.push(buildAllowance({
      action: QUOTA_ACTIONS.llmOutputTokens,
      ...getQuotaActionMeta(QUOTA_ACTIONS.llmOutputTokens),
      clubId,
      dailyMax: llmOutputDailyMax,
      counts: await countLlmOutputUsage(pool, input.actorMemberId, clubId),
    }));
  }

  return allowances;
}

export function getLlmGateMaxOutputTokens(): number {
  return getConfig().policy.quotas.llm.gateMaxOutputTokens;
}

export async function getClubLlmOutputUsage(pool: Pool, clubId: string): Promise<QuotaWindowUsage[]> {
  const counts = await countClubLlmOutputUsage(pool, clubId);
  const dailyMax = getConfig().policy.quotas.actions[QUOTA_ACTIONS.llmOutputTokens].dailyMax;
  const maxes = deriveWindowMaxes(dailyMax);
  return QUOTA_WINDOWS.map((window) => ({
    window,
    max: maxes[window],
    used: counts[window],
    remaining: Math.max(0, maxes[window] - counts[window]),
  }));
}

function getGlobalRequestDailyMax(
  action:
    | typeof QUOTA_ACTIONS.messagesSend
    | typeof QUOTA_ACTIONS.embeddingQuery
    | typeof QUOTA_ACTIONS.clubsApply
    | typeof QUOTA_ACTIONS.clubsCreate,
): number {
  return getConfig().policy.quotas.actions[action].dailyMax;
}

async function resolveContentCreateBaseQuota(client: DbClient, clubId: string): Promise<number> {
  const result = await client.query<{ slug: string }>(
    `select slug
     from clubs
     where id = $1
     limit 1`,
    [clubId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('club_not_found', 'Club not found');
  }

  const quotaConfig = getConfig().policy.quotas.actions[QUOTA_ACTIONS.contentCreate];
  return quotaConfig.clubOverrides[row.slug] ?? quotaConfig.dailyMax;
}
