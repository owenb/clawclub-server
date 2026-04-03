import type { Repository, RequestScope, SharedResponseContext } from './app.ts';
import type { ActorContext } from './app-contract.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  NormalizeOptionalString,
  NormalizeTokenCreateInput,
  RequireNonEmptyString,
  RequireSuperadmin,
} from './app-helpers.ts';

export async function handlePlatformAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeOptionalString: NormalizeOptionalString;
  normalizeTokenCreateInput: NormalizeTokenCreateInput;
  requireNonEmptyString: RequireNonEmptyString;
  requireSuperadmin: RequireSuperadmin;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeOptionalString,
    normalizeTokenCreateInput,
    payload,
    repository,
    requestScope,
    requireNonEmptyString,
    requireSuperadmin,
    sharedContext,
  } = input;

  switch (action) {
    case 'session.describe':
      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: {},
      });

    case 'quotas.status': {
      const clubIds = actor.memberships.map((m) => m.clubId);
      const quotas = await repository.getQuotaStatus({
        actorMemberId: actor.member.id,
        clubIds,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { quotas },
      });
    }

    case 'clubs.list': {
      requireSuperadmin(actor);
      const includeArchived = payload.includeArchived === true;
      const clubs = await repository.listClubs?.({
        actorMemberId: actor.member.id,
        includeArchived,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: {
          includeArchived,
          clubs: clubs ?? [],
        },
      });
    }

    case 'clubs.create': {
      requireSuperadmin(actor);
      const slug = requireNonEmptyString(payload.slug, 'slug');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        throw createAppError(400, 'invalid_input', 'slug must use lowercase letters, numbers, and single hyphens');
      }

      let club: Awaited<ReturnType<NonNullable<typeof repository.createClub>>>;
      try {
        club = await repository.createClub?.({
          actorMemberId: actor.member.id,
          slug,
          name: requireNonEmptyString(payload.name, 'name'),
          summary: requireNonEmptyString(payload.summary, 'summary'),
          ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
        }) ?? null;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
            'constraint' in error && typeof error.constraint === 'string' && error.constraint.includes('slug')) {
          throw createAppError(409, 'slug_conflict', 'A club with that slug already exists');
        }
        throw error;
      }

      if (!club) {
        throw createAppError(404, 'not_found', 'Owner member not found or not active');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { club },
      });
    }

    case 'clubs.archive': {
      requireSuperadmin(actor);
      const club = await repository.archiveClub?.({
        actorMemberId: actor.member.id,
        clubId: requireNonEmptyString(payload.clubId, 'clubId'),
      });

      if (!club) {
        throw createAppError(404, 'not_found', 'Club not found for archive');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { club },
      });
    }

    case 'clubs.assignOwner': {
      requireSuperadmin(actor);
      const club = await repository.assignClubOwner?.({
        actorMemberId: actor.member.id,
        clubId: requireNonEmptyString(payload.clubId, 'clubId'),
        ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
      });

      if (!club) {
        throw createAppError(404, 'not_found', 'Club or owner member not found for owner assignment');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { club },
      });
    }

    case 'tokens.list': {
      const tokens = await repository.listBearerTokens({
        actorMemberId: actor.member.id,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { tokens },
      });
    }

    case 'tokens.create': {
      const { label, expiresAt, metadata } = normalizeTokenCreateInput(payload);
      const created = await repository.createBearerToken({
        actorMemberId: actor.member.id,
        label,
        expiresAt,
        metadata,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: created,
      });
    }

    case 'tokens.revoke': {
      const tokenId = requireNonEmptyString(payload.tokenId, 'tokenId');
      const token = await repository.revokeBearerToken({
        actorMemberId: actor.member.id,
        tokenId,
      });

      if (!token) {
        throw createAppError(404, 'not_found', 'Token not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { token },
      });
    }

    default:
      return null;
  }
}
