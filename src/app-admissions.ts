import type { Repository, RequestScope, SharedResponseContext } from './app.ts';
import type { ActorContext, ApplicationStatus, MembershipState } from './app-contract.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  NormalizeApplicationIntake,
  NormalizeApplicationMetadataPatch,
  NormalizeLimit,
  NormalizeOptionalString,
  RequireAccessibleClub,
  RequireApplicationPath,
  RequireApplicationStatus,
  RequireMembershipOwner,
  RequireMembershipState,
  RequireNonEmptyString,
  RequireObject,
} from './app-helpers.ts';

function normalizeMembershipReviewStatuses(
  value: unknown,
  requireMembershipState: RequireMembershipState,
  createAppError: CreateAppError,
): MembershipState[] {
  if (value === undefined) {
    return ['invited', 'pending_review'];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw createAppError(400, 'invalid_input', 'statuses must be a non-empty array when provided');
  }

  return [...new Set(value.map((status) => requireMembershipState(status, 'statuses[]')))];
}

function requireMembershipCreateRole(value: unknown, createAppError: CreateAppError): 'member' | 'admin' {
  if (value === undefined || value === 'member') {
    return 'member';
  }

  if (value !== 'admin') {
    throw createAppError(400, 'invalid_input', 'role must be member or admin');
  }

  return value;
}

function requireMembershipCreateInitialStatus(value: unknown, createAppError: CreateAppError): Extract<MembershipState, 'invited' | 'pending_review' | 'active'> {
  if (value === undefined || value === 'invited') {
    return 'invited';
  }

  if (value !== 'pending_review' && value !== 'active') {
    throw createAppError(400, 'invalid_input', 'initialStatus must be one of: invited, pending_review, active');
  }

  return value;
}

function normalizeApplicationStatuses(
  value: unknown,
  requireApplicationStatus: RequireApplicationStatus,
  createAppError: CreateAppError,
): ApplicationStatus[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw createAppError(400, 'invalid_input', 'statuses must be a non-empty array when provided');
  }

  return [...new Set(value.map((status) => requireApplicationStatus(status, 'statuses[]')))];
}

function requireApplicationCreateInitialStatus(
  value: unknown,
  requireApplicationStatus: RequireApplicationStatus,
  createAppError: CreateAppError,
): Extract<ApplicationStatus, 'draft' | 'submitted' | 'interview_scheduled'> {
  if (value === undefined) {
    return 'submitted';
  }

  const status = requireApplicationStatus(value, 'initialStatus');
  if (status !== 'draft' && status !== 'submitted' && status !== 'interview_scheduled') {
    throw createAppError(400, 'invalid_input', 'initialStatus must be one of: draft, submitted, interview_scheduled');
  }

  return status;
}

export async function handleAdmissionsAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  normalizeOptionalString: NormalizeOptionalString;
  requireAccessibleClub: RequireAccessibleClub;
  requireMembershipOwner: RequireMembershipOwner;
  requireMembershipState: RequireMembershipState;
  requireApplicationStatus: RequireApplicationStatus;
  requireApplicationPath: RequireApplicationPath;
  normalizeApplicationIntake: NormalizeApplicationIntake;
  normalizeApplicationMetadataPatch: NormalizeApplicationMetadataPatch;
  requireNonEmptyString: RequireNonEmptyString;
  requireObject: RequireObject;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeApplicationIntake,
    normalizeApplicationMetadataPatch,
    normalizeLimit,
    normalizeOptionalString,
    payload,
    repository,
    requireAccessibleClub,
    requireApplicationPath,
    requireApplicationStatus,
    requireMembershipOwner,
    requireMembershipState,
    requireNonEmptyString,
    requireObject,
    sharedContext,
  } = input;

  switch (action) {
    case 'memberships.list': {
      const limit = normalizeLimit(payload.limit);
      let clubScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.clubId !== undefined) {
        clubScope = [requireMembershipOwner(actor, payload.clubId)];
      }

      if (clubScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any clubs');
      }

      const status = payload.status === undefined ? undefined : requireMembershipState(payload.status, 'status');
      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listMemberships({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        status,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId:
            typeof payload.clubId === 'string' && payload.clubId.trim().length > 0 ? payload.clubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          limit,
          status: status ?? null,
          clubScope,
          results,
        },
      });
    }

    case 'memberships.review': {
      const limit = normalizeLimit(payload.limit);
      let clubScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.clubId !== undefined) {
        clubScope = [requireMembershipOwner(actor, payload.clubId)];
      }

      if (clubScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any clubs');
      }

      const statuses = normalizeMembershipReviewStatuses(payload.statuses, requireMembershipState, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listMembershipReviews({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        statuses,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId:
            typeof payload.clubId === 'string' && payload.clubId.trim().length > 0 ? payload.clubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          limit,
          statuses,
          clubScope,
          results,
        },
      });
    }

    case 'memberships.create': {
      const club = requireMembershipOwner(actor, payload.clubId);
      const membership = await repository.createMembership({
        actorMemberId: actor.member.id,
        clubId: club.clubId,
        memberId: requireNonEmptyString(payload.memberId, 'memberId'),
        sponsorMemberId: requireNonEmptyString(payload.sponsorMemberId, 'sponsorMemberId'),
        role: requireMembershipCreateRole(payload.role, createAppError),
        initialStatus: requireMembershipCreateInitialStatus(payload.initialStatus, createAppError),
        reason: normalizeOptionalString(payload.reason, 'reason'),
        metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
      });

      if (!membership) {
        throw createAppError(404, 'not_found', 'Member or sponsor not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: membership.clubId,
          activeClubIds: [membership.clubId],
        },
        sharedContext,
        data: { membership },
      });
    }

    case 'memberships.transition': {
      const membershipId = requireNonEmptyString(payload.membershipId, 'membershipId');
      const membership = await repository.transitionMembershipState({
        actorMemberId: actor.member.id,
        membershipId,
        nextStatus: requireMembershipState(payload.status, 'status'),
        reason: normalizeOptionalString(payload.reason, 'reason'),
        accessibleClubIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.clubId),
      });

      if (!membership) {
        throw createAppError(404, 'not_found', 'Membership not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: membership.clubId,
          activeClubIds: [membership.clubId],
        },
        sharedContext,
        data: { membership },
      });
    }

    case 'applications.list': {
      const limit = normalizeLimit(payload.limit);
      let clubScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.clubId !== undefined) {
        clubScope = [requireMembershipOwner(actor, payload.clubId)];
      }

      if (clubScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any clubs');
      }

      const statuses = normalizeApplicationStatuses(payload.statuses, requireApplicationStatus, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listApplications?.({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        statuses,
      });

      if (!results) {
        throw createAppError(501, 'not_implemented', 'applications.list is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId:
            typeof payload.clubId === 'string' && payload.clubId.trim().length > 0 ? payload.clubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          limit,
          statuses: statuses ?? null,
          clubScope,
          results,
        },
      });
    }

    case 'applications.create': {
      const club = requireMembershipOwner(actor, payload.clubId);
      const application = await repository.createApplication?.({
        actorMemberId: actor.member.id,
        clubId: club.clubId,
        applicantMemberId: requireNonEmptyString(payload.applicantMemberId, 'applicantMemberId'),
        sponsorMemberId: normalizeOptionalString(payload.sponsorMemberId, 'sponsorMemberId'),
        membershipId: normalizeOptionalString(payload.membershipId, 'membershipId'),
        path: requireApplicationPath(payload.path, 'path'),
        initialStatus: requireApplicationCreateInitialStatus(payload.initialStatus, requireApplicationStatus, createAppError),
        notes: normalizeOptionalString(payload.notes, 'notes'),
        intake: normalizeApplicationIntake(payload.intake, 'intake'),
        metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
      });

      if (application === undefined) {
        throw createAppError(501, 'not_implemented', 'applications.create is not implemented');
      }

      if (!application) {
        throw createAppError(404, 'not_found', 'Applicant, sponsor, or membership not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: application.clubId,
          activeClubIds: [application.clubId],
        },
        sharedContext,
        data: { application },
      });
    }

    case 'applications.transition': {
      const applicationId = requireNonEmptyString(payload.applicationId, 'applicationId');
      const application = await repository.transitionApplication?.({
        actorMemberId: actor.member.id,
        applicationId,
        nextStatus: requireApplicationStatus(payload.status, 'status'),
        notes: normalizeOptionalString(payload.notes, 'notes'),
        accessibleClubIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.clubId),
        intake: payload.intake === undefined ? undefined : normalizeApplicationIntake(payload.intake, 'intake'),
        membershipId: payload.membershipId === undefined ? undefined : normalizeOptionalString(payload.membershipId, 'membershipId'),
        activateMembership: payload.activateMembership === true,
        activationReason: normalizeOptionalString(payload.activationReason, 'activationReason'),
        metadataPatch: normalizeApplicationMetadataPatch(payload.metadata, 'metadata'),
      });

      if (application === undefined) {
        throw createAppError(501, 'not_implemented', 'applications.transition is not implemented');
      }

      if (!application) {
        throw createAppError(404, 'not_found', 'Application not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: application.clubId,
          activeClubIds: [application.clubId],
        },
        sharedContext,
        data: { application },
      });
    }

    case 'members.search': {
      const query = requireNonEmptyString(payload.query, 'query');
      const limit = normalizeLimit(payload.limit);
      const requestedClubId = payload.clubId;

      let clubIds = actor.memberships.map((club) => club.clubId);
      if (requestedClubId !== undefined) {
        clubIds = [requireAccessibleClub(actor, requestedClubId).clubId];
      }

      if (clubIds.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any clubs');
      }

      const results = await repository.searchMembers({
        actorMemberId: actor.member.id,
        clubIds,
        query,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId:
            typeof requestedClubId === 'string' && requestedClubId.trim().length > 0 ? requestedClubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          query,
          limit,
          clubScope: actor.memberships.filter((club) => clubIds.includes(club.clubId)),
          results,
        },
      });
    }

    case 'members.list': {
      const limit = normalizeLimit(payload.limit);
      let clubScope = actor.memberships;

      if (payload.clubId !== undefined) {
        clubScope = [requireAccessibleClub(actor, payload.clubId)];
      }

      if (clubScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any clubs');
      }

      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listMembers({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId:
            typeof payload.clubId === 'string' && payload.clubId.trim().length > 0 ? payload.clubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          limit,
          clubScope,
          results,
        },
      });
    }

    case 'vouches.create': {
      const club = requireAccessibleClub(actor, payload.clubId);
      const targetMemberId = requireNonEmptyString(payload.memberId, 'memberId');
      const reason = requireNonEmptyString(payload.reason, 'reason');

      if (reason.length > 500) {
        throw createAppError(400, 'invalid_input', 'reason must be at most 500 characters');
      }

      if (targetMemberId === actor.member.id) {
        throw createAppError(400, 'self_vouch', 'You cannot vouch for yourself');
      }

      let vouch;
      try {
        vouch = await repository.createVouch({
          actorMemberId: actor.member.id,
          clubId: club.clubId,
          targetMemberId,
          reason,
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          throw createAppError(409, 'duplicate_vouch', 'You have already vouched for this member in this club');
        }
        if (error && typeof error === 'object' && 'code' in error && error.code === '23514') {
          throw createAppError(400, 'self_vouch', 'You cannot vouch for yourself');
        }
        throw error;
      }

      if (!vouch) {
        throw createAppError(404, 'not_found', 'Target member was not found in this club');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { vouch },
      });
    }

    case 'vouches.list': {
      const targetMemberId = requireNonEmptyString(payload.memberId, 'memberId');
      const limit = normalizeLimit(payload.limit);
      const clubScope = actor.memberships;
      if (payload.clubId !== undefined) {
        requireAccessibleClub(actor, payload.clubId);
      }
      const clubIds = payload.clubId !== undefined
        ? [requireNonEmptyString(payload.clubId, 'clubId')]
        : clubScope.map((m) => m.clubId);

      const results = await repository.listVouches({
        actorMemberId: actor.member.id,
        clubIds,
        targetMemberId,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: typeof payload.clubId === 'string' ? payload.clubId.trim() : null,
          activeClubIds: clubIds,
        },
        sharedContext,
        data: { memberId: targetMemberId, results },
      });
    }

    default:
      return null;
  }
}
