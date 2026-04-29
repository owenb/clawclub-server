/**
 * Action contracts: superadmin.platform.getOverview, superadmin.members.list, superadmin.members.get,
 * superadmin.members.remove,
 * superadmin.members.createWithAccessToken, superadmin.memberships.create,
 * superadmin.diagnostics.getHealth, superadmin.clubs.list, superadmin.clubs.create,
 * superadmin.clubs.archive, superadmin.clubs.assignOwner, superadmin.clubs.update,
 * superadmin.content.list, superadmin.messages.list, superadmin.messages.get,
 * superadmin.accessTokens.list, superadmin.accessTokens.revoke, superadmin.accessTokens.create
 *
 * Platform-wide actions restricted to server operators (superadmin role).
 */
import { z } from 'zod';
import { requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError } from '../errors.ts';
import { runCreateGateCheck } from '../gate-runner.ts';
import { clubTextPatchSkipsGate, clubTextPatchTouchesFields, mergeClubTextPatch } from './club-text.ts';
import {
  boundedArray,
  decodeOptionalCursor,
  describeClientKey,
  describeOptionalScopedClubId,
  describeScopedClubId,
  paginatedOutput,
  paginationFields,
  wireRequiredString, parseRequiredString,
  wireHumanRequiredString, parseHumanRequiredString,
  wirePublicName, parsePublicName,
  wireEmail, parseEmail,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalBoolean,
  wireShortId, parseShortId,
  wirePatchString, parsePatchString,
  wireIsoDatetime, parseFutureIsoDatetime,
  wirePositiveInt32, parsePositiveInt32,
  wireSlug, parseSlug,
  contentKind,
  membershipRole, membershipCreateInitialStatus,
} from './fields.ts';
import {
  adminOverview, superadminMemberSummary, superadminMemberDetail,
  adminDiagnostics, clubSummary, superadminClubDetail,
  adminContentSummary, adminThreadSummary,
  directMessageEntry,
  includedBundle,
  paginatedOutputWithIncluded,
  bearerTokenSummary, createdBearerToken,
  memberRef, membershipAdminSummary, removedClubSummary, removedMemberSummary,
  notificationProducerSummary,
  notificationProducerTopicSummary,
  createdNotificationProducer,
  rotatedNotificationProducerSecret,
} from './responses.ts';
import {
  clubScopedResult,
  paginatedResultData,
  defineInput,
  registerActions,
  type ActionDefinition,
  type HandlerContext,
  type ActionResult,
} from './registry.ts';

const wireMemberCap = wirePositiveInt32('Explicit member cap. Required when usesFreeAllowance is false. Must fit a Postgres integer.');
const parseMemberCap = parsePositiveInt32();
const SUPERADMIN_DEFAULT_PAGINATION = paginationFields({ defaultLimit: 8, maxLimit: 20 });
const SUPERADMIN_CLUBS_LIST_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 50 });
const SUPERADMIN_ACCESS_TOKENS_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 50 });
const notificationProducerStatus = z.enum(['active', 'disabled']);
const notificationDeliveryClass = z.enum(['transactional', 'informational', 'suggestion']);
const notificationProducerTopicInput = z.object({
  topic: wireRequiredString.describe('Registered topic owned by the producer.'),
  deliveryClass: notificationDeliveryClass.describe('Delivery class used for rate limiting and operator policy.'),
  status: notificationProducerStatus.default('active').describe('Initial topic status.'),
});

async function loadClubForUpdateGate(
  ctx: Pick<HandlerContext, 'repository' | 'actor'>,
  clubId: string,
) {
  const club = await ctx.repository.loadClubForGate({
    actorMemberId: ctx.actor.member.id,
    clubId,
  });
  if (!club) {
    throw new AppError('club_not_found', 'Club not found.');
  }
  if (club.archivedAt !== null) {
    throw new AppError('club_archived', 'Club is archived.');
  }
  return club;
}

// ── superadmin.platform.getOverview ────────────────────────────────

const superadminOverview: ActionDefinition = {
  action: 'superadmin.platform.getOverview',
  domain: 'superadmin',
  description: 'Get platform-wide overview statistics.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({}),
  }),
  wire: {
    output: z.object({ overview: adminOverview }),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const overview = await ctx.repository.adminGetOverview({ actorMemberId: ctx.actor.member.id });
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

  input: defineInput({
    wire: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.wire,
    }),
    parse: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(superadminMemberSummary),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { limit, cursor: rawCursor } = input as SuperadminMembersListInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, id]) => ({ createdAt, id }));

    const result = await ctx.repository.adminListMembers({
      actorMemberId: ctx.actor.member.id,
      limit,
      cursor,
    });

    return { data: paginatedResultData(result) };
  },
};

// ── superadmin.members.get ─────────────────────────────

const superadminMembersGet: ActionDefinition = {
  action: 'superadmin.members.get',
  domain: 'superadmin',
  description: 'Get detailed info for a single member.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      memberId: wireRequiredString.describe('Member to inspect'),
    }),
    parse: z.object({
      memberId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ member: superadminMemberDetail }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { memberId } = input as { memberId: string };

    const member = await ctx.repository.adminGetMember({
      actorMemberId: ctx.actor.member.id,
      memberId,
    });

    if (!member) {
      throw new AppError('member_not_found', 'Member not found');
    }

  return { data: { member } };
  },
};

// ── superadmin.members.remove ───────────────────────────

type SuperadminMembersRemoveInput = {
  clientKey: string;
  memberId: string;
  confirmPublicName: string;
  reason: string;
};

const superadminMembersRemove: ActionDefinition = {
  action: 'superadmin.members.remove',
  domain: 'superadmin',
  description: 'Permanently remove a member and the rows that should disappear with them.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe('Idempotency key for this hard delete.'),
      memberId: wireRequiredString.describe('Member to permanently delete.'),
      confirmPublicName: wireRequiredString.describe('Exact current publicName, used as a destructive-action confirmation.'),
      reason: wireHumanRequiredString.describe('Operator reason for the permanent delete.'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      memberId: parseRequiredString,
      confirmPublicName: parseRequiredString,
      reason: parseHumanRequiredString,
    }),
  }),
  wire: {
    output: z.object({ removedMember: removedMemberSummary }),
  },

  idempotency: {
    getClientKey: (input) => (input as SuperadminMembersRemoveInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:members.remove:${(input as SuperadminMembersRemoveInput).memberId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, memberId, confirmPublicName, reason } = input as SuperadminMembersRemoveInput;

    const removedMember = await ctx.repository.adminRemoveMember({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:members.remove:${memberId}`,
      idempotencyRequestValue: input,
      clientKey,
      memberId,
      confirmPublicName,
      reason,
    });

    if (!removedMember) {
      throw new AppError('member_not_found', 'Member not found.');
    }

    return { data: { removedMember } };
  },
};

// ── superadmin.diagnostics.getHealth ──────────────────────

const superadminDiagnosticsHealth: ActionDefinition = {
  action: 'superadmin.diagnostics.getHealth',
  domain: 'superadmin',
  description: 'Get platform diagnostics and health status.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({}),
  }),
  wire: {
    output: z.object({ diagnostics: adminDiagnostics }),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const diagnostics = await ctx.repository.adminGetDiagnostics({ actorMemberId: ctx.actor.member.id });
    return { data: { diagnostics } };
  },
};

// ── superadmin.clubs.list ──────────────────────────────

type ClubsListInput = {
  includeArchived: boolean;
  limit: number;
  cursor: string | null;
};

const superadminClubsList: ActionDefinition = {
  action: 'superadmin.clubs.list',
  domain: 'superadmin',
  description: 'List all clubs (superadmin only).',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      includeArchived: wireOptionalBoolean.describe('Include archived clubs'),
      ...SUPERADMIN_CLUBS_LIST_PAGINATION.wire,
    }),
    parse: z.object({
      includeArchived: z.boolean().optional().default(false),
      ...SUPERADMIN_CLUBS_LIST_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(clubSummary).extend({
      includeArchived: z.boolean(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { includeArchived, limit, cursor: rawCursor } = input as ClubsListInput;
    const cursor = decodeOptionalCursor(rawCursor, 3, ([archivedAt, name, clubId]) => ({ archivedAt, name, clubId }));

    const clubs = await ctx.repository.listClubs({
      actorMemberId: ctx.actor.member.id,
      includeArchived,
      limit,
      cursor,
    });

    return {
      data: paginatedResultData(clubs, { includeArchived }),
    };
  },
};

// ── superadmin.clubs.get ───────────────────────────────

const superadminClubsGet: ActionDefinition = {
  action: 'superadmin.clubs.get',
  domain: 'superadmin',
  description: 'Get detailed club information and AI budget usage.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe('Club to inspect'),
    }),
    parse: z.object({
      clubId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ club: superadminClubDetail }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clubId } = input as { clubId: string };
    const club = await ctx.repository.adminGetClub({
      actorMemberId: ctx.actor.member.id,
      clubId,
    });
    if (!club) {
      throw new AppError('club_not_found', 'Club not found');
    }
    return { data: { club } };
  },
};

// ── superadmin.clubs.create ────────────────────────────

type ClubsCreateInput = {
  clientKey: string;
  slug: string;
  name: string;
  summary: string;
  admissionPolicy: string | null;
  ownerMemberId: string;
  usesFreeAllowance: boolean;
  memberCap: number | null;
};

const superadminClubsCreate: ActionDefinition = {
  action: 'superadmin.clubs.create',
  domain: 'superadmin',
  description: 'Create a new club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  refreshActorOnSuccess: true,

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe('Idempotency key for this club creation.'),
      slug: wireSlug.describe('URL-safe slug for the club'),
      name: wireHumanRequiredString.describe('Club display name'),
      summary: wireHumanRequiredString.describe('Club summary'),
      admissionPolicy: wireOptionalString.describe('Optional admission policy'),
      ownerMemberId: wireRequiredString.describe('Member ID of the club owner'),
      usesFreeAllowance: wireOptionalBoolean.describe('When true, this club still counts against the owner’s free-club allowance.'),
      memberCap: wireMemberCap,
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      slug: parseSlug,
      name: parseHumanRequiredString,
      summary: parseHumanRequiredString,
      admissionPolicy: parseTrimmedNullableString.default(null),
      ownerMemberId: parseRequiredString,
      usesFreeAllowance: z.boolean().optional().default(true),
      memberCap: parseMemberCap,
    }).refine(
      (input) => input.usesFreeAllowance
        ? input.memberCap === undefined || input.memberCap === null
        : input.memberCap !== undefined && input.memberCap !== null,
      'usesFreeAllowance=false requires an explicit memberCap; usesFreeAllowance=true forbids one',
    ),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as ClubsCreateInput).clientKey,
    getScopeKey: (_input, ctx) => `superadmin:${ctx.actor.member.id}:clubs.create`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const parsed = input as ClubsCreateInput;
    const actorContext = `superadmin:${ctx.actor.member.id}:clubs.create`;
    const requestValue = parsed;

    let replayHit = false;
    if (ctx.repository.peekIdempotencyReplay) {
      replayHit = await ctx.repository.peekIdempotencyReplay({
        clientKey: parsed.clientKey,
        actorContext,
        requestValue,
      });
    }

    if (!replayHit) {
      const existingClub = await ctx.repository.findClubBySlug({
        actorMemberId: ctx.actor.member.id,
        slug: parsed.slug,
      });
      if (existingClub) {
        throw new AppError('slug_conflict', 'A club with that slug already exists.');
      }

      const owner = await ctx.repository.adminGetMember({
        actorMemberId: ctx.actor.member.id,
        memberId: parsed.ownerMemberId,
      });
      if (!owner) {
        throw new AppError('member_not_found', 'Owner member not found or not active.');
      }

      await runCreateGateCheck({
        actionName: 'superadmin.clubs.create',
        actorMemberId: ctx.actor.member.id,
        artifact: {
          kind: 'club',
          name: parsed.name,
          summary: parsed.summary,
          admissionPolicy: parsed.admissionPolicy,
        },
        repository: ctx.repository,
        runLlmGate: ctx.runLlmGate,
        idempotency: {
          clientKey: parsed.clientKey,
          actorContext,
          requestValue,
        },
      });
    }

    const club = await ctx.repository.createClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: actorContext,
      idempotencyRequestValue: requestValue,
      clientKey: parsed.clientKey,
      slug: parsed.slug,
      name: parsed.name,
      summary: parsed.summary,
      admissionPolicy: parsed.admissionPolicy,
      ownerMemberId: parsed.ownerMemberId,
      usesFreeAllowance: parsed.usesFreeAllowance,
      memberCap: parsed.usesFreeAllowance ? null : parsed.memberCap,
      enforceFreeClubLimit: false,
    });

    if (!club) {
      throw new AppError('member_not_found', 'Owner member not found or not active');
    }

    return clubScopedResult(club, { club });
  },
};

// ── superadmin.clubs.archive ───────────────────────────

const superadminClubsArchive: ActionDefinition = {
  action: 'superadmin.clubs.archive',
  domain: 'superadmin',
  description: 'Archive a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'club_archived',
      meaning: 'The club is already archived.',
      recovery: 'Use superadmin.clubs.remove to remove the archived club, or leave it archived.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this club archive.')),
      clubId: wireRequiredString.describe(describeScopedClubId('Club to archive.')),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      clubId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:clubs.archive:${(input as { clubId: string }).clubId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, clubId } = input as { clientKey: string; clubId: string };

    const club = await ctx.repository.archiveClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:clubs.archive:${clubId}`,
      idempotencyRequestValue: input,
      clientKey,
      clubId,
    });

    if (!club) {
      throw new AppError('club_not_found', 'Club not found for archive');
    }

    return clubScopedResult(club, { club });
  },
};

// ── superadmin.clubs.assignOwner ───────────────────────

const superadminClubsAssignOwner: ActionDefinition = {
  action: 'superadmin.clubs.assignOwner',
  domain: 'superadmin',
  description: 'Assign a new owner to a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'member_not_found',
      meaning: 'The requested new owner is missing or does not have an active membership in the club.',
      recovery: 'Create or reactivate the membership first, then retry the ownership transfer.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this owner assignment.')),
      clubId: wireRequiredString.describe(describeScopedClubId('Club to reassign.')),
      ownerMemberId: wireRequiredString.describe('New owner member ID'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      clubId: parseRequiredString,
      ownerMemberId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:clubs.assignOwner:${(input as { clubId: string }).clubId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, clubId, ownerMemberId } = input as { clientKey: string; clubId: string; ownerMemberId: string };

    const club = await ctx.repository.assignClubOwner({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:clubs.assignOwner:${clubId}`,
      idempotencyRequestValue: input,
      clientKey,
      clubId,
      ownerMemberId,
    });

    if (!club) {
      throw new AppError('club_not_found', 'Club or owner member not found for owner assignment');
    }

    return clubScopedResult(club, { club });
  },
};

// ── superadmin.clubs.update ───────────────────────────

type ClubsUpdateInput = {
  clientKey: string;
  clubId: string;
  name?: string;
  summary?: string | null;
  admissionPolicy?: string | null;
  usesFreeAllowance?: boolean;
  memberCap?: number | null;
};

type SuperadminSetDirectoryListedInput = {
  clubId: string;
  listed: boolean;
};

const superadminClubsUpdate: ActionDefinition = {
  action: 'superadmin.clubs.update',
  domain: 'superadmin',
  description: 'Update mutable fields on a club (superadmin only).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'club_archived',
      meaning: 'The club is archived and cannot be updated.',
      recovery: 'Restore the club before changing it.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe('Idempotency key for this club update.'),
      clubId: wireRequiredString.describe(describeScopedClubId('Club to update.')),
      name: wireHumanRequiredString.optional().describe('New club name (cannot be empty if provided)'),
      summary: wirePatchString.describe('Club summary'),
      admissionPolicy: wirePatchString.describe('Admission policy text (1-2000 chars)'),
      usesFreeAllowance: wireOptionalBoolean.describe('Set true to put the club back onto the free allowance; false to move it out.'),
      memberCap: wireMemberCap,
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      clubId: parseRequiredString,
      name: parseHumanRequiredString.optional(),
      summary: parsePatchString,
      admissionPolicy: parsePatchString,
      usesFreeAllowance: z.boolean().optional(),
      memberCap: parseMemberCap,
    }).refine(
      ({ clubId: _clubId, clientKey: _clientKey, ...patch }) =>
        Object.values(patch).some((value) => value !== undefined),
      'superadmin.clubs.update requires at least one field to change',
    ).refine(
      (input) => input.usesFreeAllowance !== false || (input.memberCap !== undefined && input.memberCap !== null),
      'usesFreeAllowance=false requires an explicit memberCap',
    ).refine(
      (input) => input.usesFreeAllowance !== true || input.memberCap === undefined || input.memberCap === null,
      'usesFreeAllowance=true forbids an explicit memberCap',
    ),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  llmGate: {
    async shouldSkip(input, ctx): Promise<boolean> {
      const parsed = input as ClubsUpdateInput;
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      if (!clubTextPatchTouchesFields(parsed)) {
        return true;
      }
      return clubTextPatchSkipsGate(current, parsed);
    },
    async buildArtifact(input, ctx) {
      const parsed = input as ClubsUpdateInput;
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      return {
        kind: 'club' as const,
        ...mergeClubTextPatch(current, parsed),
      };
    },
    async resolveBudgetClubId(input): Promise<string | null> {
      return (input as ClubsUpdateInput).clubId;
    },
  },
  idempotency: {
    getClientKey: (input) => (input as ClubsUpdateInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:clubs.update:${(input as ClubsUpdateInput).clubId}`,
    getRequestValue: (input) => input,
  },
  preGate: async (input, ctx) => {
    const parsed = input as ClubsUpdateInput;
    if (parsed.memberCap !== undefined && parsed.usesFreeAllowance === undefined) {
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      if (current.usesFreeAllowance) {
        throw new AppError('invalid_input', 'memberCap cannot be set while the club still uses the free allowance.');
      }
    }
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clubId, clientKey, ...patch } = input as ClubsUpdateInput;

    const club = await ctx.repository.updateClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:clubs.update:${clubId}`,
      idempotencyRequestValue: input,
      clientKey,
      clubId,
      patch,
    });

    if (!club) {
      throw new AppError('club_not_found', 'Club not found');
    }

    return clubScopedResult(club, { club });
  },
};

const superadminClubsSetDirectoryListed: ActionDefinition = {
  action: 'superadmin.clubs.setDirectoryListed',
  domain: 'superadmin',
  description: 'Set whether any club, including an archived club, appears in the public directory. Changes appear within roughly 60 seconds because the public directory is TTL-cached.',
  auth: 'superadmin',
  scope: { strategy: 'handler' },
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Repeated calls with the same listed value leave the same directory-listed state.',
  },
  businessErrors: [
    {
      code: 'club_not_found',
      meaning: 'The requested club was not found.',
      recovery: 'Use superadmin.clubs.list or superadmin.clubs.get to confirm the clubId.',
    },
  ],
  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list or hide.')),
      listed: z.boolean().describe('Whether the club should appear in the public directory.'),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      listed: z.boolean(),
    }),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clubId, listed } = input as SuperadminSetDirectoryListedInput;
    const club = await ctx.repository.setClubDirectoryListed({ clubId, listed, allowArchived: true });
    if (!club) {
      throw new AppError('club_not_found', 'Club not found.');
    }
    ctx.directoryCache.invalidate();
    return clubScopedResult(club, { club });
  },
};

// ── superadmin.clubs.remove ───────────────────────────

type ClubsRemoveInput = {
  clientKey: string;
  clubId: string;
  confirmSlug: string;
  reason: string;
};

const superadminClubsRemove: ActionDefinition = {
  action: 'superadmin.clubs.remove',
  domain: 'superadmin',
  description: 'Physically remove an archived club after writing one restore archive row.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe('Idempotency key for this club removal.'),
      clubId: wireRequiredString.describe(describeScopedClubId('Archived club to remove.')),
      confirmSlug: wireRequiredString.describe('Exact current slug, used as a destructive-action confirmation.'),
      reason: wireHumanRequiredString.describe('Operator reason for removal.'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      clubId: parseRequiredString,
      confirmSlug: parseRequiredString,
      reason: parseHumanRequiredString,
    }),
  }),
  wire: {
    output: z.object({ removedClub: removedClubSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as ClubsRemoveInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:clubs.remove:${(input as ClubsRemoveInput).clubId}`,
    getRequestValue: (input) => input,
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, clubId, confirmSlug, reason } = input as ClubsRemoveInput;
    const removedClub = await ctx.repository.removeClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:clubs.remove:${clubId}`,
      idempotencyRequestValue: input,
      clientKey,
      clubId,
      confirmSlug,
      reason,
    });
    if (!removedClub) {
      throw new AppError('club_not_found', 'Club not found.');
    }
    return {
      data: {
        removedClub: {
          ...removedClub,
          isExpired: false,
          removedByMember: {
            memberId: ctx.actor.member.id,
            publicName: ctx.actor.member.publicName,
          },
          reason,
        },
      },
      requestScope: requestScopeForClubs(clubId, []),
    };
  },
};

// ── superadmin.removedClubs.list ───────────────────────────

type RemovedClubsListInput = {
  limit: number;
  cursor: string | null;
  clubSlug?: string;
};

const superadminRemovedClubsList: ActionDefinition = {
  action: 'superadmin.removedClubs.list',
  domain: 'superadmin',
  description: 'List archived removed-club snapshots that may still be restorable.',
  auth: 'superadmin',
  safety: 'read_only',
  input: defineInput({
    wire: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.wire,
      clubSlug: wireOptionalString.describe('Optional slug filter for one removed club lineage.'),
    }),
    parse: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.parse,
      clubSlug: parseTrimmedNullableString.transform((value) => value ?? undefined),
    }),
  }),
  wire: {
    output: paginatedOutput(removedClubSummary),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { limit, cursor: rawCursor, clubSlug } = input as RemovedClubsListInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([removedAt, archiveId]) => ({ removedAt, archiveId }));
    const result = await ctx.repository.listRemovedClubs({
      actorMemberId: ctx.actor.member.id,
      limit,
      cursor,
      clubSlug: clubSlug ?? null,
    });
    return {
      data: {
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    };
  },
};

// ── superadmin.removedClubs.restore ───────────────────────────

type RemovedClubsRestoreInput = {
  clientKey: string;
  archiveId: string;
};

const superadminRemovedClubsRestore: ActionDefinition = {
  action: 'superadmin.removedClubs.restore',
  domain: 'superadmin',
  description: 'Restore a previously removed club from its archived payload.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe('Idempotency key for this restore.'),
      archiveId: wireRequiredString.describe('Removed-club archive to restore.'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      archiveId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as RemovedClubsRestoreInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:removedClubs.restore:${(input as RemovedClubsRestoreInput).archiveId}`,
    getRequestValue: (input) => input,
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, archiveId } = input as RemovedClubsRestoreInput;
    const club = await ctx.repository.restoreRemovedClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:removedClubs.restore:${archiveId}`,
      idempotencyRequestValue: input,
      clientKey,
      archiveId,
    });
    if (!club) {
      throw new AppError('club_archive_not_found', 'Removed club archive not found.');
    }
    return {
      data: { club },
      requestScope: requestScopeForClub(club.clubId),
    };
  },
};

// ── superadmin.content.list ──────────────────────────────

type SuperadminContentListInput = {
  clubId?: string;
  kind?: z.infer<typeof contentKind>;
  limit: number;
  cursor: string | null;
};

const superadminContentList: ActionDefinition = {
  action: 'superadmin.content.list',
  domain: 'superadmin',
  description: 'List content across all clubs with optional filters.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter.')),
      kind: contentKind.optional().describe('Filter by content kind'),
      ...SUPERADMIN_DEFAULT_PAGINATION.wire,
    }),
    parse: z.object({
      clubId: parseRequiredString.optional(),
      kind: contentKind.optional().catch(undefined),
      ...SUPERADMIN_DEFAULT_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutputWithIncluded(adminContentSummary),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clubId, kind, limit, cursor: rawCursor } = input as SuperadminContentListInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, id]) => ({ createdAt, id }));

    const result = await ctx.repository.adminListContent({
      actorMemberId: ctx.actor.member.id,
      clubId,
      kind,
      limit,
      cursor,
    });

    return { data: paginatedResultData(result, { included: result.included }) };
  },
};

// ── superadmin.messages.list ──────────────────────────

type SuperadminMessagesThreadsInput = {
  limit: number;
  cursor: string | null;
};

const superadminMessagesThreads: ActionDefinition = {
  action: 'superadmin.messages.list',
  domain: 'superadmin',
  description: 'List DM threads across the platform. DMs are not club-scoped; each thread shows currently shared clubs between participants.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.wire,
    }),
    parse: z.object({
      ...SUPERADMIN_DEFAULT_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(adminThreadSummary),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { limit, cursor: rawCursor } = input as SuperadminMessagesThreadsInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, id]) => ({ createdAt, id }));

    const result = await ctx.repository.adminListThreads({
      actorMemberId: ctx.actor.member.id,
      limit,
      cursor,
    });

    return { data: paginatedResultData(result) };
  },
};

// ── superadmin.messages.get ─────────────────────────────

type SuperadminMessagesReadInput = {
  threadId: string;
  limit: number;
  cursor: string | null;
};

const superadminMessagesRead: ActionDefinition = {
  action: 'superadmin.messages.get',
  domain: 'superadmin',
  description: 'Read a DM thread newest-first as superadmin.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      threadId: wireRequiredString.describe('Thread to read'),
      ...SUPERADMIN_DEFAULT_PAGINATION.wire,
    }),
    parse: z.object({
      threadId: parseRequiredString,
      ...SUPERADMIN_DEFAULT_PAGINATION.parse,
    }),
  }),
  wire: {
    output: z.object({
      thread: adminThreadSummary,
      messages: paginatedOutput(directMessageEntry),
      included: includedBundle,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { threadId, limit, cursor: rawCursor } = input as SuperadminMessagesReadInput;
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, messageId]) => ({ createdAt, messageId }));

    const result = await ctx.repository.adminReadThread({
      actorMemberId: ctx.actor.member.id,
      threadId,
      limit,
      cursor,
    });

    if (!result) {
      throw new AppError('thread_not_found', 'Thread not found');
    }

    return { data: result };
  },
};

// ── superadmin.accessTokens.list ───────────────────────────────

const superadminTokensList: ActionDefinition = {
  action: 'superadmin.accessTokens.list',
  domain: 'superadmin',
  description: 'List bearer tokens for a specific member.',
  auth: 'superadmin',
  safety: 'read_only',

  input: defineInput({
    wire: z.object({
      memberId: wireRequiredString.describe('Member whose tokens to list'),
      ...SUPERADMIN_ACCESS_TOKENS_PAGINATION.wire,
    }),
    parse: z.object({
      memberId: parseRequiredString,
      ...SUPERADMIN_ACCESS_TOKENS_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(bearerTokenSummary),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { memberId, limit, cursor: rawCursor } = input as { memberId: string; limit: number; cursor: string | null };
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, tokenId]) => ({ createdAt, tokenId }));

    const tokens = await ctx.repository.adminListMemberTokens({
      actorMemberId: ctx.actor.member.id,
      memberId,
      limit,
      cursor,
    });

    return { data: tokens };
  },
};

// ── superadmin.accessTokens.revoke ─────────────────────────────

const superadminTokensRevoke: ActionDefinition = {
  action: 'superadmin.accessTokens.revoke',
  domain: 'superadmin',
  description: 'Revoke a bearer token for a specific member.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Revoking the same token repeatedly leaves the same revoked token state and does not append audit rows.',
  },
  businessErrors: [
    {
      code: 'token_not_found',
      meaning: 'The token was not found for the specified member.',
      recovery: 'Refetch superadmin.accessTokens.list for that member and retry only with a visible tokenId.',
    },
  ],

  input: defineInput({
    wire: z.object({
      memberId: wireRequiredString.describe('Member who owns the token'),
      tokenId: wireRequiredString.describe('Token to revoke'),
    }),
    parse: z.object({
      memberId: parseRequiredString,
      tokenId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ token: bearerTokenSummary }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { memberId, tokenId } = input as { memberId: string; tokenId: string };

    const token = await ctx.repository.adminRevokeMemberToken({
      actorMemberId: ctx.actor.member.id,
      memberId,
      tokenId,
    });

    if (!token) {
      throw new AppError('token_not_found', 'Token not found for the specified member');
    }

    return { data: { token } };
  },
};

// ── superadmin.accessTokens.create ─────────────────────────────
//
// Mint a fresh bearer token for an existing active member. This is the
// operator recovery path for cases where a member has lost their bearer
// token and needs a replacement. Registration intentionally returns the
// bearer only once, so there is no self-service replay path through the
// public API.
//
// SECURITY:
//   - `auth: 'superadmin'` is enforced twice: the dispatcher rejects
//     non-superadmins before capability checks, and the handler keeps its
//     own `ctx.requireSuperadmin()` as a defensive backstop.
//   - The target member must exist and have `state = 'active'`. Suspended
//     or removed members cannot be minted for — the repository layer
//     returns `null`, mapped here to `404 not_found`.
//   - Every minted token records `{ mintedBy, mintedAt, mintedVia }` plus
//     an optional `reason` in its metadata for post-hoc audit.
//   - The per-member 10-token self-service quota is intentionally NOT
//     enforced here. This is an ops/recovery path; the quota exists to
//     protect self-service abuse, not admin recovery.
//   - The returned plaintext bearer token is only emitted in this single
//     response; the server stores only the hash in `member_bearer_tokens`
//     and cannot retrieve it later. The admin must deliver it out-of-band.

type SuperadminAccessTokensCreateInput = {
  clientKey: string;
  memberId: string;
  label: string | null;
  expiresAt: string | null;
  reason: string | null;
};

const superadminTokensCreate: ActionDefinition = {
  action: 'superadmin.accessTokens.create',
  domain: 'superadmin',
  description: 'Mint a fresh bearer token for an existing active member. Recovery path for lost or never-persisted tokens.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'secretMint' },
  authorizationNote: 'Requires superadmin global role. The minted token is returned exactly once in plaintext; deliver it out-of-band.',

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this admin bearer token mint. Plaintext tokens are never replayed.')),
      memberId: z.string().max(64).describe('Existing active member to mint a token for (short_id, max 64 characters)'),
      label: wireOptionalString.describe('Human-readable label for the new token (default: "admin-minted")'),
      expiresAt: wireIsoDatetime.nullable().optional().describe('Optional ISO 8601 date or datetime (e.g. "2025-12-31T23:59:59Z"); null or omit for no expiry'),
      reason: wireOptionalString.describe('Optional free-text reason recorded in the token metadata for audit'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      memberId: parseRequiredString.pipe(z.string().max(64, 'memberId must be at most 64 characters')),
      label: parseTrimmedNullableString.default(null),
      expiresAt: parseFutureIsoDatetime.default(null),
      reason: parseTrimmedNullableString.default(null),
    }),
  }),
  wire: {
    output: createdBearerToken,
  },
  idempotency: {
    getClientKey: (input) => (input as SuperadminAccessTokensCreateInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:accessTokens.create:${(input as SuperadminAccessTokensCreateInput).memberId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    // SECURITY: this MUST be the first line. Do not reorder.
    ctx.requireSuperadmin();
    const { clientKey, memberId, label, expiresAt, reason } = input as SuperadminAccessTokensCreateInput;

    const created = await ctx.repository.adminCreateAccessToken({
      actorMemberId: ctx.actor.member.id,
      clientKey,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:accessTokens.create:${memberId}`,
      idempotencyRequestValue: input,
      memberId,
      label,
      expiresAt,
      reason,
    });

    if (!created) {
      throw new AppError('member_not_found', 'Member not found or not active');
    }

    return { data: created };
  },
};

// ── superadmin.members.createWithAccessToken ───────────────────────────

type SuperadminMembersCreateInput = {
  clientKey: string;
  publicName: string;
  email: string;
};

const superadminMembersCreate: ActionDefinition = {
  action: 'superadmin.members.createWithAccessToken',
  domain: 'superadmin',
  description: 'Create a new platform member with a bearer token (no club membership).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'secretMint' },
  businessErrors: [
    {
      code: 'email_already_registered',
      meaning: 'That email is already registered to another member.',
      recovery: 'Use a different email, or recover the existing member out-of-band.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this member + bearer token creation. Plaintext tokens are never replayed.')),
      publicName: wirePublicName.describe('Display name for the new member'),
      email: wireEmail.describe('Private contact email for the new member'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      publicName: parsePublicName,
      email: parseEmail,
    }),
  }),
  wire: {
    output: z.object({
      member: memberRef,
      token: createdBearerToken,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as SuperadminMembersCreateInput).clientKey,
    getScopeKey: (_input, ctx) => `superadmin:${ctx.actor.member.id}:members.createWithAccessToken`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, publicName, email } = input as SuperadminMembersCreateInput;

    const result = await ctx.repository.adminCreateMember({
      actorMemberId: ctx.actor.member.id,
      clientKey,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:members.createWithAccessToken`,
      idempotencyRequestValue: input,
      publicName,
      email,
    });

    return { data: result };
  },
};

// ── superadmin.memberships.create ───────────────────────

type SuperadminMembershipsCreateInput = {
  clientKey: string;
  clubId: string;
  memberId: string;
  role: 'member' | 'clubadmin';
  sponsorId?: string | null;
  initialStatus: 'active';
  reason?: string | null;
};

const superadminMembershipsCreate: ActionDefinition = {
  action: 'superadmin.memberships.create',
  domain: 'superadmin',
  description: 'Add an existing member to a club (bypasses club admin requirement).',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'member_already_active',
      meaning: 'The member already has an active membership in the club.',
      recovery: 'Read the existing membership instead of creating another one.',
    },
    {
      code: 'application_blocked',
      meaning: 'The member has an active application block in this club from a temporary decline block or prior removal/ban.',
      recovery: 'Use the superadmin reactivation path for historical memberships, wait for a temporary block to expire, or remove the block out of band before creating a fresh membership.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this membership creation.')),
      clubId: wireShortId.describe(describeScopedClubId('Club to add the member to.')),
      memberId: wireShortId.describe('Member to add.'),
      role: membershipRole.default('member').describe('Role: member or clubadmin'),
      sponsorId: wireShortId.nullable().optional().describe('Optional sponsoring member.'),
      initialStatus: membershipCreateInitialStatus.default('active').describe('Initial membership status (always active in the reference implementation)'),
      reason: wireOptionalString.describe('Reason for creation'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      clubId: parseShortId,
      memberId: parseShortId,
      role: membershipRole.default('member'),
      sponsorId: parseShortId.nullable().optional().default(null),
      initialStatus: membershipCreateInitialStatus.default('active'),
      reason: parseTrimmedNullableString.default(null),
    }),
  }),
  wire: {
    output: z.object({ membership: membershipAdminSummary }),
  },
  idempotency: {
    getClientKey: (input) => (input as SuperadminMembershipsCreateInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:memberships.create:${(input as SuperadminMembershipsCreateInput).clubId}:${(input as SuperadminMembershipsCreateInput).memberId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, clubId, memberId, role, sponsorId, initialStatus, reason } = input as SuperadminMembershipsCreateInput;
    const initialProfile = ctx.repository.buildMembershipSeedProfile
      ? await ctx.repository.buildMembershipSeedProfile({ memberId, clubId })
      : {
          tagline: null,
          summary: null,
          whatIDo: null,
          knownFor: null,
          servicesSummary: null,
          websiteUrl: null,
          links: [],
        };

    const membership = await ctx.repository.adminCreateMembership({
      actorMemberId: ctx.actor.member.id,
      clientKey,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:memberships.create:${clubId}:${memberId}`,
      idempotencyRequestValue: input,
      clubId,
      memberId,
      role,
      sponsorId,
      initialStatus,
      reason,
      initialProfile: {
        fields: initialProfile,
        generationSource: 'membership_seed',
      },
    });

    if (!membership) {
      throw new AppError('member_not_found', 'Member not found or not active');
    }

    return {
      data: { membership },
      requestScope: requestScopeForClub(clubId),
    };
  },
};

// ── superadmin.notificationProducers.create ───────────────────────

type SuperadminNotificationProducersCreateInput = {
  clientKey: string;
  producerId: string;
  namespacePrefix: string;
  burstLimit?: number | null;
  hourlyLimit?: number | null;
  dailyLimit?: number | null;
  topics: Array<{
    topic: string;
    deliveryClass: 'transactional' | 'informational' | 'suggestion';
    status?: 'active' | 'disabled';
  }>;
};

const superadminNotificationProducersCreate: ActionDefinition = {
  action: 'superadmin.notificationProducers.create',
  domain: 'superadmin',
  description: 'Register a producer, issue its initial secret, and register its initial topics.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'secretMint' },

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this producer secret mint. Plaintext secrets are never replayed.')),
      producerId: wireRequiredString.describe('Stable producer identifier used in headers and registry rows.'),
      namespacePrefix: wireOptionalString.describe('Required topic prefix for this producer. Use empty string only for core-like internal producers.'),
      burstLimit: wirePositiveInt32('Optional burst cap applied to this producer.'),
      hourlyLimit: wirePositiveInt32('Optional hourly cap applied to this producer.'),
      dailyLimit: wirePositiveInt32('Optional daily cap applied to this producer.'),
      topics: boundedArray(notificationProducerTopicInput, {
        minItems: 1,
        maxItems: 100,
        description: 'Initial registered topics owned by this producer.',
      }),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      producerId: parseRequiredString,
      namespacePrefix: parseTrimmedNullableString.transform((value) => value ?? ''),
      burstLimit: parsePositiveInt32(),
      hourlyLimit: parsePositiveInt32(),
      dailyLimit: parsePositiveInt32(),
      topics: boundedArray(z.object({
        topic: parseRequiredString,
        deliveryClass: notificationDeliveryClass,
        status: notificationProducerStatus.default('active'),
      }), { minItems: 1, maxItems: 100 }),
    }),
  }),
  wire: {
    output: createdNotificationProducer,
  },
  idempotency: {
    getClientKey: (input) => (input as SuperadminNotificationProducersCreateInput).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:notificationProducers.create:${(input as SuperadminNotificationProducersCreateInput).producerId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const parsed = input as SuperadminNotificationProducersCreateInput;
    const created = await ctx.repository.adminCreateNotificationProducer({
      actorMemberId: ctx.actor.member.id,
      clientKey: parsed.clientKey,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:notificationProducers.create:${parsed.producerId}`,
      idempotencyRequestValue: input,
      producerId: parsed.producerId,
      namespacePrefix: parsed.namespacePrefix,
      burstLimit: parsed.burstLimit,
      hourlyLimit: parsed.hourlyLimit,
      dailyLimit: parsed.dailyLimit,
      topics: parsed.topics,
    });
    return { data: created };
  },
};

// ── superadmin.notificationProducers.rotateSecret ───────────────────────

const superadminNotificationProducersRotateSecret: ActionDefinition = {
  action: 'superadmin.notificationProducers.rotateSecret',
  domain: 'superadmin',
  description: 'Rotate a producer secret with dual-secret overlap.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'secretMint' },

  input: defineInput({
    wire: z.object({
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this producer secret rotation. Plaintext secrets are never replayed.')),
      producerId: wireRequiredString.describe('Producer whose secret should be rotated.'),
    }),
    parse: z.object({
      clientKey: parseRequiredString,
      producerId: parseRequiredString,
    }),
  }),
  wire: {
    output: rotatedNotificationProducerSecret,
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (input, ctx) => `superadmin:${ctx.actor.member.id}:notificationProducers.rotateSecret:${(input as { producerId: string }).producerId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { clientKey, producerId } = input as { clientKey: string; producerId: string };
    const rotated = await ctx.repository.adminRotateNotificationProducerSecret({
      actorMemberId: ctx.actor.member.id,
      clientKey,
      idempotencyActorContext: `superadmin:${ctx.actor.member.id}:notificationProducers.rotateSecret:${producerId}`,
      idempotencyRequestValue: input,
      producerId,
    });
    if (!rotated) {
      throw new AppError('not_found', 'Notification producer not found.');
    }
    return { data: rotated };
  },
};

// ── superadmin.notificationProducers.updateStatus ───────────────────────

const superadminNotificationProducersUpdateStatus: ActionDefinition = {
  action: 'superadmin.notificationProducers.updateStatus',
  domain: 'superadmin',
  description: 'Enable or disable a producer globally.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Producer status updates set one status value; repeating the same status leaves the same producer state.',
  },

  input: defineInput({
    wire: z.object({
      producerId: wireRequiredString.describe('Producer to enable or disable.'),
      status: notificationProducerStatus.describe('New producer status.'),
    }),
    parse: z.object({
      producerId: parseRequiredString,
      status: notificationProducerStatus,
    }),
  }),
  wire: {
    output: z.object({ producer: notificationProducerSummary }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { producerId, status } = input as { producerId: string; status: 'active' | 'disabled' };
    const producer = await ctx.repository.adminUpdateNotificationProducerStatus({
      actorMemberId: ctx.actor.member.id,
      producerId,
      status,
    });
    if (!producer) {
      throw new AppError('not_found', 'Notification producer not found.');
    }
    return { data: { producer } };
  },
};

// ── superadmin.notificationProducerTopics.updateStatus ───────────────────────

const superadminNotificationProducerTopicsUpdateStatus: ActionDefinition = {
  action: 'superadmin.notificationProducerTopics.updateStatus',
  domain: 'superadmin',
  description: 'Enable or disable a single producer topic.',
  auth: 'superadmin',
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Producer topic status updates set one status value; repeating the same status leaves the same topic state.',
  },

  input: defineInput({
    wire: z.object({
      producerId: wireRequiredString.describe('Producer that owns the topic.'),
      topic: wireRequiredString.describe('Registered topic to update.'),
      status: notificationProducerStatus.describe('New topic status.'),
    }),
    parse: z.object({
      producerId: parseRequiredString,
      topic: parseRequiredString,
      status: notificationProducerStatus,
    }),
  }),
  wire: {
    output: z.object({ topic: notificationProducerTopicSummary }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    const { producerId, topic, status } = input as {
      producerId: string;
      topic: string;
      status: 'active' | 'disabled';
    };
    const updatedTopic = await ctx.repository.adminUpdateNotificationProducerTopicStatus({
      actorMemberId: ctx.actor.member.id,
      producerId,
      topic,
      status,
    });
    if (!updatedTopic) {
      throw new AppError('not_found', 'Notification producer topic not found.');
    }
    return { data: { topic: updatedTopic } };
  },
};

registerActions([
  superadminOverview, superadminMembersList, superadminMembersGet, superadminMembersRemove,
  superadminMembersCreate,
  superadminDiagnosticsHealth, superadminClubsList, superadminClubsGet, superadminClubsCreate,
  superadminClubsArchive, superadminClubsAssignOwner, superadminClubsUpdate,
  superadminClubsSetDirectoryListed,
  superadminClubsRemove, superadminRemovedClubsList, superadminRemovedClubsRestore,
  superadminMembershipsCreate,
  superadminContentList,
  superadminMessagesThreads, superadminMessagesRead,
  superadminTokensList, superadminTokensRevoke, superadminTokensCreate,
  superadminNotificationProducersCreate,
  superadminNotificationProducersRotateSecret,
  superadminNotificationProducersUpdateStatus,
  superadminNotificationProducerTopicsUpdateStatus,
]);
