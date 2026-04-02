import type { Repository, RequestScope, SharedResponseContext } from './app.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  NormalizeLimit,
  RequireAccessibleClub,
  RequireNonEmptyString,
} from './app-helpers.ts';
import { resolveScopedClubs, resolveRequestedClubId } from './app-helpers.ts';
import type { ActorContext } from './app-contract.ts';

export async function handleMessageAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  requireAccessibleClub: RequireAccessibleClub;
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
    requireAccessibleClub,
    requireNonEmptyString,
    sharedContext,
  } = input;

  switch (action) {
    case 'messages.send': {
      const recipientMemberId = requireNonEmptyString(payload.recipientMemberId, 'recipientMemberId');
      const message = await repository.sendDirectMessage({
        actorMemberId: actor.member.id,
        accessibleClubIds: actor.memberships.map((club) => club.clubId),
        recipientMemberId,
        clubId: payload.clubId === undefined ? undefined : requireAccessibleClub(actor, payload.clubId).clubId,
        messageText: requireNonEmptyString(payload.messageText, 'messageText'),
      });

      if (!message) {
        throw createAppError(404, 'not_found', 'Recipient not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: message.clubId,
          activeClubIds: [message.clubId],
        },
        sharedContext,
        data: { message },
      });
    }

    case 'messages.list': {
      const limit = normalizeLimit(payload.limit);
      const clubScope = resolveScopedClubs(actor, payload.clubId, requireAccessibleClub, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const results = await repository.listDirectMessageThreads({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: resolveRequestedClubId(payload.clubId),
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

    case 'messages.read': {
      const threadId = requireNonEmptyString(payload.threadId, 'threadId');
      const transcript = await repository.readDirectMessageThread({
        actorMemberId: actor.member.id,
        accessibleClubIds: actor.memberships.map((club) => club.clubId),
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
          requestedClubId: transcript.thread.clubId,
          activeClubIds: [transcript.thread.clubId],
        },
        sharedContext,
        data: transcript,
      });
    }

    case 'messages.inbox': {
      const limit = normalizeLimit(payload.limit);
      const clubScope = resolveScopedClubs(actor, payload.clubId, requireAccessibleClub, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const unreadOnly = payload.unreadOnly === true;
      const results = await repository.listDirectMessageInbox({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        unreadOnly,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: resolveRequestedClubId(payload.clubId),
          activeClubIds: clubIds,
        },
        sharedContext,
        data: {
          limit,
          unreadOnly,
          clubScope,
          results,
        },
      });
    }

    default:
      return null;
  }
}
