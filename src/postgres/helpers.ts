import type { Pool, PoolClient } from 'pg';
import type { EmbeddingProjectionRow, EmbeddingProjectionSummary } from '../contract.ts';

export type DbClient = Pool | PoolClient;

export type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  clubIds: string[],
  options?: Record<string, never>,
) => Promise<void>;

export type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  clubIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export function mapEmbeddingProjectionRow(row: EmbeddingProjectionRow): EmbeddingProjectionSummary | null {
  if (!row.embedding_id || !row.embedding_model || row.embedding_dimensions === null || !row.embedding_source_text || !row.embedding_created_at) {
    return null;
  }

  return {
    embeddingId: row.embedding_id,
    model: row.embedding_model,
    dimensions: Number(row.embedding_dimensions),
    sourceText: row.embedding_source_text,
    metadata: row.embedding_metadata ?? {},
    createdAt: row.embedding_created_at,
  };
}
