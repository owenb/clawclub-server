import type { Repository, RequestScope, SharedResponseContext } from './app.ts';
import type {
  BuildSuccessResponse,
  CreateAppError,
  NormalizeEntityKinds,
  NormalizeEntityPatch,
  NormalizeLimit,
  NormalizeOptionalInteger,
  NormalizeOptionalString,
  RequireAccessibleClub,
  RequireEntityKind,
  RequireEventRsvpState,
  RequireNonEmptyString,
  RequireObject,
} from './app-helpers.ts';
import { resolveScopedClubs, resolveRequestedClubId } from './app-helpers.ts';
import type { ActorContext } from './app-contract.ts';

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
  requireAccessibleClub: RequireAccessibleClub;
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
    requireAccessibleClub,
    requireEntityKind,
    requireEventRsvpState,
    requireNonEmptyString,
    requireObject,
    sharedContext,
  } = input;

  switch (action) {
    case 'entities.create': {
      const club = requireAccessibleClub(actor, payload.clubId);
      const entity = await repository.createEntity({
        authorMemberId: actor.member.id,
        clubId: club.clubId,
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
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { entity },
      });
    }

    case 'entities.update': {
      const entityId = requireNonEmptyString(payload.entityId, 'entityId');
      const entity = await repository.updateEntity({
        actorMemberId: actor.member.id,
        accessibleClubIds: actor.memberships.map((club) => club.clubId),
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
          requestedClubId: entity.clubId,
          activeClubIds: [entity.clubId],
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
        accessibleClubIds: actor.memberships.map((club) => club.clubId),
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
          requestedClubId: entity.clubId,
          activeClubIds: [entity.clubId],
        },
        sharedContext,
        data: { entity },
      });
    }

    case 'entities.list': {
      const limit = normalizeLimit(payload.limit);
      const kinds = normalizeEntityKinds(payload.kinds);
      const clubScope = resolveScopedClubs(actor, payload.clubId, requireAccessibleClub, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
      const results = await repository.listEntities({
        actorMemberId: actor.member.id,
        clubIds,
        kinds,
        limit,
        query,
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
          query: query ?? null,
          kinds,
          limit,
          clubScope,
          results,
        },
      });
    }

    case 'events.create': {
      const club = requireAccessibleClub(actor, payload.clubId);
      const event = await repository.createEvent({
        authorMemberId: actor.member.id,
        clubId: club.clubId,
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
          requestedClubId: club.clubId,
          activeClubIds: [club.clubId],
        },
        sharedContext,
        data: { event },
      });
    }

    case 'events.list': {
      const limit = normalizeLimit(payload.limit);
      const clubScope = resolveScopedClubs(actor, payload.clubId, requireAccessibleClub, createAppError);
      const clubIds = clubScope.map((club) => club.clubId);
      const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
      const results = await repository.listEvents({
        actorMemberId: actor.member.id,
        clubIds,
        limit,
        query,
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
          query: query ?? null,
          limit,
          clubScope,
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
          clubId: membership.clubId,
        })),
      });

      if (!event) {
        throw createAppError(404, 'not_found', 'Event not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope: {
          requestedClubId: event.clubId,
          activeClubIds: [event.clubId],
        },
        sharedContext,
        data: { event },
      });
    }

    default:
      return null;
  }
}
