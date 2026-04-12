/**
 * Action contracts: profile.list, profile.update
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wirePatchString, parsePatchString,
  wireLinks, wireProfileObject,
} from './fields.ts';
import { memberProfileEnvelope } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const PROFILE_UPDATE_ERRORS = [
  {
    code: 'illegal_content',
    meaning: 'The profile update was rejected for soliciting or facilitating clearly illegal activity.',
    recovery: 'Relay the reason to the user, revise the profile fields, and resubmit.',
  },
  {
    code: 'gate_rejected',
    meaning: 'The profile update failed the quality gate after schema validation.',
    recovery: 'Review the feedback, revise the profile fields, and resubmit.',
  },
  {
    code: 'gate_unavailable',
    meaning: 'The profile quality gate is temporarily unavailable.',
    recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
  },
] as const;

type ProfileListInput = {
  memberId?: string;
  clubId?: string;
};

const profileList: ActionDefinition = {
  action: 'profile.list',
  domain: 'profile',
  description: 'List a member\'s visible profiles across clubs. Omit memberId for the current actor.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      memberId: wireRequiredString.optional().describe('Target member ID. Omit for own profile.'),
      clubId: wireRequiredString.optional().describe('Restrict to one club inside the actor scope.'),
    }),
    output: memberProfileEnvelope,
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString.optional(),
      clubId: parseRequiredString.optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { memberId, clubId } = input as ProfileListInput;
    const targetMemberId = memberId ?? ctx.actor.member.id;
    const actorClubIds = ctx.actor.memberships.map(m => m.clubId);

    const profile = await ctx.repository.listMemberProfiles({
      actorMemberId: ctx.actor.member.id,
      targetMemberId,
      actorClubIds,
      clubId: clubId ?? undefined,
    });

    if (!profile) {
      throw new AppError(404, 'not_found', 'Member profile not found inside the actor scope');
    }

    return {
      data: profile,
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: actorClubIds },
    };
  },
};

type ProfileUpdateInput = {
  clubId: string;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: unknown[];
  profile?: Record<string, unknown>;
};

function validateProfileUpdateInput(patch: ProfileUpdateInput): void {
  const keys = Object.keys(patch) as Array<keyof ProfileUpdateInput>;
  const changedKeys = keys.filter((key) => key !== 'clubId');

  if (changedKeys.length === 0) {
    throw new AppError(400, 'invalid_input', 'At least one profile field must be provided');
  }
}

const profileUpdate: ActionDefinition = {
  action: 'profile.update',
  domain: 'profile',
  description: 'Update the current actor club-scoped profile fields for one club.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own profile only.',
  businessErrors: [...PROFILE_UPDATE_ERRORS],
  notes: [
    'Use members.updateIdentity for global identity fields like handle and displayName. profile.update only changes club-scoped profile fields.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club whose profile should be updated.'),
      tagline: wirePatchString.describe('Short tagline'),
      summary: wirePatchString.describe('Profile summary'),
      whatIDo: wirePatchString.describe('What I do'),
      knownFor: wirePatchString.describe('Known for'),
      servicesSummary: wirePatchString.describe('Services summary'),
      websiteUrl: wirePatchString.describe('Website URL'),
      links: wireLinks,
      profile: wireProfileObject,
    }),
    output: memberProfileEnvelope,
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      tagline: parsePatchString,
      summary: parsePatchString,
      whatIDo: parsePatchString,
      knownFor: parsePatchString,
      servicesSummary: parsePatchString,
      websiteUrl: parsePatchString,
      links: z.array(z.unknown()).optional(),
      profile: z.record(z.string(), z.unknown()).optional(),
    }),
  },

  qualityGate: 'profile-update',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const patch = input as ProfileUpdateInput;
    validateProfileUpdateInput(patch);

    if (!ctx.repository.updateClubProfile) {
      throw new AppError(500, 'invalid_data', 'Profile update handler is not configured');
    }

    const updatedProfile = await ctx.repository.updateClubProfile({
      actor: ctx.actor,
      patch,
    });

    return {
      data: updatedProfile,
      nextMember: {
        id: updatedProfile.memberId,
        handle: updatedProfile.handle,
        publicName: updatedProfile.publicName,
      },
    };
  },
};

registerActions([profileList, profileUpdate]);
