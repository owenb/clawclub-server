import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AppError } from './errors.ts';
import type { Repository } from './repository.ts';
import type {
  DirectoryClubSummary,
  DirectoryPayload,
  IncludedMember,
} from './schemas/responses.ts';
import { decodeCursor, encodeCursor } from './schemas/fields.ts';

export const DIRECTORY_SCHEMA_VERSION = 1;

const DIRECTORY_PAYLOAD_FIELDS = [
  'schemaVersion',
  'directorySchemaHash',
  'generatedAt',
  'clubs',
  'membersById',
].sort();
const DIRECTORY_CLUB_FIELDS = [
  'clubId',
  'slug',
  'name',
  'ownerMemberId',
  'memberCount',
  'createdAt',
  'archivedAt',
].sort();
const DIRECTORY_MEMBER_FIELDS = ['memberId', 'publicName'].sort();

export const DIRECTORY_SCHEMA_HASH = createHash('sha256')
  .update(JSON.stringify({
    schemaVersion: DIRECTORY_SCHEMA_VERSION,
    payloadFields: DIRECTORY_PAYLOAD_FIELDS,
    clubFields: DIRECTORY_CLUB_FIELDS,
    memberFields: DIRECTORY_MEMBER_FIELDS,
  }))
  .digest('hex');

export type DirectoryCacheEntry = {
  payload: DirectoryPayload;
  envelopePlain: Buffer;
  envelopeGzipped: Buffer;
  etag: string;
  expiresAt: number;
};

export type DirectoryCache = {
  get(): Promise<DirectoryCacheEntry>;
  invalidate(): void;
};

export type DirectorySort = 'newest' | 'alphabetical' | 'most_popular';

export type DirectoryListPageInput = {
  cursor: string | null;
  limit: number;
  sort: DirectorySort;
  nameContains?: string | null;
};

export type DirectoryListPage = {
  schemaVersion: 1;
  directorySchemaHash: string;
  generatedAt: string;
  membersById: Record<string, IncludedMember>;
  results: DirectoryClubSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

export function createDirectoryCache(
  repository: Pick<Repository, 'loadDirectorySnapshot'>,
  opts: { ttlMs?: number } = {},
): DirectoryCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  let current: DirectoryCacheEntry | null = null;
  let refresh: Promise<DirectoryCacheEntry> | null = null;

  async function rebuild(): Promise<DirectoryCacheEntry> {
    const snapshot = await repository.loadDirectorySnapshot();
    const membersById = Object.fromEntries(
      snapshot.members.map((member) => [member.memberId, member]),
    );
    const payload: DirectoryPayload = {
      schemaVersion: DIRECTORY_SCHEMA_VERSION,
      directorySchemaHash: DIRECTORY_SCHEMA_HASH,
      generatedAt: new Date().toISOString(),
      clubs: snapshot.clubs,
      membersById,
    };
    const envelopePlain = Buffer.from(JSON.stringify({ ok: true, data: payload }), 'utf8');
    const envelopeGzipped = gzipSync(envelopePlain);
    const etag = `W/"${createHash('sha256').update(envelopePlain).digest('hex').slice(0, 16)}"`;
    return {
      payload,
      envelopePlain,
      envelopeGzipped,
      etag,
      expiresAt: Date.now() + ttlMs,
    };
  }

  return {
    async get(): Promise<DirectoryCacheEntry> {
      const now = Date.now();
      if (current && current.expiresAt > now) {
        return current;
      }
      if (!refresh) {
        refresh = rebuild().finally(() => {
          refresh = null;
        });
      }
      current = await refresh;
      return current;
    },
    invalidate(): void {
      current = null;
      refresh = null;
    },
  };
}

export function normalizeDirectoryFilter(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function listDirectoryPage(
  entry: DirectoryCacheEntry,
  input: DirectoryListPageInput,
): DirectoryListPage {
  const sort = input.sort;
  const normalizedFilter = normalizeDirectoryFilter(input.nameContains);
  let offset = 0;
  if (input.cursor) {
    const [cursorEtag, cursorSort, cursorFilter, cursorOffset] = decodeCursor(input.cursor, 4);
    if (cursorEtag !== entry.etag) {
      throw new AppError('invalid_input', 'Directory cursor expired; restart listing.');
    }
    if (cursorSort !== sort || cursorFilter !== normalizedFilter) {
      throw new AppError('invalid_input', 'Directory cursor does not match the requested sort or filter; restart listing.');
    }
    const parsedOffset = Number.parseInt(cursorOffset, 10);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || String(parsedOffset) !== cursorOffset) {
      throw new AppError('invalid_input', 'Invalid directory cursor.');
    }
    offset = parsedOffset;
  }

  const clubs = [...entry.payload.clubs];
  sortDirectoryClubs(clubs, sort);
  const filtered = normalizedFilter
    ? clubs.filter((club) => club.name.toLowerCase().includes(normalizedFilter))
    : clubs;
  const results = filtered.slice(offset, offset + input.limit);
  const hasMore = offset + results.length < filtered.length;
  const nextCursor = hasMore
    ? encodeCursor([entry.etag, sort, normalizedFilter, String(offset + input.limit)])
    : null;
  const memberIds = new Set(results.map((club) => club.ownerMemberId));
  const membersById = Object.fromEntries(
    Object.entries(entry.payload.membersById).filter(([memberId]) => memberIds.has(memberId)),
  );

  return {
    schemaVersion: DIRECTORY_SCHEMA_VERSION,
    directorySchemaHash: entry.payload.directorySchemaHash,
    generatedAt: entry.payload.generatedAt,
    membersById,
    results,
    hasMore,
    nextCursor,
  };
}

function sortDirectoryClubs(clubs: DirectoryClubSummary[], sort: DirectorySort): void {
  if (sort === 'alphabetical') {
    clubs.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      || a.clubId.localeCompare(b.clubId));
    return;
  }
  if (sort === 'most_popular') {
    clubs.sort((a, b) =>
      b.memberCount - a.memberCount
      || b.createdAt.localeCompare(a.createdAt)
      || b.clubId.localeCompare(a.clubId));
    return;
  }
  clubs.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
    || b.clubId.localeCompare(a.clubId));
}
