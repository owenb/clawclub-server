/**
 * Action contracts: quotas.status, clubs.list, clubs.create, clubs.archive, clubs.assignOwner, tokens.list, tokens.create, tokens.revoke
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalBoolean,
  wireOptionalRecord, parseOptionalRecord,
  wireSlug, parseSlug,
} from './fields.ts';
import {
  quotaAllowance, clubSummary, bearerTokenSummary, createdBearerToken,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── quotas.status ───────────────────────────────────────

const quotasStatus: ActionDefinition = {
  action: 'quotas.status',
  domain: 'platform',
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
    });

    return { data: { quotas } };
  },
};

// ── clubs.list ──────────────────────────────────────────

type ClubsListInput = {
  includeArchived: boolean;
};

const clubsList: ActionDefinition = {
  action: 'clubs.list',
  domain: 'platform',
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

// ── clubs.create ────────────────────────────────────────

type ClubsCreateInput = {
  slug: string;
  name: string;
  summary: string;
  ownerMemberId: string;
};

const clubsCreate: ActionDefinition = {
  action: 'clubs.create',
  domain: 'platform',
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

// ── clubs.archive ───────────────────────────────────────

const clubsArchive: ActionDefinition = {
  action: 'clubs.archive',
  domain: 'platform',
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

// ── clubs.assignOwner ───────────────────────────────────

const clubsAssignOwner: ActionDefinition = {
  action: 'clubs.assignOwner',
  domain: 'platform',
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

// ── tokens.list ─────────────────────────────────────────

const tokensList: ActionDefinition = {
  action: 'tokens.list',
  domain: 'platform',
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

// ── tokens.create ───────────────────────────────────────

type TokensCreateInput = {
  label: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
};

const tokensCreate: ActionDefinition = {
  action: 'tokens.create',
  domain: 'platform',
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

// ── tokens.revoke ───────────────────────────────────────

const tokensRevoke: ActionDefinition = {
  action: 'tokens.revoke',
  domain: 'platform',
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

registerActions([quotasStatus, clubsList, clubsCreate, clubsArchive, clubsAssignOwner, tokensList, tokensCreate, tokensRevoke]);
