/**
 * Action contracts: memberships.list, memberships.review, memberships.create,
 * memberships.transition, admissions.list, admissions.transition,
 * admissions.sponsor, admissions.issueAccess, members.fullTextSearch, members.list,
 * vouches.create, vouches.list
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wirePatchString, parsePatchString,
  wireLimit, parseLimit,
  wireOptionalRecord, parseOptionalRecord,
  membershipState, admissionStatus,
  membershipCreateRole, membershipCreateInitialStatus,
  wireMembershipStates, parseMembershipStates,
  wireAdmissionStatuses, parseAdmissionStatuses,
  wireIntake, parseIntake,
  wireBoundedString, parseBoundedString,
  wireFullName, parseFullName,
  wireEmail, parseEmail,
  type MembershipState, type AdmissionStatus,
} from './fields.ts';
import {
  membershipSummary, membershipAdminSummary, membershipReviewSummary,
  admissionSummary, memberSearchResult, clubMemberSummary, vouchSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── Helpers ─────────────────────────────────────────────

function resolveOwnerClubs(ctx: HandlerContext, clubId?: string) {
  if (clubId) {
    return [ctx.requireMembershipOwner(clubId)];
  }
  const ownerClubs = ctx.actor.memberships.filter(m => m.role === 'owner');
  if (ownerClubs.length === 0) {
    throw new AppError(403, 'forbidden', 'This member does not currently own any clubs');
  }
  return ownerClubs;
}

// ── memberships.list ────────────────────────────────────

type MembershipsListInput = {
  clubId?: string;
  status?: MembershipState;
  limit: number;
};

const membershipsList: ActionDefinition = {
  action: 'memberships.list',
  domain: 'admissions',
  description: 'List memberships across owned clubs.',
  auth: 'owner',
  safety: 'read_only',
  authorizationNote: 'Only memberships in clubs the actor owns.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one owned club'),
      status: membershipState.optional().describe('Filter by membership status'),
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      status: membershipState.nullable(),
      clubScope: z.array(membershipSummary),
      results: z.array(membershipAdminSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      status: membershipState.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, status, limit } = input as MembershipsListInput;
    const clubScope = resolveOwnerClubs(ctx, clubId);
    const clubIds = clubScope.map(c => c.clubId);

    const results = await ctx.repository.listMemberships({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      status,
    });

    return {
      data: { limit, status: status ?? null, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── memberships.review ──────────────────────────────────

type MembershipsReviewInput = {
  clubId?: string;
  statuses: MembershipState[];
  limit: number;
};

const membershipsReview: ActionDefinition = {
  action: 'memberships.review',
  domain: 'admissions',
  description: 'List memberships pending review across owned clubs.',
  auth: 'owner',
  safety: 'read_only',
  authorizationNote: 'Only memberships in clubs the actor owns.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one owned club'),
      statuses: wireMembershipStates.describe('Filter by statuses (default: invited, pending_review)'),
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      statuses: z.array(membershipState),
      clubScope: z.array(membershipSummary),
      results: z.array(membershipReviewSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      statuses: parseMembershipStates(['invited', 'pending_review']),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, statuses, limit } = input as MembershipsReviewInput;
    const clubScope = resolveOwnerClubs(ctx, clubId);
    const clubIds = clubScope.map(c => c.clubId);

    const results = await ctx.repository.listMembershipReviews({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      statuses,
    });

    return {
      data: { limit, statuses, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── memberships.create ──────────────────────────────────

type MembershipsCreateInput = {
  clubId: string;
  memberId: string;
  sponsorMemberId: string;
  role: 'member' | 'admin';
  initialStatus: 'invited' | 'pending_review' | 'active';
  reason: string | null;
  metadata: Record<string, unknown>;
};

const membershipsCreate: ActionDefinition = {
  action: 'memberships.create',
  domain: 'admissions',
  description: 'Create a new membership in an owned club.',
  auth: 'owner',
  safety: 'mutating',
  authorizationNote: 'Requires club ownership.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to add membership in'),
      memberId: wireRequiredString.describe('Member to add'),
      sponsorMemberId: wireRequiredString.describe('Sponsoring member'),
      role: membershipCreateRole.default('member').describe('Role (member or admin)'),
      initialStatus: membershipCreateInitialStatus.default('invited').describe('Initial status'),
      reason: wireOptionalString.describe('Reason for creation'),
      metadata: wireOptionalRecord.describe('Additional metadata'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      sponsorMemberId: parseRequiredString,
      role: membershipCreateRole.default('member'),
      initialStatus: membershipCreateInitialStatus.default('invited'),
      reason: parseTrimmedNullableString.default(null),
      metadata: parseOptionalRecord,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, sponsorMemberId, role, initialStatus, reason, metadata } = input as MembershipsCreateInput;
    const club = ctx.requireMembershipOwner(clubId);

    const membership = await ctx.repository.createMembership({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      memberId,
      sponsorMemberId,
      role,
      initialStatus,
      reason,
      metadata,
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Member or sponsor not found inside the owner scope');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: membership.clubId, activeClubIds: [membership.clubId] },
    };
  },
};

// ── memberships.transition ──────────────────────────────

type MembershipsTransitionInput = {
  membershipId: string;
  status: MembershipState;
  reason: string | null;
};

const membershipsTransition: ActionDefinition = {
  action: 'memberships.transition',
  domain: 'admissions',
  description: 'Transition a membership to a new status.',
  auth: 'owner',
  safety: 'mutating',
  authorizationNote: 'Only memberships in clubs the actor owns.',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to transition'),
      status: membershipState.describe('Target status'),
      reason: wireOptionalString.describe('Reason for transition'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
      status: membershipState,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { membershipId, status, reason } = input as MembershipsTransitionInput;
    const accessibleClubIds = ctx.actor.memberships
      .filter(m => m.role === 'owner')
      .map(m => m.clubId);

    const membership = await ctx.repository.transitionMembershipState({
      actorMemberId: ctx.actor.member.id,
      membershipId,
      nextStatus: status,
      reason,
      accessibleClubIds,
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Membership not found inside the owner scope');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: membership.clubId, activeClubIds: [membership.clubId] },
    };
  },
};

// ── admissions.list ─────────────────────────────────────

type AdmissionsListInput = {
  clubId?: string;
  statuses?: AdmissionStatus[];
  limit: number;
};

const admissionsList: ActionDefinition = {
  action: 'admissions.list',
  domain: 'admissions',
  description: 'List admissions across owned clubs.',
  auth: 'owner',
  safety: 'read_only',
  authorizationNote: 'Only admissions in clubs the actor owns.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one owned club'),
      statuses: wireAdmissionStatuses.describe('Filter by admission statuses'),
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      statuses: z.array(admissionStatus).nullable(),
      clubScope: z.array(membershipSummary),
      results: z.array(admissionSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      statuses: parseAdmissionStatuses,
      limit: parseLimit,
    }),
  },

  requiredCapability: 'listAdmissions',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, statuses, limit } = input as AdmissionsListInput;
    const clubScope = resolveOwnerClubs(ctx, clubId);
    const clubIds = clubScope.map(c => c.clubId);
    ctx.requireCapability('listAdmissions');

    const results = await ctx.repository.listAdmissions!({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      statuses,
    });

    return {
      data: { limit, statuses: statuses ?? null, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── admissions.transition ───────────────────────────────

type AdmissionsTransitionInput = {
  admissionId: string;
  status: AdmissionStatus;
  notes: string | null;
  intake?: {
    kind?: 'fit_check' | 'advice_call' | 'other';
    price?: { amount?: number | null; currency?: string | null };
    bookingUrl?: string | null;
    bookedAt?: string | null;
    completedAt?: string | null;
  };
  metadata?: Record<string, unknown>;
};

const admissionsTransition: ActionDefinition = {
  action: 'admissions.transition',
  domain: 'admissions',
  description: 'Transition an admission to a new status.',
  auth: 'owner',
  safety: 'mutating',
  authorizationNote: 'Only admissions in clubs the actor owns.',

  wire: {
    input: z.object({
      admissionId: wireRequiredString.describe('Admission to transition'),
      status: admissionStatus.describe('Target status'),
      notes: wireOptionalString.describe('Notes for the transition'),
      intake: wireIntake,
      metadata: wireOptionalRecord.describe('Metadata patch'),
    }),
    output: z.object({ admission: admissionSummary }),
  },

  parse: {
    input: z.object({
      admissionId: parseRequiredString,
      status: admissionStatus,
      notes: parseTrimmedNullableString.default(null),
      intake: parseIntake,
      metadata: z.record(z.unknown()).optional(),
    }),
  },

  requiredCapability: 'transitionAdmission',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { admissionId, status, notes, intake, metadata } = input as AdmissionsTransitionInput;
    const accessibleClubIds = ctx.actor.memberships
      .filter(m => m.role === 'owner')
      .map(m => m.clubId);
    ctx.requireCapability('transitionAdmission');

    const admission = await ctx.repository.transitionAdmission!({
      actorMemberId: ctx.actor.member.id,
      admissionId,
      nextStatus: status,
      notes,
      accessibleClubIds,
      intake,
      metadataPatch: metadata,
    });

    if (admission === undefined) {
      throw new AppError(501, 'not_implemented', 'admissions.transition is not implemented');
    }

    if (!admission) {
      throw new AppError(404, 'not_found', 'Admission not found inside the owner scope');
    }

    return {
      data: { admission },
      requestScope: { requestedClubId: admission.clubId, activeClubIds: [admission.clubId] },
    };
  },
};

// ── admissions.sponsor ──────────────────────────────────

type AdmissionsSponsorInput = {
  clubId: string;
  name: string;
  email: string;
  socials: string;
  reason: string;
};

const admissionsSponsor: ActionDefinition = {
  action: 'admissions.sponsor',
  domain: 'admissions',
  description: 'Sponsor a candidate for admission to a club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to sponsor into'),
      name: wireFullName.describe('Candidate full name'),
      email: wireEmail.describe('Candidate email'),
      socials: wireBoundedString.describe('Social media handles or URLs'),
      reason: wireBoundedString.describe('Why this person should join'),
    }),
    output: z.object({ admission: admissionSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      name: parseFullName,
      email: parseEmail,
      socials: parseBoundedString,
      reason: parseBoundedString,
    }),
  },

  qualityGate: 'admissions-sponsor',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, name, email, socials, reason } = input as AdmissionsSponsorInput;
    const club = ctx.requireAccessibleClub(clubId);

    const admission = await ctx.repository.createAdmissionSponsorship({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      candidateName: name,
      candidateEmail: email,
      candidateDetails: { socials },
      reason,
    });

    return {
      data: { admission },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── admissions.issueAccess ──────────────────────────────

const admissionsIssueAccess: ActionDefinition = {
  action: 'admissions.issueAccess',
  domain: 'admissions',
  description: 'Issue access credentials for an accepted admission.',
  auth: 'owner',
  safety: 'mutating',
  authorizationNote: 'Only admissions in clubs the actor owns.',

  wire: {
    input: z.object({
      admissionId: wireRequiredString.describe('Admission to issue access for'),
    }),
    output: z.object({
      admission: admissionSummary,
      bearerToken: z.string(),
    }),
  },

  parse: {
    input: z.object({
      admissionId: parseRequiredString,
    }),
  },

  requiredCapability: 'issueAdmissionAccess',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { admissionId } = input as { admissionId: string };
    const accessibleClubIds = ctx.actor.memberships
      .filter(m => m.role === 'owner')
      .map(m => m.clubId);

    if (accessibleClubIds.length === 0) {
      throw new AppError(403, 'forbidden', 'This member does not currently own any clubs');
    }

    ctx.requireCapability('issueAdmissionAccess');

    const result = await ctx.repository.issueAdmissionAccess!({
      actorMemberId: ctx.actor.member.id,
      admissionId,
      accessibleClubIds,
    });

    if (result === undefined) {
      throw new AppError(501, 'not_implemented', 'admissions.issueAccess is not implemented');
    }

    if (!result) {
      throw new AppError(404, 'not_found', 'Admission not found inside the owner scope');
    }

    return {
      data: { admission: result.admission, bearerToken: result.bearerToken },
      requestScope: { requestedClubId: result.admission.clubId, activeClubIds: [result.admission.clubId] },
    };
  },
};

// ── members.fullTextSearch ──────────────────────────────

type MembersFullTextSearchInput = {
  query: string;
  clubId?: string;
  limit: number;
};

const membersFullTextSearch: ActionDefinition = {
  action: 'members.fullTextSearch',
  domain: 'members',
  description: 'Full-text search for members across accessible clubs using PostgreSQL FTS.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: wireRequiredString.describe('Search text'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(memberSearchResult),
    }),
  },

  parse: {
    input: z.object({
      query: parseRequiredString,
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, limit } = input as MembersFullTextSearchInput;

    let clubIds: string[];
    if (clubId) {
      clubIds = [ctx.requireAccessibleClub(clubId).clubId];
    } else {
      clubIds = ctx.actor.memberships.map(m => m.clubId);
    }

    if (clubIds.length === 0) {
      throw new AppError(403, 'forbidden', 'This member does not currently have access to any clubs');
    }

    const results = await ctx.repository.fullTextSearchMembers({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      query,
      limit,
    });

    const clubScope = ctx.actor.memberships.filter(m => clubIds.includes(m.clubId));

    return {
      data: { query, limit, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── members.list ────────────────────────────────────────

type MembersListInput = {
  clubId?: string;
  limit: number;
};

const membersList: ActionDefinition = {
  action: 'members.list',
  domain: 'members',
  description: 'List members across accessible clubs.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(clubMemberSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, limit } = input as MembersListInput;

    let clubScope = ctx.actor.memberships;
    if (clubId) {
      clubScope = [ctx.requireAccessibleClub(clubId)];
    }

    if (clubScope.length === 0) {
      throw new AppError(403, 'forbidden', 'This member does not currently have access to any clubs');
    }

    const clubIds = clubScope.map(c => c.clubId);
    const results = await ctx.repository.listMembers({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
    });

    return {
      data: { limit, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── vouches.create ──────────────────────────────────────

type VouchesCreateInput = {
  clubId: string;
  memberId: string;
  reason: string;
};

const vouchesCreate: ActionDefinition = {
  action: 'vouches.create',
  domain: 'admissions',
  description: 'Vouch for another member in a club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership. Cannot self-vouch.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club context'),
      memberId: wireRequiredString.describe('Member to vouch for'),
      reason: wireBoundedString.describe('Reason for vouching'),
    }),
    output: z.object({ vouch: vouchSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      reason: parseBoundedString,
    }),
  },

  qualityGate: 'vouches-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, reason } = input as VouchesCreateInput;
    const club = ctx.requireAccessibleClub(clubId);

    if (memberId === ctx.actor.member.id) {
      throw new AppError(400, 'self_vouch', 'You cannot vouch for yourself');
    }

    let vouch;
    try {
      vouch = await ctx.repository.createVouch({
        actorMemberId: ctx.actor.member.id,
        clubId: club.clubId,
        targetMemberId: memberId,
        reason,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new AppError(409, 'duplicate_vouch', 'You have already vouched for this member in this club');
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23514') {
        throw new AppError(400, 'self_vouch', 'You cannot vouch for yourself');
      }
      throw error;
    }

    if (!vouch) {
      throw new AppError(404, 'not_found', 'Target member was not found in this club');
    }

    return {
      data: { vouch },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── vouches.list ────────────────────────────────────────

type VouchesListInput = {
  memberId: string;
  clubId?: string;
  limit: number;
};

const vouchesList: ActionDefinition = {
  action: 'vouches.list',
  domain: 'admissions',
  description: 'List vouches for a member.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      memberId: wireRequiredString.describe('Member to list vouches for'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
    }),
    output: z.object({
      memberId: z.string(),
      results: z.array(vouchSummary),
    }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { memberId: targetMemberId, clubId, limit } = input as VouchesListInput;

    if (clubId) {
      ctx.requireAccessibleClub(clubId);
    }

    const clubIds = clubId
      ? [clubId]
      : ctx.actor.memberships.map(m => m.clubId);

    const results = await ctx.repository.listVouches({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      targetMemberId,
      limit,
    });

    return {
      data: { memberId: targetMemberId, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── members.findViaEmbedding ──────────────────────────────

type MembersFindViaEmbeddingInput = {
  query: string;
  clubId?: string;
  limit: number;
};

const membersFindViaEmbedding: ActionDefinition = {
  action: 'members.findViaEmbedding',
  domain: 'members',
  description: 'Find members by natural-language query using embedding similarity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(memberSearchResult),
    }),
  },

  parse: {
    input: z.object({
      query: z.string().trim().min(1).max(1000),
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, limit } = input as MembersFindViaEmbeddingInput;
    const { embed } = await import('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { EMBEDDING_PROFILES } = await import('../ai.ts');

    const profile = EMBEDDING_PROFILES.member_profile;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'members.findViaEmbedding',
        gateName: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'no_api_key',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: null,
      })?.catch(() => {});
      throw new AppError(503, 'embedding_unavailable', 'Embedding service is not configured');
    }

    let clubIds: string[];
    if (clubId) {
      clubIds = [ctx.requireAccessibleClub(clubId).clubId];
    } else {
      clubIds = ctx.actor.memberships.map(m => m.clubId);
    }

    if (clubIds.length === 0) {
      throw new AppError(403, 'forbidden', 'This member does not currently have access to any clubs');
    }

    const provider = createOpenAI({ apiKey });
    const embeddingModel = provider.embedding(profile.model, { dimensions: profile.dimensions });

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embed({ model: embeddingModel, value: query });
      embedding = result.embedding;
      usageTokens = result.usage?.tokens ?? 0;
    } catch (err) {
      console.error('Embedding provider error in members.findViaEmbedding:', err);
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'members.findViaEmbedding',
        gateName: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'provider_error',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      })?.catch(() => {});
      throw new AppError(503, 'embedding_unavailable', 'Embedding service is temporarily unavailable');
    }

    ctx.repository.logLlmUsage?.({
      memberId: ctx.actor.member.id,
      requestedClubId: clubId ?? null,
      actionName: 'members.findViaEmbedding',
      gateName: 'embedding_query',
      provider: 'openai',
      model: profile.model,
      gateStatus: 'passed',
      skipReason: null,
      promptTokens: usageTokens,
      completionTokens: 0,
      providerErrorCode: null,
    })?.catch(() => {});

    const queryVector = `[${embedding.join(',')}]`;

    const results = await ctx.repository.findMembersViaEmbedding({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      queryEmbedding: queryVector,
      limit,
    });

    const clubScope = ctx.actor.memberships.filter(m => clubIds.includes(m.clubId));

    return {
      data: { query, limit, clubScope, results },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

registerActions([
  membershipsList,
  membershipsReview,
  membershipsCreate,
  membershipsTransition,
  admissionsList,
  admissionsTransition,
  admissionsSponsor,
  admissionsIssueAccess,
  membersFullTextSearch,
  membersList,
  membersFindViaEmbedding,
  vouchesCreate,
  vouchesList,
]);
