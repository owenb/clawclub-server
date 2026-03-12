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
    authSubject: string;
    handle: string | null;
    publicName: string;
  };
  networks: MembershipSummary[];
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

export type Repository = {
  getActorContextByAuthSubject(authSubject: string): Promise<ActorContext | null>;
  searchMembers(input: {
    networkIds: string[];
    query: string;
    limit: number;
  }): Promise<MemberSearchResult[]>;
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

export function buildApp({ repository }: { repository: Repository }) {
  return {
    async handleAction(input: {
      authSubject: string | null;
      action: unknown;
      payload?: unknown;
    }) {
      const authSubject = requireNonEmptyString(input.authSubject, 'Authorization bearer token');
      const action = requireNonEmptyString(input.action, 'action');
      const payload = (input.payload ?? {}) as Record<string, unknown>;

      const actor = await repository.getActorContextByAuthSubject(authSubject);

      if (!actor) {
        throw new AppError(401, 'unauthorized', 'Unknown bearer token');
      }

      switch (action) {
        case 'session.describe':
          return {
            action,
            data: {
              member: actor.member,
              accessibleNetworks: actor.networks,
            },
          };

        case 'members.search': {
          const query = requireNonEmptyString(payload.query, 'query');
          const limit = normalizeLimit(payload.limit);
          const requestedNetworkId = payload.networkId;

          let networkIds = actor.networks.map((network) => network.networkId);

          if (requestedNetworkId !== undefined) {
            const networkId = requireNonEmptyString(requestedNetworkId, 'networkId');
            const allowed = actor.networks.find((network) => network.networkId === networkId);

            if (!allowed) {
              throw new AppError(403, 'forbidden', 'Requested network is outside the actor scope');
            }

            networkIds = [networkId];
          }

          if (networkIds.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const results = await repository.searchMembers({
            networkIds,
            query,
            limit,
          });

          return {
            action,
            data: {
              query,
              limit,
              networkScope: actor.networks.filter((network) => networkIds.includes(network.networkId)),
              results,
            },
          };
        }

        default:
          throw new AppError(400, 'unknown_action', `Unsupported action: ${action}`);
      }
    },
  };
}
