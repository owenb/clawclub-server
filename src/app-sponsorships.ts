import type { Repository, SharedResponseContext } from './app.ts';
import type { ActorContext } from './app-contract.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  NormalizeLimit,
  RequireAccessibleNetwork,
  RequireNonEmptyString,
} from './app-helpers.ts';
import { resolveScopedNetworks, resolveRequestedNetworkId } from './app-helpers.ts';

const MAX_FIELD_LENGTH = 500;

export async function handleSponsorshipAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  requireAccessibleNetwork: RequireAccessibleNetwork;
  requireNonEmptyString: RequireNonEmptyString;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeLimit,
    payload,
    repository,
    requireAccessibleNetwork,
    requireNonEmptyString,
    sharedContext,
  } = input;

  switch (action) {
    case 'sponsorships.create': {
      const network = requireAccessibleNetwork(actor, payload.networkId);

      const name = requireNonEmptyString(payload.name, 'name');
      const nameWords = name.split(/\s+/).filter((w) => w.length > 0);
      if (nameWords.length < 2) {
        throw createAppError(400, 'invalid_input', 'name must be a full name (first and last name)');
      }
      if (name.length > MAX_FIELD_LENGTH) {
        throw createAppError(400, 'invalid_input', `name must be at most ${MAX_FIELD_LENGTH} characters`);
      }
      const candidateName = nameWords.join(' ');

      const email = requireNonEmptyString(payload.email, 'email').toLowerCase();
      if (!email.includes('@')) {
        throw createAppError(400, 'invalid_input', 'email must look like an email address');
      }
      if (email.length > MAX_FIELD_LENGTH) {
        throw createAppError(400, 'invalid_input', `email must be at most ${MAX_FIELD_LENGTH} characters`);
      }

      const socials = requireNonEmptyString(payload.socials, 'socials');
      if (socials.length > MAX_FIELD_LENGTH) {
        throw createAppError(400, 'invalid_input', `socials must be at most ${MAX_FIELD_LENGTH} characters`);
      }

      const reason = requireNonEmptyString(payload.reason, 'reason');
      if (reason.length > MAX_FIELD_LENGTH) {
        throw createAppError(400, 'invalid_input', `reason must be at most ${MAX_FIELD_LENGTH} characters`);
      }

      const sponsorship = await repository.createSponsorship({
        actorMemberId: actor.member.id,
        networkId: network.networkId,
        candidateName,
        candidateEmail: email,
        candidateDetails: { socials },
        reason,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { sponsorship },
      });
    }

    case 'sponsorships.list': {
      const limit = normalizeLimit(payload.limit);
      const networkScope = resolveScopedNetworks(actor, payload.networkId, requireAccessibleNetwork, createAppError);
      const networkIds = networkScope.map((n) => n.networkId);

      const results = await repository.listSponsorships({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: resolveRequestedNetworkId(payload.networkId),
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: { limit, results },
      });
    }

    default:
      return null;
  }
}
