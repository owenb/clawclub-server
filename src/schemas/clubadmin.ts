/**
 * Club admin action contracts: clubadmin.memberships.list, clubadmin.memberships.listForReview,
 * clubadmin.memberships.create, clubadmin.memberships.get, clubadmin.memberships.setStatus,
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
  membershipCreateInitialStatus,
  wireMembershipStates, parseMembershipStates,
  type MembershipState,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import {
  membershipAdminSummary, membershipReviewSummary,
  membershipApplicationAdminSummary,
  adminClubStats,
  contentEntity, includedBundle, messageRemovalResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const CLUBADMIN_SCOPE_RULES = [
  'clubadmin actions require an explicit clubId. The server does not infer it from session context.',
] as const;

// ── clubadmin.memberships.list ─────────────────────────

type MembershipsListInput = {
  clubId: string;
  status?: MembershipState;
  limit: number;
  cursor: string | null;
};

const clubadminMembershipsList: ActionDefinition = {
  action: 'clubadmin.memberships.list',
  domain: 'clubadmin',
  description: 'List memberships in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to list memberships for'),
      status: membershipState.optional().describe('Filter by membership status'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      status: membershipState.nullable(),
      results: z.array(membershipAdminSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      status: membershipState.optional(),
      limit: parseLimitOf(50, 50),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, status, limit, cursor: rawCursor } = input as MembershipsListInput;
    ctx.requireClubAdmin(clubId);

    const cursor = rawCursor ? (() => {
      const [stateCreatedAt, id] = decodeCursor(rawCursor, 2);
      return { stateCreatedAt, id };
    })() : null;

    const result = await ctx.repository.listMemberships({
      actorMemberId: ctx.actor.member.id,
      clubIds: [clubId],
      limit,
      status,
      cursor,
    });

    return {
      data: { limit, status: status ?? null, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

// ── clubadmin.memberships.listForReview ───────────────────────

type MembershipsReviewInput = {
  clubId: string;
  statuses: MembershipState[];
  limit: number;
  cursor: string | null;
};

const clubadminMembershipsReview: ActionDefinition = {
  action: 'clubadmin.memberships.listForReview',
  domain: 'clubadmin',
  description: 'List memberships pending review in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to review memberships for'),
      statuses: wireMembershipStates.describe('Filter by statuses (default: submitted, interview_scheduled, interview_completed)'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      statuses: z.array(membershipState),
      results: z.array(membershipReviewSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      statuses: parseMembershipStates(['submitted', 'interview_scheduled', 'interview_completed']),
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, statuses, limit, cursor: rawCursor } = input as MembershipsReviewInput;
    ctx.requireClubAdmin(clubId);

    const cursor = rawCursor ? (() => {
      const [stateCreatedAt, id] = decodeCursor(rawCursor, 2);
      return { stateCreatedAt, id };
    })() : null;

    const result = await ctx.repository.listMembershipReviews({
      actorMemberId: ctx.actor.member.id,
      clubIds: [clubId],
      limit,
      statuses,
      cursor,
    });

    return {
      data: { limit, statuses, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
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

// ── clubadmin.memberships.get ─────────────────────────────

const clubadminMembershipsGet: ActionDefinition = {
  action: 'clubadmin.memberships.get',
  domain: 'clubadmin',
  description: 'Get one membership/application in the specified club.',
  auth: 'clubadmin',
  safety: 'read_only',
  authorizationNote: 'Requires club admin role.',
  scopeRules: [...CLUBADMIN_SCOPE_RULES],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club the membership belongs to'),
      membershipId: wireRequiredString.describe('Membership to fetch'),
    }),
    output: membershipApplicationAdminSummary,
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      membershipId: parseRequiredString,
    }),
  },

  requiredCapability: 'getMembershipApplication',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, membershipId } = input as { clubId: string; membershipId: string };
    ctx.requireClubAdmin(clubId);
    ctx.requireCapability('getMembershipApplication');

    const summary = await ctx.repository.getMembershipApplication!({
      actorMemberId: ctx.actor.member.id,
      membershipId,
      accessibleClubIds: [clubId],
    });

    if (!summary || summary.club.clubId !== clubId) {
      throw new AppError(404, 'not_found', 'Membership not found in the specified club');
    }

    return {
      data: summary,
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
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
  clubadminMembershipsList, clubadminMembershipsReview,
  clubadminMembershipsCreate, clubadminMembershipsTransition, clubadminMembershipsGet,
  clubadminClubsStats,
  clubadminEntitiesRemove,
]);
