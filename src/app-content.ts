import type {
  ActorContext,
  EntityKind,
  EventRsvpState,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateEntityInput,
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
type NormalizeOptionalInteger = (value: unknown, field: string) => number | null | undefined;
type NormalizeOptionalString = (value: unknown, field: string) => string | null | undefined;
type NormalizeEntityKinds = (value: unknown) => EntityKind[];
type NormalizeEntityPatch = (payload: Record<string, unknown>) => UpdateEntityInput['patch'];
type RequireAccessibleNetwork = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
type RequireEntityKind = (value: unknown, field: string) => EntityKind;
type RequireEventRsvpState = (value: unknown, field: string) => EventRsvpState;
type RequireNonEmptyString = (value: unknown, field: string) => string;
type RequireObject = (value: unknown, field: string) => Record<string, unknown>;

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

export async function handleContentAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeLimit: NormalizeLimit;
  normalizeOptionalInteger: NormalizeOptionalInteger;
  normalizeOptionalString: NormalizeOptionalString;
  normalizeEntityKinds: NormalizeEntityKinds;
  normalizeEntityPatch: NormalizeEntityPatch;
  requireAccessibleNetwork: RequireAccessibleNetwork;
  requireEntityKind: RequireEntityKind;
  requireEventRsvpState: RequireEventRsvpState;
  requireNonEmptyString: RequireNonEmptyString;
  requireObject: RequireObject;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeEntityKinds,
    normalizeEntityPatch,
    normalizeLimit,
    normalizeOptionalInteger,
    normalizeOptionalString,
    payload,
    repository,
    requireAccessibleNetwork,
    requireEntityKind,
    requireEventRsvpState,
    requireNonEmptyString,
    requireObject,
    sharedContext,
  } = input;

  switch (action) {
    case 'entities.create': {
      const network = requireAccessibleNetwork(actor, payload.networkId);
      const entity = await repository.createEntity({
        authorMemberId: actor.member.id,
        networkId: network.networkId,
        kind: requireEntityKind(payload.kind, 'kind'),
        title: normalizeOptionalString(payload.title, 'title') ?? null,
        summary: normalizeOptionalString(payload.summary, 'summary') ?? null,
        body: normalizeOptionalString(payload.body, 'body') ?? null,
        expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt') ?? null,
        content: payload.content === undefined ? {} : requireObject(payload.content, 'content'),
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { entity },
      });
    }

    case 'entities.update': {
      const entityId = requireNonEmptyString(payload.entityId, 'entityId');
      const entity = await repository.updateEntity({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        entityId,
        patch: normalizeEntityPatch(payload),
      });

      if (!entity) {
        throw createAppError(404, 'not_found', 'Entity not found inside the actor scope');
      }

      if (entity.author.memberId !== actor.member.id) {
        throw createAppError(403, 'forbidden', 'Only the author may update this entity');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: entity.networkId,
          activeNetworkIds: [entity.networkId],
        },
        sharedContext,
        data: { entity },
      });
    }

    case 'entities.archive': {
      const entityId = requireNonEmptyString(payload.entityId, 'entityId');
      if (!repository.archiveEntity) {
        throw createAppError(501, 'not_implemented', 'entities.archive is not implemented');
      }

      const entity = await repository.archiveEntity({
        actorMemberId: actor.member.id,
        accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
        entityId,
      });

      if (!entity) {
        throw createAppError(404, 'not_found', 'Entity not found inside the actor scope');
      }

      if (entity.author.memberId !== actor.member.id) {
        throw createAppError(403, 'forbidden', 'Only the author may archive this entity');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: entity.networkId,
          activeNetworkIds: [entity.networkId],
        },
        sharedContext,
        data: { entity },
      });
    }

    case 'entities.list': {
      const limit = normalizeLimit(payload.limit);
      const kinds = normalizeEntityKinds(payload.kinds);
      const networkScope = resolveScopedNetworks(actor, payload.networkId, requireAccessibleNetwork, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
      const results = await repository.listEntities({
        actorMemberId: actor.member.id,
        networkIds,
        kinds,
        limit,
        query,
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
          query: query ?? null,
          kinds,
          limit,
          networkScope,
          results,
        },
      });
    }

    case 'events.create': {
      const network = requireAccessibleNetwork(actor, payload.networkId);
      const event = await repository.createEvent({
        authorMemberId: actor.member.id,
        networkId: network.networkId,
        title: normalizeOptionalString(payload.title, 'title') ?? null,
        summary: normalizeOptionalString(payload.summary, 'summary') ?? null,
        body: normalizeOptionalString(payload.body, 'body') ?? null,
        startsAt: normalizeOptionalString(payload.startsAt, 'startsAt') ?? null,
        endsAt: normalizeOptionalString(payload.endsAt, 'endsAt') ?? null,
        timezone: normalizeOptionalString(payload.timezone, 'timezone') ?? null,
        recurrenceRule: normalizeOptionalString(payload.recurrenceRule, 'recurrenceRule') ?? null,
        capacity: normalizeOptionalInteger(payload.capacity, 'capacity') ?? null,
        expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt') ?? null,
        content: payload.content === undefined ? {} : requireObject(payload.content, 'content'),
      });

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: network.networkId,
          activeNetworkIds: [network.networkId],
        },
        sharedContext,
        data: { event },
      });
    }

    case 'events.list': {
      const limit = normalizeLimit(payload.limit);
      const networkScope = resolveScopedNetworks(actor, payload.networkId, requireAccessibleNetwork, createAppError);
      const networkIds = networkScope.map((network) => network.networkId);
      const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
      const results = await repository.listEvents({
        actorMemberId: actor.member.id,
        networkIds,
        limit,
        query,
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
          query: query ?? null,
          limit,
          networkScope,
          results,
        },
      });
    }

    case 'events.rsvp': {
      const eventEntityId = requireNonEmptyString(payload.eventEntityId, 'eventEntityId');
      const event = await repository.rsvpEvent({
        actorMemberId: actor.member.id,
        eventEntityId,
        response: requireEventRsvpState(payload.response, 'response'),
        note: normalizeOptionalString(payload.note, 'note'),
        accessibleMemberships: actor.memberships.map((membership) => ({
          membershipId: membership.membershipId,
          networkId: membership.networkId,
        })),
      });

      if (!event) {
        throw createAppError(404, 'not_found', 'Event not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedNetworkId: event.networkId,
          activeNetworkIds: [event.networkId],
        },
        sharedContext,
        data: { event },
      });
    }

    default:
      return null;
  }
}
