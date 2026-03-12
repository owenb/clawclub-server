export type MembershipSummary = {
  membershipId: string;
  networkId: string;
  slug: string;
  name: string;
  summary: string | null;
  manifestoMarkdown: string | null;
  role: 'owner' | 'admin' | 'member';
  status: 'active';
  sponsorMemberId: string | null;
  joinedAt: string;
};

export type ActorContext = {
  member: {
    id: string;
    handle: string | null;
    publicName: string;
  };
  memberships: MembershipSummary[];
};

export type RequestScope = {
  requestedNetworkId: string | null;
  activeNetworkIds: string[];
};

export type AuthResult = {
  actor: ActorContext;
  requestScope: RequestScope;
};

export type MemberSearchResult = {
  memberId: string;
  publicName: string;
  displayName: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  sharedNetworks: Array<{ id: string; slug: string; name: string }>;
};

export type MemberProfile = {
  memberId: string;
  publicName: string;
  handle: string | null;
  displayName: string;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: unknown[];
  profile: Record<string, unknown>;
  version: {
    id: string | null;
    versionNo: number | null;
    createdAt: string | null;
    createdByMemberId: string | null;
  };
  sharedNetworks: Array<{ id: string; slug: string; name: string }>;
};

export type UpdateOwnProfileInput = {
  handle?: string | null;
  displayName?: string;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: unknown;
  profile?: unknown;
};

export type EntityKind = 'post' | 'opportunity' | 'service' | 'ask';

export type EntitySummary = {
  entityId: string;
  entityVersionId: string;
  networkId: string;
  kind: EntityKind;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  version: {
    versionNo: number;
    state: 'published';
    title: string | null;
    summary: string | null;
    body: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    createdAt: string;
    content: Record<string, unknown>;
  };
  createdAt: string;
};

export type CreateEntityInput = {
  authorMemberId: string;
  networkId: string;
  kind: EntityKind;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
};

export type ListEntitiesInput = {
  networkIds: string[];
  kinds: EntityKind[];
  limit: number;
};

export type Repository = {
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  searchMembers(input: {
    networkIds: string[];
    query: string;
    limit: number;
  }): Promise<MemberSearchResult[]>;
  getMemberProfile(input: { actorMemberId: string; targetMemberId: string }): Promise<MemberProfile | null>;
  updateOwnProfile(input: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile>;
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  listEntities(input: ListEntitiesInput): Promise<EntitySummary[]>;
};

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, 'invalid_input', `${field} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) {
    return 8;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', 'limit must be an integer');
  }

  return Math.min(Math.max(Number(value), 1), 20);
}

function normalizeOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_input', `${field} must be a string or null`);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeHandle(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalString(value, 'handle');

  if (normalized === undefined || normalized === null) {
    return normalized;
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new AppError(400, 'invalid_input', 'handle must use lowercase letters, numbers, and single hyphens');
  }

  return normalized;
}

function normalizeOptionalStringArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an array`);
  }

  return value;
}

function normalizeOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function normalizeProfilePatch(payload: Record<string, unknown>): UpdateOwnProfileInput {
  return {
    handle: normalizeHandle(payload.handle),
    displayName: payload.displayName === undefined ? undefined : requireNonEmptyString(payload.displayName, 'displayName'),
    tagline: normalizeOptionalString(payload.tagline, 'tagline'),
    summary: normalizeOptionalString(payload.summary, 'summary'),
    whatIDo: normalizeOptionalString(payload.whatIDo, 'whatIDo'),
    knownFor: normalizeOptionalString(payload.knownFor, 'knownFor'),
    servicesSummary: normalizeOptionalString(payload.servicesSummary, 'servicesSummary'),
    websiteUrl: normalizeOptionalString(payload.websiteUrl, 'websiteUrl'),
    links: normalizeOptionalStringArray(payload.links, 'links'),
    profile: normalizeOptionalRecord(payload.profile, 'profile'),
  };
}

function requireAccessibleNetwork(actor: ActorContext, networkIdValue: unknown): MembershipSummary {
  const networkId = requireNonEmptyString(networkIdValue, 'networkId');
  const allowed = actor.memberships.find((network) => network.networkId === networkId);

  if (!allowed) {
    throw new AppError(403, 'forbidden', 'Requested network is outside the actor scope');
  }

  return allowed;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function isEntityKind(value: unknown): value is EntityKind {
  return value === 'post' || value === 'opportunity' || value === 'service' || value === 'ask';
}

function requireEntityKind(value: unknown, field: string): EntityKind {
  if (!isEntityKind(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: post, opportunity, service, ask`);
  }

  return value;
}

function normalizeEntityKinds(value: unknown): EntityKind[] {
  if (value === undefined) {
    return ['post', 'opportunity', 'service', 'ask'];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, 'invalid_input', 'kinds must be a non-empty array when provided');
  }

  const kinds = value.map((item) => requireEntityKind(item, 'kinds[]'));
  return [...new Set(kinds)];
}

function buildSuccessResponse(input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  data: unknown;
}) {
  return {
    action: input.action,
    actor: {
      member: input.actor.member,
      activeMemberships: input.actor.memberships,
      requestScope: input.requestScope,
    },
    data: input.data,
  };
}

export function buildApp({ repository }: { repository: Repository }) {
  return {
    async handleAction(input: {
      bearerToken: string | null;
      action: unknown;
      payload?: unknown;
    }) {
      const bearerToken = requireNonEmptyString(input.bearerToken, 'Authorization bearer token');
      const action = requireNonEmptyString(input.action, 'action');
      const payload = (input.payload ?? {}) as Record<string, unknown>;

      const auth = await repository.authenticateBearerToken(bearerToken);

      if (!auth) {
        throw new AppError(401, 'unauthorized', 'Unknown bearer token');
      }

      const actor = auth.actor;

      switch (action) {
        case 'session.describe':
          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            data: {
              member: actor.member,
              accessibleNetworks: actor.memberships,
            },
          });

        case 'members.search': {
          const query = requireNonEmptyString(payload.query, 'query');
          const limit = normalizeLimit(payload.limit);
          const requestedNetworkId = payload.networkId;

          let networkIds = actor.memberships.map((network) => network.networkId);

          if (requestedNetworkId !== undefined) {
            networkIds = [requireAccessibleNetwork(actor, requestedNetworkId).networkId];
          }

          if (networkIds.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const requestScope: RequestScope = {
            requestedNetworkId:
              typeof requestedNetworkId === 'string' && requestedNetworkId.trim().length > 0
                ? requestedNetworkId.trim()
                : null,
            activeNetworkIds: networkIds,
          };

          const results = await repository.searchMembers({
            networkIds,
            query,
            limit,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope,
            data: {
              query,
              limit,
              networkScope: actor.memberships.filter((network) => networkIds.includes(network.networkId)),
              results,
            },
          });
        }

        case 'profile.get': {
          const targetMemberId = payload.memberId === undefined ? actor.member.id : requireNonEmptyString(payload.memberId, 'memberId');
          const profile = await repository.getMemberProfile({
            actorMemberId: actor.member.id,
            targetMemberId,
          });

          if (!profile) {
            throw new AppError(404, 'not_found', 'Member profile not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            data: profile,
          });
        }

        case 'profile.update': {
          const patch = normalizeProfilePatch(payload);
          const updatedProfile = await repository.updateOwnProfile({ actor, patch });

          return buildSuccessResponse({
            action,
            actor: {
              member: {
                id: updatedProfile.memberId,
                handle: updatedProfile.handle,
                publicName: updatedProfile.publicName,
              },
              memberships: actor.memberships,
            },
            requestScope: auth.requestScope,
            data: updatedProfile,
          });
        }

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
            data: { entity },
          });
        }

        case 'entities.list': {
          const limit = normalizeLimit(payload.limit);
          const kinds = normalizeEntityKinds(payload.kinds);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listEntities({
            networkIds,
            kinds,
            limit,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            data: {
              kinds,
              limit,
              networkScope,
              results,
            },
          });
        }

        default:
          throw new AppError(400, 'unknown_action', `Unsupported action: ${action}`);
      }
    },
  };
}
