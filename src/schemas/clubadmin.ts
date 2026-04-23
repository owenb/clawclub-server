/**
 * Club admin action contracts: clubadmin.members.list, clubadmin.members.get,
 * clubadmin.applications.list, clubadmin.applications.get,
 * clubadmin.members.update,
 * clubadmin.clubs.getStatistics
 *
 * All actions require auth: 'clubadmin' — the caller must be a club admin,
 * the club owner, or a superadmin. All actions require an explicit clubId.
 */
import { z } from 'zod';
import { requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError } from '../repository.ts';
import { adminApplicationState, applicationPhase } from './application-shapes.ts';
import {
  describeClientKey,
  describeScopedClubId,
  wireRequiredString, parseRequiredString,
  wireHumanRequiredString, parseHumanRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  membershipState,
  membershipRole,
  wireMembershipStates,
  type MembershipState,
  wireCursor, parseCursor, decodeOptionalCursor,
  paginatedOutput,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import {
  adminClubStats,
  adminMemberSummary,
  clubSummary,
  content, contentWithIncluded, messageRemovalResult,
  membershipSummary,
  membershipAdminSummary,
} from './responses.ts';
import {
  clubScopedPaginatedResult,
  registerActions,
  type ActionDefinition,
  type HandlerContext,
  type ActionResult,
} from './registry.ts';

const CLUBADMIN_SCOPE_RULES = [
  'clubadmin actions require an explicit clubId. Use the stable clubId from session.getContext.activeMemberships; the server does not infer it from session context and does not accept clubSlug here.',
] as const;

const CLUBADMIN_FORBIDDEN_ERROR = {
  code: 'forbidden',
  meaning: 'Caller is not a clubadmin in the requested club.',
  recovery: 'Cross-check clubId against session.getContext.activeMemberships and only call clubadmin.* for clubs where role == "clubadmin".',
} as const;

const MEMBER_STATUSES = ['active', 'cancelled'] as const;

const wireMembershipRoles = z.array(membershipRole).min(1).optional();
const parseOptionalMembershipStates = z.array(membershipState).min(1)
  .optional()
  .transform((states) => states ? [...new Set(states)] : undefined);
const parseMembershipRoles = z.array(membershipRole).min(1)
  .optional()
  .transform((roles) => roles ? [...new Set(roles)] : undefined);
const parseApplicationPhases = z.array(applicationPhase).min(1)
  .optional()
  .transform((phases) => phases ? [...new Set(phases)] : undefined);

function assertStateSubset(
  states: MembershipState[] | undefined,
  allowed: readonly MembershipState[],
  siblingAction: string,
): void {
  if (!states) return;
  const invalid = states.filter((state) => !allowed.includes(state));
  if (invalid.length > 0) {
    throw new AppError('invalid_input', `Statuses ${invalid.join(', ')} are out of scope here. Try ${siblingAction}.`);
  }
}

async function loadClubForUpdateGate(
  ctx: Pick<HandlerContext, 'repository' | 'actor'>,
  clubId: string,
) {
  const club = await ctx.repository.loadClubForGate?.({
    actorMemberId: ctx.actor.member.id,
    clubId,
  });
  if (!club) {
    throw new AppError('club_not_found', 'Club not found.');
  }
  return club;
}

function mergeClubTextPatch(
  current: { name: string; summary: string | null; admissionPolicy: string | null },
  patch: { name?: string; summary?: string | null; admissionPolicy?: string | null },
) {
  return {
    name: patch.name !== undefined ? patch.name : current.name,
    summary: patch.summary !== undefined ? patch.summary : current.summary,
    admissionPolicy: patch.admissionPolicy !== undefined ? patch.admissionPolicy : current.admissionPolicy,
  };
}

function clubTextPatchIsNoOp(
  current: { name: string; summary: string | null; admissionPolicy: string | null },
  patch: { name?: string; summary?: string | null; admissionPolicy?: string | null },
): boolean {
  const merged = mergeClubTextPatch(current, patch);
  return merged.name === current.name
    && merged.summary === current.summary
    && merged.admissionPolicy === current.admissionPolicy;
}

// ── clubadmin.members.list ─────────────────────────

type ClubadminMembersListInput = {
  clubId: string;
  statuses?: MembershipState[];
  roles?: Array<'clubadmin' | 'member'>;
  limit: number;
  cursor: string | null;
};

const clubadminMembersList: ActionDefinition = {
  action: 'clubadmin.members.list',
  domain: 'clubadmin',
  description: 'List accessible members in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list members for.')),
      statuses: wireMembershipStates.describe('Optional membership-state filter limited to active and cancelled'),
      roles: wireMembershipRoles.describe('Optional role filter limited to clubadmin/member'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: paginatedOutput(adminMemberSummary).extend({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      statuses: z.array(membershipState).nullable(),
      roles: z.array(membershipRole).nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      statuses: parseOptionalMembershipStates,
      roles: parseMembershipRoles,
      limit: parseLimitOf(50, 50),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, statuses, roles, limit, cursor: rawCursor } = input as ClubadminMembersListInput;
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);
    assertStateSubset(statuses, MEMBER_STATUSES, 'clubadmin.applications.list');

    const cursor = decodeOptionalCursor(rawCursor, 2, ([joinedAt, membershipId]) => ({ joinedAt, membershipId }));

    const result = await ctx.repository.listAdminMembers({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      statuses: (statuses as Array<'active' | 'cancelled'> | undefined) ?? null,
      roles: roles ?? null,
      cursor,
    });

    return clubScopedPaginatedResult(club, result, {
      limit,
      statuses: statuses ?? null,
      roles: roles ?? null,
    });
  },
};

// ── clubadmin.applications.list ───────────────────────

type ClubadminApplicationsListInput = {
  clubId: string;
  phases?: Array<z.infer<typeof applicationPhase>>;
  limit: number;
  cursor: string | null;
};

const clubadminApplicationsList: ActionDefinition = {
  action: 'clubadmin.applications.list',
  domain: 'clubadmin',
  description: 'List club applications in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  requiredCapability: 'listAdminClubApplications',
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list applications for.')),
      phases: z.array(applicationPhase).min(1).optional().describe('Optional application-phase filter. Defaults to awaiting_review. Include revision_required explicitly to inspect drafts that are still with the applicant.'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: paginatedOutput(adminApplicationState).extend({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      phases: z.array(applicationPhase).nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      phases: parseApplicationPhases,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, phases, limit, cursor: rawCursor } = input as ClubadminApplicationsListInput;
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);
    const result = await ctx.repository.listAdminClubApplications!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      phases: phases ?? null,
      cursor: decodeOptionalCursor(rawCursor, 2, ([submittedAt, applicationId]) => ({ submittedAt, applicationId })),
    });

    return clubScopedPaginatedResult(club, result, {
      limit,
      phases: phases ?? null,
    });
  },
};

// ── clubadmin.members.update ───────────────────

type ClubadminMembersUpdateInput = {
  clubId: string;
  memberId: string;
  patch: {
    role?: 'clubadmin' | 'member';
    status?: MembershipState;
    reason?: string | null;
  };
};

const clubadminMembersUpdate: ActionDefinition = {
  action: 'clubadmin.members.update',
  domain: 'clubadmin',
  description: 'Update a member’s role and/or membership status inside one club.',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Status changes require clubadmin or superadmin. Role changes require the club owner or a superadmin. The club owner cannot be demoted.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  requiredCapability: 'updateMembership',
  businessErrors: [
    CLUBADMIN_FORBIDDEN_ERROR,
    {
      code: 'invalid_state_transition',
      meaning: 'The requested membership status transition is not allowed from the current state.',
      recovery: 'Refresh the membership state and choose one of the legal next statuses for that current state.',
    },
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the membership belongs to.')),
      memberId: wireRequiredString.describe('Member to update'),
      patch: z.object({
        role: membershipRole.optional().describe('Optional role change'),
        status: membershipState.optional().describe('Optional membership status change'),
        reason: wireOptionalString.describe('Reason for the status change').optional(),
      }),
    }),
    output: z.object({ membership: membershipAdminSummary, changed: z.boolean() }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      patch: z.object({
        role: membershipRole.optional(),
        status: membershipState.optional(),
        reason: parseTrimmedNullableString,
      }).refine(
        (patch) => patch.role !== undefined || patch.status !== undefined,
        'patch must include role and/or status',
      ),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, patch } = input as ClubadminMembersUpdateInput;
    ctx.requireClubAdmin(clubId);
    if (patch.role !== undefined) {
      ctx.requireClubOwner(clubId);
    }

    const isSuperadmin = ctx.actor.globalRoles.includes('superadmin');
    const result = await ctx.repository.updateMembership!({
      actorMemberId: ctx.actor.member.id,
      actorIsSuperadmin: isSuperadmin,
      actorMemberships: ctx.actor.memberships,
      clubId,
      memberId,
      patch,
      skipClubAdminCheck: isSuperadmin,
    });

    if (!result) {
      throw new AppError('member_not_found', 'Membership not found in the specified club');
    }

    return {
      data: { membership: result.membership, changed: result.changed },
      requestScope: requestScopeForClub(result.membership.clubId),
    };
  },
};

// ── clubadmin.members.get ─────────────────────────────

const clubadminMembersGet: ActionDefinition = {
  action: 'clubadmin.members.get',
  domain: 'clubadmin',
  description: 'Get one accessible member in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the membership belongs to.')),
      membershipId: wireRequiredString.describe('Membership to fetch'),
    }),
    output: z.object({
      club: z.object({
        clubId: z.string(),
        slug: z.string(),
        name: z.string(),
      }),
      member: adminMemberSummary,
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      membershipId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, membershipId } = input as { clubId: string; membershipId: string };
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);

    const member = await ctx.repository.getAdminMember({
      actorMemberId: ctx.actor.member.id,
      clubId,
      membershipId,
    });

    if (member) {
      return {
        data: {
          club: {
            clubId: club.clubId,
            slug: club.slug,
            name: club.name,
          },
          member,
        },
        requestScope: requestScopeForClub(clubId),
      };
    }

    throw new AppError('member_not_found', 'No active member with that id was found in the specified club');
  },
};

// ── clubadmin.applications.get ─────────────────────────────

const clubadminApplicationsGet: ActionDefinition = {
  action: 'clubadmin.applications.get',
  domain: 'clubadmin',
  description: 'Get one application in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  requiredCapability: 'getAdminClubApplicationById',
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the application belongs to.')),
      applicationId: wireRequiredString.describe('Application to fetch'),
    }),
    output: z.object({
      application: adminApplicationState,
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      applicationId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, applicationId } = input as { clubId: string; applicationId: string };
    ctx.requireClubAdmin(clubId);

    const summary = await ctx.repository.getAdminClubApplicationById!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      applicationId,
    });
    if (summary) {
      return {
        data: { application: summary },
        requestScope: requestScopeForClub(clubId),
      };
    }

    throw new AppError('application_not_found', 'Application not found in the specified club');
  },
};

const clubadminApplicationsDecide: ActionDefinition = {
  action: 'clubadmin.applications.decide',
  domain: 'clubadmin',
  description: 'Accept, decline, or ban one club application.',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Requires club admin role in the specified club.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  requiredCapability: 'decideClubApplication',
  businessErrors: [
    CLUBADMIN_FORBIDDEN_ERROR,
    {
      code: 'application_already_decided',
      meaning: 'Another admin already accepted, declined, or banned this application.',
      recovery: 'Read the returned canonical application state and stop retrying the same decision.',
    },
    {
      code: 'application_not_mutable',
      meaning: 'Only applications currently in awaiting_review can be decided.',
      recovery: 'Read the canonical application state returned in error.details. If the row is revision_required, wait for the applicant to return it to awaiting_review before retrying the decision.',
    },
    {
      code: 'member_already_active',
      meaning: 'The applicant already has an active membership in the club.',
      recovery: 'Read the existing membership instead of retrying acceptance.',
    },
    {
      code: 'member_cap_reached',
      meaning: 'The club is already at its active-member cap.',
      recovery: 'Increase the member cap or free capacity before accepting the application.',
    },
  ],
  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the application belongs to.')),
      applicationId: wireRequiredString.describe('Application to decide'),
      decision: z.enum(['accept', 'decline', 'ban']),
      adminNote: wireOptionalString.describe('Optional admin note stored on the application'),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this admin application decision.')),
    }),
    output: z.object({
      application: adminApplicationState,
    }),
  },
  parse: {
    input: z.object({
      clubId: parseRequiredString,
      applicationId: parseRequiredString,
      decision: z.enum(['accept', 'decline', 'ban']),
      adminNote: parseTrimmedNullableString.default(null),
      clientKey: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, applicationId, decision, adminNote, clientKey } = input as {
      clubId: string;
      applicationId: string;
      decision: 'accept' | 'decline' | 'ban';
      adminNote: string | null;
      clientKey: string;
    };
    ctx.requireClubAdmin(clubId);
    const result = await ctx.repository.decideClubApplication!({
      actorMemberId: ctx.actor.member.id,
      actorPublicName: ctx.actor.member.publicName,
      clubId,
      applicationId,
      decision,
      adminNote,
      clientKey,
    });
    if (!result) {
      throw new AppError('application_not_found', 'Application not found in the specified club');
    }
    const application = result.application as { clubId?: string } | undefined;
    return {
      data: result,
      requestScope: requestScopeForClubs(application?.clubId ?? clubId, [clubId]),
    };
  },
};

// ── clubadmin.clubs.update ──────────────────────────────

type ClubadminClubsUpdateInput = {
  clubId: string;
  clientKey: string;
  name?: string;
  summary?: string | null;
  admissionPolicy?: string | null;
};

const clubadminClubsUpdate: ActionDefinition = {
  action: 'clubadmin.clubs.update',
  domain: 'clubadmin',
  description: 'Update club text as the club owner or a superadmin.',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Requires clubadmin auth on the surface, then narrows to the club owner or a superadmin before mutation.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  requiredCapability: 'updateClub',
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],
  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to update.')),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this club update.')),
      name: wireHumanRequiredString.optional().describe('New club name.'),
      summary: wireOptionalString.describe('New summary.'),
      admissionPolicy: wireOptionalString.describe('New admission policy.'),
    }),
    output: z.object({ club: clubSummary }),
  },
  parse: {
    input: z.object({
      clubId: parseRequiredString,
      clientKey: parseRequiredString,
      name: parseHumanRequiredString.optional(),
      summary: parseTrimmedNullableString,
      admissionPolicy: parseTrimmedNullableString,
    }).refine(
      ({ clubId: _clubId, clientKey: _clientKey, ...patch }) =>
        Object.values(patch).some((value) => value !== undefined),
      'clubadmin.clubs.update requires at least one field to change',
    ),
  },
  llmGate: {
    async shouldSkip(input, ctx): Promise<boolean> {
      const parsed = input as ClubadminClubsUpdateInput;
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      return clubTextPatchIsNoOp(current, parsed);
    },
    async buildArtifact(input, ctx) {
      const parsed = input as ClubadminClubsUpdateInput;
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      return {
        kind: 'club' as const,
        ...mergeClubTextPatch(current, parsed),
      };
    },
    async resolveBudgetClubId(input): Promise<string | null> {
      return (input as ClubadminClubsUpdateInput).clubId;
    },
  },
  idempotency: {
    getClientKey: (input) => (input as ClubadminClubsUpdateInput).clientKey,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:clubs.update:${(input as ClubadminClubsUpdateInput).clubId}`,
    getRequestValue: (input) => input,
  },
  preGate: async (input, ctx) => {
    const { clubId } = input as ClubadminClubsUpdateInput;
    ctx.requireAccessibleClub(clubId);
    ctx.requireClubOwner(clubId);
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, clientKey, ...patch } = input as ClubadminClubsUpdateInput;
    const club = await ctx.repository.updateClub!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      clientKey,
      idempotencyActorContext: `member:${ctx.actor.member.id}:clubs.update:${clubId}`,
      idempotencyRequestValue: input,
      patch,
    });

    if (!club) {
      throw new AppError('club_not_found', 'Club not found.');
    }

    return {
      data: { club },
      requestScope: requestScopeForClub(club.clubId),
    };
  },
};

// ── clubadmin.clubs.getStatistics ──────────────────────────────

const clubadminClubsStats: ActionDefinition = {
  action: 'clubadmin.clubs.getStatistics',
  domain: 'clubadmin',
  description: 'Get statistics for the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],

  requiredCapability: 'adminGetClubStats',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to inspect.')),
    }),
    output: z.object({ stats: adminClubStats }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId } = input as { clubId: string };
    ctx.requireClubAdmin(clubId);

    const stats = await ctx.repository.adminGetClubStats!({
      actorMemberId: ctx.actor.member.id,
      clubId,
    });

    if (!stats) {
      throw new AppError('club_not_found', 'Club not found');
    }

    return { data: { stats } };
  },
};

// ── clubadmin.content.remove ─────────────────────────────

const clubadminContentRemove: ActionDefinition = {
  action: 'clubadmin.content.remove',
  domain: 'clubadmin',
  description: 'Remove any content in the specified club (moderation).',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Club admin may remove any content in their club. Reason is required for moderation audit trail.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [CLUBADMIN_FORBIDDEN_ERROR],
  requiredCapability: 'removeContent',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the content belongs to.')),
      id: wireRequiredString.describe('Content to remove'),
      reason: wireHumanRequiredString.describe('Reason for removal (required for moderation)'),
    }),
    output: contentWithIncluded,
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      id: parseRequiredString,
      reason: parseHumanRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, id, reason } = input as { clubId: string; id: string; reason: string };
    ctx.requireClubAdmin(clubId);

    const result = await ctx.repository.removeContent!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: [clubId],
      id,
      reason,
      moderatorRemoval: { restrictToClubId: clubId },
    });

    if (!result) {
      throw new AppError('content_not_found', 'Content not found in the specified club');
    }

    return {
      data: result,
      requestScope: requestScopeForClub(result.content.clubId),
    };
  },
};

// clubadmin.messages.remove has been removed.
// Messages are no longer club-scoped — club admins have no authority over private messages.

registerActions([
  clubadminMembersList, clubadminApplicationsList,
  clubadminMembersUpdate,
  clubadminMembersGet, clubadminApplicationsGet,
  clubadminApplicationsDecide,
  clubadminClubsUpdate,
  clubadminClubsStats,
  clubadminContentRemove,
]);
