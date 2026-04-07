/**
 * Club owner action contracts: clubowner.members.promoteToAdmin,
 * clubowner.members.demoteFromAdmin
 *
 * All actions require auth: 'clubowner' — the caller must be the club owner.
 * Superadmins also pass the clubadmin gate but must still be the club owner
 * for these actions. All actions require an explicit clubId.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import { wireRequiredString, parseRequiredString } from './fields.ts';
import { membershipAdminSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── clubowner.members.promoteToAdmin ──────────────────

const clubownerMembersPromote: ActionDefinition = {
  action: 'clubowner.members.promoteToAdmin',
  domain: 'clubowner',
  description: 'Promote a club member to admin role (owner only).',
  auth: 'clubowner',
  safety: 'mutating',
  authorizationNote: 'Only the club owner can promote members.',

  requiredCapability: 'promoteMemberToAdmin',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to promote in'),
      memberId: wireRequiredString.describe('Member to promote'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId } = input as { clubId: string; memberId: string };
    ctx.requireClubAdmin(clubId);
    ctx.requireClubOwner(clubId);
    ctx.requireCapability('promoteMemberToAdmin');

    const membership = await ctx.repository.promoteMemberToAdmin!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Member not found or not eligible for promotion in this club');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

// ── clubowner.members.demoteFromAdmin ─────────────────

const clubownerMembersDemote: ActionDefinition = {
  action: 'clubowner.members.demoteFromAdmin',
  domain: 'clubowner',
  description: 'Demote a club admin to regular member (owner only).',
  auth: 'clubowner',
  safety: 'mutating',
  authorizationNote: 'Only the club owner can demote admins. The owner cannot be demoted.',

  requiredCapability: 'demoteMemberFromAdmin',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to demote in'),
      memberId: wireRequiredString.describe('Admin to demote'),
    }),
    output: z.object({ membership: membershipAdminSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      memberId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, memberId } = input as { clubId: string; memberId: string };
    ctx.requireClubAdmin(clubId);
    ctx.requireClubOwner(clubId);
    ctx.requireCapability('demoteMemberFromAdmin');

    const membership = await ctx.repository.demoteMemberFromAdmin!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
    });

    if (!membership) {
      throw new AppError(404, 'not_found', 'Admin not found or not eligible for demotion in this club');
    }

    return {
      data: { membership },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

registerActions([clubownerMembersPromote, clubownerMembersDemote]);
