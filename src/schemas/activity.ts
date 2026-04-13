import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString,
  parseRequiredString,
  wireCursor,
  parseCursor,
  wireLimitOf,
  parseLimitOf,
  encodeCursor,
  decodeCursor,
} from './fields.ts';
import { activityEvent } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

function encodeActivityCursor(seq: number): string {
  return encodeCursor([String(seq)]);
}

function decodeActivityCursor(cursor: string): number {
  const [rawSeq] = decodeCursor(cursor, 1);
  const seq = Number.parseInt(rawSeq, 10);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new AppError(400, 'invalid_input', 'Invalid activity cursor');
  }
  return seq;
}

const activityList: ActionDefinition = {
  action: 'activity.list',
  domain: 'activity',
  description: 'List club activity events for the current scope.',
  auth: 'member',
  safety: 'read_only',
  notes: [
    'Use after="latest" to skip backlog and start from the current activity tip.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Optional club scope. Omit to read across all accessible clubs.'),
      limit: wireLimitOf(20),
      after: wireCursor.describe('Opaque activity cursor from a previous response, or "latest" to seed from the current tip.'),
    }),
    output: z.object({
      items: z.array(activityEvent),
      nextAfter: z.string().nullable(),
      polledAt: z.string(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimitOf(20, 20),
      after: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, limit, after } = input as { clubId?: string; limit: number; after: string | null };
    const scopedMemberships = ctx.resolveScopedClubs(clubId);
    const clubIds = scopedMemberships.map((membership) => membership.clubId);
    const adminClubIds = scopedMemberships
      .filter((membership) => membership.role === 'clubadmin')
      .map((membership) => membership.clubId);
    const ownerClubIds = scopedMemberships
      .filter((membership) => membership.isOwner)
      .map((membership) => membership.clubId);

    const afterSeq = after === 'latest'
      ? null
      : after === null
        ? 0
        : decodeActivityCursor(after);

    const result = await ctx.repository.listClubActivity({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      adminClubIds,
      ownerClubIds,
      limit,
      afterSeq,
    });

    return {
      data: {
        items: result.items,
        nextAfter: result.nextAfterSeq === null ? null : encodeActivityCursor(result.nextAfterSeq),
        polledAt: new Date().toISOString(),
      },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

registerActions([activityList]);
