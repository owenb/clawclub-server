/**
 * Action contracts: entities.create, entities.update, entities.archive, entities.redact, entities.list
 */
import { z } from 'zod';
import { AppError } from '../app.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireLimit, parseLimit,
  wireOptionalRecord, parseOptionalRecord,
  wireEntityKinds, parseEntityKinds,
  entityKind,
} from './fields.ts';
import { entitySummary, membershipSummary, redactionResult } from './responses.ts';
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
  aiExposed: true,
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
    }),
  },

  qualityGate: 'entities-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, kind, title, summary, body, expiresAt, content } = input as CreateInput;
    const club = ctx.requireAccessibleClub(clubId);

    const entity = await ctx.repository.createEntity({
      authorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      kind, title, summary, body, expiresAt, content,
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
  aiExposed: false,
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

// ── entities.archive ─────────────────────────────────────

const entitiesArchive: ActionDefinition = {
  action: 'entities.archive',
  domain: 'content',
  description: 'Archive an entity (author only).',
  auth: 'member',
  safety: 'mutating',
  aiExposed: true,
  authorizationNote: 'Only the original author may archive.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to archive'),
    }),
    output: z.object({ entity: entitySummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  requiredCapability: 'archiveEntity',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId } = input as { entityId: string };
    ctx.requireCapability('archiveEntity');

    const entity = await ctx.repository.archiveEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
    });

    if (!entity) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    if (entity.author.memberId !== ctx.actor.member.id) {
      throw new AppError(403, 'forbidden', 'Only the author may archive this entity');
    }

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

// ── entities.redact ──────────────────────────────────────

const entitiesRedact: ActionDefinition = {
  action: 'entities.redact',
  domain: 'content',
  description: 'Redact an entity (author or club owner).',
  auth: 'member',
  safety: 'mutating',
  aiExposed: false,
  authorizationNote: 'Author or club owner may redact.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to redact'),
      reason: wireOptionalString.describe('Reason for redaction'),
    }),
    output: z.object({ redaction: redactionResult }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  requiredCapability: 'redactEntity',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, reason } = input as { entityId: string; reason: string | null };
    ctx.requireCapability('redactEntity');

    const result = await ctx.repository.redactEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      reason,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
    }

    const isAuthor = result.authorMemberId === ctx.actor.member.id;
    const isOwner = ctx.actor.memberships.some(m => m.clubId === result.redaction.clubId && m.role === 'owner');
    if (!isAuthor && !isOwner) {
      throw new AppError(403, 'forbidden', 'Only the author or a club owner may redact this entity');
    }

    return {
      data: { redaction: result.redaction },
      requestScope: { requestedClubId: result.redaction.clubId, activeClubIds: [result.redaction.clubId] },
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
  aiExposed: true,

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

registerActions([entitiesCreate, entitiesUpdate, entitiesArchive, entitiesRedact, entitiesList]);
