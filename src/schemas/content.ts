/**
 * Action contracts: content.create, content.update, content.remove, content.get,
 * content.list, content.searchBySemanticSimilarity, content.setLoopState
 */
import { z } from 'zod';
import { membershipScopes, requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError } from '../repository.ts';
import type { NonApplicationArtifact } from '../gate.ts';
import { QUOTA_ACTIONS } from '../quota-metadata.ts';
import { compareIsoTimestamp } from '../timestamps.ts';
import {
  describeClientKey,
  describeOptionalScopedClubId,
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalOpaqueString, parseTrimmedNullableOpaqueString,
  wireLargeOptionalString, parseLargeTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireLargePatchString, parseLargePatchString,
  wireContentKinds, parseContentKinds,
  boundedArray,
  contentKind,
  decodeOptionalCursor,
  paginatedOutput,
  paginationFields,
  wireEventFieldsCreate, parseEventFieldsCreate,
  wireEventFieldsPatch, parseEventFieldsPatch,
} from './fields.ts';
import {
  content,
  contentSearchResult,
  contentThread,
  contentThreadSummary,
  contentWithIncluded,
  includedBundle,
  membershipSummary,
  paginatedOutputWithIncluded,
} from './responses.ts';
import {
  clubScopedResult,
  paginatedResultData,
  registerActions,
  type ActionDefinition,
  type HandlerContext,
  type ActionResult,
  type LlmGateBuildContext,
} from './registry.ts';
import { logger } from '../logger.ts';
import { outboundLlmSignal } from '../workers/environment.ts';

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
    meaning: 'The member has reached the rolling content.create quota for this club.',
    recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
  },
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used with a different payload.',
    recovery: 'Generate a new clientKey for the new creation intent, or resend the exact same payload to replay safely.',
  },
  {
    code: 'invalid_mentions',
    meaning: 'One or more mention spans points to a member that cannot be resolved in the writer scope.',
    recovery: 'Read error.details.invalidSpans, remove or correct those mention spans, and retry.',
  },
  {
    code: 'low_quality_content',
    meaning: 'The content gate rejected the submission for being too low-information or generic.',
    recovery: 'Relay the feedback to the user, add the missing concrete detail, and resubmit.',
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

const CONTENT_GET_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 50 });
const CONTENT_LIST_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });
const CONTENT_SEMANTIC_SEARCH_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });

const CONTENT_UPDATE_ERRORS = [
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used with a different content update payload.',
    recovery: 'Generate a fresh clientKey for a different update intent, or resend the exact same payload to replay safely.',
  },
  {
    code: 'forbidden_scope',
    meaning: 'The content exists, but the caller is not allowed to update it.',
    recovery: 'Only the original author can update content through content.update.',
  },
  {
    code: 'invalid_mentions',
    meaning: 'One or more changed mention spans points to a member that cannot be resolved in the writer scope.',
    recovery: 'Read error.details.invalidSpans, remove or correct those mention spans, and retry.',
  },
  {
    code: 'low_quality_content',
    meaning: 'The content gate rejected the update for being too low-information or generic.',
    recovery: 'Relay the feedback to the user, add the missing concrete detail, and resubmit.',
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
    throw new AppError('invalid_input', `${fieldName} must be a valid ISO 8601 timestamp`);
  }
  return parsed;
}

function validateCreatePayload(input: {
  kind: z.infer<typeof contentKind>;
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
      throw new AppError('invalid_input', 'kind=event requires an event object');
    }
    if (!hasTitle) {
      throw new AppError('invalid_input', 'kind=event requires a title');
    }
    const startsAt = parseIsoDate(input.event.startsAt, 'event.startsAt');
    if (input.event.endsAt) {
      const endsAt = parseIsoDate(input.event.endsAt, 'event.endsAt');
      if (endsAt < startsAt) {
        throw new AppError('invalid_input', 'event.endsAt must be after or equal to event.startsAt');
      }
    }
    return;
  }

  if (input.event) {
    throw new AppError('invalid_input', 'event fields are only valid when kind=event');
  }

  if (!hasTitle && !hasSummary && !hasBody) {
    throw new AppError('invalid_input', 'At least one of title, summary, or body must be provided');
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
      throw new AppError('invalid_input', 'event.endsAt must be after or equal to event.startsAt');
    }
  }
}

type CreateInput = {
  clubId?: string;
  threadId?: string;
  kind: z.infer<typeof contentKind>;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  clientKey: string | null;
  event?: EventInput | null;
};

async function buildCreateArtifact(input: CreateInput): Promise<NonApplicationArtifact> {
  if (input.kind === 'event') {
    return {
      kind: 'event',
      title: input.title,
      summary: input.summary,
      body: input.body,
      location: input.event!.location,
      startsAt: input.event!.startsAt,
      endsAt: input.event!.endsAt ?? null,
      timezone: input.event!.timezone ?? null,
    };
  }

  return {
    kind: 'content',
    contentKind: input.kind,
    isReply: Boolean(input.threadId),
    title: input.title,
    summary: input.summary,
    body: input.body,
  };
}

const contentsCreate: ActionDefinition = {
  action: 'content.create',
  domain: 'content',
  description: 'Create public content or respond inside an existing content thread.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'optional' },
  authorizationNote: 'Requires club membership. Subject to the rolling unified content quota.',
  businessErrors: [...CONTENT_CREATE_ERRORS],
  notes: [
    'Publishes immediately. There is no draft-save state.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Required when starting a new thread. Ignored when threadId is provided.')),
      threadId: wireRequiredString.optional().describe('Existing content thread to respond to. Omit to start a new thread.'),
      kind: contentKind.describe('Content kind'),
      title: wireOptionalString.describe('Title'),
      summary: wireOptionalString.describe('Summary'),
      body: wireLargeOptionalString.describe('Body text'),
      expiresAt: wireOptionalString.describe('ISO 8601 expiration timestamp'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Idempotency key for this content creation.')),
      event: wireEventFieldsCreate.describe('Required when kind=event.'),
    }),
    output: contentWithIncluded,
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      threadId: parseRequiredString.optional(),
      kind: contentKind,
      title: parseTrimmedNullableString.default(null),
      summary: parseTrimmedNullableString.default(null),
      body: parseLargeTrimmedNullableString.default(null),
      expiresAt: parseTrimmedNullableString.default(null),
      clientKey: parseTrimmedNullableOpaqueString.default(null),
      event: parseEventFieldsCreate,
    }),
  },

  llmGate: {
    async buildArtifact(input): Promise<NonApplicationArtifact> {
      return buildCreateArtifact(input as CreateInput);
    },
    async resolveBudgetClubId(input, ctx): Promise<string | null> {
      const parsed = input as CreateInput;
      if (parsed.threadId) {
        return ctx.repository.resolveContentThreadClubIdForGate({
          actorMemberId: ctx.actor.member.id,
          threadId: parsed.threadId,
          accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
        }) ?? null;
      }
      if (parsed.clubId) return parsed.clubId;
      return null;
    },
  },
  quotaAction: QUOTA_ACTIONS.contentCreate,
  idempotency: {
    getClientKey: (input) => (input as CreateInput).clientKey ?? null,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:content.create`,
    getRequestValue: (input, ctx) => {
      const parsed = input as CreateInput;
      return {
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
    },
  },
  preGate: async (input, ctx) => {
    const parsed = input as CreateInput;
    validateCreatePayload(parsed);
    if (!parsed.threadId && !parsed.clubId) {
      throw new AppError('invalid_input', 'clubId is required when starting a new thread');
    }
    await ctx.repository.preflightCreateContentMentions({
      actorMemberId: ctx.actor.member.id,
      actorClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      clubId: parsed.threadId ? undefined : parsed.clubId,
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
      throw new AppError('invalid_input', 'clubId is required when starting a new thread');
    }

    if (!parsed.threadId && parsed.clubId) {
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

    const result = await ctx.repository.createContent(createInput);

    return clubScopedResult(result.content, result);
  },
};

type UpdateInput = {
  id: string;
  clientKey?: string | null;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  event?: Partial<EventInput> | null;
};

async function buildUpdateArtifact(input: UpdateInput, ctx: LlmGateBuildContext): Promise<NonApplicationArtifact> {
  const current = await ctx.repository.loadContentForGate({
    actorMemberId: ctx.actor.member.id,
    id: input.id,
    accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
  });
  if (!current) {
    throw new AppError('content_not_found', 'Content not found inside the actor scope');
  }

  const title = input.title !== undefined ? input.title : current.title;
  const summary = input.summary !== undefined ? input.summary : current.summary;
  const body = input.body !== undefined ? input.body : current.body;

  if (current.contentKind === 'event') {
    return {
      kind: 'event',
      title,
      summary,
      body,
      location: input.event?.location ?? current.event!.location,
      startsAt: input.event?.startsAt ?? current.event!.startsAt,
      endsAt: input.event?.endsAt ?? current.event!.endsAt,
      timezone: input.event?.timezone ?? current.event!.timezone,
    };
  }

  return {
    kind: 'content',
    contentKind: current.contentKind,
    isReply: current.isReply,
    title,
    summary,
    body,
  };
}

function contentUpdateHasEffectiveChange(
  current: import('../repository.ts').ContentForGate,
  input: UpdateInput,
): boolean {
  const nextTitle = input.title !== undefined ? input.title : current.title;
  const nextSummary = input.summary !== undefined ? input.summary : current.summary;
  const nextBody = input.body !== undefined ? input.body : current.body;
  const nextExpiresAt = input.expiresAt !== undefined ? input.expiresAt : current.expiresAt;

  if (nextTitle !== current.title) return true;
  if (nextSummary !== current.summary) return true;
  if (nextBody !== current.body) return true;
  if (compareIsoTimestamp(nextExpiresAt, current.expiresAt) !== 0) return true;

  if (current.contentKind !== 'event') {
    return input.event !== undefined;
  }

  const currentEvent = current.event;
  if (!currentEvent) {
    return input.event !== undefined;
  }

  const nextEvent = {
    location: input.event?.location !== undefined ? input.event.location ?? null : currentEvent.location,
    startsAt: input.event?.startsAt !== undefined ? input.event.startsAt ?? null : currentEvent.startsAt,
    endsAt: input.event?.endsAt !== undefined ? input.event.endsAt ?? null : currentEvent.endsAt,
    timezone: input.event?.timezone !== undefined ? input.event.timezone ?? null : currentEvent.timezone,
    recurrenceRule: input.event?.recurrenceRule !== undefined
      ? input.event.recurrenceRule ?? null
      : currentEvent.recurrenceRule,
    capacity: input.event?.capacity !== undefined ? input.event.capacity ?? null : currentEvent.capacity,
  };

  return nextEvent.location !== currentEvent.location
    || compareIsoTimestamp(nextEvent.startsAt, currentEvent.startsAt) !== 0
    || compareIsoTimestamp(nextEvent.endsAt, currentEvent.endsAt) !== 0
    || nextEvent.timezone !== currentEvent.timezone
    || nextEvent.recurrenceRule !== currentEvent.recurrenceRule
    || nextEvent.capacity !== currentEvent.capacity;
}

async function isContentUpdateNoOp(input: UpdateInput, ctx: LlmGateBuildContext): Promise<boolean> {
  const current = await ctx.repository.loadContentForGate({
    actorMemberId: ctx.actor.member.id,
    id: input.id,
    accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
  });
  if (!current) {
    throw new AppError('content_not_found', 'Content not found inside the actor scope');
  }
  return !contentUpdateHasEffectiveChange(current, input);
}

const contentsUpdate: ActionDefinition = {
  action: 'content.update',
  domain: 'content',
  description: 'Update existing public content (author only).',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'optional' },
  authorizationNote: 'Only the original author may update. At least one field must change.',
  businessErrors: [...CONTENT_UPDATE_ERRORS],

  wire: {
    input: z.object({
      id: wireRequiredString.describe('Content to update'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Idempotency key for this content update.')),
      title: wirePatchString.describe('New title'),
      summary: wirePatchString.describe('New summary'),
      body: wireLargePatchString.describe('New body text'),
      expiresAt: wirePatchString.describe('New expiration timestamp'),
      event: wireEventFieldsPatch.describe('Event patch fields (only valid for event contents)'),
    }),
    output: contentWithIncluded,
  },

  parse: {
    input: z.object({
      id: parseRequiredString,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
      title: parsePatchString,
      summary: parsePatchString,
      body: parseLargePatchString,
      expiresAt: parsePatchString,
      event: parseEventFieldsPatch,
    }).refine(input => {
      const { id: _id, clientKey: _clientKey, ...patch } = input;
      return Object.values(patch).some(value => value !== undefined);
    }, 'content.update requires at least one field to change'),
  },

  llmGate: {
    async shouldSkip(input, ctx): Promise<boolean> {
      return isContentUpdateNoOp(input as UpdateInput, ctx);
    },
    async buildArtifact(input, ctx): Promise<NonApplicationArtifact> {
      return buildUpdateArtifact(input as UpdateInput, ctx);
    },
    async resolveBudgetClubId(input, ctx): Promise<string | null> {
      const parsed = input as UpdateInput;
      return ctx.repository.resolveContentClubIdForGate({
        actorMemberId: ctx.actor.member.id,
        contentId: parsed.id,
        accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      }) ?? null;
    },
  },
  idempotency: {
    getClientKey: (input) => (input as UpdateInput).clientKey ?? null,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:content.update:${(input as UpdateInput).id}`,
    getRequestValue: (input, ctx) => {
      const parsed = input as UpdateInput;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== 'id' && key !== 'clientKey' && value !== undefined) {
          patch[key] = value;
        }
      }
      return {
        actorMemberId: ctx.actor.member.id,
        id: parsed.id,
        clientKey: parsed.clientKey,
        patch,
      };
    },
  },
  preGate: async (input, ctx) => {
    const parsed = input as UpdateInput;
    validateUpdateEventPatch(parsed.event);
    await ctx.repository.preflightUpdateContentMentions({
      actorMemberId: ctx.actor.member.id,
      actorClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      id: parsed.id,
      patch: {
        title: parsed.title,
        summary: parsed.summary,
        body: parsed.body,
      },
    });
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { id, clientKey, ...patchFields } = input as UpdateInput;
    validateUpdateEventPatch(patchFields.event);

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchFields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    const result = await ctx.repository.updateContent({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      id,
      clientKey,
      patch: patch as {
        title?: string | null;
        summary?: string | null;
        body?: string | null;
        expiresAt?: string | null;
        event?: Partial<EventInput> | null;
      },
    });

    if (!result) {
      throw new AppError('content_not_found', 'Content not found inside the actor scope');
    }

    return clubScopedResult(result.content, result);
  },
};

const contentsRemove: ActionDefinition = {
  action: 'content.remove',
  domain: 'content',
  description: 'Remove content inside a public content thread (author only).',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Removing the same content twice leaves the database in the same removed state; divergent terminal retries raise content_already_removed.',
  },
  authorizationNote: 'Only the original author may remove their own content.',
  businessErrors: [
    {
      code: 'forbidden_scope',
      meaning: 'The content exists, but the caller is not the author.',
      recovery: 'Do not retry as this actor. Ask the author or a club admin to remove the content.',
    },
    {
      code: 'content_already_removed',
      meaning: 'The content was already removed before this request.',
      recovery: 'Read the canonical removed content in error.details.content and stop retrying the remove intent.',
    },
  ],

  wire: {
    input: z.object({
      id: wireRequiredString.describe('Content to remove'),
      reason: wireOptionalString.describe('Reason for removal (optional)'),
    }),
    output: contentWithIncluded,
  },

  parse: {
    input: z.object({
      id: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { id, reason } = input as { id: string; reason: string | null };

    const result = await ctx.repository.removeContent({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      id,
      reason,
    });

    if (!result) {
      throw new AppError('content_not_found', 'Content not found inside the actor scope');
    }

    return clubScopedResult(result.content, result);
  },
};

type GetThreadInput = {
  contentId?: string;
  threadId?: string;
  includeClosed: boolean;
  limit: number;
  cursor: string | null;
};

const contentGetThread: ActionDefinition = {
  action: 'content.get',
  domain: 'content',
  description: 'Read a public content thread by thread ID or any content ID inside it.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      contentId: wireRequiredString.optional().describe('Any content id inside the target thread'),
      threadId: wireRequiredString.optional().describe('Thread ID to read directly'),
      includeClosed: z.boolean().optional().describe('Include closed asks, gifts, services, and opportunities in thread reads'),
      ...CONTENT_GET_PAGINATION.wire,
    }),
    output: z.object({
      thread: contentThreadSummary,
      contents: paginatedOutput(content),
      included: includedBundle,
    }),
  },

  parse: {
    input: z.object({
      contentId: parseRequiredString.optional(),
      threadId: parseRequiredString.optional(),
      includeClosed: z.boolean().optional().default(false),
      ...CONTENT_GET_PAGINATION.parse,
    }).refine(
      input => !!input.contentId !== !!input.threadId,
      'Provide exactly one of contentId or threadId',
    ),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { contentId, threadId, includeClosed, limit, cursor: rawCursor } = input as GetThreadInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, contentId]) => ({ createdAt, contentId }));

    const result = await ctx.repository.readContentThread({
      actorMemberId: ctx.actor.member.id,
      accessibleMemberships: ctx.actor.memberships.map(m => ({
        membershipId: m.membershipId,
        clubId: m.clubId,
      })),
      accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      contentId,
      threadId,
      includeClosed,
      limit,
      cursor,
    });

    if (!result) {
      throw new AppError(
        contentId ? 'content_not_found' : 'thread_not_found',
        contentId ? 'Content not found inside the actor scope' : 'Thread not found inside the actor scope',
      );
    }

    return clubScopedResult(result.thread, {
      thread: result.thread,
      contents: paginatedResultData({
        results: result.contents,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      }),
      included: result.included,
    });
  },
};

type ListInput = {
  clubId?: string;
  kinds: z.infer<typeof contentKind>[];
  query?: string | null;
  includeClosed: boolean;
  limit: number;
  cursor: string | null;
};

const contentsList: ActionDefinition = {
  action: 'content.list',
  domain: 'content',
  description: 'List public content threads ordered by thread activity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for content listing.')),
      kinds: wireContentKinds,
      query: wireOptionalString.describe('Search thread subject text'),
      includeClosed: z.boolean().optional().describe('Include closed ask, gift, service, and opportunity subjects'),
      ...CONTENT_LIST_PAGINATION.wire,
    }),
    output: paginatedOutputWithIncluded(contentThread, {
      query: z.string().nullable(),
      kinds: z.array(contentKind),
      includeClosed: z.boolean(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      kinds: parseContentKinds,
      query: parseTrimmedNullableString,
      includeClosed: z.boolean().optional().default(false),
      ...CONTENT_LIST_PAGINATION.parse,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kinds, query, includeClosed, limit, cursor: rawCursor } = input as ListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map(c => c.clubId);
    const cursor = decodeOptionalCursor(rawCursor, 2, ([latestActivityAt, threadId]) => ({ latestActivityAt, threadId }));

    const result = await ctx.repository.listContent({
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
      requestScope: requestScopeForClubs(clubId ?? null, clubIds),
    };
  },
};

type ContentFindViaEmbeddingInput = {
  query: string;
  clubId?: string;
  kinds?: string[];
  limit: number;
  cursor: string | null;
};

const contentsFindViaEmbedding: ActionDefinition = {
  action: 'content.searchBySemanticSimilarity',
  domain: 'content',
  description: 'Find public content by semantic similarity.',
  auth: 'member',
  safety: 'read_only',
  businessErrors: [
    {
      code: 'quota_exceeded',
      meaning: 'The member has reached the rolling semantic-search quota.',
      recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
    },
  ],

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for semantic content search.')),
      kinds: boundedArray(contentKind, { minItems: 1, maxItems: 6 }).optional().describe('Filter by content kinds'),
      ...CONTENT_SEMANTIC_SEARCH_PAGINATION.wire,
    }),
    output: paginatedOutputWithIncluded(contentSearchResult, {
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      query: z.string().trim().min(1).max(1000),
      clubId: parseRequiredString.optional(),
      kinds: boundedArray(contentKind, { minItems: 1, maxItems: 6 }).optional(),
      ...CONTENT_SEMANTIC_SEARCH_PAGINATION.parse,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, kinds, limit, cursor: rawCursor } = input as ContentFindViaEmbeddingInput;
    const { EMBEDDING_PROFILES, embedQueryText, isEmbeddingStubEnabled } = await import('../ai.ts');
    const { AppError: AppErr } = await import('../errors.ts');

    const profile = EMBEDDING_PROFILES.content;
    const clubIds = clubId
      ? [ctx.requireAccessibleClub(clubId).clubId]
      : membershipScopes(ctx.actor.memberships).clubIds;

    if (clubIds.length === 0) {
      throw new AppErr('forbidden_scope', 'This member does not currently have access to any clubs');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && !isEmbeddingStubEnabled()) {
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'content.searchBySemanticSimilarity',
        artifactKind: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'no_api_key',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: null,
        feedback: null,
      })?.catch(() => {});
      throw new AppErr('embedding_unavailable', 'Embedding service is not configured');
    }

    await ctx.repository.enforceEmbeddingQueryQuota?.({ memberId: ctx.actor.member.id });

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embedQueryText({
        value: query,
        profile: 'content',
        abortSignal: outboundLlmSignal(),
      });
      embedding = result.embedding;
      usageTokens = result.usageTokens;
    } catch (err) {
      logger.error('content_embedding_query_error', err, {
        actionName: 'content.searchBySemanticSimilarity',
        clubId: clubId ?? null,
        memberId: ctx.actor.member.id,
      });
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'content.searchBySemanticSimilarity',
        artifactKind: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'provider_error',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        feedback: null,
      })?.catch(() => {});
      throw new AppErr('embedding_unavailable', 'Embedding service is temporarily unavailable');
    }

    ctx.repository.logLlmUsage?.({
      memberId: ctx.actor.member.id,
      requestedClubId: clubId ?? null,
      actionName: 'content.searchBySemanticSimilarity',
      artifactKind: 'embedding_query',
      provider: 'openai',
      model: profile.model,
      gateStatus: 'passed',
      skipReason: null,
      promptTokens: usageTokens,
      completionTokens: 0,
      providerErrorCode: null,
      feedback: null,
    })?.catch(() => {});

    const queryVector = `[${embedding.join(',')}]`;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([distance, contentId]) => ({ distance, contentId }));

    const result = await ctx.repository.findContentViaEmbedding({
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
      requestScope: requestScopeForClubs(clubId ?? null, clubIds),
    };
  },
};

const contentSetLoopState: ActionDefinition = {
  action: 'content.setLoopState',
  domain: 'content',
  description: 'Open or close an ask, gift, service, or opportunity (author only).',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Setting a loop to the same open/closed state repeatedly leaves one current published loop state.',
  },
  authorizationNote: 'Only the original author may change the loop state of their own published loopable content.',
  businessErrors: [
    {
      code: 'forbidden_scope',
      meaning: 'The content exists, but the caller is not the author.',
      recovery: 'Do not retry as this actor. Ask the original author to change the loop state.',
    },
    {
      code: 'invalid_state',
      meaning: 'The content exists but is not a loopable kind.',
      recovery: 'Only asks, gifts, services, and opportunities have open/closed loop state.',
    },
  ],

  wire: {
    input: z.object({
      id: wireRequiredString.describe('Content whose loop state should change'),
      state: z.enum(['open', 'closed']).describe('Target loop state'),
    }),
    output: contentWithIncluded,
  },

  parse: {
    input: z.object({
      id: parseRequiredString,
      state: z.enum(['open', 'closed']),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { id, state } = input as { id: string; state: 'open' | 'closed' };
    const result = state === 'closed'
      ? await ctx.repository.closeContentLoop({
          actorMemberId: ctx.actor.member.id,
          accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
          id,
        })
      : await ctx.repository.reopenContentLoop({
          actorMemberId: ctx.actor.member.id,
          accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
          id,
        });

    if (!result) {
      throw new AppError('content_not_found', 'Content not found inside the actor scope');
    }

    return clubScopedResult(result.content, result);
  },
};

registerActions([
  contentsCreate,
  contentsUpdate,
  contentsRemove,
  contentGetThread,
  contentsList,
  contentsFindViaEmbedding,
  contentSetLoopState,
]);
