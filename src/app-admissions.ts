import type { Repository, SharedResponseContext } from './app.ts';
import type { ActorContext, AdmissionStatus, MembershipState } from './app-contract.ts';
import {
  normalizeCandidateEmail,
  normalizeCandidateFullName,
  requireBoundedString,
  type BuildSuccessResponse,
  type CreateAppError,
  type NormalizeAdmissionIntake,
  type NormalizeAdmissionMetadataPatch,
  type NormalizeLimit,
  type NormalizeOptionalString,
  type RequireAccessibleClub,
  type RequireAdmissionStatus,
  type RequireMembershipOwner,
  type RequireMembershipState,
  type RequireNonEmptyString,
  type RequireObject,
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

function normalizeAdmissionStatuses(
  value: unknown,
  requireAdmissionStatus: RequireAdmissionStatus,
  createAppError: CreateAppError,
): AdmissionStatus[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw createAppError(400, 'invalid_input', 'statuses must be a non-empty array when provided');
  }

  return [...new Set(value.map((status) => requireAdmissionStatus(status, 'statuses[]')))];
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
  requireAdmissionStatus: RequireAdmissionStatus;
  normalizeAdmissionIntake: NormalizeAdmissionIntake;
  normalizeAdmissionMetadataPatch: NormalizeAdmissionMetadataPatch;
  requireNonEmptyString: RequireNonEmptyString;
  requireObject: RequireObject;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeAdmissionIntake,
    normalizeAdmissionMetadataPatch,
    normalizeLimit,
    normalizeOptionalString,
    payload,
    repository,
    requireAccessibleClub,
    requireAdmissionStatus,
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

    case 'admissions.list': {
      const limit = normalizeLimit(payload.limit);
      let clubScope = actor.memberships.filter((membership) => membership.role === 'owner');

      if (payload.clubId !== undefined) {
        clubScope = [requireMembershipOwner(actor, payload.clubId)];
      }

      if (clubScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any clubs');
      }

      const statuses = normalizeAdmissionStatuses(payload.statuses, requireAdmissionStatus, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listAdmissions?.({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        statuses,
      });

      if (!results) {
        throw createAppError(501, 'not_implemented', 'admissions.list is not implemented');
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

    case 'admissions.transition': {
      const admissionId = requireNonEmptyString(payload.admissionId, 'admissionId');
      const admission = await repository.transitionAdmission?.({
        actorMemberId: actor.member.id,
        admissionId,
        nextStatus: requireAdmissionStatus(payload.status, 'status'),
        notes: normalizeOptionalString(payload.notes, 'notes'),
        accessibleClubIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.clubId),
        intake: payload.intake === undefined ? undefined : normalizeAdmissionIntake(payload.intake, 'intake'),
        metadataPatch: normalizeAdmissionMetadataPatch(payload.metadata, 'metadata'),
      });

      if (admission === undefined) {
        throw createAppError(501, 'not_implemented', 'admissions.transition is not implemented');
      }

      if (!admission) {
        throw createAppError(404, 'not_found', 'Admission not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: admission.clubId,
          activeClubIds: [admission.clubId],
        },
        sharedContext,
        data: { admission },
      });
    }

    case 'admissions.sponsor': {
      const club = requireAccessibleClub(actor, payload.clubId);
      const candidateName = normalizeCandidateFullName(payload.name, requireNonEmptyString, createAppError);
      const candidateEmail = normalizeCandidateEmail(payload.email, requireNonEmptyString, createAppError);
      const socials = requireBoundedString(payload.socials, 'socials', requireNonEmptyString, createAppError);
      const reason = requireBoundedString(payload.reason, 'reason', requireNonEmptyString, createAppError);

      const admission = await repository.createAdmissionSponsorship({
        actorMemberId: actor.member.id,
        clubId: club.clubId,
        candidateName,
        candidateEmail,
        candidateDetails: { socials },
        reason,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { admission },
      });
    }

    case 'admissions.issueAccess': {
      const admissionId = requireNonEmptyString(payload.admissionId, 'admissionId');
      const accessibleClubIds = actor.memberships.filter((item) => item.role === 'owner').map((item) => item.clubId);

      if (accessibleClubIds.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently own any clubs');
      }

      const result = await repository.issueAdmissionAccess?.({
        actorMemberId: actor.member.id,
        admissionId,
        accessibleClubIds,
      });

      if (result === undefined) {
        throw createAppError(501, 'not_implemented', 'admissions.issueAccess is not implemented');
      }

      if (!result) {
        throw createAppError(404, 'not_found', 'Admission not found inside the owner scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: result.admission.clubId,
          activeClubIds: [result.admission.clubId],
        },
        sharedContext,
        data: {
          admission: result.admission,
          bearerToken: result.bearerToken,
        },
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
