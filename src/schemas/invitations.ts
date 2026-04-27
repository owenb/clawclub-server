import { z } from 'zod';
import { membershipScopes, requestScopeForActor, requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError } from '../repository.ts';
import type { NonApplicationArtifact } from '../gate.ts';
import { applicationPhase, memberApplicationState } from './application-shapes.ts';
import {
  APPLICATION_SOCIALS_DESCRIPTION,
  decodeOptionalCursor,
  describeClientKey,
  describeOptionalScopedClubId,
  describeScopedClubId,
  parseEmail,
  parsePersonName,
  parseHumanRequiredString,
  parseRequiredString,
  parseApplicationText,
  parseBoundedString,
  parseOptionalEmptyBoundedString,
  parseTrimmedNullableOpaqueString,
  parseTrimmedNullableString,
  paginatedOutput,
  paginationFields,
  wireEmail,
  wirePersonName,
  wireApplicationText,
  wireBoundedString,
  wireHumanRequiredString,
  wireOptionalOpaqueString,
  wireOptionalString,
  wireOptionalEmptyBoundedString,
  wireRequiredString,
} from './fields.ts';
import { invitationSummary } from './responses.ts';
import { clubScopedResult, registerActions, type ActionDefinition, type ActionResult, type HandlerContext } from './registry.ts';

const wireAsciiEmail = wireEmail.describe('ASCII email address. Server trims, lowercases, and validates address shape.');
const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');
const INVITATIONS_LIST_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });
const invitationStatus = z.enum(['open', 'used', 'revoked', 'expired']);
const wireInvitationCode = wireRequiredString.describe('Invitation code (XXXX-XXXX). Input is trimmed and upper-cased before lookup, so 7dk4-m9q2 and 7DK4-M9Q2 redeem the same invitation.');

const invitationsIssueInputSchema = z.object({
  clubId: wireRequiredString.describe(describeScopedClubId('Club to invite the candidate into.')),
  candidateMemberId: wireRequiredString.optional().describe('Existing registered member to notify in-app directly. When this is present, omit candidateEmail and candidateName.'),
  candidateEmail: wireAsciiEmail.optional().describe('Candidate email. If it already belongs to an active member, the server upgrades the invitation to in-app delivery automatically and no code is issued.'),
  candidateName: wirePersonName.optional().describe('Full candidate name. Required only when candidateEmail does not resolve to an existing active member.'),
  reason: wireHumanRequiredString.describe('Why this candidate should be invited'),
  clientKey: wireOptionalOpaqueString.describe(describeClientKey('Optional idempotency key for replay-safe invitation issuance.')),
}).superRefine((value, ctx) => {
  const hasMemberId = value.candidateMemberId !== undefined;
  const hasEmail = value.candidateEmail !== undefined;

  if (hasMemberId && hasEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateMemberId'],
      message: 'Provide either candidateMemberId or candidateEmail, not both.',
    });
  }

  if (!hasMemberId && !hasEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateEmail'],
      message: 'Provide either candidateMemberId or candidateEmail.',
    });
  }

  if (hasMemberId && value.candidateName !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateName'],
      message: 'candidateName is only used with candidateEmail.',
    });
  }
});

type InvitationsIssueInput = {
  clubId: string;
  candidateMemberId?: string;
  candidateEmail?: string;
  candidateName?: string;
  reason: string;
  clientKey: string | null;
};

function buildInvitationIssueMessages(invitation: z.infer<typeof invitationSummary>): { summary: string; details: string } {
  if (invitation.deliveryKind === 'notification') {
    return {
      summary: 'This candidate already has a ClawClub account, so they were notified in-app. No code was issued.',
      details: 'They still need to call clubs.apply and go through the normal admission review flow. The invitation itself does not grant membership.',
    };
  }
  return {
    summary: 'Share this invitation code with the candidate so they can register if needed and redeem it.',
    details: 'Redeeming the code still creates a normal application that answers the club admission policy and goes through club-admin review.',
  };
}

const invitationsIssueOutputSchema = z.object({
  invitation: invitationSummary,
  messages: z.object({
    summary: z.string(),
    details: z.string(),
  }),
});

const invitationsIssueParseSchema = z.object({
  clubId: parseRequiredString,
  candidateMemberId: parseRequiredString.optional(),
  candidateEmail: parseAsciiEmail.optional(),
  candidateName: parsePersonName.optional(),
  reason: parseHumanRequiredString,
  clientKey: parseTrimmedNullableOpaqueString.default(null),
}).superRefine((value, ctx) => {
  const hasMemberId = value.candidateMemberId !== undefined;
  const hasEmail = value.candidateEmail !== undefined;

  if (hasMemberId && hasEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateMemberId'],
      message: 'Provide either candidateMemberId or candidateEmail, not both.',
    });
  }

  if (!hasMemberId && !hasEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateEmail'],
      message: 'Provide either candidateMemberId or candidateEmail.',
    });
  }

  if (hasMemberId && value.candidateName !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateName'],
      message: 'candidateName is only used with candidateEmail.',
    });
  }
});

const invitationsIssue: ActionDefinition = {
  action: 'invitations.issue',
  domain: 'invitations',
  description: 'Issue a new invitation for a candidate in a specific club.',
  auth: 'member',
  scope: { strategy: 'rawClubId' },
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'optional' },
  notes: [
    'Existing registered members can be targeted by candidateMemberId or by candidateEmail. If the email belongs to an active member, the server upgrades the invitation to in-app delivery automatically and no code is issued.',
    'Issuing an invitation never grants membership by itself. Existing members apply through clubs.apply; external invitees redeem a code and then submit an application.',
  ],
  businessErrors: [
    {
      code: 'invitation_quota_exceeded',
      meaning: 'The sponsor already has the maximum number of live invitations for this club.',
      recovery: 'Revoke an invitation, wait for one to expire, or wait for a sponsored application to reach a terminal state before issuing another.',
    },
    {
      code: 'low_quality_content',
      meaning: 'The invitation reason was too generic or missing relationship context.',
      recovery: 'Relay the feedback to the sponsor, add how they know the candidate and one concrete detail, then resubmit.',
    },
    {
      code: 'illegal_content',
      meaning: 'The invitation reason endorsed clearly illegal activity.',
      recovery: 'Relay the feedback to the sponsor, remove the illegal endorsement, and resubmit.',
    },
    {
      code: 'gate_rejected',
      meaning: 'The content gate returned a malformed or non-passing verdict.',
      recovery: 'Review the feedback, revise the invitation reason, and resubmit.',
    },
    {
      code: 'gate_unavailable',
      meaning: 'The content gate is temporarily unavailable.',
      recovery: 'Retry after a short delay. If the problem persists, surface the outage to the user.',
    },
    {
      code: 'invitation_already_open',
      meaning: 'The sponsor already has a live invitation for this candidate in this club.',
      recovery: 'Use the existing invitation returned in error.details. Revoke it with invitations.revoke before issuing a fresh one.',
    },
    {
      code: 'candidate_name_required',
      meaning: 'The candidate email does not belong to an existing active member, so an external invitation also needs a full candidateName.',
      recovery: 'Provide candidateName and retry, or target an existing registered member by candidateMemberId.',
    },
    {
      code: 'member_not_found',
      meaning: 'The requested existing member target was not found or does not currently have a registered email address.',
      recovery: 'Choose a different existing member, or fall back to candidateEmail for an email-delivered invitation.',
    },
    {
      code: 'member_already_active',
      meaning: 'The target already has an active membership in this club.',
      recovery: 'Do not issue another invitation. Use the existing membership returned in error.details instead.',
    },
    {
      code: 'application_blocked',
      meaning: 'The target is blocked from applying to this club because a temporary decline block or persistent removal/ban block is active.',
      recovery: 'Do not retry automatically. Wait until the temporary block expires, or ask a club admin whether a persistent block should be reconsidered.',
    },
  ],
  wire: {
    input: invitationsIssueInputSchema,
    output: invitationsIssueOutputSchema,
  },
  parse: {
    input: invitationsIssueParseSchema,
  },
  llmGate: {
    async buildArtifact(input): Promise<NonApplicationArtifact> {
      const parsed = input as { reason: string };
      return { kind: 'invitation', reason: parsed.reason };
    },
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey?: string | null }).clientKey ?? null,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:invitations.issue`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const parsed = input as InvitationsIssueInput;
    const target = await ctx.repository.resolveInvitationTarget({
      candidateMemberId: parsed.candidateMemberId,
      candidateEmail: parsed.candidateEmail,
      candidateName: parsed.candidateName ?? null,
    });
    const result = await ctx.repository.issueInvitation({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: `member:${ctx.actor.member.id}:invitations.issue`,
      idempotencyRequestValue: {
        actorMemberId: ctx.actor.member.id,
        ...parsed,
      },
      clubId: parsed.clubId,
      reason: parsed.reason,
      clientKey: parsed.clientKey,
      target,
    });
    if (!result) {
      throw new AppError('club_not_found', 'Club not found in the caller scope');
    }
    return clubScopedResult({ clubId: parsed.clubId }, {
      invitation: result.invitation,
      messages: buildInvitationIssueMessages(result.invitation),
    });
  },
};

const invitationsListMine: ActionDefinition = {
  action: 'invitations.list',
  domain: 'invitations',
  description: 'List invitations issued by the calling member.',
  auth: 'member',
  scope: { strategy: 'rawClubId' },
  safety: 'read_only',
  notes: [
    'Each invitation includes quotaState so sponsors can see whether it still occupies one of their live invitation slots.',
    'Sponsors can recover a forgotten invitation code from the code field on their own code-backed invitations.',
  ],
  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for issued invitations.')),
      status: invitationStatus.optional().describe('Optional invitation status filter'),
      ...INVITATIONS_LIST_PAGINATION.wire,
    }),
    output: paginatedOutput(invitationSummary),
  },
  parse: {
    input: z.object({
      clubId: parseTrimmedNullableString.transform((value) => value ?? undefined),
      status: invitationStatus.optional(),
      ...INVITATIONS_LIST_PAGINATION.parse,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, status, limit, cursor: rawCursor } = input as {
      clubId?: string;
      status?: 'open' | 'used' | 'revoked' | 'expired';
      limit: number;
      cursor: string | null;
    };
    const clubScope = clubId
      ? [ctx.requireAccessibleClub(clubId)]
      : ctx.actor.memberships;
    const clubIds = clubScope.map((membership) => membership.clubId);
    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, invitationId]) => ({ createdAt, invitationId }));
    const invitations = await ctx.repository.listIssuedInvitations({
      actorMemberId: ctx.actor.member.id,
      clubId,
      clubIds: clubId ? clubIds : null,
      status,
      limit,
      cursor,
    });
    return {
      data: invitations,
      requestScope: requestScopeForClubs(clubId ?? null, clubIds),
    };
  },
};

const invitationsRevoke: ActionDefinition = {
  action: 'invitations.revoke',
  domain: 'invitations',
  description: 'Revoke one invitation issued by the caller or administered by the caller.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'optional' },
  businessErrors: [
    {
      code: 'forbidden_scope',
      meaning: 'Only the sponsor or a clubadmin in the invitation’s club may revoke it.',
      recovery: 'Use your own invitation, or choose a club where you are a clubadmin.',
    },
    {
      code: 'invalid_state',
      meaning: 'This invitation can no longer be changed through revoke.',
      recovery: 'Treat terminal invitations as historical records. Live consumed invitations can only be withdrawn while their resulting application is still in revision_required or awaiting_review.',
    },
    {
      code: 'invitation_already_revoked',
      meaning: 'The invitation was already revoked before this request.',
      recovery: 'Read the canonical invitation in error.details.invitation and stop retrying the revoke intent.',
    },
    {
      code: 'invitation_already_expired',
      meaning: 'The invitation was already expired before this request.',
      recovery: 'Read the canonical invitation in error.details.invitation and issue a new invitation if appropriate.',
    },
  ],
  wire: {
    input: z.object({
      invitationId: wireRequiredString.describe('Invitation to revoke'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Optional idempotency key for this invitation revoke.')),
    }),
    output: z.object({
      invitation: invitationSummary,
    }),
  },
  parse: {
    input: z.object({
      invitationId: parseRequiredString,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey?: string | null }).clientKey ?? null,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:invitations.revoke:${(input as { invitationId: string }).invitationId}`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { invitationId, clientKey } = input as { invitationId: string; clientKey: string | null };
    const invitation = await ctx.repository.revokeInvitation({
      actorMemberId: ctx.actor.member.id,
      invitationId,
      clientKey,
      idempotencyActorContext: `member:${ctx.actor.member.id}:invitations.revoke:${invitationId}`,
      idempotencyRequestValue: {
        actorMemberId: ctx.actor.member.id,
        invitationId,
        clientKey,
      },
      adminClubIds: membershipScopes(ctx.actor.memberships).adminClubIds,
    });
    if (!invitation) {
      throw new AppError('invitation_not_found', 'Invitation not found');
    }
    const visibleInvitation = invitation.sponsor.memberId === ctx.actor.member.id
      ? invitation
      : { ...invitation, code: null };
    return clubScopedResult(invitation, { invitation: visibleInvitation });
  },
};

const invitationsRedeem: ActionDefinition = {
  action: 'invitations.redeem',
  domain: 'invitations',
  description: 'Redeem an external invitation code and submit the linked club application using the caller’s existing account.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  notes: [
    'Use invitations.redeem only for code-backed external invitations.',
    'Existing registered members who were invited in-app should call clubs.apply instead. They do not redeem a code.',
  ],
  businessErrors: [
    {
      code: 'quota_exceeded',
      meaning: 'The member has reached the rolling application quota.',
      recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
    },
    {
      code: 'invalid_invitation_code',
      meaning: 'The invitation code was malformed, expired, revoked, already consumed, or otherwise unusable.',
      recovery: 'Ask the sponsor to check invitations.list for the correct code.',
    },
    {
      code: 'application_limit_reached',
      meaning: 'The member already has the maximum number of live applications in flight.',
      recovery: 'Withdraw or resolve an existing live application before redeeming another invitation.',
    },
    {
      code: 'application_in_flight',
      meaning: 'The member already has a live application for this club.',
      recovery: 'Read the canonical application state returned in error.details and follow its workflow/next fields. revision_required means the draft is saved but not yet submitted; awaiting_review means it is already with club admins.',
    },
    {
      code: 'application_blocked',
      meaning: 'This member is blocked from applying to the club because a temporary decline block or persistent removal/ban block is active.',
      recovery: 'Do not retry automatically. Wait until the temporary block expires, or ask a club admin if a persistent block should be reconsidered.',
    },
    {
      code: 'member_already_active',
      meaning: 'The member already has an active membership in this club.',
      recovery: 'Stop the redemption flow and use the existing membership instead.',
    },
    {
      code: 'membership_exists',
      meaning: 'The member already has a non-terminal membership record in this club.',
      recovery: 'Stop the redemption flow and inspect the existing membership instead of creating a new application.',
    },
    {
      code: 'application_not_mutable',
      meaning: 'The invitation changed while the redemption request was being prepared, so the write was rejected.',
      recovery: 'Refresh the invitation state and retry redemption from the latest code state.',
    },
    {
      code: 'client_key_conflict',
      meaning: 'The clientKey has already been used for a different invitation redemption intent.',
      recovery: 'Generate a new clientKey for a different redemption, or resend the exact same payload to replay safely.',
    },
  ],
  wire: {
    input: z.object({
      code: wireInvitationCode,
      draft: z.object({
        name: wireBoundedString,
        socials: wireOptionalEmptyBoundedString.describe(APPLICATION_SOCIALS_DESCRIPTION),
        application: wireApplicationText.describe('Why this club should admit you'),
      }),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this invitation redemption submit.')),
    }),
    output: memberApplicationState,
  },
  parse: {
    input: z.object({
      code: parseRequiredString,
      draft: z.object({
        name: parseBoundedString,
        socials: parseOptionalEmptyBoundedString,
        application: parseApplicationText,
      }),
      clientKey: parseRequiredString,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:invitations.redeem`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { code, draft, clientKey } = input as {
      code: string;
      draft: { name: string; socials: string; application: string };
      clientKey: string;
    };
    const result = await ctx.repository.redeemInvitationApplication({
      actorMemberId: ctx.actor.member.id,
      code,
      draft,
      clientKey,
    });
    const application = result.application as { clubId: string } | undefined;
    return {
      data: result,
      requestScope: requestScopeForActor(ctx.actor, application?.clubId ?? null),
    };
  },
};

registerActions([
  invitationsIssue,
  invitationsListMine,
  invitationsRevoke,
  invitationsRedeem,
]);
