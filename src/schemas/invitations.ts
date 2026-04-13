import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  parseCursor,
  parseEmail,
  parseFullName,
  parseRequiredString,
  parseTrimmedNullableString,
  wireCursor,
  wireEmail,
  wireFullName,
  wireRequiredString,
} from './fields.ts';
import { invitationSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type ActionResult, type HandlerContext } from './registry.ts';

const wireAsciiEmail = wireEmail.describe('ASCII email address. Server trims, lowercases, and validates @.');
const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');
const invitationStatus = z.enum(['open', 'used', 'revoked', 'expired']);

const invitationsIssue: ActionDefinition = {
  action: 'invitations.issue',
  domain: 'invitations',
  description: 'Issue a new invitation for a specific candidate email in a specific club.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'issueInvitation',
  qualityGate: 'invitations-issue',
  businessErrors: [
    {
      code: 'invitation_quota_exceeded',
      meaning: 'The sponsor already has the maximum number of open invitations for this club and rolling window.',
      recovery: 'Revoke an unused invitation or wait for an existing one to close before issuing a new one.',
    },
  ],
  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to invite the candidate into'),
      candidateName: wireFullName.describe('Full candidate name'),
      candidateEmail: wireAsciiEmail,
      reason: wireRequiredString.describe('Why this candidate should be invited'),
    }),
    output: z.object({
      invitation: invitationSummary,
      invitationCode: z.string(),
    }),
  },
  parse: {
    input: z.object({
      clubId: parseRequiredString,
      candidateName: parseFullName,
      candidateEmail: parseAsciiEmail,
      reason: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('issueInvitation');
    const { clubId, candidateName, candidateEmail, reason } = input as {
      clubId: string;
      candidateName: string;
      candidateEmail: string;
      reason: string;
    };
    const result = await ctx.repository.issueInvitation!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      candidateName,
      candidateEmail,
      reason,
    });
    if (!result) {
      throw new AppError(404, 'not_found', 'Club not found in the caller scope');
    }
    return {
      data: result,
      requestScope: { requestedClubId: clubId, activeClubIds: [clubId] },
    };
  },
};

const invitationsListMine: ActionDefinition = {
  action: 'invitations.listMine',
  domain: 'invitations',
  description: 'List invitations issued by the calling member.',
  auth: 'member',
  safety: 'read_only',
  requiredCapability: 'listIssuedInvitations',
  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Optional club filter'),
      status: invitationStatus.optional().describe('Optional invitation status filter'),
      cursor: wireCursor.describe('Reserved for future pagination; ignored in v1.'),
    }),
    output: z.object({
      invitations: z.array(invitationSummary),
    }),
  },
  parse: {
    input: z.object({
      clubId: parseTrimmedNullableString.transform((value) => value ?? undefined),
      status: invitationStatus.optional(),
      cursor: parseCursor,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('listIssuedInvitations');
    const { clubId, status } = input as { clubId?: string; status?: 'open' | 'used' | 'revoked' | 'expired' };
    const invitations = await ctx.repository.listIssuedInvitations!({
      actorMemberId: ctx.actor.member.id,
      clubId,
      status,
    });
    return {
      data: { invitations },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubId ? [clubId] : [] },
    };
  },
};

const invitationsRevoke: ActionDefinition = {
  action: 'invitations.revoke',
  domain: 'invitations',
  description: 'Revoke one invitation issued by the caller or administered by the caller.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'revokeInvitation',
  wire: {
    input: z.object({
      invitationId: wireRequiredString.describe('Invitation to revoke'),
    }),
    output: z.object({
      invitation: invitationSummary,
    }),
  },
  parse: {
    input: z.object({
      invitationId: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    ctx.requireCapability('revokeInvitation');
    const { invitationId } = input as { invitationId: string };
    const invitation = await ctx.repository.revokeInvitation!({
      actorMemberId: ctx.actor.member.id,
      invitationId,
      adminClubIds: ctx.actor.memberships
        .filter((membership) => membership.role === 'clubadmin')
        .map((membership) => membership.clubId),
    });
    if (!invitation) {
      throw new AppError(404, 'not_found', 'Invitation not found');
    }
    return {
      data: { invitation },
      requestScope: { requestedClubId: invitation.clubId, activeClubIds: [invitation.clubId] },
    };
  },
};

registerActions([
  invitationsIssue,
  invitationsListMine,
  invitationsRevoke,
]);
