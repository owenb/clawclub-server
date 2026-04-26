import { z } from 'zod';
import { requestScopeForActor, requestScopeForClub } from '../actors.ts';
import { AppError } from '../repository.ts';
import { getConfig } from '../config/index.ts';
import { runCreateGateCheck } from '../gate-runner.ts';
import { applicationPhase, memberApplicationState } from './application-shapes.ts';
import {
  decodeOptionalCursor,
  describeClientKey,
  describePublicClubSlug,
  parseApplicationText,
  parseBoundedString,
  parseHumanRequiredString,
  parseSlug,
  paginatedOutput,
  paginationFields,
  parseOptionalEmptyBoundedString,
  parseRequiredString,
  wireApplicationText,
  wireBoundedString,
  wireHumanRequiredString,
  wireOptionalEmptyBoundedString,
  wireRequiredString,
  wireSlug,
} from './fields.ts';
import { clubSummary } from './responses.ts';
import { clubScopedResult, registerActions, type ActionDefinition, type ActionResult, type HandlerContext } from './registry.ts';

const clubsCreateInputSchema = z.object({
  clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this club creation.')),
  slug: wireSlug.describe('URL-safe slug for the new club.'),
  name: wireHumanRequiredString.describe('Club display name.'),
  summary: wireHumanRequiredString.describe('Club summary shown to prospective members.'),
  admissionPolicy: wireHumanRequiredString.describe('Admission policy shown to applicants. Must contain at least one concrete question or condition the applicant must answer or meet. The legality/quality gate rejects vague policies that do not actually ask the applicant anything.'),
});

type ClubsCreateInput = {
  clientKey: string;
  slug: string;
  name: string;
  summary: string;
  admissionPolicy: string;
};

const CLUB_APPLICATIONS_LIST_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });

function buildClubArtifact(input: {
  name: string;
  summary: string | null;
  admissionPolicy: string | null;
}) {
  return {
    kind: 'club' as const,
    name: input.name,
    summary: input.summary,
    admissionPolicy: input.admissionPolicy,
  };
}

const clubsCreate: ActionDefinition = {
  action: 'clubs.create',
  domain: 'clubs',
  description: 'Create a new club owned by the authenticated member.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  refreshActorOnSuccess: true,
  businessErrors: [
    {
      code: 'owner_club_limit_reached',
      meaning: 'The member already owns the maximum number of clubs they may create themselves.',
      recovery: 'Use an existing club, or have a superadmin raise the per-member club cap.',
    },
    {
      code: 'quota_exceeded',
      meaning: 'The rolling clubs.create request quota has been exhausted.',
      recovery: 'Wait for quota to replenish or check quotas.getUsage before retrying.',
    },
    {
      code: 'slug_conflict',
      meaning: 'Another club already uses that slug.',
      recovery: 'Choose a different slug and retry with a new clientKey.',
    },
  ],
  wire: {
    input: clubsCreateInputSchema,
    output: z.object({ club: clubSummary }),
  },
  parse: {
    input: z.object({
      clientKey: parseRequiredString,
      slug: parseSlug,
      name: parseHumanRequiredString,
      summary: parseHumanRequiredString,
      admissionPolicy: parseHumanRequiredString,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as ClubsCreateInput).clientKey,
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:clubs.create`,
    getRequestValue: (input) => input,
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const parsed = input as ClubsCreateInput;
    const actorContext = `member:${ctx.actor.member.id}:clubs.create`;
    const requestValue = parsed;

    let replayHit = false;
    if (ctx.repository.peekIdempotencyReplay) {
      replayHit = await ctx.repository.peekIdempotencyReplay({
        clientKey: parsed.clientKey,
        actorContext,
        requestValue,
      });
    }

    if (!replayHit) {
      const slugMatch = await ctx.repository.findClubBySlug({
        actorMemberId: ctx.actor.member.id,
        slug: parsed.slug,
      });

      if (slugMatch) {
        throw new AppError('slug_conflict', 'A club with that slug already exists.');
      }

      const existingClubs = await ctx.repository.listClubs({
        actorMemberId: ctx.actor.member.id,
        includeArchived: true,
        limit: 50,
        cursor: null,
      });
      const ownedClubs = existingClubs.results.filter((club) =>
        club.owner.memberId === ctx.actor.member.id && club.archivedAt === null
      ).length;
      if (ownedClubs >= getConfig().policy.clubs.maxClubsPerMember) {
        throw new AppError('owner_club_limit_reached', 'This member already owns the maximum number of clubs they may create themselves.');
      }

      await ctx.repository.enforceClubsCreateQuota({ memberId: ctx.actor.member.id });
      await runCreateGateCheck({
        actionName: 'clubs.create',
        actorMemberId: ctx.actor.member.id,
        artifact: buildClubArtifact(parsed),
        repository: ctx.repository,
        runLlmGate: ctx.runLlmGate,
      });
    }

    const club = await ctx.repository.createClub({
      actorMemberId: ctx.actor.member.id,
      idempotencyActorContext: actorContext,
      idempotencyRequestValue: requestValue,
      clientKey: parsed.clientKey,
      slug: parsed.slug,
      name: parsed.name,
      summary: parsed.summary,
      admissionPolicy: parsed.admissionPolicy,
      ownerMemberId: ctx.actor.member.id,
      usesFreeAllowance: true,
      memberCap: null,
      enforceFreeClubLimit: true,
    });

    if (!club) {
      throw new AppError('member_not_found', 'Club owner was not found.');
    }

    return clubScopedResult(club, { club });
  },
};

const clubsApply: ActionDefinition = {
  action: 'clubs.apply',
  domain: 'clubs',
  description: 'Submit a new application to a club using the caller’s existing bearer-authenticated account.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  notes: [
    'Registration happens separately through accounts.register.',
    'A member may keep at most three live applications in flight at once.',
    'Use updates.list as the standing poll surface for verdicts and welcome guidance.',
    'A 200 response with phase=revision_required means the draft was saved but NOT submitted to club admins yet. Treat the returned workflow block as authoritative for whether the applicant still needs to act.',
    'If there is exactly one open in-app invitation for this member in the target club, clubs.apply binds it automatically. Pass invitationId only when multiple open invitations exist for the same club.',
  ],
  businessErrors: [
    {
      code: 'quota_exceeded',
      meaning: 'The member has reached the rolling application quota.',
      recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
    },
    {
      code: 'application_limit_reached',
      meaning: 'The member already has the maximum number of live applications in flight.',
      recovery: 'Withdraw or resolve an existing live application before starting another one.',
    },
    {
      code: 'application_in_flight',
      meaning: 'The member already has a live application for this club.',
      recovery: 'Read the canonical application state returned in error.details and follow its workflow/next fields. revision_required means the draft is saved but not yet submitted; awaiting_review means it is already with club admins.',
    },
    {
      code: 'application_blocked',
      meaning: 'This member is blocked from reapplying to the club because they were previously banned or removed.',
      recovery: 'Do not retry automatically. Ask a club admin if the block should be reconsidered.',
    },
    {
      code: 'member_already_active',
      meaning: 'The member already has an active membership in this club.',
      recovery: 'Stop the application flow and use the existing membership instead.',
    },
    {
      code: 'membership_exists',
      meaning: 'The member already has a non-terminal membership record in this club.',
      recovery: 'Stop the application flow and inspect the existing membership instead of creating a new application.',
    },
    {
      code: 'application_not_mutable',
      meaning: 'The club changed while the application request was being prepared, so the write was rejected.',
      recovery: 'Refresh the target club state and retry the application request.',
    },
    {
      code: 'invitation_ambiguous',
      meaning: 'Multiple open in-app invitations exist for this member in the same club, so the caller must choose one explicitly.',
      recovery: 'Read the candidate invitations returned in error.details, pick one invitationId, and retry clubs.apply with that invitationId.',
    },
    {
      code: 'invitation_not_found',
      meaning: 'The supplied invitationId is not a live in-app invitation for this member in the target club.',
      recovery: 'Retry without invitationId for a cold application, or use one of the live invitations returned by invitation_ambiguous.',
    },
    {
      code: 'client_key_conflict',
      meaning: 'The clientKey has already been used for a different application intent.',
      recovery: 'Generate a new clientKey for a different application, or resend the exact same payload to replay safely.',
    },
  ],
  wire: {
    input: z.object({
      clubSlug: wireRequiredString.describe(describePublicClubSlug('Club to apply to.')),
      invitationId: wireRequiredString.optional().describe('Optional invitation to bind when applying through an existing in-app invite. Omit this unless multiple live invites exist for the same club.'),
      draft: z.object({
        name: wireBoundedString,
        socials: wireOptionalEmptyBoundedString,
        application: wireApplicationText.describe('Why this club should admit you'),
      }),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this club application submit.')),
    }),
    output: memberApplicationState,
  },
  parse: {
    input: z.object({
      clubSlug: parseRequiredString,
      invitationId: parseRequiredString.optional(),
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
    getScopeKey: (_input, ctx) => `member:${ctx.actor.member.id}:clubs.apply`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubSlug, invitationId, draft, clientKey } = input as {
      clubSlug: string;
      invitationId?: string;
      draft: { name: string; socials: string; application: string };
      clientKey: string;
    };
    const result = await ctx.repository.applyToClub({
      actorMemberId: ctx.actor.member.id,
      clubSlug,
      ...(invitationId ? { invitationId } : {}),
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

const clubsApplicationsRevise: ActionDefinition = {
  action: 'clubs.applications.revise',
  domain: 'clubs',
  description: 'Replace the saved draft on a revision_required application and rerun the admission gate. This is only allowed while the applicant still owns the draft.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'quota_exceeded',
      meaning: 'The member has reached the rolling application quota.',
      recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
    },
    {
      code: 'application_not_mutable',
      meaning: 'Only applications currently in revision_required can be revised.',
      recovery: 'Read the canonical application state returned in error.details and follow its workflow/next fields. If it is already awaiting_review, the draft has already been submitted to club admins and the applicant must wait.',
    },
    {
      code: 'client_key_conflict',
      meaning: 'The clientKey has already been used for a different application revision intent.',
      recovery: 'Generate a new clientKey for a different revision, or resend the exact same payload to replay safely.',
    },
  ],
  wire: {
    input: z.object({
      applicationId: wireRequiredString.describe('Application to revise'),
      draft: z.object({
        name: wireBoundedString,
        socials: wireOptionalEmptyBoundedString,
        application: wireApplicationText.describe('Revised application text'),
      }),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this application revision.')),
    }),
    output: memberApplicationState,
  },
  parse: {
    input: z.object({
      applicationId: parseRequiredString,
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
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:clubs.applications.revise:${(input as { applicationId: string }).applicationId}`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { applicationId, draft, clientKey } = input as {
      applicationId: string;
      draft: { name: string; socials: string; application: string };
      clientKey: string;
    };
    const result = await ctx.repository.reviseClubApplication({
      actorMemberId: ctx.actor.member.id,
      applicationId,
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

const clubsApplicationsGet: ActionDefinition = {
  action: 'clubs.applications.get',
  domain: 'clubs',
  description: 'Read one application owned by the authenticated member.',
  auth: 'member',
  safety: 'read_only',
  wire: {
    input: z.object({
      applicationId: wireRequiredString.describe('Application to fetch'),
    }),
    output: memberApplicationState,
  },
  parse: {
    input: z.object({
      applicationId: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { applicationId } = input as { applicationId: string };
    const result = await ctx.repository.getMemberApplicationById({
      actorMemberId: ctx.actor.member.id,
      applicationId,
    });
    if (!result) {
      throw new AppError('application_not_found', 'Application not found.');
    }
    const application = result.application as { clubId: string } | undefined;
    return {
      data: result,
      requestScope: requestScopeForActor(ctx.actor, application?.clubId ?? null),
    };
  },
};

const clubsApplicationsList: ActionDefinition = {
  action: 'clubs.applications.list',
  domain: 'clubs',
  description: 'List applications owned by the authenticated member.',
  auth: 'member',
  safety: 'read_only',
  wire: {
    input: z.object({
      phases: z.array(applicationPhase).min(1).optional().describe('Optional application-phase filter. Defaults to awaiting_review + active. Include revision_required explicitly when you need saved drafts that are not yet in the admin queue.'),
      ...CLUB_APPLICATIONS_LIST_PAGINATION.wire,
    }),
    output: paginatedOutput(memberApplicationState).extend({
      limit: z.number(),
      phases: z.array(applicationPhase).nullable(),
    }),
  },
  parse: {
    input: z.object({
      phases: z.array(applicationPhase).min(1).optional(),
      ...CLUB_APPLICATIONS_LIST_PAGINATION.parse,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { phases, limit, cursor } = input as {
      phases?: Array<z.infer<typeof applicationPhase>>;
      limit: number;
      cursor: string | null;
    };
    const result = await ctx.repository.listMemberApplications({
      actorMemberId: ctx.actor.member.id,
      phases: phases ?? null,
      limit,
      cursor: decodeOptionalCursor(cursor, 2, ([submittedAt, applicationId]) => ({ submittedAt, applicationId })),
    });
    return {
      data: {
        limit,
        phases: phases ?? null,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      requestScope: requestScopeForActor(ctx.actor, null),
    };
  },
};

const clubsApplicationsWithdraw: ActionDefinition = {
  action: 'clubs.applications.withdraw',
  domain: 'clubs',
  description: 'Withdraw a live application owned by the authenticated member.',
  auth: 'member',
  safety: 'mutating',
  idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
  businessErrors: [
    {
      code: 'application_not_mutable',
      meaning: 'Only non-terminal applications can be withdrawn.',
      recovery: 'Read the canonical application state returned in error.details and follow its workflow/next fields instead of retrying this withdraw call.',
    },
  ],
  wire: {
    input: z.object({
      applicationId: wireRequiredString.describe('Application to withdraw'),
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this application withdrawal.')),
    }),
    output: memberApplicationState,
  },
  parse: {
    input: z.object({
      applicationId: parseRequiredString,
      clientKey: parseRequiredString,
    }),
  },
  idempotency: {
    getClientKey: (input) => (input as { clientKey: string }).clientKey,
    getScopeKey: (input, ctx) => `member:${ctx.actor.member.id}:clubs.applications.withdraw:${(input as { applicationId: string }).applicationId}`,
    getRequestValue: (input, ctx) => ({
      actorMemberId: ctx.actor.member.id,
      ...(input as Record<string, unknown>),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { applicationId, clientKey } = input as { applicationId: string; clientKey: string };
    const result = await ctx.repository.withdrawClubApplication({
      actorMemberId: ctx.actor.member.id,
      applicationId,
      clientKey,
    });
    if (!result) {
      throw new AppError('application_not_found', 'Application not found.');
    }
    const application = result.application as { clubId: string } | undefined;
    return {
      data: result,
      requestScope: requestScopeForActor(ctx.actor, application?.clubId ?? null),
    };
  },
};

registerActions([
  clubsCreate,
  clubsApply,
  clubsApplicationsRevise,
  clubsApplicationsGet,
  clubsApplicationsList,
  clubsApplicationsWithdraw,
]);
