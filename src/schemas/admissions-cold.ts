/**
 * Action contracts: admissions.public.requestChallenge, admissions.public.submitApplication
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
import { normalizeAdmissionApplyOutcome } from './admissions-common.ts';
import { admissionChallengeResult, admissionApplyResult } from './responses.ts';
import { registerActions, type ActionDefinition, type ColdHandlerContext, type ActionResult } from './registry.ts';

// ── admissions.public.requestChallenge ────────────────────────────────

type ChallengeInput = {
  clubSlug: string;
};

const admissionsChallenge: ActionDefinition = {
  action: 'admissions.public.requestChallenge',
  domain: 'admissions',
  description: 'Request a proof-of-work challenge bound to a specific club. The response carries the club\'s admission policy and an expiresAt timestamp; the challenge is valid for one hour from creation. Read the policy before drafting — the admission gate is a literal completeness check.',
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

// ── admissions.public.submitApplication ────────────────────────────────

type ApplyInput = {
  challengeId: string;
  nonce: string;
  name: string;
  email: string;
  socials: string;
  application: string;
};

const COLD_SUBMIT_ERRORS = [
  {
    code: 'challenge_not_found',
    meaning: 'The challenge ID does not exist or is no longer available.',
    recovery: 'Request a fresh challenge and try again.',
  },
  {
    code: 'challenge_not_cold',
    meaning: 'The challenge was issued for the authenticated cross-club path, not the cold public path.',
    recovery: 'Use admissions.crossClub.submitApplication with the authenticated member token instead.',
  },
  {
    code: 'challenge_expired',
    meaning: 'The challenge expired before submission.',
    recovery: 'Request a fresh challenge.',
  },
  {
    code: 'invalid_proof',
    meaning: 'The proof-of-work nonce did not satisfy the challenge difficulty.',
    recovery: 'Re-solve the PoW for this challenge and resubmit.',
  },
  {
    code: 'challenge_consumed',
    meaning: 'A concurrent request already consumed this challenge.',
    recovery: 'Request a fresh challenge and try again.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The admission gate is temporarily unavailable.',
    recovery: 'Retry the same submission after a short delay. If the outage persists, surface it to the user.',
  },
] as const;

const admissionsApply: ActionDefinition = {
  action: 'admissions.public.submitApplication',
  domain: 'admissions',
  description: 'Submit a solved proof-of-work challenge with an application. On needs_revision the challenge is not consumed — patch only the items in feedback and resubmit against the same challengeId.',
  auth: 'none',
  safety: 'mutating',
  businessErrors: [...COLD_SUBMIT_ERRORS],
  notes: [
    'The club is bound to the challenge. Do not send clubSlug again on submit.',
    'Use application for the free-text field; do not send reason.',
    'A needs_revision status means the challenge remains valid and the same challengeId and nonce can be reused.',
    'When status is accepted, the message field is the server\'s canonical response text.',
  ],

  wire: {
    input: z.object({
      challengeId: wireBoundedString.describe('Challenge ID from admissions.public.requestChallenge'),
      nonce: wireBoundedString.describe('Canonical PoW: a nonce such that sha256(challengeId + ":" + nonce) ends in `difficulty` hex zeros. The server currently also accepts a leading-zero compatibility fallback, but clients should solve for trailing zeros.'),
      name: wireFullName,
      email: wireEmail,
      socials: wireBoundedString.describe('Social media handles or URLs'),
      application: wireApplicationText.describe('Your application. The admission gate is a literal completeness check: it rejects when an explicit ask in the policy is left unanswered, but does not reject for vagueness, brevity, or quality on its own. If the policy is question-shaped, answer every question directly.'),
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

    return normalizeAdmissionApplyOutcome(result);
  },
};

registerActions([admissionsChallenge, admissionsApply]);
