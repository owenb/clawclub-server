/**
 * Action contracts: superadmin.overview, superadmin.members.list, superadmin.members.get,
 * superadmin.diagnostics.health, superadmin.clubs.list, superadmin.clubs.create,
 * superadmin.clubs.archive, superadmin.clubs.assignOwner, superadmin.clubs.update,
 * superadmin.content.list, superadmin.content.archive, superadmin.content.redact,
 * superadmin.messages.threads, superadmin.messages.read, superadmin.messages.redact,
 * superadmin.tokens.list, superadmin.tokens.revoke
 *
 * Platform-wide actions restricted to server operators (superadmin role).
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalBoolean,
  wirePatchString, parsePatchString,
  wireLimit, parseLimit,
  wireCursor, parseCursor,
  wireSlug, parseSlug,
  entityKind,
} from './fields.ts';
import {
  adminOverview, adminMemberSummary, adminMemberDetail,
  adminDiagnostics, clubSummary,
  adminContentSummary, adminThreadSummary,
  directMessageEntry,
  bearerTokenSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

function encodeSuperadminCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeSuperadminCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof createdAt !== 'string' || typeof id !== 'string') throw new Error();
    return { createdAt, id };
  } catch {
    throw new AppError(400, 'invalid_input', 'Invalid pagination cursor');
  }
}

// ── superadmin.overview ────────────────────────────────

const superadminOverview: ActionDefinition = {
  action: 'superadmin.overview',
  domain: 'superadmin',
  description: 'Get platform-wide overview statistics.',
  auth: 'superadmin',
  safety: 'read_only',

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

// ── superadmin.members.list ────────────────────────────

type SuperadminMembersListInput = {
  limit: number;
  cursor: string | null;
};

const superadminMembersList: ActionDefinition = {
  action: 'superadmin.members.list',
  domain: 'superadmin',
  description: 'List all members with summary info.',
  auth: 'superadmin',
  safety: 'read_only',

  requiredCapability: 'adminListMembers',

  wire: {
    input: z.object({
      limit: wireLimit,
      cursor: wireCursor,
    }),
    output: z.object({ members: z.array(adminMemberSummary), nextCursor: z.string().nullable() }),
  },

  parse: {
    input: z.object({
      limit: parseLimit,
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('adminListMembers');
    const { limit, cursor: rawCursor } = input as SuperadminMembersListInput;
    const cursor = rawCursor ? decodeSuperadminCursor(rawCursor) : null;

    const members = await ctx.repository.adminListMembers!({
      actorMemberId: ctx.actor.member.id,
      limit,
      cursor,
    });

    const last = members[members.length - 1];
    const nextCursor = last ? encodeSuperadminCursor(last.createdAt, last.memberId) : null;

    return { data: { members, nextCursor } };
  },
};

// ── superadmin.members.get ─────────────────────────────

const superadminMembersGet: ActionDefinition = {
  action: 'superadmin.members.get',
  domain: 'superadmin',
  description: 'Get detailed info for a single member.',
  auth: 'superadmin',
  safety: 'read_only',

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

// ── superadmin.diagnostics.health ──────────────────────

const superadminDiagnosticsHealth: ActionDefinition = {
  action: 'superadmin.diagnostics.health',
  domain: 'superadmin',
  description: 'Get platform diagnostics and health status.',
  auth: 'superadmin',
  safety: 'read_only',

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

// ── superadmin.clubs.list ──────────────────────────────

type ClubsListInput = {
  includeArchived: boolean;
};

const superadminClubsList: ActionDefinition = {
  action: 'superadmin.clubs.list',
  domain: 'superadmin',
  description: 'List all clubs (superadmin only).',
  auth: 'superadmin',
  safety: 'read_only',

  wire: {
    input: z.object({
      includeArchived: wireOptionalBoolean.describe('Include archived clubs'),
    }),
    output: z.object({
      includeArchived: z.boolean(),
      clubs: z.array(clubSummary),
    }),
  },

  parse: {
    input: z.object({
      includeArchived: z.boolean().optional().default(false),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { includeArchived } = input as ClubsListInput;

    const clubs = await ctx.repository.listClubs?.({
      actorMemberId: ctx.actor.member.id,
      includeArchived,
    });

    return {
      data: {
        includeArchived,
        clubs: clubs ?? [],
      },
    };
  },
};

// ── superadmin.clubs.create ────────────────────────────

type ClubsCreateInput = {
  slug: string;
  name: string;
  summary: string;
  ownerMemberId: string;
};

const superadminClubsCreate: ActionDefinition = {
  action: 'superadmin.clubs.create',
  domain: 'superadmin',
  description: 'Create a new club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'createClub',

  wire: {
    input: z.object({
      slug: wireSlug.describe('URL-safe slug for the club'),
      name: wireRequiredString.describe('Club display name'),
      summary: wireRequiredString.describe('Club summary'),
      ownerMemberId: wireRequiredString.describe('Member ID of the club owner'),
    }),
    output: z.object({ club: clubSummary }),
  },

  parse: {
    input: z.object({
      slug: parseSlug,
      name: parseRequiredString,
      summary: parseRequiredString,
      ownerMemberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('createClub');
    const { slug, name, summary, ownerMemberId } = input as ClubsCreateInput;

    let club: Awaited<ReturnType<NonNullable<typeof ctx.repository.createClub>>>;
    try {
      club = await ctx.repository.createClub!({
        actorMemberId: ctx.actor.member.id,
        slug,
        name,
        summary,
        ownerMemberId,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
          'constraint' in error && typeof error.constraint === 'string' && error.constraint.includes('slug')) {
        throw new AppError(409, 'slug_conflict', 'A club with that slug already exists');
      }
      throw error;
    }

    if (!club) {
      throw new AppError(404, 'not_found', 'Owner member not found or not active');
    }

    return {
      data: { club },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── superadmin.clubs.archive ───────────────────────────

const superadminClubsArchive: ActionDefinition = {
  action: 'superadmin.clubs.archive',
  domain: 'superadmin',
  description: 'Archive a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'archiveClub',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to archive'),
    }),
    output: z.object({ club: clubSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('archiveClub');
    const { clubId } = input as { clubId: string };

    const club = await ctx.repository.archiveClub!({
      actorMemberId: ctx.actor.member.id,
      clubId,
    });

    if (!club) {
      throw new AppError(404, 'not_found', 'Club not found for archive');
    }

    return {
      data: { club },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── superadmin.clubs.assignOwner ───────────────────────

const superadminClubsAssignOwner: ActionDefinition = {
  action: 'superadmin.clubs.assignOwner',
  domain: 'superadmin',
  description: 'Assign a new owner to a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'assignClubOwner',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to reassign'),
      ownerMemberId: wireRequiredString.describe('New owner member ID'),
    }),
    output: z.object({ club: clubSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      ownerMemberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('assignClubOwner');
    const { clubId, ownerMemberId } = input as { clubId: string; ownerMemberId: string };

    const club = await ctx.repository.assignClubOwner!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      ownerMemberId,
    });

    if (!club) {
      throw new AppError(404, 'not_found', 'Club or owner member not found for owner assignment');
    }

    return {
      data: { club },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── superadmin.clubs.update ───────────────────────────

type ClubsUpdateInput = {
  clubId: string;
  name?: string;
  summary?: string | null;
  admissionPolicy?: string | null;
};

const superadminClubsUpdate: ActionDefinition = {
  action: 'superadmin.clubs.update',
  domain: 'superadmin',
  description: 'Update mutable fields on a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'updateClub',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to update'),
      name: wireRequiredString.optional().describe('New club name (cannot be empty if provided)'),
      summary: wirePatchString.describe('Club summary'),
      admissionPolicy: wirePatchString.describe('Admission policy text (1-2000 chars)'),
    }),
    output: z.object({ club: clubSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      name: parseRequiredString.optional(),
      summary: parsePatchString,
      admissionPolicy: parsePatchString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('updateClub');
    const { clubId, ...patch } = input as ClubsUpdateInput;

    if (patch.name === undefined && patch.summary === undefined &&
        patch.admissionPolicy === undefined) {
      throw new AppError(400, 'invalid_input', 'At least one field to update must be provided');
    }

    const club = await ctx.repository.updateClub!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      patch,
    });

    if (!club) {
      throw new AppError(404, 'not_found', 'Club not found');
    }

    return {
      data: { club },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── superadmin.content.list ──────────────────────────────

type SuperadminContentListInput = {
  clubId?: string;
  kind?: 'post' | 'opportunity' | 'service' | 'ask';
  limit: number;
  cursor: string | null;
};

const superadminContentList: ActionDefinition = {
  action: 'superadmin.content.list',
  domain: 'superadmin',
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
    const { clubId, kind, limit, cursor: rawCursor } = input as SuperadminContentListInput;
    const cursor = rawCursor ? decodeSuperadminCursor(rawCursor) : null;

    const content = await ctx.repository.adminListContent!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      kind,
      limit,
      cursor,
    });

    const last = content[content.length - 1];
    const nextCursor = last ? encodeSuperadminCursor(last.createdAt, last.entityId) : null;

    return { data: { content, nextCursor } };
  },
};

// ── superadmin.messages.threads ──────────────────────────

type SuperadminMessagesThreadsInput = {
  clubId?: string;
  limit: number;
  cursor: string | null;
};

const superadminMessagesThreads: ActionDefinition = {
  action: 'superadmin.messages.threads',
  domain: 'superadmin',
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
    const { clubId, limit, cursor: rawCursor } = input as SuperadminMessagesThreadsInput;
    const cursor = rawCursor ? decodeSuperadminCursor(rawCursor) : null;

    const threads = await ctx.repository.adminListThreads!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      cursor,
    });

    const last = threads[threads.length - 1];
    const nextCursor = last ? encodeSuperadminCursor(last.latestMessageAt, last.threadId) : null;

    return { data: { threads, nextCursor } };
  },
};

// ── superadmin.messages.read ─────────────────────────────

type SuperadminMessagesReadInput = {
  threadId: string;
  limit: number;
};

const superadminMessagesRead: ActionDefinition = {
  action: 'superadmin.messages.read',
  domain: 'superadmin',
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
    const { threadId, limit } = input as SuperadminMessagesReadInput;

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

// ── superadmin.tokens.list ───────────────────────────────

const superadminTokensList: ActionDefinition = {
  action: 'superadmin.tokens.list',
  domain: 'superadmin',
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

// ── superadmin.tokens.revoke ─────────────────────────────

const superadminTokensRevoke: ActionDefinition = {
  action: 'superadmin.tokens.revoke',
  domain: 'superadmin',
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
  superadminOverview, superadminMembersList, superadminMembersGet,
  superadminDiagnosticsHealth, superadminClubsList, superadminClubsCreate,
  superadminClubsArchive, superadminClubsAssignOwner, superadminClubsUpdate,
  superadminContentList,
  superadminMessagesThreads, superadminMessagesRead,
  superadminTokensList, superadminTokensRevoke,
]);
