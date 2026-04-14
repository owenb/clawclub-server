import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  membershipState,
  parseApplicationText,
  parseBoundedString,
  parseCursor,
  parseEmail,
  parseLimitOf,
  parseRequiredString,
  parseTrimmedNullableString,
  wireApplicationText,
  wireBoundedString,
  wireCursor,
  wireLimitOf,
  wireRequiredString,
} from './fields.ts';
import {
  applicationSummary,
  clubJoinResult,
  clubsApplicationsSubmitResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type ActionResult, type HandlerContext, type OptionalHandlerContext } from './registry.ts';

const wireAsciiEmail = z.string()
  .max(500)
  .describe('ASCII email address. Server trims, lowercases, and validates @.');

const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');

const applicationStatusFilter = z.union([membershipState, z.array(membershipState).min(1)]);

const clubsJoin: ActionDefinition = {
  action: 'clubs.join',
  domain: 'clubs',
  description: 'Create or resume a club application for the calling human. Missing Authorization joins anonymously; a valid bearer token reuses the existing member identity.',
  auth: 'optional_member',
  safety: 'mutating',
  requiredCapability: 'joinClub',
  notes: [
    'This action is safely retryable on the same clubSlug/email pair.',
    'Missing Authorization header uses the anonymous branch. Present-but-invalid Authorization returns 401.',
  ],
  businessErrors: [
    {
      code: 'email_required_for_first_join',
      meaning: 'An authenticated member without a stored contact email must provide one before joining a new club.',
      recovery: 'Retry clubs.join with the email field set.',
    },
    {
      code: 'invalid_invitation_code',
      meaning: 'The invitation code was malformed, expired, revoked, mismatched, or otherwise unusable.',
      recovery: 'Retry with a different invitation code or omit invitationCode and proceed through PoW.',
    },
  ],
  wire: {
    input: z.object({
      clubSlug: wireRequiredString.describe('Club slug to join'),
      email: wireAsciiEmail.optional().describe('Required for anonymous joins and for authenticated joins that do not yet have a stored contact email.'),
      invitationCode: wireRequiredString.optional().describe('Optional invitation code (cc_inv_...).'),
    }),
    output: clubJoinResult,
  },
  parse: {
    input: z.object({
      clubSlug: parseRequiredString,
      email: parseAsciiEmail.optional(),
      invitationCode: parseTrimmedNullableString.transform((value) => value ?? undefined),
    }),
  },
  async handleOptionalMember(input: unknown, ctx: OptionalHandlerContext): Promise<ActionResult> {
    ctx.requireCapability('joinClub');
    const { clubSlug, email, invitationCode } = input as { clubSlug: string; email?: string; invitationCode?: string };
    const join = await ctx.repository.joinClub!({
      actorMemberId: ctx.actor.member?.id ?? null,
      clubSlug,
      email,
      invitationCode,
    });
    return { data: join };
  },
};

const clubsApplicationsSubmit: ActionDefinition = {
  action: 'clubs.applications.submit',
  domain: 'clubs',
  description: 'Submit an in-progress club application for the calling member.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'submitClubApplication',
  businessErrors: [
    {
      code: 'missing_nonce',
      meaning: 'This application still requires proof of work and no nonce was supplied.',
      recovery: 'Solve the current challenge and retry with nonce set.',
    },
    {
      code: 'challenge_expired',
      meaning: 'The active proof-of-work challenge expired.',
      recovery: 'Re-call clubs.join to get a fresh challenge for the same membership, then retry submit.',
    },
    {
      code: 'invalid_proof',
      meaning: 'The supplied nonce does not satisfy the challenge difficulty.',
      recovery: 'Solve the proof again and retry submit with the same application text.',
    },
  ],
  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to submit'),
      nonce: wireBoundedString.optional().describe('Required when the membership proof_kind is pow. Ignored otherwise.'),
      name: wireBoundedString.describe('Applicant name'),
      socials: wireBoundedString.describe('Social links or profile URLs'),
      application: wireApplicationText,
    }),
    output: clubsApplicationsSubmitResult,
  },
  parse: {
    input: z.object({
      membershipId: parseRequiredString,
      nonce: parseTrimmedNullableString.transform((value) => value ?? undefined),
      name: parseBoundedString,
      socials: parseBoundedString,
      application: parseApplicationText,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('submitClubApplication');
    const { membershipId, nonce, name, socials, application } = input as {
      membershipId: string;
      nonce?: string;
      name: string;
      socials: string;
      application: string;
    };
    const result = await ctx.repository.submitClubApplication!({
      actorMemberId: ctx.actor.member.id,
      membershipId,
      nonce,
      name,
      socials,
      application,
    });
    return { data: result };
  },
};

const clubsApplicationsGet: ActionDefinition = {
  action: 'clubs.applications.get',
  domain: 'clubs',
  description: 'Read one membership/application owned by the calling member.',
  auth: 'member',
  safety: 'read_only',
  requiredCapability: 'getClubApplication',
  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to fetch'),
    }),
    output: z.object({
      application: applicationSummary,
    }),
  },
  parse: {
    input: z.object({
      membershipId: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('getClubApplication');
    const { membershipId } = input as { membershipId: string };
    const application = await ctx.repository.getClubApplication!({
      actorMemberId: ctx.actor.member.id,
      membershipId,
    });
    if (!application) {
      throw new AppError(404, 'not_found', 'Application not found');
    }
    return {
      data: { application },
      requestScope: { requestedClubId: application.clubId, activeClubIds: [application.clubId] },
    };
  },
};

const clubsApplicationsList: ActionDefinition = {
  action: 'clubs.applications.list',
  domain: 'clubs',
  description: 'List memberships/applications owned by the calling member.',
  auth: 'member',
  safety: 'read_only',
  requiredCapability: 'listClubApplications',
  wire: {
    input: z.object({
      status: applicationStatusFilter.optional().describe('Optional state filter; pass one status or an array of statuses.'),
      clubId: wireRequiredString.optional().describe('Optional club filter.'),
    }),
    output: z.object({
      applications: z.array(applicationSummary),
    }),
  },
  parse: {
    input: z.object({
      status: z.union([membershipState, z.array(membershipState).min(1)])
        .optional()
        .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? [...new Set(value)] : [value])),
      clubId: parseTrimmedNullableString.transform((value) => value ?? undefined),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('listClubApplications');
    const { status, clubId } = input as { status?: string[]; clubId?: string };
    const applications = await ctx.repository.listClubApplications!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      statuses: status as never,
    });
    return {
      data: { applications },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubId ? [clubId] : [] },
    };
  },
};

const clubsBillingStartCheckout: ActionDefinition = {
  action: 'clubs.billing.startCheckout',
  domain: 'clubs',
  description: 'Start billing checkout for a payment-pending membership owned by the calling member.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'startMembershipCheckout',
  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club whose pending membership should be checked out'),
    }),
    output: z.object({
      checkoutUrl: z.string(),
    }),
  },
  parse: {
    input: z.object({
      clubId: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('startMembershipCheckout');
    const { clubId } = input as { clubId: string };
    const checkout = await ctx.repository.startMembershipCheckout!({
      actorMemberId: ctx.actor.member.id,
      clubId,
    });
    if (!checkout) {
      throw new AppError(404, 'not_found', 'Payment-pending membership not found for this club');
    }
    return {
      data: checkout,
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

registerActions([
  clubsJoin,
  clubsApplicationsSubmit,
  clubsApplicationsGet,
  clubsApplicationsList,
  clubsBillingStartCheckout,
]);
