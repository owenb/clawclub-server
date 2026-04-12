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
import { normalizeAdmissionApplyOutcome } from './admissions-common.ts';
import { admissionChallengeResult, admissionApplyResult } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── admissions.crossClub.requestChallenge ──────────────────────────────

type CrossChallengeInput = {
  clubSlug: string;
};

const CROSS_CHALLENGE_ERRORS = [
  {
    code: 'no_active_membership',
    meaning: 'Only active members of an existing club can use the cross-club apply path.',
    recovery: 'Use the cold public admissions path, or authenticate as a member with an active membership.',
  },
  {
    code: 'membership_exists',
    meaning: 'The actor already has a membership record in the target club.',
    recovery: 'Stop retrying this path and contact the club admin instead.',
  },
  {
    code: 'admission_pending',
    meaning: 'The actor already has a pending admission for the target club.',
    recovery: 'Wait for the current admission to be resolved before retrying.',
  },
  {
    code: 'too_many_pending',
    meaning: 'The actor has too many pending cross-club applications across the network.',
    recovery: 'Wait for existing applications to resolve before applying to more clubs.',
  },
  {
    code: 'incomplete_profile',
    meaning: 'The actor profile is missing the required name or email for cross-application.',
    recovery: 'Update the profile first, then request a fresh challenge.',
  },
] as const;

const admissionsCrossChallenge: ActionDefinition = {
  action: 'admissions.crossClub.requestChallenge',
  domain: 'admissions',
  description: 'Request a reduced-difficulty PoW challenge for an existing network member applying to a new club. The response carries the club\'s admission policy and an expiresAt timestamp; the challenge is valid for one hour from creation. Read the policy before drafting — the admission gate is a literal completeness check, the same one cold applicants face.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires at least one active membership in any club. Must not already be a member of the target club. Capped at 3 pending cross-applications across all clubs.',
  businessErrors: [...CROSS_CHALLENGE_ERRORS],

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

const CROSS_SUBMIT_ERRORS = [
  {
    code: 'challenge_not_found',
    meaning: 'The challenge ID does not exist or is no longer available.',
    recovery: 'Request a fresh challenge and try again.',
  },
  {
    code: 'challenge_not_yours',
    meaning: 'The challenge was issued to a different authenticated member.',
    recovery: 'Use the token that requested the challenge, or request a new one under the current account.',
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
    code: 'incomplete_profile',
    meaning: 'The actor profile is missing the required name or email for cross-application.',
    recovery: 'Update the profile first, then request a fresh challenge.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The admission gate is temporarily unavailable.',
    recovery: 'Retry the same submission after a short delay. If the outage persists, surface it to the user.',
  },
] as const;

const admissionsCrossApply: ActionDefinition = {
  action: 'admissions.crossClub.submitApplication',
  domain: 'admissions',
  description: 'Submit a solved cross-apply PoW challenge with an application. Name and email are locked to your profile. On needs_revision the challenge is not consumed — patch only the items in feedback and resubmit against the same challengeId.',
  auth: 'member',
  safety: 'mutating',
  businessErrors: [...CROSS_SUBMIT_ERRORS],
  notes: [
    'Name and email are locked to the current profile. Do not send them again on submit.',
    'A needs_revision status means the challenge remains valid and the same challengeId and nonce can be reused.',
    'When status is accepted, the message field is the server\'s canonical response text.',
  ],

  wire: {
    input: z.object({
      challengeId: wireRequiredString.describe('Challenge ID from admissions.crossClub.requestChallenge'),
      nonce: wireBoundedString.describe('Canonical PoW: a nonce such that sha256(challengeId + ":" + nonce) ends in `difficulty` hex zeros. The server currently also accepts a leading-zero compatibility fallback, but clients should solve for trailing zeros.'),
      socials: wireBoundedString.describe('Social media handles or URLs'),
      application: wireApplicationText.describe('Your application. The admission gate is a literal completeness check: it rejects when an explicit ask in the policy is left unanswered, but does not reject for vagueness, brevity, or quality on its own. If the policy is question-shaped, answer every question directly.'),
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

    return normalizeAdmissionApplyOutcome(result);
  },
};

registerActions([admissionsCrossChallenge, admissionsCrossApply]);
