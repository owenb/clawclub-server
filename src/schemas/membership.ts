/**
 * Action contracts: members.searchByFullText, members.list,
 * members.searchBySemanticSimilarity, members.updateProfile, vouches.create, vouches.list
 *
 * Member-auth actions for discovery and vouching.
 */
import { z } from 'zod';
import { membershipScopes, requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError, type ProfileForGate } from '../repository.ts';
import type { NonApplicationArtifact } from '../gate.ts';
import {
  describeClientKey,
  describeOptionalScopedClubId,
  describeScopedClubId,
  wireRequiredString, parseRequiredString,
  wireHumanRequiredString, parseHumanRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalOpaqueString, parseTrimmedNullableOpaqueString,
  wireBoundedString, parseBoundedString,
  wirePatchString, parsePatchString,
  wirePatchHttpUrl, parsePatchHttpUrl,
  wireCursor, parseCursor, decodeOptionalCursor,
  paginatedOutput,
  wireLimitOf, parseLimitOf,
  profileLink, parseProfileLink,
} from './fields.ts';
import {
  membershipSummary,
  memberSearchResult, memberProfileEnvelope, publicMemberSummary, vouchSummary,
} from './responses.ts';
import {
  clubScopedPaginatedResult,
  clubScopedResult,
  registerActions,
  type ActionDefinition,
  type HandlerContext,
  type ActionResult,
} from './registry.ts';
import { logger } from '../logger.ts';
import { outboundLlmSignal } from '../workers/environment.ts';

// ── members.searchByFullText ──────────────────────────────

type MembersFullTextSearchInput = {
  query: string;
  clubId: string;
  limit: number;
  cursor: string | null;
};

const membersFullTextSearch: ActionDefinition = {
  action: 'members.searchByFullText',
  domain: 'members',
  description: 'Full-text search members in one club. Requires clubId.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: wireHumanRequiredString.describe('Search text'),
      clubId: wireRequiredString.describe(describeScopedClubId('Club to search within.')),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: paginatedOutput(memberSearchResult).extend({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      query: parseHumanRequiredString,
      clubId: parseRequiredString,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, limit, cursor: rawCursor } = input as MembersFullTextSearchInput;

    const club = ctx.requireAccessibleClub(clubId);

    const cursor = decodeOptionalCursor(rawCursor, 2, ([rank, memberId]) => ({ rank, memberId }));

    const result = await ctx.repository.fullTextSearchMembers({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      query,
      limit,
      cursor,
    });

    return clubScopedPaginatedResult(club, result, { query, limit });
  },
};

// ── members.list ────────────────────────────────────────

type MembersListInput = {
  clubId: string;
  limit: number;
  cursor: string | null;
};

const membersList: ActionDefinition = {
  action: 'members.list',
  domain: 'members',
  description: 'List members in one club. Requires clubId.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to list members from.')),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: paginatedOutput(publicMemberSummary).extend({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      limit: parseLimitOf(50, 50),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, limit, cursor: rawCursor } = input as MembersListInput;

    const club = ctx.requireAccessibleClub(clubId);

    const cursor = decodeOptionalCursor(rawCursor, 2, ([joinedAt, membershipId]) => ({ joinedAt, membershipId }));

    const result = await ctx.repository.listMembers({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      limit,
      cursor,
    });

    return clubScopedPaginatedResult(club, result, { limit });
  },
};

// ── members.get ────────────────────────────────────────

type MembersGetInput = {
  clubId: string;
  memberId: string;
};

const membersGet: ActionDefinition = {
  action: 'members.get',
  domain: 'members',
  description: 'Get one member inside one club. Requires clubId.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club to fetch the member from.')),
      memberId: wireRequiredString.describe('Member to fetch'),
    }),
    output: z.object({
      club: z.object({
        clubId: z.string(),
        slug: z.string(),
        name: z.string(),
      }),
      member: publicMemberSummary,
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId } = input as MembersGetInput;
    const club = ctx.requireAccessibleClub(clubId);

    const member = await ctx.repository.getMember({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      memberId,
    });
    if (!member) {
      throw new AppError('member_not_found', 'Member not found in the specified club');
    }

    return clubScopedResult(club, {
      club: {
        clubId: club.clubId,
        slug: club.slug,
        name: club.name,
      },
      member,
    });
  },
};

// ── members.updateProfile ──────────────────────────────

type MembersUpdateProfileInput = {
  clubId: string;
  clientKey?: string | null;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: Array<{ url: string; label: string | null }>;
};

const PROFILE_UPDATE_ERRORS = [
  {
    code: 'low_quality_content',
    meaning: 'The profile update was rejected for being too generic or low-information.',
    recovery: 'Relay the feedback to the user, add a concrete role, domain, skill, or experience, and resubmit.',
  },
  {
    code: 'illegal_content',
    meaning: 'The profile update was rejected for soliciting or facilitating clearly illegal activity.',
    recovery: 'Relay the reason to the user, revise the profile fields, and resubmit.',
  },
  {
    code: 'gate_rejected',
    meaning: 'The profile update failed the content gate after schema validation.',
    recovery: 'Review the feedback, revise the profile fields, and resubmit.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The content gate is temporarily unavailable.',
    recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
  },
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used for a different profile update payload.',
    recovery: 'Generate a fresh clientKey for a new profile intent, or resend the exact same payload to replay safely.',
  },
] as const;

function validateProfileUpdateInput(patch: MembersUpdateProfileInput): void {
  const keys = Object.keys(patch) as Array<keyof MembersUpdateProfileInput>;
  const changedKeys = keys.filter((key) => key !== 'clubId' && key !== 'clientKey');
  if (changedKeys.length === 0) {
    throw new AppError('invalid_input', 'At least one profile field must be provided');
  }
}

function profileFieldsEqual(left: ProfileForGate, right: ProfileForGate): boolean {
  return left.tagline === right.tagline
    && left.summary === right.summary
    && left.whatIDo === right.whatIDo
    && left.knownFor === right.knownFor
    && left.servicesSummary === right.servicesSummary
    && left.websiteUrl === right.websiteUrl
    && JSON.stringify(left.links) === JSON.stringify(right.links);
}

async function isProfileUpdateNoOp(
  input: MembersUpdateProfileInput,
  ctx: { actor: import('../actors.ts').AuthenticatedActor; repository: import('../repository.ts').Repository },
): Promise<boolean> {
  const current = await ctx.repository.loadProfileForGate?.({
    actorMemberId: ctx.actor.member.id,
    clubId: input.clubId,
  });
  if (!current) {
    throw new AppError('profile_not_found', 'Profile not found inside the actor scope');
  }
  const next: ProfileForGate = {
    tagline: input.tagline !== undefined ? input.tagline : current.tagline,
    summary: input.summary !== undefined ? input.summary : current.summary,
    whatIDo: input.whatIDo !== undefined ? input.whatIDo : current.whatIDo,
    knownFor: input.knownFor !== undefined ? input.knownFor : current.knownFor,
    servicesSummary: input.servicesSummary !== undefined ? input.servicesSummary : current.servicesSummary,
    websiteUrl: input.websiteUrl !== undefined ? input.websiteUrl : current.websiteUrl,
    links: input.links !== undefined ? input.links : current.links,
  };
  return profileFieldsEqual(current, next);
}

const membersUpdateProfile: ActionDefinition = {
  action: 'members.updateProfile',
  domain: 'members',
  description: 'Update the current actor club-scoped profile fields for one club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own profile only.',
  businessErrors: [...PROFILE_UPDATE_ERRORS],
  notes: [
    'Use accounts.updateIdentity for global identity fields like displayName.',
    'members.updateProfile only changes club-scoped profile fields.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club whose profile should be updated.')),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Idempotency key for this club profile update.')),
      tagline: wirePatchString.describe('Short tagline'),
      summary: wirePatchString.describe('Profile summary'),
      whatIDo: wirePatchString.describe('What I do'),
      knownFor: wirePatchString.describe('Known for'),
      servicesSummary: wirePatchString.describe('Services summary'),
      websiteUrl: wirePatchHttpUrl.describe('Website URL'),
      links: z.array(profileLink).max(20).optional(),
    }),
    output: memberProfileEnvelope,
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
      tagline: parsePatchString,
      summary: parsePatchString,
      whatIDo: parsePatchString,
      knownFor: parsePatchString,
      servicesSummary: parsePatchString,
      websiteUrl: parsePatchHttpUrl,
      links: z.array(parseProfileLink).max(20).optional(),
    }),
  },

  llmGate: {
    async shouldSkip(input, ctx) {
      return isProfileUpdateNoOp(input as MembersUpdateProfileInput, ctx);
    },
    async buildArtifact(input, ctx) {
      const patch = input as MembersUpdateProfileInput;
      const current = await ctx.repository.loadProfileForGate?.({
        actorMemberId: ctx.actor.member.id,
        clubId: patch.clubId,
      });
      if (!current) {
        throw new AppError('profile_not_found', 'Profile not found inside the actor scope');
      }
      return {
        kind: 'profile',
        tagline: patch.tagline !== undefined ? patch.tagline : current.tagline,
        summary: patch.summary !== undefined ? patch.summary : current.summary,
        whatIDo: patch.whatIDo !== undefined ? patch.whatIDo : current.whatIDo,
        knownFor: patch.knownFor !== undefined ? patch.knownFor : current.knownFor,
        servicesSummary: patch.servicesSummary !== undefined ? patch.servicesSummary : current.servicesSummary,
        websiteUrl: patch.websiteUrl !== undefined ? patch.websiteUrl : current.websiteUrl,
        links: patch.links !== undefined ? patch.links : current.links,
      };
    },
  },
  idempotency: {
    getClientKey: (input) => (input as MembersUpdateProfileInput).clientKey ?? null,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:members.updateProfile`,
  },
  preGate: async (input) => {
    validateProfileUpdateInput(input as MembersUpdateProfileInput);
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const patch = input as MembersUpdateProfileInput;
    validateProfileUpdateInput(patch);

    if (!ctx.repository.updateClubProfile) {
      throw new AppError('invalid_data', 'Profile update handler is not configured');
    }

    const updatedProfile = await ctx.repository.updateClubProfile({
      actor: ctx.actor,
      patch,
    });

    return {
      data: updatedProfile,
      nextMember: {
        id: updatedProfile.memberId,
        publicName: updatedProfile.publicName,
      },
    };
  },
};

// ── vouches.create ──────────────────────────────────────

type VouchesCreateInput = {
  clubId: string;
  memberId: string;
  reason: string;
  clientKey?: string | null;
};

const VOUCH_CREATE_ERRORS = [
  {
    code: 'vouchee_not_accessible',
    meaning: 'The requested member is not vouchable in the specified club.',
    recovery: 'Choose a member who shares that club with the caller and is not the caller themselves, then retry.',
  },
  {
    code: 'duplicate_vouch',
    meaning: 'The actor has already vouched for this member in this club.',
    recovery: 'Treat the existing vouch as canonical instead of retrying.',
  },
  {
    code: 'low_quality_content',
    meaning: 'The submission was rejected for being too generic or lacking firsthand detail.',
    recovery: 'Relay the feedback to the user, add one specific thing the voucher personally saw, and resubmit.',
  },
  {
    code: 'illegal_content',
    meaning: 'The submission was rejected for soliciting or facilitating clearly illegal activity.',
    recovery: 'Relay the reason to the user, revise the vouch text, and resubmit.',
  },
  {
    code: 'gate_rejected',
    meaning: 'The content gate returned a non-passing verdict after schema validation.',
    recovery: 'Review the feedback, revise the vouch text, and resubmit.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The content gate is temporarily unavailable.',
    recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
  },
] as const;

const vouchesCreate: ActionDefinition = {
  action: 'vouches.create',
  domain: 'vouches',
  description: 'Vouch for another member in a club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership.',
  businessErrors: [...VOUCH_CREATE_ERRORS],
  skipRequestedClubScopePrecheck: true,

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe(describeScopedClubId('Club context for the vouch.')),
      memberId: wireRequiredString.describe('Member to vouch for'),
      reason: wireBoundedString.describe('Reason for vouching'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Idempotency key for this vouch creation.')),
    }),
    output: z.object({ vouch: vouchSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      reason: parseBoundedString,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
    }),
  },

  llmGate: {
    async buildArtifact(input): Promise<NonApplicationArtifact> {
      const parsed = input as VouchesCreateInput;
      return { kind: 'vouch', reason: parsed.reason };
    },
  },
  idempotency: {
    getClientKey: (input) => (input as VouchesCreateInput).clientKey ?? null,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:vouches.create`,
    getRequestValue: (input) => {
      const parsed = input as VouchesCreateInput;
      return {
        clubId: parsed.clubId,
        targetMemberId: parsed.memberId,
        reason: parsed.reason,
      };
    },
  },
  preGate: async (input, ctx) => {
    const { clubId, memberId } = input as VouchesCreateInput;
    const result = await ctx.repository.checkVouchTargetAccessible({
      actorMemberId: ctx.actor.member.id,
      clubId,
      targetMemberId: memberId,
    });
    if (!result.vouchable) {
      throw new AppError('vouchee_not_accessible', 'This member is not vouchable.');
    }
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, reason, clientKey } = input as VouchesCreateInput;

    let vouch;
    try {
      vouch = await ctx.repository.createVouch({
        actorMemberId: ctx.actor.member.id,
        clubId,
        targetMemberId: memberId,
        reason,
        clientKey,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new AppError('duplicate_vouch', 'You have already vouched for this member in this club');
      }
      throw error;
    }

    if (!vouch) {
      throw new AppError('vouchee_not_accessible', 'This member is not vouchable.');
    }

    return {
      data: { vouch },
      requestScope: requestScopeForClub(clubId),
    };
  },
};

// ── vouches.list ────────────────────────────────────────

type VouchesListInput = {
  memberId?: string;
  clubId?: string;
  limit: number;
  cursor: string | null;
};

const vouchesList: ActionDefinition = {
  action: 'vouches.list',
  domain: 'vouches',
  description: 'List vouches for a member.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      memberId: wireRequiredString.optional().describe('Member that is the subject of the vouches — i.e. vouches received (defaults to the calling member). Each result row already carries the creator as fromMemberId.'),
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for vouches.')),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: paginatedOutput(vouchSummary).extend({
      memberId: z.string(),
    }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString.optional(),
      clubId: parseRequiredString.optional(),
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { memberId, clubId, limit, cursor: rawCursor } = input as VouchesListInput;
    const targetMemberId = memberId ?? ctx.actor.member.id;

    if (clubId) {
      ctx.requireAccessibleClub(clubId);
    }

    const clubIds = clubId
      ? [clubId]
      : membershipScopes(ctx.actor.memberships).clubIds;

    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, edgeId]) => ({ createdAt, edgeId }));

    const result = await ctx.repository.listVouches({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      targetMemberId,
      limit,
      cursor,
    });

    return {
      data: { memberId: targetMemberId, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: requestScopeForClubs(clubId ?? null, clubIds),
    };
  },
};

// ── members.searchBySemanticSimilarity ─────────────────────

type MembersFindViaEmbeddingInput = {
  query: string;
  clubId: string;
  limit: number;
  cursor: string | null;
};

const membersFindViaEmbedding: ActionDefinition = {
  action: 'members.searchBySemanticSimilarity',
  domain: 'members',
  description: 'Semantic-similarity search for members in one club. Requires clubId.',
  auth: 'member',
  safety: 'read_only',
  businessErrors: [
    {
      code: 'quota_exceeded',
      meaning: 'The member has reached the rolling semantic-search quota.',
      recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
    },
  ],

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.describe(describeScopedClubId('Club to search semantically within.')),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: paginatedOutput(memberSearchResult).extend({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      query: z.string().trim().min(1).max(1000),
      clubId: parseRequiredString,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, limit, cursor: rawCursor } = input as MembersFindViaEmbeddingInput;
    const { EMBEDDING_PROFILES, embedQueryText, isEmbeddingStubEnabled } = await import('../ai.ts');

    const profile = EMBEDDING_PROFILES.member_profile;
    const club = ctx.requireAccessibleClub(clubId);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && !isEmbeddingStubEnabled()) {
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: club.clubId,
        actionName: 'members.searchBySemanticSimilarity',
        artifactKind: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'no_api_key',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: null,
        feedback: null,
      })?.catch(() => {});
      throw new AppError('embedding_unavailable', 'Embedding service is not configured');
    }

    await ctx.repository.enforceEmbeddingQueryQuota?.({ memberId: ctx.actor.member.id });

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embedQueryText({
        value: query,
        profile: 'member_profile',
        abortSignal: outboundLlmSignal(),
      });
      embedding = result.embedding;
      usageTokens = result.usageTokens;
    } catch (err) {
      logger.error('member_embedding_query_error', err, {
        actionName: 'members.searchBySemanticSimilarity',
        clubId: club.clubId,
        memberId: ctx.actor.member.id,
      });
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: club.clubId,
        actionName: 'members.searchBySemanticSimilarity',
        artifactKind: 'embedding_query',
        provider: 'openai',
        model: profile.model,
        gateStatus: 'skipped',
        skipReason: 'provider_error',
        promptTokens: null,
        completionTokens: null,
        providerErrorCode: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        feedback: null,
      })?.catch(() => {});
      throw new AppError('embedding_unavailable', 'Embedding service is temporarily unavailable');
    }

    ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: club.clubId,
      actionName: 'members.searchBySemanticSimilarity',
      artifactKind: 'embedding_query',
      provider: 'openai',
      model: profile.model,
      gateStatus: 'passed',
      skipReason: null,
      promptTokens: usageTokens,
      completionTokens: 0,
      providerErrorCode: null,
      feedback: null,
    })?.catch(() => {});

    const queryVector = `[${embedding.join(',')}]`;

    const cursor = decodeOptionalCursor(rawCursor, 2, ([distance, memberId]) => ({ distance, memberId }));

    const result = await ctx.repository.findMembersViaEmbedding({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      queryEmbedding: queryVector,
      limit,
      cursor,
    });

    return clubScopedPaginatedResult(club, result, { query, limit });
  },
};

registerActions([
  membersFullTextSearch,
  membersList,
  membersGet,
  membersUpdateProfile,
  membersFindViaEmbedding,
  vouchesCreate,
  vouchesList,
]);
