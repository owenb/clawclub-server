import type { Repository, RequestScope, SharedResponseContext } from './app.ts';
import type { ActorContext } from './app-contract.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  IsEntityKind,
  NormalizeLimit,
  RequireNonEmptyString,
  RequireSuperadmin,
} from './app-helpers.ts';

function normalizeOffset(value: unknown, createAppError: CreateAppError): number {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || Number(value) < 0) {
    throw createAppError(400, 'invalid_input', 'offset must be a non-negative integer');
  }

  return Number(value);
}

export async function handleAdminAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  requireSuperadmin: RequireSuperadmin;
  requireNonEmptyString: RequireNonEmptyString;
  normalizeLimit: NormalizeLimit;
  isEntityKind: IsEntityKind;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    isEntityKind,
    normalizeLimit,
    payload,
    repository,
    requestScope,
    requireNonEmptyString,
    requireSuperadmin,
    sharedContext,
  } = input;

  switch (action) {
    case 'admin.overview': {
      requireSuperadmin(actor);
      const overview = await repository.adminGetOverview?.({ actorMemberId: actor.member.id });
      if (!overview) {
        throw createAppError(501, 'not_implemented', 'admin.overview is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { overview },
      });
    }

    case 'admin.members.list': {
      requireSuperadmin(actor);
      const members = await repository.adminListMembers?.({
        actorMemberId: actor.member.id,
        limit: normalizeLimit(payload.limit),
        offset: normalizeOffset(payload.offset, createAppError),
      });
      if (!members) {
        throw createAppError(501, 'not_implemented', 'admin.members.list is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { members },
      });
    }

    case 'admin.members.get': {
      requireSuperadmin(actor);
      const memberId = requireNonEmptyString(payload.memberId, 'memberId');
      const member = await repository.adminGetMember?.({ actorMemberId: actor.member.id, memberId });
      if (!member) {
        throw createAppError(404, 'not_found', 'Member not found');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { member },
      });
    }

    case 'admin.clubs.stats': {
      requireSuperadmin(actor);
      const clubId = requireNonEmptyString(payload.clubId, 'clubId');
      const stats = await repository.adminGetClubStats?.({ actorMemberId: actor.member.id, clubId });
      if (!stats) {
        throw createAppError(404, 'not_found', 'Club not found');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { stats },
      });
    }

    case 'admin.content.list': {
      requireSuperadmin(actor);
      const clubId = typeof payload.clubId === 'string' ? payload.clubId.trim() : undefined;
      const kind = isEntityKind(payload.kind) ? payload.kind : undefined;
      const content = await repository.adminListContent?.({
        actorMemberId: actor.member.id,
        clubId: clubId || undefined,
        kind,
        limit: normalizeLimit(payload.limit),
        offset: normalizeOffset(payload.offset, createAppError),
      });
      if (!content) {
        throw createAppError(501, 'not_implemented', 'admin.content.list is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { content },
      });
    }

    case 'admin.content.archive': {
      requireSuperadmin(actor);
      const entityId = requireNonEmptyString(payload.entityId, 'entityId');
      const result = await repository.adminArchiveEntity?.({ actorMemberId: actor.member.id, entityId });
      if (!result) {
        throw createAppError(404, 'not_found', 'Entity not found or already archived');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: result,
      });
    }

    case 'admin.content.redact': {
      requireSuperadmin(actor);
      const entityId = requireNonEmptyString(payload.entityId, 'entityId');
      const result = await repository.redactEntity?.({
        actorMemberId: actor.member.id,
        accessibleClubIds: [],
        entityId,
        reason: typeof payload.reason === 'string' ? payload.reason.trim() || null : null,
        skipNotification: true,
      });
      if (!result) {
        throw createAppError(404, 'not_found', 'Entity not found');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { redaction: result.redaction },
      });
    }

    case 'admin.messages.threads': {
      requireSuperadmin(actor);
      const clubId = typeof payload.clubId === 'string' ? payload.clubId.trim() : undefined;
      const threads = await repository.adminListThreads?.({
        actorMemberId: actor.member.id,
        clubId: clubId || undefined,
        limit: normalizeLimit(payload.limit),
        offset: normalizeOffset(payload.offset, createAppError),
      });
      if (!threads) {
        throw createAppError(501, 'not_implemented', 'admin.messages.threads is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { threads },
      });
    }

    case 'admin.messages.read': {
      requireSuperadmin(actor);
      const threadId = requireNonEmptyString(payload.threadId, 'threadId');
      const result = await repository.adminReadThread?.({
        actorMemberId: actor.member.id,
        threadId,
        limit: normalizeLimit(payload.limit),
      });
      if (!result) {
        throw createAppError(404, 'not_found', 'Thread not found');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: result,
      });
    }

    case 'admin.messages.redact': {
      requireSuperadmin(actor);
      const messageId = requireNonEmptyString(payload.messageId, 'messageId');
      const result = await repository.redactMessage?.({
        actorMemberId: actor.member.id,
        accessibleClubIds: [],
        messageId,
        reason: typeof payload.reason === 'string' ? payload.reason.trim() || null : null,
        skipNotification: true,
      });
      if (!result) {
        throw createAppError(404, 'not_found', 'Message not found');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { redaction: result.redaction },
      });
    }

    case 'admin.tokens.list': {
      requireSuperadmin(actor);
      const memberId = requireNonEmptyString(payload.memberId, 'memberId');
      const tokens = await repository.adminListMemberTokens?.({ actorMemberId: actor.member.id, memberId });
      if (!tokens) {
        throw createAppError(501, 'not_implemented', 'admin.tokens.list is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { tokens },
      });
    }

    case 'admin.tokens.revoke': {
      requireSuperadmin(actor);
      const memberId = requireNonEmptyString(payload.memberId, 'memberId');
      const tokenId = requireNonEmptyString(payload.tokenId, 'tokenId');
      const token = await repository.adminRevokeMemberToken?.({ actorMemberId: actor.member.id, memberId, tokenId });
      if (!token) {
        throw createAppError(404, 'not_found', 'Token not found for the specified member');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { token },
      });
    }

    case 'admin.diagnostics.health': {
      requireSuperadmin(actor);
      const diagnostics = await repository.adminGetDiagnostics?.({ actorMemberId: actor.member.id });
      if (!diagnostics) {
        throw createAppError(501, 'not_implemented', 'admin.diagnostics.health is not implemented');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { diagnostics },
      });
    }

    default:
      return null;
  }
}
