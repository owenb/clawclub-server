import type {
  ActorContext,
  CreateDeliveryEndpointInput,
  DeliveryAttemptSummary,
  DeliveryEndpointSummary,
  DeliverySecretResolver,
  DeliverySummary,
  DeliveryWorkerAuthResult,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateDeliveryEndpointInput,
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
type NormalizeOptionalDeliveryAttemptStatus = (value: unknown) => DeliveryAttemptSummary['status'] | undefined;
type NormalizeOptionalString = (value: unknown, field: string) => string | null | undefined;
type RequireAccessibleNetwork = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
type RequireInteger = (value: unknown, field: string) => number;
type RequireNonEmptyString = (value: unknown, field: string) => string;
type NormalizeCreateDeliveryEndpointInput = (payload: Record<string, unknown>) => Omit<CreateDeliveryEndpointInput, 'actorMemberId'>;
type NormalizeUpdateDeliveryEndpointPatch = (payload: Record<string, unknown>) => UpdateDeliveryEndpointInput['patch'];
type BuildSignedDeliveryHeaders = (input: {
  endpoint: DeliveryEndpointSummary;
  delivery: DeliverySummary;
  attempt: DeliveryAttemptSummary;
  body: string;
  resolveDeliverySecret?: DeliverySecretResolver;
}) => Promise<Record<string, string>>;
type ReadExecutionResponseBody = (response: Response) => Promise<string | null>;

export async function handleDeliveryAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  workerAuth: DeliveryWorkerAuthResult | null;
  sharedContext: SharedResponseContext;
  repository: Repository;
  fetchImpl: typeof fetch;
  resolveDeliverySecret?: DeliverySecretResolver;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  normalizeOptionalDeliveryAttemptStatus: NormalizeOptionalDeliveryAttemptStatus;
  normalizeOptionalString: NormalizeOptionalString;
  requireAccessibleNetwork: RequireAccessibleNetwork;
  requireInteger: RequireInteger;
  requireNonEmptyString: RequireNonEmptyString;
  normalizeCreateDeliveryEndpointInput: NormalizeCreateDeliveryEndpointInput;
  normalizeUpdateDeliveryEndpointPatch: NormalizeUpdateDeliveryEndpointPatch;
  buildSignedDeliveryHeaders: BuildSignedDeliveryHeaders;
  readExecutionResponseBody: ReadExecutionResponseBody;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSignedDeliveryHeaders,
    buildSuccessResponse,
    createAppError,
    fetchImpl,
    normalizeCreateDeliveryEndpointInput,
    normalizeLimit,
    normalizeOptionalDeliveryAttemptStatus,
    normalizeOptionalString,
    normalizeUpdateDeliveryEndpointPatch,
    payload,
    readExecutionResponseBody,
    repository,
    requireAccessibleNetwork,
    requireInteger,
    requireNonEmptyString,
    resolveDeliverySecret,
    sharedContext,
    workerAuth,
  } = input;

  switch (action) {
    case 'deliveries.endpoints.list': {
      const endpoints = await repository.listDeliveryEndpoints({
        actorMemberId: actor.member.id,
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds: actor.memberships.map((network) => network.networkId),
        },
        sharedContext,
        data: { endpoints },
      });
    }

    case 'deliveries.endpoints.create': {
      const endpoint = await repository.createDeliveryEndpoint({
        actorMemberId: actor.member.id,
        ...normalizeCreateDeliveryEndpointInput(payload),
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds: actor.memberships.map((network) => network.networkId),
        },
        sharedContext,
        data: { endpoint },
      });
    }

    case 'deliveries.endpoints.update': {
      const endpointId = requireNonEmptyString(payload.endpointId, 'endpointId');
      const endpoint = await repository.updateDeliveryEndpoint({
        actorMemberId: actor.member.id,
        endpointId,
        patch: normalizeUpdateDeliveryEndpointPatch(payload),
      });

      if (!endpoint) {
        throw createAppError(404, 'not_found', 'Delivery endpoint not found for this member');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds: actor.memberships.map((network) => network.networkId),
        },
        sharedContext,
        data: { endpoint },
      });
    }

    case 'deliveries.endpoints.revoke': {
      const endpointId = requireNonEmptyString(payload.endpointId, 'endpointId');
      const endpoint = await repository.revokeDeliveryEndpoint({
        actorMemberId: actor.member.id,
        endpointId,
      });

      if (!endpoint) {
        throw createAppError(404, 'not_found', 'Delivery endpoint not found for this member');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds: actor.memberships.map((network) => network.networkId),
        },
        sharedContext,
        data: { endpoint },
      });
    }

    case 'deliveries.list': {
      const limit = normalizeLimit(payload.limit);
      let networkScope = actor.memberships;

      if (payload.networkId !== undefined) {
        networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
      }

      const networkIds = networkScope.map((network) => network.networkId);
      const pendingOnly = payload.pendingOnly === true;
      const results = await repository.listDeliveries({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        pendingOnly,
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
          pendingOnly,
          networkScope,
          results,
        },
      });
    }

    case 'deliveries.attempts': {
      const limit = normalizeLimit(payload.limit);
      let networkScope = actor.memberships;

      if (payload.networkId !== undefined) {
        networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
      }

      if (networkScope.length === 0) {
        throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
      }

      const networkIds = networkScope.map((network) => network.networkId);
      const endpointId = payload.endpointId === undefined ? undefined : requireNonEmptyString(payload.endpointId, 'endpointId');
      const recipientMemberId =
        payload.recipientMemberId === undefined ? undefined : requireNonEmptyString(payload.recipientMemberId, 'recipientMemberId');
      const status = normalizeOptionalDeliveryAttemptStatus(payload.status);
      const results = await repository.listDeliveryAttempts({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        endpointId,
        recipientMemberId,
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
          filters: {
            endpointId: endpointId ?? null,
            recipientMemberId: recipientMemberId ?? null,
            status: status ?? null,
          },
          networkScope,
          results,
        },
      });
    }

    case 'deliveries.acknowledge': {
      const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
      const state = payload.state === 'shown' || payload.state === 'suppressed' ? payload.state : null;

      if (!state) {
        throw createAppError(400, 'invalid_input', 'state must be one of: shown, suppressed');
      }

      const acknowledgement = await repository.acknowledgeDelivery({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        deliveryId,
        state,
        suppressionReason: normalizeOptionalString(payload.suppressionReason, 'suppressionReason'),
      });

      if (!acknowledgement) {
        throw createAppError(404, 'not_found', 'Delivery not found inside the actor scope');
      }

      const remainingPendingDeliveries = sharedContext.pendingDeliveries.filter((delivery) => delivery.deliveryId !== acknowledgement.deliveryId);

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: acknowledgement.networkId,
          activeNetworkIds: [acknowledgement.networkId],
        },
        sharedContext: {
          pendingDeliveries: remainingPendingDeliveries,
        },
        data: { acknowledgement },
      });
    }

    case 'deliveries.retry': {
      const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
      const delivery = await repository.retryDelivery({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        deliveryId,
      });

      if (!delivery) {
        throw createAppError(404, 'not_found', 'Delivery not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: delivery.networkId,
          activeNetworkIds: [delivery.networkId],
        },
        sharedContext,
        data: { delivery },
      });
    }

    case 'deliveries.claim': {
      const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
      const claimed = await repository.claimNextDelivery({
        actorMemberId: actor.member.id,
        accessibleNetworkIds,
        workerKey: normalizeOptionalString(payload.workerKey, 'workerKey'),
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: claimed?.delivery.networkId ?? null,
          activeNetworkIds: claimed ? [claimed.delivery.networkId] : accessibleNetworkIds,
        },
        sharedContext,
        data: { claimed },
      });
    }

    case 'deliveries.complete': {
      const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
      const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
      const responseStatusCode =
        payload.responseStatusCode === undefined || payload.responseStatusCode === null ? null : requireInteger(payload.responseStatusCode, 'responseStatusCode');
      const claimed = await repository.completeDeliveryAttempt({
        actorMemberId: actor.member.id,
        accessibleNetworkIds,
        deliveryId,
        responseStatusCode,
        responseBody: normalizeOptionalString(payload.responseBody, 'responseBody'),
      });

      if (!claimed) {
        throw createAppError(404, 'not_found', 'Processing delivery not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: claimed.delivery.networkId,
          activeNetworkIds: [claimed.delivery.networkId],
        },
        sharedContext,
        data: claimed,
      });
    }

    case 'deliveries.fail': {
      const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
      const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
      const responseStatusCode =
        payload.responseStatusCode === undefined || payload.responseStatusCode === null ? null : requireInteger(payload.responseStatusCode, 'responseStatusCode');
      const claimed = await repository.failDeliveryAttempt({
        actorMemberId: actor.member.id,
        accessibleNetworkIds,
        deliveryId,
        errorMessage: requireNonEmptyString(payload.errorMessage, 'errorMessage'),
        responseStatusCode,
        responseBody: normalizeOptionalString(payload.responseBody, 'responseBody'),
      });

      if (!claimed) {
        throw createAppError(404, 'not_found', 'Processing delivery not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: claimed.delivery.networkId,
          activeNetworkIds: [claimed.delivery.networkId],
        },
        sharedContext,
        data: claimed,
      });
    }

    case 'deliveries.execute': {
      const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
      const claimed = await repository.claimNextDelivery({
        actorMemberId: actor.member.id,
        accessibleNetworkIds,
        workerKey: normalizeOptionalString(payload.workerKey, 'workerKey'),
      });

      if (!claimed) {
        return buildSuccessResponse({
          action,
          actor,
          requestScope: {
            requestedNetworkId: null,
            activeNetworkIds: accessibleNetworkIds,
          },
          sharedContext,
          data: { execution: { outcome: 'idle', claimed: null } },
        });
      }

      try {
        const requestBody = JSON.stringify({
          deliveryId: claimed.delivery.deliveryId,
          networkId: claimed.delivery.networkId,
          recipientMemberId: claimed.delivery.recipientMemberId,
          topic: claimed.delivery.topic,
          payload: claimed.delivery.payload,
          entityId: claimed.delivery.entityId,
          entityVersionId: claimed.delivery.entityVersionId,
          transcriptMessageId: claimed.delivery.transcriptMessageId,
          attempt: {
            attemptId: claimed.attempt.attemptId,
            attemptNo: claimed.attempt.attemptNo,
            workerKey: claimed.attempt.workerKey,
            startedAt: claimed.attempt.startedAt,
          },
        });
        const signedHeaders = await buildSignedDeliveryHeaders({
          endpoint: claimed.endpoint,
          delivery: claimed.delivery,
          attempt: claimed.attempt,
          body: requestBody,
          resolveDeliverySecret,
        });
        const response = await fetchImpl(claimed.endpoint.endpointUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'clawclub-delivery-executor/0.1',
            'x-clawclub-delivery-id': claimed.delivery.deliveryId,
            'x-clawclub-attempt-id': claimed.attempt.attemptId,
            'x-clawclub-topic': claimed.delivery.topic,
            ...signedHeaders,
          },
          body: requestBody,
        });

        const responseBody = await readExecutionResponseBody(response);
        const result = response.ok
          ? await repository.completeDeliveryAttempt({
              actorMemberId: actor.member.id,
              accessibleNetworkIds: [claimed.delivery.networkId],
              deliveryId: claimed.delivery.deliveryId,
              responseStatusCode: response.status,
              responseBody,
            })
          : await repository.failDeliveryAttempt({
              actorMemberId: actor.member.id,
              accessibleNetworkIds: [claimed.delivery.networkId],
              deliveryId: claimed.delivery.deliveryId,
              errorMessage: `HTTP ${response.status}`,
              responseStatusCode: response.status,
              responseBody,
            });

        if (!result) {
          throw createAppError(409, 'delivery_execution_conflict', 'Claimed delivery could not be finalized');
        }

        return buildSuccessResponse({
          action,
          actor,
          requestScope: {
            requestedNetworkId: result.delivery.networkId,
            activeNetworkIds: [result.delivery.networkId],
          },
          sharedContext,
          data: { execution: { outcome: response.ok ? 'sent' : 'failed', claimed: result } },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery execution error';
        const failed = await repository.failDeliveryAttempt({
          actorMemberId: actor.member.id,
          accessibleNetworkIds: [claimed.delivery.networkId],
          deliveryId: claimed.delivery.deliveryId,
          errorMessage: message,
        });

        if (!failed) {
          throw error;
        }

        return buildSuccessResponse({
          action,
          actor,
          requestScope: {
            requestedNetworkId: failed.delivery.networkId,
            activeNetworkIds: [failed.delivery.networkId],
          },
          sharedContext,
          data: { execution: { outcome: 'failed', claimed: failed } },
        });
      }
    }

    default:
      return null;
  }
}
