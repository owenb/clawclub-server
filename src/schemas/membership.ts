/**
 * Action contracts: admissions.sponsor, members.fullTextSearch, members.list,
 * members.findViaEmbedding, vouches.create, vouches.list
 *
 * Member-auth actions for discovery, sponsorship, and vouching.
 * Club admin actions (memberships, admissions management) are in clubadmin.ts.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireLimit, parseLimit,
  wireBoundedString, parseBoundedString,
  wireFullName, parseFullName,
  wireEmail, parseEmail,
} from './fields.ts';
import {
  membershipSummary, admissionSummary,
  memberSearchResult, clubMemberSummary, vouchSummary,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admissions.sponsor ──────────────────────────────────

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

// ── members.fullTextSearch ──────────────────────────────

type MembersFullTextSearchInput = {
  query: string;
  clubId?: string;
  limit: number;
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
  action: 'members.searchBySemanticSimilarity',
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
  admissionsSponsor,
  membersFullTextSearch,
  membersList,
  membersFindViaEmbedding,
  vouchesCreate,
  vouchesList,
]);
