/**
 * Club owner action contracts: clubowner.members.promoteToAdmin,
 * clubowner.members.demoteFromAdmin
 *
 * All actions require auth: 'clubowner' — the caller must be the club owner
 * or a superadmin. Superadmins are root and pass all authorization gates.
 * All actions require an explicit clubId.
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
  description: 'Promote a club member to admin role.',
  auth: 'clubowner',
  safety: 'mutating',
  authorizationNote: 'Requires club owner or superadmin.',

  requiredCapability: 'promoteMemberToAdmin',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to promote in'),
      memberId: wireRequiredString.describe('Member to promote'),
    }),
    output: z.object({ membership: membershipAdminSummary, changed: z.boolean() }),
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

    const result = await ctx.repository.promoteMemberToAdmin!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Member not found or not eligible for promotion in this club');
    }

    return {
      data: { membership: result.membership, changed: result.changed },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

// ── clubowner.members.demoteFromAdmin ─────────────────

const clubownerMembersDemote: ActionDefinition = {
  action: 'clubowner.members.demoteFromAdmin',
  domain: 'clubowner',
  description: 'Demote a club admin to regular member.',
  auth: 'clubowner',
  safety: 'mutating',
  authorizationNote: 'Requires club owner or superadmin. The club owner cannot be demoted.',

  requiredCapability: 'demoteMemberFromAdmin',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to demote in'),
      memberId: wireRequiredString.describe('Admin to demote'),
    }),
    output: z.object({ membership: membershipAdminSummary, changed: z.boolean() }),
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

    const result = await ctx.repository.demoteMemberFromAdmin!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      memberId,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Admin not found or not eligible for demotion in this club');
    }

    return {
      data: { membership: result.membership, changed: result.changed },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

registerActions([clubownerMembersPromote, clubownerMembersDemote]);
