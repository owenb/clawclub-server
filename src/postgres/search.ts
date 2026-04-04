import { AppError } from '../contract.ts';

const MAX_QUERY_LENGTH = 120;
const LIKE_META_CHARACTERS = /[%_\\]/g;

export function normalizeSearchQuery(query: string | null | undefined): string | null {
  if (query === null || query === undefined) {
    return null;
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new AppError(400, 'invalid_input', `query must be ${MAX_QUERY_LENGTH} characters or fewer`);
  }

  return trimmed;
}

export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_META_CHARACTERS, '\\$&');
}

export function buildContainsLikePattern(query: string | null): string | null {
  return query === null ? null : `%${escapeLikePattern(query)}%`;
}

export function buildPrefixLikePattern(query: string | null): string | null {
  return query === null ? null : `${escapeLikePattern(query)}%`;
}
