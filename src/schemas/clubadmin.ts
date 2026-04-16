/**
 * Club admin action contracts: clubadmin.members.list, clubadmin.members.get,
 * clubadmin.applications.list, clubadmin.applications.get,
 * clubadmin.memberships.create, clubadmin.memberships.setStatus,
 * clubadmin.clubs.getStatistics
 *
 * All actions require auth: 'clubadmin' — the caller must be a club admin,
 * the club owner, or a superadmin. All actions require an explicit clubId.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalRecord, parseOptionalRecord,
  membershipState,
  membershipRole,
  membershipCreateInitialStatus,
  wireMembershipStates,
  type MembershipState,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import {
  adminApplicationSummary,
  adminClubStats,
  adminMemberSummary,
  contentEntity, includedBundle, messageRemovalResult,
  membershipSummary,
  membershipAdminSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const CLUBADMIN_SCOPE_RULES = [
  'clubadmin actions require an explicit clubId. The server does not infer it from session context.',
] as const;

const MEMBER_STATUSES = ['active', 'renewal_pending', 'cancelled'] as const;
const APPLICATION_STATUSES = ['applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending'] as const;

const wireMembershipRoles = z.array(membershipRole).min(1).optional();
const parseOptionalMembershipStates = z.array(membershipState).min(1)
  .optional()
  .transform((states) => states ? [...new Set(states)] : undefined);
const parseMembershipRoles = z.array(membershipRole).min(1)
  .optional()
  .transform((roles) => roles ? [...new Set(roles)] : undefined);

function assertStateSubset(
  states: MembershipState[] | undefined,
  allowed: readonly MembershipState[],
  siblingAction: string,
): void {
  if (!states) return;
  const invalid = states.filter((state) => !allowed.includes(state));
  if (invalid.length > 0) {
    throw new AppError(422, 'invalid_input', `Statuses ${invalid.join(', ')} are out of scope here. Try ${siblingAction}.`);
  }
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

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to list members for'),
      statuses: wireMembershipStates.describe('Optional membership-state filter limited to active, renewal_pending, cancelled'),
      roles: wireMembershipRoles.describe('Optional role filter limited to clubadmin/member'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      statuses: z.array(membershipState).nullable(),
      roles: z.array(membershipRole).nullable(),
      results: z.array(adminMemberSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
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

    const cursor = rawCursor ? (() => {
      const [joinedAt, membershipId] = decodeCursor(rawCursor, 2);
      return { joinedAt, membershipId };
    })() : null;

    const result = await ctx.repository.listAdminMembers({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      statuses: (statuses as Array<'active' | 'renewal_pending' | 'cancelled'> | undefined) ?? null,
      roles: roles ?? null,
      cursor,
    });

    return {
      data: {
        limit,
        clubScope: [club],
        statuses: statuses ?? null,
        roles: roles ?? null,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

// ── clubadmin.applications.list ───────────────────────

type ClubadminApplicationsListInput = {
  clubId: string;
  statuses: MembershipState[];
  limit: number;
  cursor: string | null;
};

const clubadminApplicationsList: ActionDefinition = {
  action: 'clubadmin.applications.list',
  domain: 'clubadmin',
  description: 'List applications and payment-pending memberships in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to list applications for'),
      statuses: wireMembershipStates.describe('Optional application-state filter limited to applying, submitted, interview_scheduled, interview_completed, payment_pending'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      statuses: z.array(membershipState).nullable(),
      results: z.array(adminApplicationSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      statuses: parseOptionalMembershipStates,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, statuses, limit, cursor: rawCursor } = input as ClubadminApplicationsListInput;
    const club = ctx.requireAccessibleClub(clubId);
    ctx.requireClubAdmin(clubId);
    assertStateSubset(statuses, APPLICATION_STATUSES, 'clubadmin.members.list');

    const cursor = rawCursor ? (() => {
      const [stateCreatedAt, membershipId] = decodeCursor(rawCursor, 2);
      return { stateCreatedAt, membershipId };
    })() : null;

    const result = await ctx.repository.listAdminApplications!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      limit,
      statuses: statuses as Array<'applying' | 'submitted' | 'interview_scheduled' | 'interview_completed' | 'payment_pending'>,
      cursor,
    });

    return {
      data: {
        limit,
        clubScope: [club],
        statuses: statuses ?? null,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

// ── clubadmin.memberships.create ───────────────────────

type MembershipsCreateInput = {
  clubId: string;
  memberId: string;
  sponsorMemberId: string | null;
  initialStatus: 'applying' | 'submitted' | 'active' | 'payment_pending';
  reason: string | null;
  metadata: Record<string, unknown>;
};

const clubadminMembershipsCreate: ActionDefinition = {
  action: 'clubadmin.memberships.create',
  domain: 'clubadmin',
  description: 'Create a new membership in the specified club.',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Requires club admin role. Members are always created with role member. Use promoteToAdmin to elevate.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to add membership in'),
      memberId: wireRequiredString.describe('Member to add'),
      sponsorMemberId: wireOptionalString.describe('Optional sponsor member'),
      initialStatus: membershipCreateInitialStatus.default('active').describe('Initial status'),
      reason: wireOptionalString.describe('Reason for creation'),
      metadata: wireOptionalRecord.describe('Additional metadata'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      sponsorMemberId: parseTrimmedNullableString.default(null),
      initialStatus: membershipCreateInitialStatus.default('active'),
      reason: parseTrimmedNullableString.default(null),
      metadata: parseOptionalRecord,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, sponsorMemberId, initialStatus, reason, metadata } = input as MembershipsCreateInput;
    ctx.requireClubAdmin(clubId);

    const isSuperadmin = ctx.actor.globalRoles.includes('superadmin');
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
    const membership = await ctx.repository.createMembership({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
      sponsorMemberId,
      role: 'member',
      initialStatus,
      reason,
      metadata,
      skipClubAdminCheck: isSuperadmin,
      initialProfile: {
        fields: initialProfile,
        generationSource: 'membership_seed',
      },
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Member or sponsor not found inside the club scope');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: membership.clubId, activeClubIds: [membership.clubId] },
    };
  },
};

// ── clubadmin.memberships.setStatus ───────────────────

type MembershipsTransitionInput = {
  clubId: string;
  membershipId: string;
  status: MembershipState;
  reason: string | null;
};

const clubadminMembershipsTransition: ActionDefinition = {
  action: 'clubadmin.memberships.setStatus',
  domain: 'clubadmin',
  description: 'Transition a membership to a new status.',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club the membership belongs to'),
      membershipId: wireRequiredString.describe('Membership to transition'),
      status: membershipState.describe('Target status'),
      reason: wireOptionalString.describe('Reason for transition'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      membershipId: parseRequiredString,
      status: membershipState,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, membershipId, status, reason } = input as MembershipsTransitionInput;
    ctx.requireClubAdmin(clubId);

    const isSuperadmin = ctx.actor.globalRoles.includes('superadmin');
    const membership = await ctx.repository.transitionMembershipState({
      actorMemberId: ctx.actor.member.id,
      membershipId,
      nextStatus: status,
      reason,
      accessibleClubIds: [clubId],
      skipClubAdminCheck: isSuperadmin,
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Membership not found in the specified club');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: membership.clubId, activeClubIds: [membership.clubId] },
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

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club the membership belongs to'),
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
        requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
      };
    }

    const application = await ctx.repository.getAdminApplication!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      membershipId,
    });
    if (application) {
      throw new AppError(404, 'not_found', 'Membership not found in the member surface for this club. Try clubadmin.applications.get instead.');
    }

    throw new AppError(404, 'not_found', 'No active member with that id was found in the specified club');
  },
};

// ── clubadmin.applications.get ─────────────────────────────

const clubadminApplicationsGet: ActionDefinition = {
  action: 'clubadmin.applications.get',
  domain: 'clubadmin',
  description: 'Get one application or payment-pending membership in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club the application or payment-pending membership belongs to'),
      membershipId: wireRequiredString.describe('Membership to fetch'),
    }),
    output: z.object({
      club: z.object({
        clubId: z.string(),
        slug: z.string(),
        name: z.string(),
        summary: z.string().nullable(),
        admissionPolicy: z.string().nullable(),
        ownerName: z.string().nullable(),
        priceUsd: z.number().nullable(),
      }),
      application: adminApplicationSummary,
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
    ctx.requireClubAdmin(clubId);

    const summary = await ctx.repository.getAdminApplication!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      membershipId,
    });
    if (summary) {
      return {
        data: summary,
        requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
      };
    }

    const member = await ctx.repository.getAdminMember({
      actorMemberId: ctx.actor.member.id,
      clubId,
      membershipId,
    });
    if (member) {
      throw new AppError(404, 'not_found', 'Membership not found in the applications surface for this club. Try clubadmin.members.get instead.');
    }

    throw new AppError(404, 'not_found', 'Membership not found in the specified club');
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
    const { clubId } = input as { clubId: string };
    ctx.requireClubAdmin(clubId);
    ctx.requireCapability('adminGetClubStats');

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

// ── clubadmin.content.remove ─────────────────────────────

const clubadminEntitiesRemove: ActionDefinition = {
  action: 'clubadmin.content.remove',
  domain: 'clubadmin',
  description: 'Remove any entity in the specified club (moderation).',
  auth: 'clubadmin',
  safety: 'mutating',
  authorizationNote: 'Club admin may remove any entity in their club. Reason is required for moderation audit trail.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  requiredCapability: 'removeEntity',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club the entity belongs to'),
      entityId: wireRequiredString.describe('Entity to remove'),
      reason: wireRequiredString.describe('Reason for removal (required for moderation)'),
    }),
    output: z.object({ entity: contentEntity, included: includedBundle }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      entityId: parseRequiredString,
      reason: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, entityId, reason } = input as { clubId: string; entityId: string; reason: string };
    ctx.requireClubAdmin(clubId);
    ctx.requireCapability('removeEntity');

    const result = await ctx.repository.removeEntity!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: [clubId],
      entityId,
      reason,
      skipAuthCheck: true,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Entity not found in the specified club');
    }

    return {
      data: result,
      requestScope: { requestedClubId: result.entity.clubId, activeClubIds: [result.entity.clubId] },
    };
  },
};

// clubadmin.messages.remove has been removed.
// Messages are no longer club-scoped — club admins have no authority over private messages.

registerActions([
  clubadminMembersList, clubadminApplicationsList,
  clubadminMembershipsCreate, clubadminMembershipsTransition,
  clubadminMembersGet, clubadminApplicationsGet,
  clubadminClubsStats,
  clubadminEntitiesRemove,
]);
