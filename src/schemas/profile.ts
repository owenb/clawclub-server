/**
 * Action contracts: profile.list, profile.update
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wirePatchString, parsePatchString,
  wireHandle, parseHandle,
  wireLinks, wireProfileObject,
} from './fields.ts';
import { memberProfileEnvelope } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

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
    const actorClubIds = clubId
      ? [ctx.requireAccessibleClub(clubId).clubId]
      : ctx.actor.memberships.map(m => m.clubId);

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
  clubId?: string;
  handle?: string | null;
  displayName?: string;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: unknown[];
  profile?: Record<string, unknown>;
};

const CLUB_SCOPED_KEYS = new Set<keyof ProfileUpdateInput>([
  'tagline', 'summary', 'whatIDo', 'knownFor', 'servicesSummary', 'websiteUrl', 'links', 'profile',
]);

const IDENTITY_KEYS = new Set<keyof ProfileUpdateInput>(['handle', 'displayName']);

function validateProfileUpdateInput(patch: ProfileUpdateInput): void {
  const keys = Object.keys(patch) as Array<keyof ProfileUpdateInput>;
  const changedKeys = keys.filter((key) => key !== 'clubId');
  const hasClubScopedKeys = changedKeys.some((key) => CLUB_SCOPED_KEYS.has(key));
  const hasIdentityKeys = changedKeys.some((key) => IDENTITY_KEYS.has(key));

  if (!hasClubScopedKeys && !hasIdentityKeys) {
    throw new AppError(400, 'invalid_input', 'At least one profile field must be provided');
  }

  if (hasClubScopedKeys && !patch.clubId) {
    throw new AppError(400, 'invalid_input', 'clubId is required when updating club-scoped profile fields');
  }
}

const profileUpdate: ActionDefinition = {
  action: 'profile.update',
  domain: 'profile',
  description: 'Update the current actor profile.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own profile only.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Club to update when sending club-scoped profile fields.'),
      handle: wireHandle,
      displayName: wireRequiredString.optional().describe('Display name (cannot be empty if provided).'),
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
      clubId: parseRequiredString.optional(),
      handle: parseHandle,
      displayName: z.string().trim().min(1).optional(),
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

    if (patch.clubId) {
      ctx.requireAccessibleClub(patch.clubId);
    }

    const updatedProfile = await ctx.repository.updateOwnProfile({
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
