/**
 * Action contracts: admissions.challenge, admissions.apply
 *
 * These are the unauthenticated (auth: 'none') cold-admissions actions.
 * They use handleCold instead of handle.
 *
 * Club discovery is out of band — the user must already know the club slug.
 */
import { z } from 'zod';
import {
  wireBoundedString, parseBoundedString,
  wireApplicationText, parseApplicationText,
  wireFullName, parseFullName,
  wireEmail, parseEmail,
} from './fields.ts';
import { admissionChallengeResult, admissionApplyResult } from './responses.ts';
import { registerActions, type ActionDefinition, type ColdHandlerContext, type ActionResult } from './registry.ts';

// ── admissions.challenge ────────────────────────────────

type ChallengeInput = {
  clubSlug: string;
};

const admissionsChallenge: ActionDefinition = {
  action: 'admissions.challenge',
  domain: 'cold-admissions',
  description: 'Request a proof-of-work challenge bound to a specific club.',
  auth: 'none',
  safety: 'mutating',

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

  requiredCapability: 'createAdmissionChallenge',

  async handleCold(input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const { clubSlug } = input as ChallengeInput;
    const challenge = await ctx.repository.createAdmissionChallenge!({ clubSlug });
    return { data: challenge };
  },
};

// ── admissions.apply ────────────────────────────────────

type ApplyInput = {
  challengeId: string;
  nonce: string;
  name: string;
  email: string;
  socials: string;
  application: string;
};

const admissionsApply: ActionDefinition = {
  action: 'admissions.apply',
  domain: 'cold-admissions',
  description: 'Submit a solved proof-of-work challenge with an application.',
  auth: 'none',
  safety: 'mutating',

  wire: {
    input: z.object({
      challengeId: wireBoundedString.describe('Challenge ID from admissions.challenge'),
      nonce: wireBoundedString.describe('Nonce that solves the PoW'),
      name: wireFullName,
      email: wireEmail,
      socials: wireBoundedString.describe('Social media handles or URLs'),
      application: wireApplicationText.describe('Your application — include all information requested by the club\'s admission policy'),
    }),
    output: admissionApplyResult,
  },

  parse: {
    input: z.object({
      challengeId: parseBoundedString,
      nonce: parseBoundedString,
      name: parseFullName,
      email: parseEmail,
      socials: parseBoundedString,
      application: parseApplicationText,
    }),
  },

  requiredCapability: 'solveAdmissionChallenge',

  async handleCold(input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const { challengeId, nonce, name, email, socials, application } = input as ApplyInput;

    const result = await ctx.repository.solveAdmissionChallenge!({
      challengeId, nonce, name, email, socials, application,
    });

    return { data: result };
  },
};

registerActions([admissionsChallenge, admissionsApply]);
