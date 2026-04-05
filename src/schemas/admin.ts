/**
 * Action contracts: admin.clubs.stats, admin.content.list, admin.content.archive,
 * admin.content.redact, admin.messages.threads, admin.messages.read, admin.messages.redact,
 * admin.tokens.list, admin.tokens.revoke
 *
 * These are superadmin actions that operate within club scope and may become
 * owner-scoped in future.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireLimit, parseLimit,
  wireCursor, parseCursor,
  entityKind,
} from './fields.ts';

function encodeAdminCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeAdminCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof createdAt !== 'string' || typeof id !== 'string') throw new Error();
    return { createdAt, id };
  } catch {
    throw new AppError(400, 'invalid_input', 'Invalid pagination cursor');
  }
}
import {
  adminClubStats, adminContentSummary, adminThreadSummary,
  directMessageEntry, redactionResult,
  bearerTokenSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admin.clubs.stats ───────────────────────────────────

const adminClubsStats: ActionDefinition = {
  action: 'admin.clubs.stats',
  domain: 'admin',
  description: 'Get statistics for a single club.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminGetClubStats',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to inspect'),
    }),
    output: z.object({ stats: adminClubStats }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminGetClubStats');
    const { clubId } = input as { clubId: string };

    const stats = await ctx.repository.adminGetClubStats!({
      actorMemberId: ctx.actor.member.id,
      clubId,
    });

    if (!stats) {
      throw new AppError(404, 'not_found', 'Club not found');
    }

    return { data: { stats } };
  },
};

// ── admin.content.list ──────────────────────────────────

type AdminContentListInput = {
  clubId?: string;
  kind?: 'post' | 'opportunity' | 'service' | 'ask';
  limit: number;
  cursor: string | null;
};

const adminContentList: ActionDefinition = {
  action: 'admin.content.list',
  domain: 'admin',
  description: 'List content across all clubs with optional filters.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminListContent',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Filter by club'),
      kind: entityKind.optional().describe('Filter by entity kind'),
      limit: wireLimit,
      cursor: wireCursor,
    }),
    output: z.object({ content: z.array(adminContentSummary), nextCursor: z.string().nullable() }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      kind: entityKind.optional().catch(undefined),
      limit: parseLimit,
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListContent');
    const { clubId, kind, limit, cursor: rawCursor } = input as AdminContentListInput;
    const cursor = rawCursor ? decodeAdminCursor(rawCursor) : null;

    const content = await ctx.repository.adminListContent!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      kind,
      limit,
      cursor,
    });

    const last = content[content.length - 1];
    const nextCursor = last ? encodeAdminCursor(last.createdAt, last.entityId) : null;

    return { data: { content, nextCursor } };
  },
};

// ── admin.content.archive ───────────────────────────────

const adminContentArchive: ActionDefinition = {
  action: 'admin.content.archive',
  domain: 'admin',
  description: 'Archive an entity as superadmin.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'adminArchiveEntity',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Entity to archive'),
    }),
    output: z.object({ entityId: z.string() }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminArchiveEntity');
    const { entityId } = input as { entityId: string };

    const result = await ctx.repository.adminArchiveEntity!({
      actorMemberId: ctx.actor.member.id,
      entityId,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found or already archived');
    }

    return { data: result };
  },
};

// ── admin.content.redact ────────────────────────────────

const adminContentRedact: ActionDefinition = {
  action: 'admin.content.redact',
  domain: 'admin',
  description: 'Redact an entity as superadmin.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'redactEntity',

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

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('redactEntity');
    const { entityId, reason } = input as { entityId: string; reason: string | null };

    const result = await ctx.repository.redactEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: [],
      ownerClubIds: [],
      entityId,
      reason,
      skipNotification: true,
      skipAuthCheck: true,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found');
    }

    return { data: { redaction: result.redaction } };
  },
};

// ── admin.messages.threads ──────────────────────────────

type AdminMessagesThreadsInput = {
  clubId?: string;
  limit: number;
  cursor: string | null;
};

const adminMessagesThreads: ActionDefinition = {
  action: 'admin.messages.threads',
  domain: 'admin',
  description: 'List DM threads across the platform.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminListThreads',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Filter by club'),
      limit: wireLimit,
      cursor: wireCursor,
    }),
    output: z.object({ threads: z.array(adminThreadSummary), nextCursor: z.string().nullable() }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListThreads');
    const { clubId, limit, cursor: rawCursor } = input as AdminMessagesThreadsInput;
    const cursor = rawCursor ? decodeAdminCursor(rawCursor) : null;

    const threads = await ctx.repository.adminListThreads!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      cursor,
    });

    const last = threads[threads.length - 1];
    const nextCursor = last ? encodeAdminCursor(last.latestMessageAt, last.threadId) : null;

    return { data: { threads, nextCursor } };
  },
};

// ── admin.messages.read ─────────────────────────────────

type AdminMessagesReadInput = {
  threadId: string;
  limit: number;
};

const adminMessagesRead: ActionDefinition = {
  action: 'admin.messages.read',
  domain: 'admin',
  description: 'Read a DM thread as superadmin.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminReadThread',

  wire: {
    input: z.object({
      threadId: wireRequiredString.describe('Thread to read'),
      limit: wireLimit,
    }),
    output: z.object({
      thread: adminThreadSummary,
      messages: z.array(directMessageEntry),
    }),
  },

  parse: {
    input: z.object({
      threadId: parseRequiredString,
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminReadThread');
    const { threadId, limit } = input as AdminMessagesReadInput;

    const result = await ctx.repository.adminReadThread!({
      actorMemberId: ctx.actor.member.id,
      threadId,
      limit,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Thread not found');
    }

    return { data: result };
  },
};

// ── admin.messages.redact ───────────────────────────────

const adminMessagesRedact: ActionDefinition = {
  action: 'admin.messages.redact',
  domain: 'admin',
  description: 'Redact a DM message as superadmin.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'redactMessage',

  wire: {
    input: z.object({
      messageId: wireRequiredString.describe('Message to redact'),
      reason: wireOptionalString.describe('Reason for redaction'),
    }),
    output: z.object({ redaction: redactionResult }),
  },

  parse: {
    input: z.object({
      messageId: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('redactMessage');
    const { messageId, reason } = input as { messageId: string; reason: string | null };

    const result = await ctx.repository.redactMessage!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: [],
      ownerClubIds: [],
      messageId,
      reason,
      skipNotification: true,
      skipAuthCheck: true,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Message not found');
    }

    return { data: { redaction: result.redaction } };
  },
};

// ── admin.tokens.list ───────────────────────────────────

const adminTokensList: ActionDefinition = {
  action: 'admin.tokens.list',
  domain: 'admin',
  description: 'List bearer tokens for a specific member.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminListMemberTokens',

  wire: {
    input: z.object({
      memberId: wireRequiredString.describe('Member whose tokens to list'),
    }),
    output: z.object({ tokens: z.array(bearerTokenSummary) }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListMemberTokens');
    const { memberId } = input as { memberId: string };

    const tokens = await ctx.repository.adminListMemberTokens!({
      actorMemberId: ctx.actor.member.id,
      memberId,
    });

    return { data: { tokens } };
  },
};

// ── admin.tokens.revoke ─────────────────────────────────

const adminTokensRevoke: ActionDefinition = {
  action: 'admin.tokens.revoke',
  domain: 'admin',
  description: 'Revoke a bearer token for a specific member.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'adminRevokeMemberToken',

  wire: {
    input: z.object({
      memberId: wireRequiredString.describe('Member who owns the token'),
      tokenId: wireRequiredString.describe('Token to revoke'),
    }),
    output: z.object({ token: bearerTokenSummary }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
      tokenId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminRevokeMemberToken');
    const { memberId, tokenId } = input as { memberId: string; tokenId: string };

    const token = await ctx.repository.adminRevokeMemberToken!({
      actorMemberId: ctx.actor.member.id,
      memberId,
      tokenId,
    });

    if (!token) {
      throw new AppError(404, 'not_found', 'Token not found for the specified member');
    }

    return { data: { token } };
  },
};

registerActions([
  adminClubsStats, adminContentList, adminContentArchive, adminContentRedact,
  adminMessagesThreads, adminMessagesRead, adminMessagesRedact,
  adminTokensList, adminTokensRevoke,
]);
