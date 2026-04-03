/**
 * Action contracts: admissions.challenge, admissions.apply
 *
 * These are the only unauthenticated (auth: 'none') actions.
 * They use handleCold instead of handle.
 */
import { z } from 'zod';
import { AppError } from '../app.ts';
import {
  wireBoundedString, parseBoundedString,
  wireFullName, parseFullName,
  wireEmail, parseEmail,
} from './fields.ts';
import { admissionChallengeResult } from './responses.ts';
import { registerActions, type ActionDefinition, type ColdHandlerContext, type ActionResult } from './registry.ts';

// ── admissions.challenge ─────────────────────────────────

const admissionsChallenge: ActionDefinition = {
  action: 'admissions.challenge',
  domain: 'cold-admissions',
  description: 'Request a proof-of-work challenge for a cold admission.',
  auth: 'none',
  safety: 'mutating',
  aiExposed: false,

  wire: {
    input: z.object({}),
    output: admissionChallengeResult,
  },

  parse: {
    input: z.object({}),
  },

  requiredCapability: 'createAdmissionChallenge',

  async handleCold(_input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const challenge = await ctx.repository.createAdmissionChallenge!();
    return {
      data: {
        challengeId: challenge.challengeId,
        difficulty: challenge.difficulty,
        expiresAt: challenge.expiresAt,
        clubs: challenge.clubs,
      },
    };
  },
};

// ── admissions.apply ─────────────────────────────────────

type ApplyInput = {
  challengeId: string;
  nonce: string;
  clubSlug: string;
  name: string;
  email: string;
  socials: string;
  reason: string;
};

const admissionsApply: ActionDefinition = {
  action: 'admissions.apply',
  domain: 'cold-admissions',
  description: 'Submit a solved proof-of-work challenge to create a cold admission.',
  auth: 'none',
  safety: 'mutating',
  aiExposed: false,

  wire: {
    input: z.object({
      challengeId: wireBoundedString.describe('Challenge ID from admissions.challenge'),
      nonce: wireBoundedString.describe('Nonce that solves the PoW'),
      clubSlug: wireBoundedString.describe('Slug of the club to apply to'),
      name: wireFullName,
      email: wireEmail,
      socials: wireBoundedString.describe('Social media handles or URLs'),
      reason: wireBoundedString.describe('Why do you want to join?'),
    }),
    output: z.object({
      message: z.string(),
    }),
  },

  parse: {
    input: z.object({
      challengeId: parseBoundedString,
      nonce: parseBoundedString,
      clubSlug: parseBoundedString,
      name: parseFullName,
      email: parseEmail,
      socials: parseBoundedString,
      reason: parseBoundedString,
    }),
  },

  requiredCapability: 'solveAdmissionChallenge',

  async handleCold(input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const { challengeId, nonce, clubSlug, name, email, socials, reason } = input as ApplyInput;

    const solved = await ctx.repository.solveAdmissionChallenge!({
      challengeId, nonce, clubSlug, name, email, socials, reason,
    });

    if (!solved) {
      throw new AppError(404, 'not_found', 'Requested challenge was not found or the club does not exist');
    }

    return {
      data: {
        message: 'Admission submitted. The club owner will review your request.',
      },
    };
  },
};

registerActions([admissionsChallenge, admissionsApply]);
