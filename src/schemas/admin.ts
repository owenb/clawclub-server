/**
 * Action contracts: admin.overview, admin.members.list, admin.members.get, admin.clubs.stats,
 * admin.content.list, admin.content.archive, admin.content.redact, admin.messages.threads,
 * admin.messages.read, admin.messages.redact, admin.tokens.list, admin.tokens.revoke,
 * admin.diagnostics.health
 */
import { z } from 'zod';
import { AppError } from '../app.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireLimit, parseLimit,
  wireOffset, parseOffset,
  entityKind,
} from './fields.ts';
import {
  adminOverview, adminMemberSummary, adminMemberDetail,
  adminClubStats, adminContentSummary, adminThreadSummary,
  adminDiagnostics, directMessageEntry, redactionResult,
  bearerTokenSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admin.overview ──────────────────────────────────────

const adminOverviewAction: ActionDefinition = {
  action: 'admin.overview',
  domain: 'admin',
  description: 'Get platform-wide overview statistics.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminGetOverview',

  wire: {
    input: z.object({}),
    output: z.object({ overview: adminOverview }),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminGetOverview');
    const overview = await ctx.repository.adminGetOverview!({ actorMemberId: ctx.actor.member.id });
    return { data: { overview } };
  },
};

// ── admin.members.list ──────────────────────────────────

type AdminMembersListInput = {
  limit: number;
  offset: number;
};

const adminMembersList: ActionDefinition = {
  action: 'admin.members.list',
  domain: 'admin',
  description: 'List all members with summary info.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminListMembers',

  wire: {
    input: z.object({
      limit: wireLimit,
      offset: wireOffset,
    }),
    output: z.object({ members: z.array(adminMemberSummary) }),
  },

  parse: {
    input: z.object({
      limit: parseLimit,
      offset: parseOffset,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListMembers');
    const { limit, offset } = input as AdminMembersListInput;

    const members = await ctx.repository.adminListMembers!({
      actorMemberId: ctx.actor.member.id,
      limit,
      offset,
    });

    return { data: { members } };
  },
};

// ── admin.members.get ───────────────────────────────────

const adminMembersGet: ActionDefinition = {
  action: 'admin.members.get',
  domain: 'admin',
  description: 'Get detailed info for a single member.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminGetMember',

  wire: {
    input: z.object({
      memberId: wireRequiredString.describe('Member to inspect'),
    }),
    output: z.object({ member: adminMemberDetail }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminGetMember');
    const { memberId } = input as { memberId: string };

    const member = await ctx.repository.adminGetMember!({
      actorMemberId: ctx.actor.member.id,
      memberId,
    });

    if (!member) {
      throw new AppError(404, 'not_found', 'Member not found');
    }

    return { data: { member } };
  },
};

// ── admin.clubs.stats ───────────────────────────────────

const adminClubsStats: ActionDefinition = {
  action: 'admin.clubs.stats',
  domain: 'admin',
  description: 'Get statistics for a single club.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

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
  offset: number;
};

const adminContentList: ActionDefinition = {
  action: 'admin.content.list',
  domain: 'admin',
  description: 'List content across all clubs with optional filters.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminListContent',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Filter by club'),
      kind: entityKind.optional().describe('Filter by entity kind'),
      limit: wireLimit,
      offset: wireOffset,
    }),
    output: z.object({ content: z.array(adminContentSummary) }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      kind: entityKind.optional().catch(undefined),
      limit: parseLimit,
      offset: parseOffset,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListContent');
    const { clubId, kind, limit, offset } = input as AdminContentListInput;

    const content = await ctx.repository.adminListContent!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      kind,
      limit,
      offset,
    });

    return { data: { content } };
  },
};

// ── admin.content.archive ───────────────────────────────

const adminContentArchive: ActionDefinition = {
  action: 'admin.content.archive',
  domain: 'admin',
  description: 'Archive an entity as superadmin.',
  auth: 'superadmin',
  safety: 'mutating',
  aiExposed: false,

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
  aiExposed: false,

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
      entityId,
      reason,
      skipNotification: true,
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
  offset: number;
};

const adminMessagesThreads: ActionDefinition = {
  action: 'admin.messages.threads',
  domain: 'admin',
  description: 'List DM threads across the platform.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminListThreads',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Filter by club'),
      limit: wireLimit,
      offset: wireOffset,
    }),
    output: z.object({ threads: z.array(adminThreadSummary) }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
      offset: parseOffset,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListThreads');
    const { clubId, limit, offset } = input as AdminMessagesThreadsInput;

    const threads = await ctx.repository.adminListThreads!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      offset,
    });

    return { data: { threads } };
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
  aiExposed: false,

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
  aiExposed: false,

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
      messageId,
      reason,
      skipNotification: true,
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
  aiExposed: false,

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
  aiExposed: false,

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

// ── admin.diagnostics.health ────────────────────────────

const adminDiagnosticsHealth: ActionDefinition = {
  action: 'admin.diagnostics.health',
  domain: 'admin',
  description: 'Get platform diagnostics and health status.',
  auth: 'superadmin',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'adminGetDiagnostics',

  wire: {
    input: z.object({}),
    output: z.object({ diagnostics: adminDiagnostics }),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminGetDiagnostics');
    const diagnostics = await ctx.repository.adminGetDiagnostics!({ actorMemberId: ctx.actor.member.id });
    return { data: { diagnostics } };
  },
};

registerActions([
  adminOverviewAction, adminMembersList, adminMembersGet,
  adminClubsStats, adminContentList, adminContentArchive, adminContentRedact,
  adminMessagesThreads, adminMessagesRead, adminMessagesRedact,
  adminTokensList, adminTokensRevoke, adminDiagnosticsHealth,
]);
