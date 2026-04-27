import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDirectoryCache,
  DIRECTORY_SCHEMA_HASH,
  listDirectoryPage,
  type DirectoryCacheEntry,
} from '../../src/directory.ts';
import type { DirectorySnapshot } from '../../src/repository.ts';

function snapshot(names: string[]): DirectorySnapshot {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  return {
    clubs: names.map((name, index) => ({
      clubId: `club-${index + 1}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      ownerMemberId: `member-${index + 1}`,
      memberCount: index + 1,
      createdAt: new Date(base + index * 60_000).toISOString(),
      archivedAt: null,
    })),
    members: names.map((name, index) => ({
      memberId: `member-${index + 1}`,
      publicName: `${name} Owner`,
    })),
  };
}

async function entryFor(names: string[]): Promise<DirectoryCacheEntry> {
  const cache = createDirectoryCache({
    loadDirectorySnapshot: async () => snapshot(names),
  }, { ttlMs: 60_000 });
  return cache.get();
}

describe('directory cache', () => {
  it('builds a normalized payload and full canonical envelope bytes', async () => {
    const entry = await entryFor(['Alpha Club', 'Beta Club']);
    assert.equal(entry.payload.schemaVersion, 1);
    assert.equal(entry.payload.directorySchemaHash, DIRECTORY_SCHEMA_HASH);
    assert.equal(entry.payload.clubs.length, 2);
    assert.deepEqual(Object.keys(entry.payload.membersById).sort(), ['member-1', 'member-2']);

    const envelope = JSON.parse(entry.envelopePlain.toString('utf8')) as Record<string, unknown>;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, entry.payload);
    assert.match(entry.etag, /^W\/"[0-9a-f]{16}"$/);
    assert.ok(entry.envelopeGzipped.length < entry.envelopePlain.length + 64);
  });

  it('uses the TTL and rebuilds after expiry', async () => {
    let calls = 0;
    const cache = createDirectoryCache({
      loadDirectorySnapshot: async () => {
        calls += 1;
        return snapshot([`Club ${calls}`]);
      },
    }, { ttlMs: 10 });

    const first = await cache.get();
    const second = await cache.get();
    assert.equal(second, first);
    assert.equal(calls, 1);

    await delay(20);
    const third = await cache.get();
    assert.notEqual(third, first);
    assert.equal(calls, 2);
    assert.notEqual(third.payload.generatedAt, first.payload.generatedAt);
  });

  it('deduplicates simultaneous cold-cache loads', async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = createDirectoryCache({
      loadDirectorySnapshot: async () => {
        calls += 1;
        await pending;
        return snapshot(['Stampede Club']);
      },
    }, { ttlMs: 60_000 });

    const first = cache.get();
    const second = cache.get();
    release();

    const [firstEntry, secondEntry] = await Promise.all([first, second]);
    assert.equal(firstEntry, secondEntry);
    assert.equal(calls, 1);
  });

  it('keeps the directory schema hash independent from data', async () => {
    const first = await entryFor(['One Club']);
    const second = await entryFor(['Different Club', 'Another Club']);
    assert.equal(first.payload.directorySchemaHash, second.payload.directorySchemaHash);
  });
});

describe('directory.list paging', () => {
  it('filters names case-insensitively and sorts deterministically', async () => {
    const entry = await entryFor(['Zeta Group', 'alpha guild', 'Alpha Network']);

    const alphabetical = listDirectoryPage(entry, {
      cursor: null,
      limit: 10,
      sort: 'alphabetical',
      nameContains: 'ALPHA',
    });
    assert.deepEqual(alphabetical.results.map((club) => club.name), ['alpha guild', 'Alpha Network']);

    const popular = listDirectoryPage(entry, {
      cursor: null,
      limit: 10,
      sort: 'most_popular',
      nameContains: null,
    });
    assert.deepEqual(popular.results.map((club) => club.memberCount), [3, 2, 1]);

    const newest = listDirectoryPage(entry, {
      cursor: null,
      limit: 10,
      sort: 'newest',
      nameContains: null,
    });
    assert.deepEqual(newest.results.map((club) => club.name), ['Alpha Network', 'alpha guild', 'Zeta Group']);
  });

  it('paginates with opaque cache-bound cursors and projected members', async () => {
    const entry = await entryFor(['A Club', 'B Club', 'C Club']);

    const first = listDirectoryPage(entry, {
      cursor: null,
      limit: 2,
      sort: 'newest',
      nameContains: null,
    });
    assert.equal(first.hasMore, true);
    assert.equal(first.results.length, 2);
    assert.ok(first.nextCursor);
    assert.deepEqual(Object.keys(first.membersById).sort(), ['member-2', 'member-3']);

    const second = listDirectoryPage(entry, {
      cursor: first.nextCursor,
      limit: 2,
      sort: 'newest',
      nameContains: null,
    });
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(second.results.map((club) => club.name), ['A Club']);
    assert.deepEqual(Object.keys(second.membersById), ['member-1']);
  });

  it('rejects stale or mismatched cursors and does not mutate the cached order', async () => {
    const entry = await entryFor(['Charlie Club', 'Bravo Club', 'Alpha Club']);
    const originalOrder = entry.payload.clubs.map((club) => club.name);

    const first = listDirectoryPage(entry, {
      cursor: null,
      limit: 1,
      sort: 'alphabetical',
      nameContains: null,
    });
    assert.deepEqual(entry.payload.clubs.map((club) => club.name), originalOrder);

    assert.throws(
      () => listDirectoryPage(entry, {
        cursor: first.nextCursor,
        limit: 1,
        sort: 'newest',
        nameContains: null,
      }),
      /sort or filter/,
    );

    const rotatedEntry = {
      ...entry,
      etag: 'W/"differentetag000"',
    };
    assert.throws(
      () => listDirectoryPage(rotatedEntry, {
        cursor: first.nextCursor,
        limit: 1,
        sort: 'alphabetical',
        nameContains: null,
      }),
      /cursor expired/,
    );
  });
});
