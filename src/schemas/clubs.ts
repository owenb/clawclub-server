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
  clubPrepareJoinResult,
  clubJoinResult,
  clubsOnboardResult,
  clubsApplicationsSubmitResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type ActionResult, type HandlerContext, type OptionalHandlerContext } from './registry.ts';

const wireAsciiEmail = z.string()
  .max(500)
  .describe('ASCII email address. Server trims, lowercases, and validates @.');

const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');

const applicationStatusFilter = z.union([membershipState, z.array(membershipState).min(1)]);

const clubsPrepareJoin: ActionDefinition = {
  action: 'clubs.prepareJoin',
  domain: 'clubs',
  description: 'Issue a proof-of-work challenge for an anonymous cold join without creating any server-side identity yet.',
  auth: 'none',
  safety: 'read_only',
  requiredCapability: 'prepareClubJoin',
  notes: [
    'This is for anonymous cold joins only. Invited and authenticated callers skip it.',
    'No database rows are created by this action.',
  ],
  wire: {
    input: z.object({
      clubSlug: wireRequiredString.describe('Club slug to join'),
    }),
    output: clubPrepareJoinResult,
  },
  parse: {
    input: z.object({
      clubSlug: parseRequiredString,
    }),
  },
  async handleCold(input: unknown, ctx): Promise<ActionResult> {
    const { clubSlug } = input as { clubSlug: string };
    const result = await ctx.repository.prepareClubJoin!({ clubSlug });
    return { data: result };
  },
};

const clubsJoin: ActionDefinition = {
  action: 'clubs.join',
  domain: 'clubs',
  description: 'Create a club application for the calling human. Missing Authorization joins anonymously after a solved clubs.prepareJoin challenge; a valid bearer token reuses the existing member identity.',
  auth: 'optional_member',
  safety: 'mutating',
  requiredCapability: 'joinClub',
  notes: [
    'Anonymous clubs.join is not idempotent. Repeating it with the same email creates a new, unrelated membership.',
    'Anonymous callers must save the returned memberToken immediately; losing it loses access to that membership.',
    'Missing Authorization header uses the anonymous branch. Present-but-invalid Authorization returns 401.',
    'Authenticated callers must not pass email; this action uses one shared optional-member wire schema, so the rejection happens semantically after auth resolution.',
  ],
  businessErrors: [
    {
      code: 'challenge_required',
      meaning: 'Anonymous callers must call clubs.prepareJoin first and then supply challengeBlob + nonce to clubs.join.',
      recovery: 'Call clubs.prepareJoin, solve the challenge, and retry clubs.join with challengeBlob and nonce.',
    },
    {
      code: 'invalid_challenge',
      meaning: 'The supplied challenge blob was malformed, failed HMAC verification, or targeted a different club.',
      recovery: 'Call clubs.prepareJoin again for the intended club and retry with the new challengeBlob.',
    },
    {
      code: 'challenge_expired',
      meaning: 'The supplied prepareJoin challenge expired before clubs.join was called.',
      recovery: 'Call clubs.prepareJoin again and solve a fresh challenge.',
    },
    {
      code: 'challenge_already_used',
      meaning: 'The supplied challenge was already consumed by a previous clubs.join attempt.',
      recovery: 'Call clubs.prepareJoin again and solve a fresh challenge.',
    },
    {
      code: 'invalid_proof',
      meaning: 'The supplied nonce does not satisfy the challenge difficulty.',
      recovery: 'Solve the challenge correctly and retry clubs.join before it expires.',
    },
    {
      code: 'contact_email_required',
      meaning: 'Anonymous caller did not supply email.',
      recovery: 'Retry clubs.join with the email field set.',
    },
    {
      code: 'invalid_invitation_code',
      meaning: 'The invitation code was malformed, expired, revoked, mismatched, or otherwise unusable.',
      recovery: 'Retry with a different invitation code or omit invitationCode and proceed through clubs.prepareJoin.',
    },
  ],
  wire: {
    input: z.object({
      clubSlug: wireRequiredString.describe('Club slug to join'),
      email: wireAsciiEmail.optional().describe('Required for anonymous joins. Authenticated callers must omit it.'),
      invitationCode: wireRequiredString.optional().describe('Optional invitation code (cc_inv_...).'),
      challengeBlob: wireRequiredString.optional().describe('Required on the anonymous non-invitation path; returned by clubs.prepareJoin.'),
      nonce: wireBoundedString.optional().describe('Proof-of-work solution for the anonymous non-invitation path.'),
    }),
    output: clubJoinResult,
  },
  parse: {
    input: z.object({
      clubSlug: parseRequiredString,
      email: parseAsciiEmail.optional(),
      invitationCode: parseTrimmedNullableString.transform((value) => value ?? undefined),
      challengeBlob: parseTrimmedNullableString.transform((value) => value ?? undefined),
      nonce: parseTrimmedNullableString.transform((value) => value ?? undefined),
    }),
  },
  async handleOptionalMember(input: unknown, ctx: OptionalHandlerContext): Promise<ActionResult> {
    ctx.requireCapability('joinClub');
    const { clubSlug, email, invitationCode, challengeBlob, nonce } = input as {
      clubSlug: string;
      email?: string;
      invitationCode?: string;
      challengeBlob?: string;
      nonce?: string;
    };
    const join = await ctx.repository.joinClub!({
      actorMemberId: ctx.actor.member?.id ?? null,
      clubSlug,
      email,
      invitationCode,
      challengeBlob,
      nonce,
    });
    return { data: join };
  },
};

const clubsOnboard: ActionDefinition = {
  action: 'clubs.onboard',
  domain: 'clubs',
  description: 'Complete the first-member onboarding ceremony after admission.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'onboardMember',
  notes: [
    'This is idempotent. Already-onboarded members receive { alreadyOnboarded: true }.',
    'Authenticated-but-unonboarded members may call only session.getContext and clubs.onboard until this succeeds.',
  ],
  wire: {
    input: z.object({}),
    output: clubsOnboardResult,
  },
  parse: {
    input: z.object({}),
  },
  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('onboardMember');
    const result = await ctx.repository.onboardMember!({
      actorMemberId: ctx.actor.member.id,
    });
    return { data: result };
  },
};

const clubsApplicationsSubmit: ActionDefinition = {
  action: 'clubs.applications.submit',
  domain: 'clubs',
  description: 'Submit an in-progress club application for the calling member. challenge_expired means the submission window elapsed, not a proof-of-work failure.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'submitClubApplication',
  businessErrors: [
    {
      code: 'challenge_expired',
      meaning: 'The application submission window elapsed before the application was submitted.',
      recovery: 'Start a fresh join/application flow to create a new membership and submission window.',
    },
  ],
  wire: {
    input: z.object({
      membershipId: wireRequiredString.describe('Membership to submit'),
      name: wireBoundedString.describe('Applicant name'),
      socials: wireBoundedString.describe('Social links or profile URLs'),
      application: wireApplicationText,
    }),
    output: clubsApplicationsSubmitResult,
  },
  parse: {
    input: z.object({
      membershipId: parseRequiredString,
      name: parseBoundedString,
      socials: parseBoundedString,
      application: parseApplicationText,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('submitClubApplication');
    const { membershipId, name, socials, application } = input as {
      membershipId: string;
      name: string;
      socials: string;
      application: string;
    };
    const result = await ctx.repository.submitClubApplication!({
      actorMemberId: ctx.actor.member.id,
      membershipId,
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
  clubsPrepareJoin,
  clubsJoin,
  clubsOnboard,
  clubsApplicationsSubmit,
  clubsApplicationsGet,
  clubsApplicationsList,
  clubsBillingStartCheckout,
]);
