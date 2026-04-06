/**
 * Action contracts: entities.create, entities.update, entities.remove, entities.list
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireLimit, parseLimit,
  wireOptionalRecord, parseOptionalRecord,
  wireEntityKinds, parseEntityKinds,
  entityKind,
} from './fields.ts';
import { entitySummary, membershipSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── entities.create ──────────────────────────────────────

type CreateInput = {
  clubId: string;
  kind: 'post' | 'opportunity' | 'service' | 'ask';
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
};

const entitiesCreate: ActionDefinition = {
  action: 'entities.create',
  domain: 'content',
  description: 'Create a new post, ask, opportunity, or service.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership. Subject to daily quota.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to post in'),
      kind: entityKind.describe('Content type'),
      title: wireOptionalString.describe('Title'),
      summary: wireOptionalString.describe('Summary'),
      body: wireOptionalString.describe('Body text'),
      expiresAt: wireOptionalString.describe('ISO 8601 expiration timestamp'),
      content: wireOptionalRecord.describe('Structured metadata'),
      clientKey: wireOptionalString.describe('Idempotency key — if provided, duplicate creates with the same key are rejected'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      kind: entityKind,
      title: parseTrimmedNullableString.default(null),
      summary: parseTrimmedNullableString.default(null),
      body: parseTrimmedNullableString.default(null),
      expiresAt: parseTrimmedNullableString.default(null),
      content: parseOptionalRecord,
      clientKey: parseTrimmedNullableString.default(null),
    }),
  },

  qualityGate: 'entities-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kind, title, summary, body, expiresAt, content, clientKey } = input as CreateInput & { clientKey?: string | null };
    const club = ctx.requireAccessibleClub(clubId);

    const entity = await ctx.repository.createEntity({
      authorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      kind, title, summary, body, expiresAt, content, clientKey,
    });

    return {
      data: { entity },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── entities.update ──────────────────────────────────────

type UpdateInput = {
  entityId: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;
};

const entitiesUpdate: ActionDefinition = {
  action: 'entities.update',
  domain: 'content',
  description: 'Update an existing entity (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may update. At least one field must change.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to update'),
      title: wirePatchString.describe('New title'),
      summary: wirePatchString.describe('New summary'),
      body: wirePatchString.describe('New body text'),
      expiresAt: wirePatchString.describe('New expiration timestamp'),
      content: z.record(z.unknown()).optional().describe('New structured metadata'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
      title: parsePatchString,
      summary: parsePatchString,
      body: parsePatchString,
      expiresAt: parsePatchString,
      content: z.record(z.unknown()).optional(),
    }).refine(input => {
      const { entityId: _, ...patch } = input;
      return Object.values(patch).some(v => v !== undefined);
    }, 'entities.update requires at least one field to change'),
  },

  qualityGate: 'entities-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, ...patchFields } = input as UpdateInput;

    // Build patch with only defined fields
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchFields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    const entity = await ctx.repository.updateEntity({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      patch: patch as { title?: string | null; summary?: string | null; body?: string | null; expiresAt?: string | null; content?: Record<string, unknown> },
    });

    if (!entity) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    if (entity.author.memberId !== ctx.actor.member.id) {
      throw new AppError(403, 'forbidden', 'Only the author may update this entity');
    }

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

// ── entities.remove ──────────────────────────────────────

const entitiesRemove: ActionDefinition = {
  action: 'entities.remove',
  domain: 'content',
  description: 'Remove an entity (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may remove their own entity.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to remove'),
      reason: wireOptionalString.describe('Reason for removal (optional)'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  requiredCapability: 'removeEntity',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, reason } = input as { entityId: string; reason: string | null };
    ctx.requireCapability('removeEntity');

    const entity = await ctx.repository.removeEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      reason,
    });

    if (!entity) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

// ── entities.list ────────────────────────────────────────

type ListInput = {
  clubId?: string;
  kinds: ('post' | 'opportunity' | 'service' | 'ask')[];
  query?: string | null;
  limit: number;
};

const entitiesList: ActionDefinition = {
  action: 'entities.list',
  domain: 'content',
  description: 'List posts, asks, opportunities, or services.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: wireEntityKinds,
      query: wireOptionalString.describe('Search text'),
      limit: wireLimit,
    }),
    output: z.object({
      query: z.string().nullable(),
      kinds: z.array(entityKind),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(entitySummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      kinds: parseEntityKinds,
      query: parseTrimmedNullableString,
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kinds, query, limit } = input as ListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map(c => c.clubId);

    const results = await ctx.repository.listEntities({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      kinds,
      limit,
      query: query ?? undefined,
    });

    return {
      data: {
        query: query ?? null,
        kinds,
        limit,
        clubScope,
        results,
      },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: clubIds,
      },
    };
  },
};

// ── entities.findViaEmbedding ──────────────────────────────

type EntitiesFindViaEmbeddingInput = {
  query: string;
  clubId?: string;
  kinds?: string[];
  limit: number;
};

const entitiesFindViaEmbedding: ActionDefinition = {
  action: 'entities.findViaEmbedding',
  domain: 'entities',
  description: 'Find entities by natural-language query using embedding similarity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: z.array(entityKind).optional().describe('Filter by entity kinds'),
      limit: wireLimit,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(entitySummary),
    }),
  },

  parse: {
    input: z.object({
      query: z.string().trim().min(1).max(1000),
      clubId: parseRequiredString.optional(),
      kinds: z.array(entityKind).optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, kinds, limit } = input as EntitiesFindViaEmbeddingInput;
    const { embed } = await import('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { EMBEDDING_PROFILES } = await import('../ai.ts');
    const { AppError: AppErr } = await import('../contract.ts');

    const profile = EMBEDDING_PROFILES.entity;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'entities.findViaEmbedding',
        gateName: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'no_api_key',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: null,
      })?.catch(() => {});
      throw new AppErr(503, 'embedding_unavailable', 'Embedding service is not configured');
    }

    let clubIds: string[];
    if (clubId) {
      clubIds = [ctx.requireAccessibleClub(clubId).clubId];
    } else {
      clubIds = ctx.actor.memberships.map(m => m.clubId);
    }

    if (clubIds.length === 0) {
      throw new AppErr(403, 'forbidden', 'This member does not currently have access to any clubs');
    }

    const provider = createOpenAI({ apiKey });
    const embeddingModel = provider.embedding(profile.model, { dimensions: profile.dimensions });

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embed({ model: embeddingModel, value: query });
      embedding = result.embedding;
      usageTokens = result.usage?.tokens ?? 0;
    } catch (err) {
      console.error('Embedding provider error in entities.findViaEmbedding:', err);
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'entities.findViaEmbedding',
        gateName: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'provider_error',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      })?.catch(() => {});
      throw new AppErr(503, 'embedding_unavailable', 'Embedding service is temporarily unavailable');
    }

    ctx.repository.logLlmUsage?.({
      memberId: ctx.actor.member.id,
      requestedClubId: clubId ?? null,
      actionName: 'entities.findViaEmbedding',
      gateName: 'embedding_query',
      provider: 'openai',
      model: profile.model,
      gateStatus: 'passed',
      skipReason: null,
      promptTokens: usageTokens,
      completionTokens: 0,
      providerErrorCode: null,
    })?.catch(() => {});

    const queryVector = `[${embedding.join(',')}]`;

    const results = await ctx.repository.findEntitiesViaEmbedding({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      queryEmbedding: queryVector,
      kinds,
      limit,
    });

    const clubScope = ctx.actor.memberships.filter(m => clubIds.includes(m.clubId));

    return {
      data: { query, limit, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

registerActions([entitiesCreate, entitiesUpdate, entitiesRemove, entitiesList, entitiesFindViaEmbedding]);
