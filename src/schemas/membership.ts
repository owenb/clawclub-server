/**
 * Action contracts: admissions.sponsorCandidate, members.searchByFullText, members.list,
 * members.searchBySemanticSimilarity, members.updateIdentity, vouches.create, vouches.list
 *
 * Member-auth actions for discovery, sponsorship, and vouching.
 * Club admin actions (memberships, admissions management) are in clubadmin.ts.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireBoundedString, parseBoundedString,
  wireFullName, parseFullName,
  wireEmail, parseEmail,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import {
  membershipSummary, admissionSummary,
  memberSearchResult, clubMemberSummary, memberIdentity, vouchSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admissions.sponsorCandidate ──────────────────────────────────

type AdmissionsSponsorInput = {
  clubId: string;
  name: string;
  email: string;
  socials: string;
  reason: string;
};

const admissionsSponsor: ActionDefinition = {
  action: 'admissions.sponsorCandidate',
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

  qualityGate: 'admissions-sponsorCandidate',

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
  description: 'Full-text search for members across accessible clubs using PostgreSQL FTS.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: wireRequiredString.describe('Search text'),
      clubId: wireRequiredString.describe('Restrict to one club'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(memberSearchResult),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      query: parseRequiredString,
      clubId: parseRequiredString,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { query, clubId, limit, cursor: rawCursor } = input as MembersFullTextSearchInput;

    const club = ctx.requireAccessibleClub(clubId);

    const cursor = rawCursor ? (() => {
      const [rank, memberId] = decodeCursor(rawCursor, 2);
      return { rank, memberId };
    })() : null;

    const result = await ctx.repository.fullTextSearchMembers({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      query,
      limit,
      cursor,
    });

    return {
      data: { query, limit, clubScope: [club], results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
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
  description: 'List members across accessible clubs.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Restrict to one club'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(clubMemberSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
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

    const cursor = rawCursor ? (() => {
      const [joinedAt, memberId] = decodeCursor(rawCursor, 2);
      return { joinedAt, memberId };
    })() : null;

    const result = await ctx.repository.listMembers({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      limit,
      cursor,
    });

    return {
      data: { limit, clubScope: [club], results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── members.updateIdentity ──────────────────────────────

type MembersUpdateIdentityInput = {
  handle?: string | null;
  displayName?: string;
};

const membersUpdateIdentity: ActionDefinition = {
  action: 'members.updateIdentity',
  domain: 'members',
  description: 'Update the current actor\'s global identity fields.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own global identity only.',

  wire: {
    input: z.object({
      handle: wireOptionalString.describe('Global handle'),
      displayName: wireOptionalString.describe('Global display name'),
    }),
    output: memberIdentity,
  },

  parse: {
    input: z.object({
      handle: parseTrimmedNullableString.optional(),
      displayName: z.string().trim().min(1).optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const patch = input as MembersUpdateIdentityInput;
    if (patch.handle === undefined && patch.displayName === undefined) {
      throw new AppError(400, 'invalid_input', 'At least one identity field must be provided');
    }

    const identity = await ctx.repository.updateMemberIdentity!({
      actor: ctx.actor,
      patch,
    });

    return {
      data: identity,
      nextMember: {
        id: identity.memberId,
        handle: identity.handle,
        publicName: identity.publicName,
      },
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
  domain: 'vouches',
  description: 'Vouch for another member in a club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership. Cannot self-vouch.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club context'),
      memberId: wireRequiredString.describe('Member to vouch for'),
      reason: wireBoundedString.describe('Reason for vouching'),
      clientKey: wireOptionalString.describe('Idempotency key'),
    }),
    output: z.object({ vouch: vouchSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
      reason: parseBoundedString,
      clientKey: parseTrimmedNullableString.default(null),
    }),
  },

  qualityGate: 'vouches-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId, reason, clientKey } = input as VouchesCreateInput & { clientKey?: string | null };
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
        clientKey,
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
      memberId: wireRequiredString.describe('Member to list vouches for'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      memberId: z.string(),
      results: z.array(vouchSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
      clubId: parseRequiredString.optional(),
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { memberId: targetMemberId, clubId, limit, cursor: rawCursor } = input as VouchesListInput;

    if (clubId) {
      ctx.requireAccessibleClub(clubId);
    }

    const clubIds = clubId
      ? [clubId]
      : ctx.actor.memberships.map(m => m.clubId);

    const cursor = rawCursor ? (() => {
      const [createdAt, edgeId] = decodeCursor(rawCursor, 2);
      return { createdAt, edgeId };
    })() : null;

    const result = await ctx.repository.listVouches({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      targetMemberId,
      limit,
      cursor,
    });

    return {
      data: { memberId: targetMemberId, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
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
  description: 'Find members by natural-language query using embedding similarity.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      query: z.string().max(1000).describe('Natural-language search query (max 1000 chars)'),
      clubId: wireRequiredString.describe('Restrict to one club'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(memberSearchResult),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
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
    const { embed } = await import('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { EMBEDDING_PROFILES } = await import('../ai.ts');

    const profile = EMBEDDING_PROFILES.member_profile;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: clubId ?? null,
        actionName: 'members.searchBySemanticSimilarity',
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

    const club = ctx.requireAccessibleClub(clubId);

    const provider = createOpenAI({ apiKey });
    const embeddingModel = provider.embedding(profile.model);

    let embedding: number[];
    let usageTokens = 0;
    try {
      const result = await embed({
        model: embeddingModel,
        value: query,
        providerOptions: { openai: { dimensions: profile.dimensions } },
      });
      embedding = result.embedding;
      usageTokens = result.usage?.tokens ?? 0;
    } catch (err) {
      console.error('Embedding provider error in members.searchBySemanticSimilarity:', err);
      ctx.repository.logLlmUsage?.({
        memberId: ctx.actor.member.id,
        requestedClubId: club.clubId,
        actionName: 'members.searchBySemanticSimilarity',
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
        requestedClubId: club.clubId,
      actionName: 'members.searchBySemanticSimilarity',
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

    const cursor = rawCursor ? (() => {
      const [distance, memberId] = decodeCursor(rawCursor, 2);
      return { distance, memberId };
    })() : null;

    const result = await ctx.repository.findMembersViaEmbedding({
      actorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      queryEmbedding: queryVector,
      limit,
      cursor,
    });

    return {
      data: { query, limit, clubScope: [club], results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

registerActions([
  admissionsSponsor,
  membersFullTextSearch,
  membersList,
  membersUpdateIdentity,
  membersFindViaEmbedding,
  vouchesCreate,
  vouchesList,
]);
