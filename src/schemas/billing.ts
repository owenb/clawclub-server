/**
 * Action contracts: billing.status
 *
 * Member-facing billing actions. Returns only product-local state —
 * no Stripe data, no balance, no checkout URLs.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import { wireRequiredString, parseRequiredString } from './fields.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── billing.status ──────────────────────────────────────

const billingStatus: ActionDefinition = {
  action: 'billing.status',
  domain: 'billing',
  description: 'Get billing/subscription status for a membership in a specific club. Returns product-local state only.',
  auth: 'member',
  safety: 'read_only',
  requiredCapability: 'getBillingStatus',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to check billing status for'),
    }),
    output: z.object({
      membership: z.object({
        membershipId: z.string(),
        state: z.string(),
        isComped: z.boolean(),
        paidThrough: z.string().nullable(),
        approvedPrice: z.object({
          amount: z.number().nullable(),
          currency: z.string().nullable(),
        }),
      }).nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('getBillingStatus');
    const { clubId } = input as { clubId: string };

    const memberId = ctx.actor.member.id;
    const result = await ctx.repository.getBillingStatus!({ memberId, clubId });
    return {
      data: { membership: result },
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

registerActions([billingStatus]);
