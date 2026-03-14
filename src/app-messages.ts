import type {
  ActorContext,
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
type RequireAccessibleNetwork = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
type RequireNonEmptyString = (value: unknown, field: string) => string;

function resolveScopedNetworks(
  actor: ActorContext,
  requestedNetworkId: unknown,
  requireAccessibleNetwork: RequireAccessibleNetwork,
  createAppError: CreateAppError,
): MembershipSummary[] {
  if (requestedNetworkId !== undefined) {
    return [requireAccessibleNetwork(actor, requestedNetworkId)];
  }

  if (actor.memberships.length === 0) {
    throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
  }

  return actor.memberships;
}

function resolveRequestedNetworkId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function handleMessageAction(input: {
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
    case 'messages.send': {
      const recipientMemberId = requireNonEmptyString(payload.recipientMemberId, 'recipientMemberId');
      const message = await repository.sendDirectMessage({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        recipientMemberId,
        networkId: payload.networkId === undefined ? undefined : requireAccessibleNetwork(actor, payload.networkId).networkId,
        messageText: requireNonEmptyString(payload.messageText, 'messageText'),
      });

      if (!message) {
        throw createAppError(404, 'not_found', 'Recipient not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: message.networkId,
          activeNetworkIds: [message.networkId],
        },
        sharedContext,
        data: { message },
      });
    }

    case 'messages.list': {
      const limit = normalizeLimit(payload.limit);
      const networkScope = resolveScopedNetworks(actor, payload.networkId, requireAccessibleNetwork, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const results = await repository.listDirectMessageThreads({
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
        data: {
          limit,
          networkScope,
          results,
        },
      });
    }

    case 'messages.read': {
      const threadId = requireNonEmptyString(payload.threadId, 'threadId');
      const transcript = await repository.readDirectMessageThread({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        threadId,
        limit: normalizeLimit(payload.limit),
      });

      if (!transcript) {
        throw createAppError(404, 'not_found', 'Thread not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: transcript.thread.networkId,
          activeNetworkIds: [transcript.thread.networkId],
        },
        sharedContext,
        data: transcript,
      });
    }

    case 'messages.inbox': {
      const limit = normalizeLimit(payload.limit);
      const networkScope = resolveScopedNetworks(actor, payload.networkId, requireAccessibleNetwork, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const unreadOnly = payload.unreadOnly === true;
      const results = await repository.listDirectMessageInbox({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        unreadOnly,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: resolveRequestedNetworkId(payload.networkId),
          activeNetworkIds: networkIds,
        },
        sharedContext,
        data: {
          limit,
          unreadOnly,
          networkScope,
          results,
        },
      });
    }

    default:
      return null;
  }
}
