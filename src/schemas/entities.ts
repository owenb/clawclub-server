/**
 * Action contracts: content.create, content.update, content.remove, content.list,
 * content.searchBySemanticSimilarity, content.closeLoop, content.reopenLoop
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireOptionalRecord, parseOptionalRecord,
  wireEntityKinds, parseEntityKinds,
  entityKind,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import { entitySummary, membershipSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── content.create ──────────────────────────────────────

type CreateInput = {
  clubId: string;
  kind: 'post' | 'opportunity' | 'service' | 'ask' | 'gift';
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
};

const entitiesCreate: ActionDefinition = {
  action: 'content.create',
  domain: 'content',
  description: 'Create a new post, ask, gift, opportunity, or service.',
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
      clientKey: wireOptionalString.describe('Idempotency key (scoped per member globally, not per club). Same key + same payload = original entity returned. Same key + different club or kind = 409 client_key_conflict.'),
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

  qualityGate: 'content-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kind, title, summary, body, expiresAt, content, clientKey } = input as CreateInput & { clientKey?: string | null };

    // Require at least one meaningful user-facing field
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const hasSummary = typeof summary === 'string' && summary.trim().length > 0;
    const hasBody = typeof body === 'string' && body.trim().length > 0;
    const hasContent = content && Object.keys(content).length > 0;
    if (!hasTitle && !hasSummary && !hasBody && !hasContent) {
      throw new AppError(400, 'invalid_input', 'At least one of title, summary, body, or content must be provided');
    }

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

// ── content.update ──────────────────────────────────────

type UpdateInput = {
  entityId: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;
};

const entitiesUpdate: ActionDefinition = {
  action: 'content.update',
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
      content: z.record(z.string(), z.unknown()).optional().describe('New structured metadata'),
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
      content: z.record(z.string(), z.unknown()).optional(),
    }).refine(input => {
      const { entityId: _, ...patch } = input;
      return Object.values(patch).some(v => v !== undefined);
    }, 'content.update requires at least one field to change'),
  },

  qualityGate: 'content-create',

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

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

// ── content.remove ──────────────────────────────────────

const entitiesRemove: ActionDefinition = {
  action: 'content.remove',
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

// ── content.list ────────────────────────────────────────

type ListInput = {
  clubId?: string;
  kinds: ('post' | 'opportunity' | 'service' | 'ask' | 'gift')[];
  query?: string | null;
  includeClosed: boolean;
  limit: number;
  cursor: string | null;
};

const entitiesList: ActionDefinition = {
  action: 'content.list',
  domain: 'content',
  description: 'List posts, asks, gifts, opportunities, or services.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: wireEntityKinds,
      query: wireOptionalString.describe('Search text'),
      includeClosed: z.boolean().optional().describe('Include your own closed asks, gifts, services, and opportunities'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string().nullable(),
      kinds: z.array(entityKind),
      includeClosed: z.boolean(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(entitySummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      kinds: parseEntityKinds,
      query: parseTrimmedNullableString,
      includeClosed: z.boolean().optional().default(false),
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kinds, query, includeClosed, limit, cursor: rawCursor } = input as ListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map(c => c.clubId);

    const result = await ctx.repository.listEntities({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      kinds,
      limit,
      query: query ?? undefined,
      includeClosed,
      rawCursor,
    });

    return {
      data: {
        query: query ?? null,
        kinds,
        includeClosed,
        limit,
        clubScope,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: clubIds,
      },
    };
  },
};

// ── content.searchBySemanticSimilarity ─────────────────────

type EntitiesFindViaEmbeddingInput = {
  query: string;
  clubId?: string;
  kinds?: string[];
  limit: number;
  cursor: string | null;
};

const entitiesFindViaEmbedding: ActionDefinition = {
  action: 'content.searchBySemanticSimilarity',
  domain: 'content',
  description: 'Find posts, asks, gifts, opportunities, or services by natural-language query using embedding similarity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: z.array(entityKind).optional().describe('Filter by entity kinds'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(entitySummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      query: z.string().trim().min(1).max(1000),
      clubId: parseRequiredString.optional(),
      kinds: z.array(entityKind).optional(),
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, kinds, limit, cursor: rawCursor } = input as EntitiesFindViaEmbeddingInput;
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
        actionName: 'content.searchBySemanticSimilarity',
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
    const embeddingModel = provider.embedding(profile.model);

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embed({
        model: embeddingModel,
        value: query,
        providerOptions: { openai: { dimensions: profile.dimensions } },
      });
      embedding = result.embedding;
      usageTokens = result.usage?.tokens ?? 0;
    } catch (err) {
      console.error('Embedding provider error in content.searchBySemanticSimilarity:', err);
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'content.searchBySemanticSimilarity',
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
      actionName: 'content.searchBySemanticSimilarity',
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

    const cursor = rawCursor ? (() => {
      const [distance, entityId] = decodeCursor(rawCursor, 2);
      return { distance, entityId };
    })() : null;

    const result = await ctx.repository.findEntitiesViaEmbedding({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      queryEmbedding: queryVector,
      kinds,
      limit,
      cursor,
    });

    const clubScope = ctx.actor.memberships.filter(m => clubIds.includes(m.clubId));

    return {
      data: { query, limit, clubScope, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── content.closeLoop ────────────────────────────────────

const entitiesCloseLoop: ActionDefinition = {
  action: 'content.closeLoop',
  domain: 'content',
  description: 'Close an open ask, gift, service, or opportunity (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may close their own published loopable content.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to close'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId } = input as { entityId: string };
    const entity = await ctx.repository.closeEntityLoop({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
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

// ── content.reopenLoop ──────────────────────────────────

const entitiesReopenLoop: ActionDefinition = {
  action: 'content.reopenLoop',
  domain: 'content',
  description: 'Reopen a previously closed ask, gift, service, or opportunity (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may reopen their own published loopable content.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to reopen'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId } = input as { entityId: string };
    const entity = await ctx.repository.reopenEntityLoop({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
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

registerActions([
  entitiesCreate,
  entitiesUpdate,
  entitiesRemove,
  entitiesList,
  entitiesFindViaEmbedding,
  entitiesCloseLoop,
  entitiesReopenLoop,
]);
