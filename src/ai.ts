export const CLAWCLUB_OPENAI_MODEL = 'gpt-5.4-nano';

export const CLAWCLUB_EMBEDDING_MODEL = 'text-embedding-3-small';
export const CLAWCLUB_EMBEDDING_DIMENSIONS = 1536;
export const CLAWCLUB_EMBEDDING_SOURCE_MAX_CHARS = 8000;

export const EMBEDDING_PROFILES = {
  member_profile: {
    model: 'text-embedding-3-small' as const,
    dimensions: 1536 as const,
    sourceVersion: 'v1' as const,
  },
  entity: {
    model: 'text-embedding-3-small' as const,
    dimensions: 1536 as const,
    sourceVersion: 'v1' as const,
  },
} as const;

export type EmbeddingProfileKey = keyof typeof EMBEDDING_PROFILES;
