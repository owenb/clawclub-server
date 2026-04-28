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
import { clubTextPatchSkipsGate, mergeClubTextPatch } from './club-text.ts';
import {
  boundedArray,
  describeClientKey,
  describeScopedClubId,
  wireRequiredString, parseRequiredString,
  wireHumanRequiredString, parseHumanRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalOpaqueString, parseTrimmedNullableOpaqueString,
  membershipState,
  membershipRole,
  wireMembershipStates,
  type MembershipState,
  decodeOptionalCursor,
  paginatedOutput,
  paginationFields,
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
  defineInput,
  registerActions,
  type ActionDefinition,
  type HandlerContext,
  type ActionResult,
} from './registry.ts';

const CLUBADMIN_SCOPE_RULES = [
  'clubadmin actions require an explicit clubId. Use the stable clubId from session.getContext.activeMemberships; the server does not infer it from session context and does not accept clubSlug here.',
] as const;

const CLUBADMIN_FORBIDDEN_SCOPE_ERROR = {
  code: 'forbidden_scope',
  meaning: 'The requested club is outside the caller access scope.',
  recovery: 'Cross-check clubId against session.getContext.activeMemberships before calling clubadmin.*.',
} as const;

const CLUBADMIN_FORBIDDEN_ROLE_ERROR = {
  code: 'forbidden_role',
  meaning: 'Caller is not a clubadmin in the requested club.',
  recovery: 'Only call clubadmin.* for clubs where role == "clubadmin", or use a superadmin token.',
} as const;

const CLUBADMIN_AUTH_ERRORS = [
  CLUBADMIN_FORBIDDEN_SCOPE_ERROR,
  CLUBADMIN_FORBIDDEN_ROLE_ERROR,
] as const;

const MEMBER_STATUSES = ['active', 'cancelled', 'removed', 'banned'] as const;
const CLUBADMIN_MEMBERS_PAGINATION = paginationFields({ defaultLimit: 50, maxLimit: 50 });
const CLUBADMIN_APPLICATIONS_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });

const wireMembershipRoles = boundedArray(membershipRole, { minItems: 1, maxItems: 2 }).optional();
const parseOptionalMembershipStates = boundedArray(membershipState, { minItems: 1, maxItems: 4 })
  .optional()
  .transform((states) => states ? [...new Set(states)] : undefined);
const parseMembershipRoles = boundedArray(membershipRole, { minItems: 1, maxItems: 2 })
  .optional()
  .transform((roles) => roles ? [...new Set(roles)] : undefined);
const parseApplicationPhases = boundedArray(applicationPhase, { minItems: 1, maxItems: 7 })
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
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
    {
      code: 'member_not_found',
      meaning: 'No active member with that id was found in the specified club.',
      recovery: 'Refetch clubadmin.members.list and retry with a current memberId.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list members for.')),
      statuses: wireMembershipStates.describe('Optional membership-state filter limited to active, cancelled, removed, and banned'),
      roles: wireMembershipRoles.describe('Optional role filter limited to clubadmin/member'),
      ...CLUBADMIN_MEMBERS_PAGINATION.wire,
    }),
    parse: z.object({
      clubId: parseRequiredString,
      statuses: parseOptionalMembershipStates,
      roles: parseMembershipRoles,
      ...CLUBADMIN_MEMBERS_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(adminMemberSummary).extend({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      statuses: z.array(membershipState).nullable(),
      roles: z.array(membershipRole).nullable(),
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
      statuses: statuses ?? null,
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
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
    {
      code: 'application_not_found',
      meaning: 'The application was not found in the specified club.',
      recovery: 'Refetch clubadmin.applications.list and retry with a current applicationId.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list applications for.')),
      phases: boundedArray(applicationPhase, { minItems: 1, maxItems: 7 }).optional().describe('Optional application-phase filter. Defaults to awaiting_review. Include revision_required explicitly to inspect drafts that are still with the applicant.'),
      ...CLUBADMIN_APPLICATIONS_PAGINATION.wire,
    }),
    parse: z.object({
      clubId: parseRequiredString,
      phases: parseApplicationPhases,
      ...CLUBADMIN_APPLICATIONS_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutput(adminApplicationState).extend({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      phases: z.array(applicationPhase).nullable(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, phases, limit, cursor: rawCursor } = input as ClubadminApplicationsListInput;
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);
    const result = await ctx.repository.listAdminClubApplications({
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
  clientKey: string | null;
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
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'optional' },
  authorizationNote: 'Status changes require clubadmin or superadmin. Role changes require the club owner or a superadmin. The club owner cannot be demoted.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
    {
      code: 'invalid_state_transition',
      meaning: 'The requested membership status transition is not allowed from the current state.',
      recovery: 'Refresh the membership state and choose one of the legal next statuses for that current state.',
    },
    {
      code: 'invalid_state',
      meaning: 'The requested role change is not valid for the membership current state.',
      recovery: 'Role changes are only valid while the membership is active.',
    },
  ],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the membership belongs to.')),
      memberId: wireRequiredString.describe('Member to update'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Optional idempotency key for this membership update.')),
      patch: z.object({
        role: membershipRole.optional().describe('Optional role change'),
        status: membershipState.optional().describe('Optional membership status change'),
        reason: wireOptionalString.describe('Reason for the status change').optional(),
      }),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
      patch: z.object({
        role: membershipRole.optional(),
        status: membershipState.optional(),
        reason: parseTrimmedNullableString,
      }).refine(
        (patch) => patch.role !== undefined || patch.status !== undefined,
        'patch must include role and/or status',
      ),
    }),
  }),
  wire: {
    output: z.object({ membership: membershipAdminSummary, changed: z.boolean() }),
  },
  idempotency: {
    getClientKey: (input) => (input as ClubadminMembersUpdateInput).clientKey ?? null,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:clubadmin.members.update:${(input as ClubadminMembersUpdateInput).clubId}:${(input as ClubadminMembersUpdateInput).memberId}`,
    getRequestValue: (input) => input,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, clientKey, patch } = input as ClubadminMembersUpdateInput;
    ctx.requireClubAdmin(clubId);
    if (patch.role !== undefined) {
      ctx.requireClubOwner(clubId);
    }

    const isSuperadmin = ctx.actor.globalRoles.includes('superadmin');
    const updateInput = {
      actorMemberId: ctx.actor.member.id,
      actorIsSuperadmin: isSuperadmin,
      actorMemberships: ctx.actor.memberships,
      clubId,
      memberId,
      patch,
      skipClubAdminCheck: isSuperadmin,
      ...(clientKey ? {
        clientKey,
        idempotencyActorContext: `member:${ctx.actor.member.id}:clubadmin.members.update:${clubId}:${memberId}`,
        idempotencyRequestValue: input,
      } : {}),
    };
    const result = await ctx.repository.updateMembership(updateInput);

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
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [...CLUBADMIN_AUTH_ERRORS],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the membership belongs to.')),
      memberId: wireRequiredString.describe('Member to fetch in the club'),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({
      club: z.object({
        clubId: z.string(),
        slug: z.string(),
        name: z.string(),
      }),
      member: adminMemberSummary,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId } = input as { clubId: string; memberId: string };
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);

    const member = await ctx.repository.getAdminMember({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
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
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [...CLUBADMIN_AUTH_ERRORS],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the application belongs to.')),
      applicationId: wireRequiredString.describe('Application to fetch'),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      applicationId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({
      application: adminApplicationState,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, applicationId } = input as { clubId: string; applicationId: string };
    ctx.requireClubAdmin(clubId);

    const summary = await ctx.repository.getAdminClubApplicationById({
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
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  authorizationNote: 'Requires club admin role in the specified club.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
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
  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the application belongs to.')),
      applicationId: wireRequiredString.describe('Application to decide'),
      decision: z.enum(['accept', 'decline', 'ban']),
      adminNote: wireOptionalString.describe('Optional admin note stored on the application'),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this admin application decision.')),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      applicationId: parseRequiredString,
      decision: z.enum(['accept', 'decline', 'ban']),
      adminNote: parseTrimmedNullableString.default(null),
      clientKey: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({
      application: adminApplicationState,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:clubadmin.applications.decide:${(input as { clubId: string; applicationId: string }).clubId}:${(input as { clubId: string; applicationId: string }).applicationId}`,
    getRequestValue: (input) => input,
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
    const result = await ctx.repository.decideClubApplication({
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
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  authorizationNote: 'Requires clubadmin auth on the surface, then narrows to the club owner or a superadmin before mutation.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
    {
      code: 'club_archived',
      meaning: 'The club is archived and cannot be updated.',
      recovery: 'Restore the club before changing its text.',
    },
  ],
  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to update.')),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this club update.')),
      name: wireHumanRequiredString.optional().describe('New club name.'),
      summary: wireOptionalString.describe('New summary.'),
      admissionPolicy: wireOptionalString.describe('New admission policy.'),
    }),
    parse: z.object({
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
  }),
  wire: {
    output: z.object({ club: clubSummary }),
  },
  llmGate: {
    async shouldSkip(input, ctx): Promise<boolean> {
      const parsed = input as ClubadminClubsUpdateInput;
      const current = await loadClubForUpdateGate(ctx, parsed.clubId);
      return clubTextPatchSkipsGate(current, parsed);
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
    const club = await ctx.repository.updateClub({
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

type ClubadminSetDirectoryListedInput = {
  clubId: string;
  listed: boolean;
};

const clubadminClubsSetDirectoryListed: ActionDefinition = {
  action: 'clubadmin.clubs.setDirectoryListed',
  domain: 'clubadmin',
  description: 'Set whether an active club appears in the public directory. Changes appear within roughly 60 seconds because the public directory is TTL-cached.',
  auth: 'clubadmin',
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Repeated calls with the same listed value leave the same directory-listed state.',
  },
  authorizationNote: 'Requires clubadmin role in the active club. Archived clubs must be toggled by superadmin.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [
    ...CLUBADMIN_AUTH_ERRORS,
    {
      code: 'club_not_found',
      meaning: 'The requested club was not found.',
      recovery: 'Refetch session.getContext and use a current clubId.',
    },
    {
      code: 'club_archived',
      meaning: 'The club is archived and cannot be listed through the clubadmin surface.',
      recovery: 'Use superadmin.clubs.setDirectoryListed for archived clubs.',
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
    const { clubId, listed } = input as ClubadminSetDirectoryListedInput;
    ctx.requireClubAdmin(clubId);
    const club = await ctx.repository.setClubDirectoryListed({ clubId, listed, allowArchived: false });
    if (!club) {
      throw new AppError('club_not_found', 'Club not found.');
    }
    ctx.directoryCache.invalidate();
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
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [...CLUBADMIN_AUTH_ERRORS],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to inspect.')),
    }),
    parse: z.object({
      clubId: parseRequiredString,
    }),
  }),
  wire: {
    output: z.object({ stats: adminClubStats }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId } = input as { clubId: string };
    ctx.requireClubAdmin(clubId);

    const stats = await ctx.repository.adminGetClubStats({
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
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'Repeated moderation removes leave the same removed content state; divergent reasons are rejected by content.remove.',
  },
  authorizationNote: 'Club admin may remove any content in their club. Reason is required for moderation audit trail.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],
  businessErrors: [...CLUBADMIN_AUTH_ERRORS],

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club the content belongs to.')),
      id: wireRequiredString.describe('Content to remove'),
      reason: wireHumanRequiredString.describe('Reason for removal (required for moderation)'),
    }),
    parse: z.object({
      clubId: parseRequiredString,
      id: parseRequiredString,
      reason: parseHumanRequiredString,
    }),
  }),
  wire: {
    output: contentWithIncluded,
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, id, reason } = input as { clubId: string; id: string; reason: string };
    ctx.requireClubAdmin(clubId);

    const result = await ctx.repository.removeContent({
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
  clubadminClubsSetDirectoryListed,
  clubadminClubsStats,
  clubadminContentRemove,
]);
