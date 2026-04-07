/**
 * Action contracts: superadmin.billing.activateMembership,
 * superadmin.billing.renewMembership, superadmin.billing.markRenewalPending,
 * superadmin.billing.expireMembership, superadmin.billing.cancelAtPeriodEnd,
 * superadmin.billing.banMember, superadmin.billing.setClubPrice,
 * superadmin.billing.archiveClub
 *
 * Billing sync surface — called by the external billing system to update
 * product state. All actions are superadmin-gated and idempotent.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import { wireRequiredString, parseRequiredString } from './fields.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── superadmin.billing.activateMembership ─────────────────

type ActivateMembershipInput = {
  membershipId: string;
  paidThrough: string;
};

const billingActivateMembership: ActionDefinition = {
  action: 'superadmin.billing.activateMembership',
  domain: 'superadmin',
  description: 'Transition a membership from payment_pending to active and create a subscription row. Idempotent: no-op if already active with same or later paidThrough.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingActivateMembership',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to activate'),
      paidThrough: wireRequiredString.describe('ISO 8601 date/datetime for subscription period end'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
      paidThrough: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingActivateMembership');
    const { membershipId, paidThrough } = input as ActivateMembershipInput;
    await ctx.repository.billingActivateMembership!({ membershipId, paidThrough });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.renewMembership ────────────────────

type RenewMembershipInput = {
  membershipId: string;
  newPaidThrough: string;
};

const billingRenewMembership: ActionDefinition = {
  action: 'superadmin.billing.renewMembership',
  domain: 'superadmin',
  description: 'Extend a subscription period end date forward. If membership was cancelled, transitions back to active. Idempotent: no-op if already at or past the given date.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingRenewMembership',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to renew'),
      newPaidThrough: wireRequiredString.describe('New ISO 8601 period end date (must be forward-only)'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
      newPaidThrough: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingRenewMembership');
    const { membershipId, newPaidThrough } = input as RenewMembershipInput;
    await ctx.repository.billingRenewMembership!({ membershipId, newPaidThrough });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.markRenewalPending ─────────────────

const billingMarkRenewalPending: ActionDefinition = {
  action: 'superadmin.billing.markRenewalPending',
  domain: 'superadmin',
  description: 'Transition active membership to renewal_pending and mark subscription past_due. Idempotent: no-op if already renewal_pending.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingMarkRenewalPending',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to mark renewal pending'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingMarkRenewalPending');
    const { membershipId } = input as { membershipId: string };
    await ctx.repository.billingMarkRenewalPending!({ membershipId });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.expireMembership ───────────────────

const billingExpireMembership: ActionDefinition = {
  action: 'superadmin.billing.expireMembership',
  domain: 'superadmin',
  description: 'Transition a membership to expired from active, renewal_pending, cancelled, or payment_pending. Sets subscription to ended. Idempotent: no-op if already expired.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingExpireMembership',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to expire'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingExpireMembership');
    const { membershipId } = input as { membershipId: string };
    await ctx.repository.billingExpireMembership!({ membershipId });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.cancelAtPeriodEnd ──────────────────

const billingCancelAtPeriodEnd: ActionDefinition = {
  action: 'superadmin.billing.cancelAtPeriodEnd',
  domain: 'superadmin',
  description: 'Transition active membership to cancelled. Does not end the subscription (Stripe keeps it active until period end). Idempotent: no-op if already cancelled.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingCancelAtPeriodEnd',

  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to cancel at period end'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      membershipId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingCancelAtPeriodEnd');
    const { membershipId } = input as { membershipId: string };
    await ctx.repository.billingCancelAtPeriodEnd!({ membershipId });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.banMember ──────────────────────────

type BanMemberInput = {
  memberId: string;
  reason: string;
};

const billingBanMember: ActionDefinition = {
  action: 'superadmin.billing.banMember',
  domain: 'superadmin',
  description: 'Ban a member: sets member state to banned, transitions all non-terminal memberships to banned, and ends all live subscriptions. Idempotent: no-op if already banned.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingBanMember',

  wire: {
    input: z.object({
      memberId: wireRequiredString.describe('Member to ban'),
      reason: wireRequiredString.describe('Reason for the ban'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      memberId: parseRequiredString,
      reason: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingBanMember');
    const { memberId, reason } = input as BanMemberInput;
    await ctx.repository.billingBanMember!({ memberId, reason });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.setClubPrice ───────────────────────

type SetClubPriceInput = {
  clubId: string;
  amount: number | null;
  currency: string;
};

const billingSetClubPrice: ActionDefinition = {
  action: 'superadmin.billing.setClubPrice',
  domain: 'superadmin',
  description: 'Set the membership price for a club by creating a new club version. Pass amount=null to make the club free. Idempotent: no-op if price already matches.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingSetClubPrice',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to set price for'),
      amount: z.number().min(0).nullable().describe('Price amount in minor or major units, or null to clear'),
      currency: z.string().optional().default('USD').describe('3-letter ISO currency code (default USD)'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      amount: z.number().min(0).nullable(),
      currency: z.string().trim().toUpperCase().optional().default('USD')
        .refine(s => /^[A-Z]{3}$/.test(s), 'Must be a 3-letter ISO currency code'),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingSetClubPrice');
    const { clubId, amount, currency } = input as SetClubPriceInput;
    await ctx.repository.billingSetClubPrice!({ clubId, amount, currency });
    return { data: { ok: true } };
  },
};

// ── superadmin.billing.archiveClub ────────────────────────

const billingArchiveClub: ActionDefinition = {
  action: 'superadmin.billing.archiveClub',
  domain: 'superadmin',
  description: 'Archive a club, bypassing the paid-club guard. Idempotent: no-op if already archived.',
  auth: 'superadmin',
  safety: 'mutating',

  requiredCapability: 'billingArchiveClub',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to archive'),
    }),
    output: z.object({ ok: z.boolean() }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireSuperadmin();
    ctx.requireCapability('billingArchiveClub');
    const { clubId } = input as { clubId: string };
    await ctx.repository.billingArchiveClub!({ clubId });
    return { data: { ok: true } };
  },
};

// ── Registration ──────────────────────────────────────────

registerActions([
  billingActivateMembership,
  billingRenewMembership,
  billingMarkRenewalPending,
  billingExpireMembership,
  billingCancelAtPeriodEnd,
  billingBanMember,
  billingSetClubPrice,
  billingArchiveClub,
]);
