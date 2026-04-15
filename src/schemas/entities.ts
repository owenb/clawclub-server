/**
 * Action contracts: content.create, content.update, content.remove, content.getThread,
 * content.list, content.searchBySemanticSimilarity, content.closeLoop, content.reopenLoop
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireEntityKinds, parseEntityKinds,
  entityKind,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
  wireEventFieldsCreate, parseEventFieldsCreate,
  wireEventFieldsPatch, parseEventFieldsPatch,
} from './fields.ts';
import { contentEntity, contentEntitySearchResult, contentThreadSummary, includedBundle, membershipSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

type EventInput = {
  location: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
};

const CONTENT_CREATE_ERRORS = [
  {
    code: 'quota_exceeded',
    meaning: 'The member has reached the daily content.create quota for this club.',
    recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry later.',
  },
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used with a different payload.',
    recovery: 'Generate a new clientKey for the new creation intent, or resend the exact same payload to replay safely.',
  },
  {
    code: 'invalid_mentions',
    meaning: 'One or more [Name|memberId] mentions referenced unknown member ids.',
    recovery: 'Correct or remove the listed mentions, then resubmit the content.',
  },
  {
    code: 'illegal_content',
    meaning: 'The content gate rejected the submission for soliciting or facilitating clearly illegal activity.',
    recovery: 'Relay the reason to the user, revise the content, and resubmit.',
  },
  {
    code: 'gate_rejected',
    meaning: 'The content gate returned a non-passing verdict after schema validation.',
    recovery: 'Review the feedback, revise the content, and resubmit.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The content gate is temporarily unavailable.',
    recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
  },
] as const;

const CONTENT_UPDATE_ERRORS = [
  {
    code: 'invalid_mentions',
    meaning: 'One or more [Name|memberId] mentions referenced unknown member ids.',
    recovery: 'Correct or remove the listed mentions, then resubmit the update.',
  },
  {
    code: 'illegal_content',
    meaning: 'The content gate rejected the update for soliciting or facilitating clearly illegal activity.',
    recovery: 'Relay the reason to the user, revise the update, and resubmit.',
  },
  {
    code: 'gate_rejected',
    meaning: 'The content gate returned a non-passing verdict after schema validation.',
    recovery: 'Review the feedback, revise the update, and resubmit.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The content gate is temporarily unavailable.',
    recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
  },
] as const;

function parseIsoDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_input', `${fieldName} must be a valid ISO 8601 timestamp`);
  }
  return parsed;
}

function validateCreatePayload(input: {
  kind: z.infer<typeof entityKind>;
  title: string | null;
  summary: string | null;
  body: string | null;
  event?: EventInput | null;
}): void {
  const hasTitle = typeof input.title === 'string' && input.title.trim().length > 0;
  const hasSummary = typeof input.summary === 'string' && input.summary.trim().length > 0;
  const hasBody = typeof input.body === 'string' && input.body.trim().length > 0;

  if (input.kind === 'event') {
    if (!input.event) {
      throw new AppError(400, 'invalid_input', 'kind=event requires an event object');
    }
    if (!hasTitle) {
      throw new AppError(400, 'invalid_input', 'kind=event requires a title');
    }
    const startsAt = parseIsoDate(input.event.startsAt, 'event.startsAt');
    if (input.event.endsAt) {
      const endsAt = parseIsoDate(input.event.endsAt, 'event.endsAt');
      if (endsAt < startsAt) {
        throw new AppError(400, 'invalid_input', 'event.endsAt must be after or equal to event.startsAt');
      }
    }
    return;
  }

  if (input.event) {
    throw new AppError(400, 'invalid_input', 'event fields are only valid when kind=event');
  }

  if (!hasTitle && !hasSummary && !hasBody) {
    throw new AppError(400, 'invalid_input', 'At least one of title, summary, or body must be provided');
  }
}

function validateUpdateEventPatch(event?: Partial<EventInput> | null): void {
  if (!event) return;
  if (event.startsAt) parseIsoDate(event.startsAt, 'event.startsAt');
  if (event.endsAt) parseIsoDate(event.endsAt, 'event.endsAt');
  if (event.startsAt && event.endsAt) {
    const startsAt = new Date(event.startsAt);
    const endsAt = new Date(event.endsAt);
    if (endsAt < startsAt) {
      throw new AppError(400, 'invalid_input', 'event.endsAt must be after or equal to event.startsAt');
    }
  }
}

type CreateInput = {
  clubId?: string;
  threadId?: string;
  kind: z.infer<typeof entityKind>;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  clientKey: string | null;
  event?: EventInput | null;
};

const entitiesCreate: ActionDefinition = {
  action: 'content.create',
  domain: 'content',
  description: 'Create public content or respond inside an existing content thread.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership. Subject to the unified daily content quota.',
  businessErrors: [...CONTENT_CREATE_ERRORS],
  notes: [
    'Publishes immediately. There is no draft-save state.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Required when starting a new thread. Ignored when threadId is provided.'),
      threadId: wireRequiredString.optional().describe('Existing content thread to respond to. Omit to start a new thread.'),
      kind: entityKind.describe('Content kind'),
      title: wireOptionalString.describe('Title'),
      summary: wireOptionalString.describe('Summary'),
      body: wireOptionalString.describe('Body text'),
      expiresAt: wireOptionalString.describe('ISO 8601 expiration timestamp'),
      clientKey: wireOptionalString.describe('Idempotency key scoped per member.'),
      event: wireEventFieldsCreate.describe('Required when kind=event.'),
    }),
    output: z.object({ entity: contentEntity, included: includedBundle }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      threadId: parseRequiredString.optional(),
      kind: entityKind,
      title: parseTrimmedNullableString.default(null),
      summary: parseTrimmedNullableString.default(null),
      body: parseTrimmedNullableString.default(null),
      expiresAt: parseTrimmedNullableString.default(null),
      clientKey: parseTrimmedNullableString.default(null),
      event: parseEventFieldsCreate,
    }),
  },

  qualityGate: 'content-create',
  preGate: async (input, ctx) => {
    const parsed = input as CreateInput;
    validateCreatePayload(parsed);
    if (!parsed.threadId && !parsed.clubId) {
      throw new AppError(400, 'invalid_input', 'clubId is required when starting a new thread');
    }
    await ctx.repository.preflightCreateEntityMentions?.({
      actorMemberId: ctx.actor.member.id,
      actorClubIds: ctx.actor.memberships.map((membership) => membership.clubId),
      clubId: parsed.clubId,
      threadId: parsed.threadId,
      title: parsed.title,
      summary: parsed.summary,
      body: parsed.body,
      clientKey: parsed.clientKey,
    });
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const parsed = input as CreateInput;
    validateCreatePayload(parsed);

    if (!parsed.threadId && !parsed.clubId) {
      throw new AppError(400, 'invalid_input', 'clubId is required when starting a new thread');
    }

    if (parsed.clubId) {
      ctx.requireAccessibleClub(parsed.clubId);
    }

    const createInput = {
      authorMemberId: ctx.actor.member.id,
      kind: parsed.kind,
      title: parsed.title,
      summary: parsed.summary,
      body: parsed.body,
      expiresAt: parsed.expiresAt,
      clientKey: parsed.clientKey,
      ...(parsed.threadId ? { threadId: parsed.threadId } : { clubId: parsed.clubId }),
      ...(parsed.event ? { event: parsed.event } : {}),
    };

    const result = await ctx.repository.createEntity(createInput);

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

type UpdateInput = {
  entityId: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  event?: Partial<EventInput> | null;
};

const entitiesUpdate: ActionDefinition = {
  action: 'content.update',
  domain: 'content',
  description: 'Update an existing content entity (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may update. At least one field must change.',
  businessErrors: [...CONTENT_UPDATE_ERRORS],

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to update'),
      title: wirePatchString.describe('New title'),
      summary: wirePatchString.describe('New summary'),
      body: wirePatchString.describe('New body text'),
      expiresAt: wirePatchString.describe('New expiration timestamp'),
      event: wireEventFieldsPatch.describe('Event patch fields (only valid for event entities)'),
    }),
    output: z.object({ entity: contentEntity, included: includedBundle }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
      title: parsePatchString,
      summary: parsePatchString,
      body: parsePatchString,
      expiresAt: parsePatchString,
      event: parseEventFieldsPatch,
    }).refine(input => {
      const { entityId: _entityId, ...patch } = input;
      return Object.values(patch).some(value => value !== undefined);
    }, 'content.update requires at least one field to change'),
  },

  qualityGate: 'content-create',
  preGate: async (input, ctx) => {
    const parsed = input as UpdateInput;
    validateUpdateEventPatch(parsed.event);
    await ctx.repository.preflightUpdateEntityMentions?.({
      actorMemberId: ctx.actor.member.id,
      actorClubIds: ctx.actor.memberships.map((membership) => membership.clubId),
      entityId: parsed.entityId,
      patch: {
        title: parsed.title,
        summary: parsed.summary,
        body: parsed.body,
      },
    });
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, ...patchFields } = input as UpdateInput;
    validateUpdateEventPatch(patchFields.event);

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchFields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    const result = await ctx.repository.updateEntity({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      patch: patch as {
        title?: string | null;
        summary?: string | null;
        body?: string | null;
        expiresAt?: string | null;
        event?: Partial<EventInput> | null;
      },
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

const entitiesRemove: ActionDefinition = {
  action: 'content.remove',
  domain: 'content',
  description: 'Remove an entity inside a public content thread (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may remove their own entity.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to remove'),
      reason: wireOptionalString.describe('Reason for removal (optional)'),
    }),
    output: z.object({ entity: contentEntity, included: includedBundle }),
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

    const result = await ctx.repository.removeEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      reason,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

type GetThreadInput = {
  entityId?: string;
  threadId?: string;
  includeClosed: boolean;
  limit: number;
  cursor: string | null;
};

const contentGetThread: ActionDefinition = {
  action: 'content.getThread',
  domain: 'content',
  description: 'Read a public content thread by thread ID or any entity ID inside it.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      entityId: wireRequiredString.optional().describe('Any entity ID inside the target thread'),
      threadId: wireRequiredString.optional().describe('Thread ID to read directly'),
      includeClosed: z.boolean().optional().describe('Include closed asks, gifts, services, and opportunities in thread reads'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: z.object({
      thread: contentThreadSummary,
      entities: z.array(contentEntity),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      included: includedBundle,
    }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString.optional(),
      threadId: parseRequiredString.optional(),
      includeClosed: z.boolean().optional().default(false),
      limit: parseLimitOf(20, 50),
      cursor: parseCursor,
    }).refine(
      input => !!input.entityId !== !!input.threadId,
      'Provide exactly one of entityId or threadId',
    ),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, threadId, includeClosed, limit, cursor: rawCursor } = input as GetThreadInput;
    const cursor = rawCursor
      ? (() => {
        const [createdAt, entityCursorId] = decodeCursor(rawCursor, 2);
        return { createdAt, entityId: entityCursorId };
      })()
      : null;

    const result = await ctx.repository.readContentThread({
      actorMemberId: ctx.actor.member.id,
      accessibleMemberships: ctx.actor.memberships.map(m => ({
        membershipId: m.membershipId,
        clubId: m.clubId,
      })),
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      threadId,
      includeClosed,
      limit,
      cursor,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Thread not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.thread.clubId, activeClubIds: [result.thread.clubId] },
    };
  },
};

type ListInput = {
  clubId?: string;
  kinds: z.infer<typeof entityKind>[];
  query?: string | null;
  includeClosed: boolean;
  limit: number;
  cursor: string | null;
};

const entitiesList: ActionDefinition = {
  action: 'content.list',
  domain: 'content',
  description: 'List public content threads ordered by thread activity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: wireEntityKinds,
      query: wireOptionalString.describe('Search first-entity text'),
      includeClosed: z.boolean().optional().describe('Include closed first-entity asks, gifts, services, and opportunities'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string().nullable(),
      kinds: z.array(entityKind),
      includeClosed: z.boolean(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(contentThreadSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      included: includedBundle,
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
    const cursor = rawCursor
      ? (() => {
        const [lastActivityAt, threadId] = decodeCursor(rawCursor, 2);
        return { lastActivityAt, threadId };
      })()
      : null;

    const result = await ctx.repository.listEntities({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      kinds,
      limit,
      query: query ?? undefined,
      includeClosed,
      cursor,
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
        included: result.included,
      },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: clubIds,
      },
    };
  },
};

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
  description: 'Find public content entities by semantic similarity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      kinds: z.array(entityKind).optional().describe('Filter by content kinds'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(contentEntitySearchResult),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      included: includedBundle,
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

    const clubIds = clubId
      ? [ctx.requireAccessibleClub(clubId).clubId]
      : ctx.actor.memberships.map(m => m.clubId);

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
    const cursor = rawCursor
      ? (() => {
        const [distance, entityId] = decodeCursor(rawCursor, 2);
        return { distance, entityId };
      })()
      : null;

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
      data: {
        query,
        limit,
        clubScope,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        included: result.included,
      },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

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
    output: z.object({ entity: contentEntity, included: includedBundle }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId } = input as { entityId: string };
    const result = await ctx.repository.closeEntityLoop({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

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
    output: z.object({ entity: contentEntity, included: includedBundle }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId } = input as { entityId: string };
    const result = await ctx.repository.reopenEntityLoop({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

registerActions([
  entitiesCreate,
  entitiesUpdate,
  entitiesRemove,
  contentGetThread,
  entitiesList,
  entitiesFindViaEmbedding,
  entitiesCloseLoop,
  entitiesReopenLoop,
]);
