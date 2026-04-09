/**
 * Action contract: admissions.getMine
 */
import { z } from 'zod';
import { wireRequiredString, parseRequiredString } from './fields.ts';
import { memberAdmissionRecord } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

type AdmissionsGetMineInput = {
  clubId?: string;
};

const admissionsGetMine: ActionDefinition = {
  action: 'admissions.getMine',
  domain: 'admissions',
  description: 'Read your own admission records, including your application text, status, club, and timestamps.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Optional club filter'),
    }),
    output: z.object({
      admissions: z.array(memberAdmissionRecord),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId } = input as AdmissionsGetMineInput;
    const admissions = await ctx.repository.getAdmissionsForMember({
      memberId: ctx.actor.member.id,
      clubId,
    });

    return {
      data: { admissions },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: ctx.actor.memberships.map(m => m.clubId),
      },
    };
  },
};

registerActions([admissionsGetMine]);
