import type { EmbeddingProjectionRow, EmbeddingProjectionSummary } from '../app.ts';

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
