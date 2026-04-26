/**
 * Action contracts: quotas.getUsage, accessTokens.list, accessTokens.create, accessTokens.revoke
 */
import { z } from 'zod';
import { membershipScopes } from '../actors.ts';
import { AppError } from '../repository.ts';
import {
  describeClientKey,
  decodeOptionalCursor,
  paginatedOutput,
  paginationFields,
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalRecord, parseOptionalRecord,
  wireIsoDatetime, parseFutureIsoDatetime,
} from './fields.ts';
import {
  quotaAllowance, bearerTokenSummary, createdBearerToken,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const ACCESS_TOKENS_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 50 });

// ── quotas.getUsage ───────────────────────────────────────

const quotasStatus: ActionDefinition = {
  action: 'quotas.getUsage',
  domain: 'quotas',
  description: 'Get quota usage for the current member across accessible clubs.',
  auth: 'member',
  safety: 'read_only',
  notes: [
    'content.create returns the effective per-club-member request quota after applying any club override and the clubadmin/owner 3x multiplier.',
    'messages.send, embedding.query, and clubs.apply are global per member.',
    'llm.outputTokens is tracked per club-member so club cost can be aggregated later.',
  ],

  wire: {
    input: z.object({}),
    output: z.object({ quotas: z.array(quotaAllowance) }),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubIds } = membershipScopes(ctx.actor.memberships);
    const quotas = await ctx.repository.getQuotaStatus({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      memberships: ctx.actor.memberships.map(m => ({
        clubId: m.clubId,
        role: m.role,
        isOwner: m.isOwner,
      })),
    });

    return { data: { quotas } };
  },
};

// ── accessTokens.list ─────────────────────────────────────────

const tokensList: ActionDefinition = {
  action: 'accessTokens.list',
  domain: 'accessTokens',
  description: 'List bearer tokens for the current member.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      ...ACCESS_TOKENS_PAGINATION.wire,
    }),
    output: paginatedOutput(bearerTokenSummary),
  },

  parse: {
    input: z.object({
      ...ACCESS_TOKENS_PAGINATION.parse,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { limit, cursor: rawCursor } = input as { limit: number; cursor: string | null };
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, tokenId]) => ({ createdAt, tokenId }));
    const tokens = await ctx.repository.listBearerTokens({
      actorMemberId: ctx.actor.member.id,
      limit,
      cursor,
    });

    return { data: tokens };
  },
};

// ── accessTokens.create ───────────────────────────────────────

type TokensCreateInput = {
  clientKey: string;
  label: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
};

const tokensCreate: ActionDefinition = {
  action: 'accessTokens.create',
  domain: 'accessTokens',
  description: 'Create a new bearer token.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'secretMint' },

  wire: {
    input: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this bearer token mint. Plaintext tokens are never replayed.')),
      label: wireOptionalString.describe('Human-readable label'),
      expiresAt: wireIsoDatetime.nullable().optional().describe('ISO 8601 expiration timestamp'),
      metadata: wireOptionalRecord.describe('Freeform metadata'),
    }),
    output: createdBearerToken,
  },

  parse: {
    input: z.object({
      clientKey: parseRequiredString,
      label: parseTrimmedNullableString.default(null),
      expiresAt: parseFutureIsoDatetime.default(null),
      metadata: parseOptionalRecord,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as TokensCreateInput).clientKey,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:accessTokens.create`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clientKey, label, expiresAt, metadata } = input as TokensCreateInput;

    const created = await ctx.repository.createBearerToken({
      actorMemberId: ctx.actor.member.id,
      clientKey,
      idempotencyActorContext: `member:${ctx.actor.member.id}:accessTokens.create`,
      idempotencyRequestValue: {
        actorMemberId: ctx.actor.member.id,
        clientKey,
        label,
        expiresAt,
        metadata,
      },
      label,
      expiresAt,
      metadata,
    });

    return { data: created };
  },
};

// ── accessTokens.revoke ───────────────────────────────────────

const tokensRevoke: ActionDefinition = {
  action: 'accessTokens.revoke',
  domain: 'accessTokens',
  description: 'Revoke a bearer token.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Revocation sets revoked_at once with coalesce; repeating the same token revoke leaves the same token state.',
  },

  wire: {
    input: z.object({
      tokenId: wireRequiredString.describe('Token to revoke'),
    }),
    output: z.object({ token: bearerTokenSummary }),
  },

  parse: {
    input: z.object({
      tokenId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { tokenId } = input as { tokenId: string };

    const token = await ctx.repository.revokeBearerToken({
      actorMemberId: ctx.actor.member.id,
      tokenId,
    });

    if (!token) {
      throw new AppError('token_not_found', 'Token not found inside the actor scope');
    }

    return { data: { token } };
  },
};

registerActions([quotasStatus, tokensList, tokensCreate, tokensRevoke]);
