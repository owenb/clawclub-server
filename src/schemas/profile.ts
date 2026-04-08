/**
 * Action contracts: profile.get, profile.update
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, wirePatchString, parsePatchString,
  wireHandle, parseHandle,
  wireLinks, wireProfileObject,
} from './fields.ts';
import { memberProfile } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── profile.get ──────────────────────────────────────────

const profileGet: ActionDefinition = {
  action: 'profile.get',
  domain: 'profile',
  description: 'Read a member profile. Omit memberId for the current actor.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      memberId: wireRequiredString.optional().describe('Target member ID. Omit for own profile.'),
    }),
    output: memberProfile,
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString.optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { memberId } = input as { memberId?: string };
    const targetMemberId = memberId ?? ctx.actor.member.id;

    const profile = await ctx.repository.getMemberProfile({
      actorMemberId: ctx.actor.member.id,
      targetMemberId,
      actorClubIds: ctx.actor.memberships.map(m => m.clubId),
    });

    if (!profile) {
      throw new AppError(404, 'not_found', 'Member profile not found inside the actor scope');
    }

    return { data: profile };
  },
};

// ── profile.update ───────────────────────────────────────

type ProfileUpdateInput = {
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

const profileUpdate: ActionDefinition = {
  action: 'profile.update',
  domain: 'profile',
  description: 'Update the current actor profile.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own profile only.',

  wire: {
    input: z.object({
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
    output: memberProfile,
  },

  parse: {
    input: z.object({
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

registerActions([profileGet, profileUpdate]);
