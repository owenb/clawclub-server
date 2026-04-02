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
      const networkIds = actor.memberships.map((m) => m.networkId);
      const quotas = await repository.getQuotaStatus({
        actorMemberId: actor.member.id,
        networkIds,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { quotas },
      });
    }

    case 'networks.list': {
      requireSuperadmin(actor);
      const includeArchived = payload.includeArchived === true;
      const networks = await repository.listNetworks?.({
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
          networks: networks ?? [],
        },
      });
    }

    case 'networks.create': {
      requireSuperadmin(actor);
      const network = await repository.createNetwork?.({
        actorMemberId: actor.member.id,
        slug: requireNonEmptyString(payload.slug, 'slug'),
        name: requireNonEmptyString(payload.name, 'name'),
        summary: normalizeOptionalString(payload.summary, 'summary'),
        manifestoMarkdown: normalizeOptionalString(payload.manifestoMarkdown, 'manifestoMarkdown'),
        ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
      });

      if (!network) {
        throw createAppError(404, 'not_found', 'Owner member not found for network create');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { network },
      });
    }

    case 'networks.archive': {
      requireSuperadmin(actor);
      const network = await repository.archiveNetwork?.({
        actorMemberId: actor.member.id,
        networkId: requireNonEmptyString(payload.networkId, 'networkId'),
      });

      if (!network) {
        throw createAppError(404, 'not_found', 'Network not found for archive');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { network },
      });
    }

    case 'networks.assignOwner': {
      requireSuperadmin(actor);
      const network = await repository.assignNetworkOwner?.({
        actorMemberId: actor.member.id,
        networkId: requireNonEmptyString(payload.networkId, 'networkId'),
        ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
      });

      if (!network) {
        throw createAppError(404, 'not_found', 'Network or owner member not found for owner assignment');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { network },
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
