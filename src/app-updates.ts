import type {
  ActorContext,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateReceiptState,
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
type RequireInteger = (value: unknown, field: string) => number;
type RequireNonEmptyString = (value: unknown, field: string) => string;

function requireUpdateReceiptState(value: unknown, field: string): UpdateReceiptState {
  if (value !== 'processed' && value !== 'suppressed') {
    throw new Error(`${field} must be one of: processed, suppressed`);
  }

  return value;
}

function normalizeUpdateIds(value: unknown, requireNonEmptyString: RequireNonEmptyString): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('updateIds must be a non-empty array');
  }

  const ids = value.map((entry, index) => requireNonEmptyString(entry, `updateIds[${index}]`));
  return [...new Set(ids)];
}

export async function handleUpdatesAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  requireInteger: RequireInteger;
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
    requestScope,
    requireInteger,
    requireNonEmptyString,
    sharedContext,
  } = input;

  switch (action) {
    case 'updates.list': {
      if (!repository.listMemberUpdates) {
        throw createAppError(501, 'not_implemented', 'updates.list is not implemented');
      }

      const after = payload.after === undefined || payload.after === null
        ? null
        : requireInteger(payload.after, 'after');
      const updates = await repository.listMemberUpdates({
        actorMemberId: actor.member.id,
        limit: normalizeLimit(payload.limit),
        after,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: { updates },
      });
    }

    case 'updates.acknowledge': {
      if (!repository.acknowledgeUpdates) {
        throw createAppError(501, 'not_implemented', 'updates.acknowledge is not implemented');
      }

      let state: UpdateReceiptState;
      try {
        state = payload.state === undefined ? 'processed' : requireUpdateReceiptState(payload.state, 'state');
      } catch (error) {
        throw createAppError(400, 'invalid_input', error instanceof Error ? error.message : 'state is invalid');
      }

      let updateIds: string[];
      try {
        updateIds = normalizeUpdateIds(payload.updateIds, requireNonEmptyString);
      } catch (error) {
        throw createAppError(400, 'invalid_input', error instanceof Error ? error.message : 'updateIds are invalid');
      }

      const suppressionReason = payload.suppressionReason === undefined
        ? undefined
        : payload.suppressionReason === null
          ? null
          : requireNonEmptyString(payload.suppressionReason, 'suppressionReason');

      const receipts = await repository.acknowledgeUpdates({
        actorMemberId: actor.member.id,
        updateIds,
        state,
        suppressionReason,
      });

      if (receipts.length !== updateIds.length) {
        throw createAppError(404, 'not_found', 'One or more updates were not found inside the actor scope');
      }

      const acknowledgedIds = new Set(receipts.map((receipt) => receipt.updateId));
      const nextSharedContext = {
        pendingUpdates: sharedContext.pendingUpdates.filter((update) => !acknowledgedIds.has(update.updateId)),
      };

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext: nextSharedContext,
        data: { receipts },
      });
    }

    default:
      return null;
  }
}
