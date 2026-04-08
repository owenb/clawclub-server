/**
 * Action contracts: admissions.crossClub.requestChallenge, admissions.crossClub.submitApplication
 *
 * Authenticated cross-apply path for existing network members.
 * Lower PoW difficulty, but same admission-policy completeness gate as cold.
 */
import { z } from 'zod';
import {
  wireBoundedString, parseBoundedString,
  wireApplicationText, parseApplicationText,
  wireRequiredString, parseRequiredString,
} from './fields.ts';
import { admissionChallengeResult, admissionApplyResult } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admissions.crossClub.requestChallenge ──────────────────────────────

type CrossChallengeInput = {
  clubSlug: string;
};

const admissionsCrossChallenge: ActionDefinition = {
  action: 'admissions.crossClub.requestChallenge',
  domain: 'admissions',
  description: 'Request a reduced-difficulty PoW challenge for an existing network member applying to a new club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires at least one active membership in any club. Must not already be a member of the target club.',

  wire: {
    input: z.object({
      clubSlug: wireBoundedString.describe('Slug of the club to apply to'),
    }),
    output: admissionChallengeResult,
  },

  parse: {
    input: z.object({
      clubSlug: parseBoundedString,
    }),
  },

  requiredCapability: 'createCrossAdmissionChallenge',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubSlug } = input as CrossChallengeInput;
    const challenge = await ctx.repository.createCrossAdmissionChallenge!({
      actorMemberId: ctx.actor.member.id,
      clubSlug,
    });
    return { data: challenge };
  },
};

// ── admissions.crossClub.submitApplication ──────────────────────────────

type CrossApplyInput = {
  challengeId: string;
  nonce: string;
  socials: string;
  application: string;
};

const admissionsCrossApply: ActionDefinition = {
  action: 'admissions.crossClub.submitApplication',
  domain: 'admissions',
  description: 'Submit a solved cross-apply PoW challenge with an application. Name and email are locked to your profile.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      challengeId: wireRequiredString.describe('Challenge ID from admissions.crossClub.requestChallenge'),
      nonce: wireBoundedString.describe('Nonce that solves the PoW'),
      socials: wireBoundedString.describe('Social media handles or URLs'),
      application: wireApplicationText.describe('Your application — include all information requested by the club\'s admission policy'),
    }),
    output: admissionApplyResult,
  },

  parse: {
    input: z.object({
      challengeId: parseRequiredString,
      nonce: parseBoundedString,
      socials: parseBoundedString,
      application: parseApplicationText,
    }),
  },

  requiredCapability: 'solveCrossAdmissionChallenge',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { challengeId, nonce, socials, application } = input as CrossApplyInput;

    const result = await ctx.repository.solveCrossAdmissionChallenge!({
      actorMemberId: ctx.actor.member.id,
      challengeId, nonce, socials, application,
    });

    return { data: result };
  },
};

registerActions([admissionsCrossChallenge, admissionsCrossApply]);
