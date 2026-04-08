/**
 * Action contracts: quotas.getUsage, accessTokens.list, accessTokens.create, accessTokens.revoke
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalRecord, parseOptionalRecord,
} from './fields.ts';
import {
  quotaAllowance, bearerTokenSummary, createdBearerToken,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── quotas.getUsage ───────────────────────────────────────

const quotasStatus: ActionDefinition = {
  action: 'quotas.getUsage',
  domain: 'quotas',
  description: 'Get quota usage for the current member across accessible clubs.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({}),
    output: z.object({ quotas: z.array(quotaAllowance) }),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const quotas = await ctx.repository.getQuotaStatus({
      actorMemberId: ctx.actor.member.id,
      clubIds: ctx.actor.memberships.map(m => m.clubId),
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
    input: z.object({}),
    output: z.object({ tokens: z.array(bearerTokenSummary) }),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const tokens = await ctx.repository.listBearerTokens({
      actorMemberId: ctx.actor.member.id,
    });

    return { data: { tokens } };
  },
};

// ── accessTokens.create ───────────────────────────────────────

type TokensCreateInput = {
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

  wire: {
    input: z.object({
      label: wireOptionalString.describe('Human-readable label'),
      expiresAt: wireOptionalString.describe('ISO 8601 expiration timestamp'),
      metadata: wireOptionalRecord.describe('Freeform metadata'),
    }),
    output: createdBearerToken,
  },

  parse: {
    input: z.object({
      label: parseTrimmedNullableString.default(null),
      expiresAt: parseTrimmedNullableString.default(null),
      metadata: parseOptionalRecord,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { label, expiresAt, metadata } = input as TokensCreateInput;

    const created = await ctx.repository.createBearerToken({
      actorMemberId: ctx.actor.member.id,
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
      throw new AppError(404, 'not_found', 'Token not found inside the actor scope');
    }

    return { data: { token } };
  },
};

registerActions([quotasStatus, tokensList, tokensCreate, tokensRevoke]);
