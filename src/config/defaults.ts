export const DEFAULT_SERVER_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  requestTimeoutMs: 20_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  maxHeadersCount: 100,
  updatesStreamHeartbeatMs: 15_000,
  updatesStreamLimit: 20,
} as const;

export const QUOTA_WINDOW_SEMANTICS = {
  day: 'rolling_24h',
  week: 'rolling_7d',
  month: 'rolling_30d',
} as const;

export const DEFAULT_CONFIG_V1 = {
  configVersion: 1,
  policy: {
    applications: {
      maxInFlightPerMember: 3,
    },
    invitations: {
      openPerSponsorPerClub: 3,
    },
    accessTokens: {
      maxActivePerMember: 10,
    },
    clubs: {
      maxClubsPerMember: 1,
      freeClubMemberCap: 5,
      removedClubRetentionDays: 30,
    },
    quotas: {
      windowMultipliers: {
        week: 4.5,
        month: 18,
      },
      actions: {
        'content.create': {
          dailyMax: 50,
          roleMultipliers: {
            member: 1,
            clubadmin: 3,
            clubOwner: 3,
          },
          clubOverrides: {} as Record<string, number>,
        },
        'messages.send': {
          dailyMax: 50,
        },
        'embedding.query': {
          dailyMax: 100,
        },
        'clubs.apply': {
          dailyMax: 10,
        },
        'clubs.create': {
          dailyMax: 5,
        },
        'llm.outputTokens': {
          dailyMax: 10_000,
        },
      },
      llm: {
        gateMaxOutputTokens: 64,
        clubSpendBudget: {
          dailyMaxCents: 100,
        },
      },
    },
    pow: {
      registrationDifficulty: 7,
      invitedRegistrationDifficulty: 6,
      challengeTtlMs: 60 * 60 * 1000,
    },
    transport: {
      maxStreamsPerMember: 5,
    },
    features: {} as Record<string, unknown>,
  },
  runtime: {
    workers: {},
  },
} as const;

export type AppConfig = typeof DEFAULT_CONFIG_V1;

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const child of Object.values(record)) {
      deepFreeze(child);
    }
    return Object.freeze(value);
  }

  return value;
}

export function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getDefaultConfig(): AppConfig {
  return cloneConfig(DEFAULT_CONFIG_V1);
}

export function freezeConfig<T>(value: T): T {
  return deepFreeze(value);
}
