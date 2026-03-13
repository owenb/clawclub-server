import type {
  ActorContext,
  ApplicationStatus,
  CreateApplicationInput,
  MembershipState,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
} from './app.ts';

type BuildSuccessResponse = (input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  data: unknown;
}) => unknown;

type CreateAppError = (status: number, code: string, message: string) => Error;
type NormalizeLimit = (value: unknown) => number;
type NormalizeOptionalString = (value: unknown, field: string) => string | null | undefined;
type RequireAccessibleNetwork = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
type RequireMembershipOwner = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
type RequireMembershipState = (value: unknown, field: string) => MembershipState;
type RequireApplicationStatus = (value: unknown, field: string) => ApplicationStatus;
type RequireApplicationPath = (value: unknown, field: string) => 'sponsored' | 'outside';
type NormalizeApplicationIntake = (value: unknown, field: string) => CreateApplicationInput['intake'];
type NormalizeApplicationMetadataPatch = (value: unknown, field: string) => Record<string, unknown> | undefined;
type RequireNonEmptyString = (value: unknown, field: string) => string;
type RequireObject = (value: unknown, field: string) => Record<string, unknown>;

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
  requireAccessibleNetwork: RequireAccessibleNetwork;
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
    requireAccessibleNetwork,
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
      let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.networkId !== undefined) {
        networkScope = [requireMembershipOwner(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any networks');
      }

      const status = payload.status === undefined ? undefined : requireMembershipState(payload.status, 'status');
      const networkIds = networkScope.map((network) => network.networkId);
      const results = await repository.listMemberships({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        status,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId:
            typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          limit,
          status: status ?? null,
          networkScope,
          results,
        },
      });
    }

    case 'memberships.review': {
      const limit = normalizeLimit(payload.limit);
      let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.networkId !== undefined) {
        networkScope = [requireMembershipOwner(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any networks');
      }

      const statuses = normalizeMembershipReviewStatuses(payload.statuses, requireMembershipState, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const results = await repository.listMembershipReviews({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        statuses,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId:
            typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          limit,
          statuses,
          networkScope,
          results,
        },
      });
    }

    case 'memberships.create': {
      const network = requireMembershipOwner(actor, payload.networkId);
      const membership = await repository.createMembership({
        actorMemberId: actor.member.id,
        networkId: network.networkId,
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
          requestedNetworkId: membership.networkId,
          activeNetworkIds: [membership.networkId],
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
        accessibleNetworkIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.networkId),
      });

      if (!membership) {
        throw createAppError(404, 'not_found', 'Membership not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: membership.networkId,
          activeNetworkIds: [membership.networkId],
        },
        sharedContext,
        data: { membership },
      });
    }

    case 'applications.list': {
      const limit = normalizeLimit(payload.limit);
      let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.networkId !== undefined) {
        networkScope = [requireMembershipOwner(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any networks');
      }

      const statuses = normalizeApplicationStatuses(payload.statuses, requireApplicationStatus, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const results = await repository.listApplications?.({
        actorMemberId: actor.member.id,
        networkIds,
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
          requestedNetworkId:
            typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          limit,
          statuses: statuses ?? null,
          networkScope,
          results,
        },
      });
    }

    case 'applications.create': {
      const network = requireMembershipOwner(actor, payload.networkId);
      const application = await repository.createApplication?.({
        actorMemberId: actor.member.id,
        networkId: network.networkId,
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
          requestedNetworkId: application.networkId,
          activeNetworkIds: [application.networkId],
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
        accessibleNetworkIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.networkId),
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
          requestedNetworkId: application.networkId,
          activeNetworkIds: [application.networkId],
        },
        sharedContext,
        data: { application },
      });
    }

    case 'members.search': {
      const query = requireNonEmptyString(payload.query, 'query');
      const limit = normalizeLimit(payload.limit);
      const requestedNetworkId = payload.networkId;

      let networkIds = actor.memberships.map((network) => network.networkId);
      if (requestedNetworkId !== undefined) {
        networkIds = [requireAccessibleNetwork(actor, requestedNetworkId).networkId];
      }

      if (networkIds.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
      }

      const results = await repository.searchMembers({
        actorMemberId: actor.member.id,
        networkIds,
        query,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId:
            typeof requestedNetworkId === 'string' && requestedNetworkId.trim().length > 0 ? requestedNetworkId.trim() : null,
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          query,
          limit,
          networkScope: actor.memberships.filter((network) => networkIds.includes(network.networkId)),
          results,
        },
      });
    }

    case 'members.list': {
      const limit = normalizeLimit(payload.limit);
      let networkScope = actor.memberships;

      if (payload.networkId !== undefined) {
        networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
      }

      const networkIds = networkScope.map((network) => network.networkId);
      const results = await repository.listMembers({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId:
            typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          limit,
          networkScope,
          results,
        },
      });
    }

    default:
      return null;
  }
}
