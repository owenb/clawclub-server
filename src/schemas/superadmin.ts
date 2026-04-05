/**
 * Action contracts: superadmin.overview, superadmin.members.list, superadmin.members.get,
 * superadmin.diagnostics.health, superadmin.clubs.list, superadmin.clubs.create,
 * superadmin.clubs.archive, superadmin.clubs.assignOwner
 *
 * Platform-wide actions restricted to server operators (superadmin role).
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalBoolean,
  wireLimit, parseLimit,
  wireCursor, parseCursor,
  wireSlug, parseSlug,
} from './fields.ts';
import {
  adminOverview, adminMemberSummary, adminMemberDetail,
  adminDiagnostics, clubSummary,
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

registerActions([
  superadminOverview, superadminMembersList, superadminMembersGet,
  superadminDiagnosticsHealth, superadminClubsList, superadminClubsCreate,
  superadminClubsArchive, superadminClubsAssignOwner,
]);
