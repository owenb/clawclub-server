import type { Pool } from 'pg';
import {
  CLAWCLUB_EMBEDDING_INPUT_MICRO_CENTS_PER_TOKEN,
  CLAWCLUB_OPENAI_INPUT_MICRO_CENTS_PER_TOKEN,
  CLAWCLUB_OPENAI_MODEL,
  CLAWCLUB_OPENAI_OUTPUT_MICRO_CENTS_PER_TOKEN,
} from './ai.ts';
import { deriveQuotaWindowMaxes, getConfig } from './config/index.ts';
import { withTransaction, type DbClient } from './db.ts';
import { AppError } from './errors.ts';
import type { GatedArtifact } from './gate.ts';
import { pickPrompt, renderArtifact } from './gate.ts';
import { logger } from './logger.ts';

export const CLUB_SPEND_WINDOWS = ['day', 'week', 'month'] as const;
export type ClubSpendWindowName = typeof CLUB_SPEND_WINDOWS[number];

export const CLUB_SPEND_MICRO_CENTS_PER_CENT = 1_000_000;
export const CLUB_SPEND_ESTIMATED_CHARS_PER_TOKEN = 4;
export const CLUB_SPEND_RESERVATION_MARGIN_BPS = 1500;
export const CLUB_SPEND_RESERVATION_TTL_MS = 10 * 60 * 1000;
export const CLUB_SPEND_BLOCKED_RECHECK_MS = 30 * 60 * 1000;

export const CLUB_SPEND_USAGE_KINDS = {
  gate: 'gate',
  embedding: 'embedding',
} as const;

export type ClubSpendUsageKind = typeof CLUB_SPEND_USAGE_KINDS[keyof typeof CLUB_SPEND_USAGE_KINDS];

type ClubSpendWindowCounts = Record<ClubSpendWindowName, bigint>;
type InternalClubSpendWindowUsage = {
  window: ClubSpendWindowName;
  maxMicroCents: bigint;
  usedMicroCents: bigint;
  remainingMicroCents: bigint;
};
type InternalClubSpendBudgetStatus = {
  clubId: string;
  windows: InternalClubSpendWindowUsage[];
};

export type ClubSpendWindowUsage = {
  window: ClubSpendWindowName;
  maxMicroCents: number;
  usedMicroCents: number;
  remainingMicroCents: number;
};

export type ClubSpendBudgetStatus = {
  clubId: string;
  windows: ClubSpendWindowUsage[];
};

export type ClubSpendBudgetPolicy = {
  dailyMaxCents: number;
  weeklyMaxCents: number;
  monthlyMaxCents: number;
};

export type ClubSpendBudgetReservation = {
  reservationId: string;
  budget: ClubSpendBudgetStatus;
};

export type GateSpendEstimate = {
  usageKind: typeof CLUB_SPEND_USAGE_KINDS.gate;
  reservedMicroCents: bigint;
  reservedInputTokensEstimate: number;
  reservedOutputTokens: number;
};

export type EmbeddingSpendEstimate = {
  usageKind: typeof CLUB_SPEND_USAGE_KINDS.embedding;
  reservedMicroCents: bigint;
  reservedInputTokensEstimate: number;
  reservedOutputTokens: 0;
};

export type SpendEstimate = GateSpendEstimate | EmbeddingSpendEstimate;

export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / CLUB_SPEND_ESTIMATED_CHARS_PER_TOKEN);
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : ((value - 1n) / divisor) + 1n;
}

function applyReservationMargin(microCents: bigint): bigint {
  return ceilDivide(
    microCents * BigInt(10_000 + CLUB_SPEND_RESERVATION_MARGIN_BPS),
    10_000n,
  );
}

function priceGateMicroCents(inputTokens: number, outputTokens: number): bigint {
  return (BigInt(inputTokens) * BigInt(CLAWCLUB_OPENAI_INPUT_MICRO_CENTS_PER_TOKEN))
    + (BigInt(outputTokens) * BigInt(CLAWCLUB_OPENAI_OUTPUT_MICRO_CENTS_PER_TOKEN));
}

function priceEmbeddingMicroCents(inputTokens: number): bigint {
  return BigInt(inputTokens) * BigInt(CLAWCLUB_EMBEDDING_INPUT_MICRO_CENTS_PER_TOKEN);
}

export function estimateGateSpend(artifact: GatedArtifact, maxOutputTokens: number): GateSpendEstimate {
  const promptText = pickPrompt(artifact);
  const userText = renderArtifact(artifact);
  const reservedInputTokensEstimate = estimateTokensFromText(`${promptText}\n${userText}`);
  return {
    usageKind: CLUB_SPEND_USAGE_KINDS.gate,
    reservedInputTokensEstimate,
    reservedOutputTokens: maxOutputTokens,
    reservedMicroCents: applyReservationMargin(priceGateMicroCents(reservedInputTokensEstimate, maxOutputTokens)),
  };
}

export function estimateEmbeddingSpend(sourceText: string): EmbeddingSpendEstimate {
  const reservedInputTokensEstimate = estimateTokensFromText(sourceText);
  return {
    usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
    reservedInputTokensEstimate,
    reservedOutputTokens: 0,
    reservedMicroCents: applyReservationMargin(priceEmbeddingMicroCents(reservedInputTokensEstimate)),
  };
}

export function computeGateActualMicroCents(input: {
  promptTokens: number;
  completionTokens: number;
}): bigint {
  return priceGateMicroCents(Math.max(0, input.promptTokens), Math.max(0, input.completionTokens));
}

export function computeEmbeddingActualMicroCents(input: {
  embeddingTokens: number;
}): bigint {
  return priceEmbeddingMicroCents(Math.max(0, input.embeddingTokens));
}

export function getClubSpendBudgetPolicy(): ClubSpendBudgetPolicy {
  const dailyMaxCents = getConfig().policy.quotas.llm.clubSpendBudget.dailyMaxCents;
  const maxes = deriveQuotaWindowMaxes(dailyMaxCents);
  return {
    dailyMaxCents: maxes.day,
    weeklyMaxCents: maxes.week,
    monthlyMaxCents: maxes.month,
  };
}

function getClubSpendWindowMaxesMicroCents(): Record<ClubSpendWindowName, bigint> {
  const policy = getClubSpendBudgetPolicy();
  return {
    day: BigInt(policy.dailyMaxCents) * BigInt(CLUB_SPEND_MICRO_CENTS_PER_CENT),
    week: BigInt(policy.weeklyMaxCents) * BigInt(CLUB_SPEND_MICRO_CENTS_PER_CENT),
    month: BigInt(policy.monthlyMaxCents) * BigInt(CLUB_SPEND_MICRO_CENTS_PER_CENT),
  };
}

function buildInternalClubSpendStatus(clubId: string, counts: ClubSpendWindowCounts): InternalClubSpendBudgetStatus {
  const maxes = getClubSpendWindowMaxesMicroCents();
  return {
    clubId,
    windows: CLUB_SPEND_WINDOWS.map((window) => ({
      window,
      maxMicroCents: maxes[window],
      usedMicroCents: counts[window],
      remainingMicroCents: maxes[window] > counts[window] ? maxes[window] - counts[window] : 0n,
    })),
  };
}

function microCentsToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('invalid_data', `${label} exceeds the safe integer boundary for the current numeric API contract`);
  }
  return Number(value);
}

function serializeClubSpendStatus(status: InternalClubSpendBudgetStatus): ClubSpendBudgetStatus {
  return {
    clubId: status.clubId,
    windows: status.windows.map((window) => ({
      window: window.window,
      maxMicroCents: microCentsToSafeNumber(window.maxMicroCents, `${window.window} maxMicroCents`),
      usedMicroCents: microCentsToSafeNumber(window.usedMicroCents, `${window.window} usedMicroCents`),
      remainingMicroCents: microCentsToSafeNumber(window.remainingMicroCents, `${window.window} remainingMicroCents`),
    })),
  };
}

function clubSpendExceededError(status: InternalClubSpendBudgetStatus, reserveMicroCents = 0n): AppError {
  const exceeded = status.windows.find((window) => window.usedMicroCents + reserveMicroCents > window.maxMicroCents);
  if (!exceeded) {
    return new AppError('quota_exceeded', 'Club AI spend budget exceeded');
  }
  const maxCents = exceeded.maxMicroCents / BigInt(CLUB_SPEND_MICRO_CENTS_PER_CENT);
  return new AppError(
    'quota_exceeded',
    `Rolling ${exceeded.window} club AI budget of ${maxCents} cents reached`,
  );
}

async function lockClubSpendScope(client: DbClient, clubId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`club-spend:${clubId}`]);
}

async function countClubSpendUsage(client: DbClient, clubId: string): Promise<ClubSpendWindowCounts> {
  const result = await client.query<{ used_day: string; used_week: string; used_month: string }>(
    `select
       coalesce(sum(case
         when created_at >= now() - interval '24 hours' then
           case
             when status = 'pending' and expires_at > now() then reserved_micro_cents
             when status = 'finalized' then actual_micro_cents
             else 0
           end
         else 0
       end), 0)::text as used_day,
       coalesce(sum(case
         when created_at >= now() - interval '7 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_micro_cents
             when status = 'finalized' then actual_micro_cents
             else 0
           end
         else 0
       end), 0)::text as used_week,
       coalesce(sum(case
         when created_at >= now() - interval '30 days' then
           case
             when status = 'pending' and expires_at > now() then reserved_micro_cents
             when status = 'finalized' then actual_micro_cents
             else 0
           end
         else 0
       end), 0)::text as used_month
     from ai_club_spend_reservations
     where club_id = $1`,
    [clubId],
  );
  const row = result.rows[0];
  return {
    day: BigInt(row?.used_day ?? '0'),
    week: BigInt(row?.used_week ?? '0'),
    month: BigInt(row?.used_month ?? '0'),
  };
}

export async function getClubSpendBudgetStatus(pool: Pool, clubId: string): Promise<ClubSpendBudgetStatus> {
  return serializeClubSpendStatus(buildInternalClubSpendStatus(clubId, await countClubSpendUsage(pool, clubId)));
}

export async function reserveClubSpendBudget(pool: Pool, input: {
  clubId: string;
  memberId: string | null;
  actionName: string;
  usageKind: ClubSpendUsageKind;
  provider: string;
  model: string;
  estimate: SpendEstimate;
}): Promise<ClubSpendBudgetReservation> {
  return withTransaction(pool, async (client) => {
    await lockClubSpendScope(client, input.clubId);

    const counts = await countClubSpendUsage(client, input.clubId);
    const status = buildInternalClubSpendStatus(input.clubId, counts);
    if (status.windows.some((window) => window.usedMicroCents + input.estimate.reservedMicroCents > window.maxMicroCents)) {
      throw clubSpendExceededError(status, input.estimate.reservedMicroCents);
    }

    const inserted = await client.query<{ id: string }>(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       ) values (
         $1, $2, $3, $4, $5, $6, 'pending', $7, null, $8, $9, null, null, null, $10, null
       )
       returning id`,
      [
        input.clubId,
        input.memberId,
        input.actionName,
        input.usageKind,
        input.provider,
        input.model,
        input.estimate.reservedMicroCents.toString(),
        input.estimate.reservedInputTokensEstimate,
        input.estimate.reservedOutputTokens,
        new Date(Date.now() + CLUB_SPEND_RESERVATION_TTL_MS).toISOString(),
      ],
    );

    return {
      reservationId: inserted.rows[0]!.id,
      budget: serializeClubSpendStatus(buildInternalClubSpendStatus(input.clubId, {
        day: counts.day + input.estimate.reservedMicroCents,
        week: counts.week + input.estimate.reservedMicroCents,
        month: counts.month + input.estimate.reservedMicroCents,
      })),
    };
  });
}

export async function finalizeClubSpendBudget(pool: Pool, input:
  | {
    reservationId: string;
    usageKind: typeof CLUB_SPEND_USAGE_KINDS.gate;
    actualPromptTokens: number;
    actualCompletionTokens: number;
  }
  | {
    reservationId: string;
    usageKind: typeof CLUB_SPEND_USAGE_KINDS.embedding;
    actualEmbeddingTokens: number;
  },
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const current = await client.query<{
      id: string;
      club_id: string;
      usage_kind: ClubSpendUsageKind;
      model: string;
      reserved_micro_cents: string;
    }>(
      `select id, club_id, usage_kind, model, reserved_micro_cents::text as reserved_micro_cents
       from ai_club_spend_reservations
       where id = $1
         and status = 'pending'
       limit 1
       for update`,
      [input.reservationId],
    );
    const row = current.rows[0];
    if (!row) {
      return;
    }

    let actualMicroCents = 0n;
    let actualPromptTokens: number | null = null;
    let actualCompletionTokens: number | null = null;
    let actualEmbeddingTokens: number | null = null;

    if (row.usage_kind === CLUB_SPEND_USAGE_KINDS.gate) {
      if (input.usageKind !== CLUB_SPEND_USAGE_KINDS.gate) {
        throw new AppError('invalid_data', 'Gate spend reservation finalized with embedding usage');
      }
      if (row.model !== CLAWCLUB_OPENAI_MODEL) {
        throw new AppError('invalid_data', `Unknown gate spend model: ${row.model}`);
      }
      actualPromptTokens = Math.max(0, input.actualPromptTokens);
      actualCompletionTokens = Math.max(0, input.actualCompletionTokens);
      actualMicroCents = computeGateActualMicroCents({
        promptTokens: actualPromptTokens,
        completionTokens: actualCompletionTokens,
      });
    } else {
      if (input.usageKind !== CLUB_SPEND_USAGE_KINDS.embedding) {
        throw new AppError('invalid_data', 'Embedding spend reservation finalized with gate usage');
      }
      actualEmbeddingTokens = Math.max(0, input.actualEmbeddingTokens);
      actualMicroCents = computeEmbeddingActualMicroCents({
        embeddingTokens: actualEmbeddingTokens,
      });
    }

    const reservedMicroCents = BigInt(row.reserved_micro_cents);
    if (actualMicroCents > reservedMicroCents) {
      logger.warn('club_spend_under_reserved', {
        reservationId: input.reservationId,
        clubId: row.club_id,
        usageKind: row.usage_kind,
        reservedMicroCents: reservedMicroCents.toString(),
        actualMicroCents: actualMicroCents.toString(),
      });
    }

    const status = actualMicroCents > 0n ? 'finalized' : 'released';
    await client.query(
      `update ai_club_spend_reservations
       set status = $2,
           actual_micro_cents = $3,
           actual_prompt_tokens = $4,
           actual_completion_tokens = $5,
           actual_embedding_tokens = $6,
           finalized_at = now()
       where id = $1
         and status = 'pending'`,
      [
        input.reservationId,
        status,
        actualMicroCents.toString(),
        actualPromptTokens,
        actualCompletionTokens,
        actualEmbeddingTokens,
      ],
    );
  });
}

export async function releaseClubSpendBudget(pool: Pool, input: {
  reservationId: string;
}): Promise<void> {
  await pool.query(
    `update ai_club_spend_reservations
     set status = 'released',
         actual_micro_cents = 0,
         actual_prompt_tokens = null,
         actual_completion_tokens = null,
         actual_embedding_tokens = null,
         finalized_at = now()
     where id = $1
       and status = 'pending'`,
    [input.reservationId],
  );
}

export async function sweepExpiredClubSpendReservations(pool: Pool): Promise<number> {
  const result = await pool.query(
    `update ai_club_spend_reservations
     set status = 'released',
         actual_micro_cents = 0,
         actual_prompt_tokens = null,
         actual_completion_tokens = null,
         actual_embedding_tokens = null,
         finalized_at = now()
     where status = 'pending'
       and expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
