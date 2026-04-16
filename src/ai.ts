import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';

export const CLAWCLUB_OPENAI_MODEL = 'gpt-5.4-nano';

export const CLAWCLUB_EMBEDDING_MODEL = 'text-embedding-3-small';
export const CLAWCLUB_EMBEDDING_DIMENSIONS = 1536;
export const CLAWCLUB_EMBEDDING_SOURCE_MAX_CHARS = 8000;

export const EMBEDDING_PROFILES = {
  member_profile: {
    model: 'text-embedding-3-small' as const,
    dimensions: 1536 as const,
    // v2: handle field removed from profile embedding source (011_delete_handles)
    sourceVersion: 'v2' as const,
  },
  entity: {
    model: 'text-embedding-3-small' as const,
    dimensions: 1536 as const,
    sourceVersion: 'v1' as const,
  },
} as const;

export type EmbeddingProfileKey = keyof typeof EMBEDDING_PROFILES;

export function isEmbeddingStubEnabled(): boolean {
  return process.env.CLAWCLUB_EMBEDDING_STUB === '1';
}

function buildStubEmbedding(value: string, dimensions: number): number[] {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    seed ^= value.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  const vector = new Array<number>(dimensions);
  let state = seed >>> 0;
  for (let i = 0; i < dimensions; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vector[i] = (state / 0xffffffff) * 2 - 1;
  }
  return vector;
}

/**
 * Test seam: non-LLM integration tests set CLAWCLUB_EMBEDDING_STUB=1 so
 * member/content semantic search can execute without network access or billing.
 */
export async function embedQueryText(input: {
  value: string;
  profile: EmbeddingProfileKey;
}): Promise<{ embedding: number[]; usageTokens: number }> {
  const profile = EMBEDDING_PROFILES[input.profile];
  if (isEmbeddingStubEnabled()) {
    return {
      embedding: buildStubEmbedding(`${input.profile}:${input.value}`, profile.dimensions),
      usageTokens: 0,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Embedding service is not configured');
  }

  const provider = createOpenAI({ apiKey });
  const model = provider.embedding(profile.model);
  const result = await embed({
    model,
    value: input.value,
    providerOptions: { openai: { dimensions: profile.dimensions } },
  });
  return {
    embedding: result.embedding,
    usageTokens: result.usage?.tokens ?? 0,
  };
}

/**
 * Batch embedding helper for worker/indexing paths. Test stub mode returns the
 * same deterministic per-string vectors as embedQueryText without network use.
 */
export async function embedManyDocuments(input: {
  values: string[];
  profile: EmbeddingProfileKey;
}): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const profile = EMBEDDING_PROFILES[input.profile];
  if (isEmbeddingStubEnabled()) {
    return {
      embeddings: input.values.map((value) => buildStubEmbedding(`${input.profile}:${value}`, profile.dimensions)),
      usageTokens: 0,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Embedding service is not configured');
  }

  const provider = createOpenAI({ apiKey });
  const model = provider.embedding(profile.model);
  const result = await embedMany({
    model,
    values: input.values,
    providerOptions: { openai: { dimensions: profile.dimensions } },
  });
  return {
    embeddings: result.embeddings,
    usageTokens: result.usage?.tokens ?? 0,
  };
}
