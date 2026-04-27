import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;
let superadmin: { token: string };

const CACHE_TTL_MS = 100;

type DirectoryHttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  json: Record<string, unknown> | null;
};

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

async function waitForDirectoryCache(): Promise<void> {
  await delay(CACHE_TTL_MS + 40);
}

function getDirectory(headers: Record<string, string> = {}): Promise<DirectoryHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: h.port,
        path: '/directory',
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const body = res.headers['content-encoding'] === 'gzip'
            ? gunzipSync(rawBody)
            : rawBody;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            json: body.length > 0 ? JSON.parse(body.toString('utf8')) as Record<string, unknown> : null,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedDirectoryClub(
  name: string,
  options: {
    listed?: boolean;
    archived?: boolean;
    memberCount?: number;
    createdAt?: string;
  } = {},
): Promise<{ clubId: string; ownerMemberId: string; name: string }> {
  const listed = options.listed ?? true;
  const memberCount = options.memberCount ?? 1;
  const owner = await h.seedOwner(uniqueSlug('directory'), name, { publicName: `${name} Owner` });
  await h.sql(
    `update clubs
        set created_at = $2::timestamptz,
            archived_at = $3::timestamptz,
            directory_listed = $4
      where id = $1::short_id`,
    [
      owner.club.id,
      options.createdAt ?? new Date().toISOString(),
      options.archived ? new Date().toISOString() : null,
      listed,
    ],
  );

  for (let index = 1; index < memberCount; index += 1) {
    await h.seedCompedMember(owner.club.id, `${name} Member ${index}`);
  }

  return { clubId: owner.club.id, ownerMemberId: owner.id, name };
}

before(async () => {
  h = await TestHarness.start({ directoryCacheTtlMs: CACHE_TTL_MS, llmGate: passthroughGate });
  superadmin = await h.seedSuperadmin('Directory Superadmin');
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('public directory', () => {
  it('serves an anonymous gzipped canonical envelope with ETag support', async () => {
    const listed = await seedDirectoryClub(uniqueName('Directory HTTP Listed'), { listed: true });
    const hidden = await seedDirectoryClub(uniqueName('Directory HTTP Hidden'), { listed: false });
    await waitForDirectoryCache();

    const response = await getDirectory({ 'accept-encoding': 'gzip' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['vary'], 'Accept-Encoding');
    assert.match(String(response.headers.etag), /^W\/"[0-9a-f]{16}"$/);
    assert.equal(response.json?.ok, true);
    const data = response.json?.data as Record<string, unknown>;
    const clubs = data.clubs as Array<Record<string, unknown>>;
    assert.ok(clubs.some((club) => club.clubId === listed.clubId));
    assert.equal(clubs.some((club) => club.clubId === hidden.clubId), false);
    const membersById = data.membersById as Record<string, Record<string, unknown>>;
    assert.equal(membersById[listed.ownerMemberId]?.publicName, `${listed.name} Owner`);

    const notModified = await getDirectory({
      'if-none-match': String(response.headers.etag),
      'accept-encoding': 'gzip',
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.rawBody.length, 0);
  });

  it('lists public clubs anonymously with sorting, filtering, pagination, and projected members', async () => {
    const prefix = uniqueName('Directory Action');
    const createdAt = Date.UTC(2026, 0, 2, 10, 0, 0);
    const alpha = await seedDirectoryClub(`${prefix} Alpha`, {
      listed: true,
      memberCount: 2,
      createdAt: new Date(createdAt).toISOString(),
    });
    const beta = await seedDirectoryClub(`${prefix} Beta`, {
      listed: true,
      memberCount: 4,
      createdAt: new Date(createdAt + 60_000).toISOString(),
    });
    const gamma = await seedDirectoryClub(`${prefix} Gamma`, {
      listed: true,
      memberCount: 3,
      createdAt: new Date(createdAt + 120_000).toISOString(),
    });
    await waitForDirectoryCache();

    const newest = await h.apiOk(null, 'directory.list', {
      nameContains: prefix,
      limit: 2,
      sort: 'newest',
    });
    const newestData = newest.data as Record<string, unknown>;
    const newestResults = newestData.results as Array<Record<string, unknown>>;
    assert.deepEqual(newestResults.map((club) => club.clubId), [gamma.clubId, beta.clubId]);
    assert.equal(newestData.hasMore, true);
    assert.ok(newestData.nextCursor);
    const newestMembers = newestData.membersById as Record<string, unknown>;
    assert.deepEqual(Object.keys(newestMembers).sort(), [beta.ownerMemberId, gamma.ownerMemberId].sort());

    const next = await h.apiOk(null, 'directory.list', {
      nameContains: prefix,
      limit: 2,
      sort: 'newest',
      cursor: newestData.nextCursor,
    });
    const nextResults = (next.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.deepEqual(nextResults.map((club) => club.clubId), [alpha.clubId]);

    const alphabetical = await h.apiOk(null, 'directory.list', {
      nameContains: prefix,
      sort: 'alphabetical',
    });
    assert.deepEqual(
      ((alphabetical.data as Record<string, unknown>).results as Array<Record<string, unknown>>).map((club) => club.name),
      [`${prefix} Alpha`, `${prefix} Beta`, `${prefix} Gamma`],
    );

    const popular = await h.apiOk(null, 'directory.list', {
      nameContains: prefix,
      sort: 'most_popular',
    });
    assert.deepEqual(
      ((popular.data as Record<string, unknown>).results as Array<Record<string, unknown>>).map((club) => club.clubId),
      [beta.clubId, gamma.clubId, alpha.clubId],
    );
  });

  it('rejects directory cursors after the cache identity changes', async () => {
    const prefix = uniqueName('Directory Cursor');
    await seedDirectoryClub(`${prefix} One`, { listed: true });
    await seedDirectoryClub(`${prefix} Two`, { listed: true });
    await waitForDirectoryCache();

    const page = await h.apiOk(null, 'directory.list', {
      nameContains: prefix,
      limit: 1,
    });
    const cursor = (page.data as Record<string, unknown>).nextCursor;
    assert.ok(cursor);

    await seedDirectoryClub(`${prefix} Three`, { listed: true });
    await waitForDirectoryCache();
    const err = await h.apiErr(null, 'directory.list', {
      nameContains: prefix,
      limit: 1,
      cursor,
    }, 'invalid_input');
    assert.match(err.message, /cursor expired/i);
  });

  it('lets clubadmins list active clubs and only superadmins list archived clubs', async () => {
    const activeOwner = await h.seedOwner(uniqueSlug('dir-active'), uniqueName('Directory Active'));
    await h.apiOk(activeOwner.token, 'clubadmin.clubs.setDirectoryListed', {
      clubId: activeOwner.club.id,
      listed: true,
    });
    await waitForDirectoryCache();
    const activeDirectory = await h.apiOk(null, 'directory.list', {
      nameContains: activeOwner.club.name,
    });
    const activeResults = (activeDirectory.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(activeResults.some((club) => club.clubId === activeOwner.club.id), true);

    const otherOwner = await h.seedOwner(uniqueSlug('dir-other'), uniqueName('Directory Other'));
    const scopeErr = await h.apiErr(otherOwner.token, 'clubadmin.clubs.setDirectoryListed', {
      clubId: activeOwner.club.id,
      listed: false,
    }, 'forbidden_scope');
    assert.match(scopeErr.message, /access scope/i);

    const regular = await h.seedCompedMember(activeOwner.club.id, 'Directory Regular Member');
    await h.apiErr(regular.token, 'clubadmin.clubs.setDirectoryListed', {
      clubId: activeOwner.club.id,
      listed: false,
    }, 'forbidden_role');

    const archivedOwner = await h.seedOwner(uniqueSlug('dir-archived'), uniqueName('Directory Archived'));
    await h.apiOk(superadmin.token, 'superadmin.clubs.archive', {
      clubId: archivedOwner.club.id,
      clientKey: uniqueSlug('archive'),
    });
    const archivedClubadminErr = await h.apiErr(archivedOwner.token, 'clubadmin.clubs.setDirectoryListed', {
      clubId: archivedOwner.club.id,
      listed: true,
    }, 'forbidden_role');
    assert.match(archivedClubadminErr.message, /club admin role/i);

    const toggled = await h.apiOk(superadmin.token, 'superadmin.clubs.setDirectoryListed', {
      clubId: archivedOwner.club.id,
      listed: true,
    });
    assert.equal(((toggled.data as Record<string, unknown>).club as Record<string, unknown>).directoryListed, true);
    await waitForDirectoryCache();
    const archivedDirectory = await h.apiOk(null, 'directory.list', {
      nameContains: archivedOwner.club.name,
    });
    const archivedResults = (archivedDirectory.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const archived = archivedResults.find((club) => club.clubId === archivedOwner.club.id);
    assert.ok(archived);
    assert.notEqual(archived.archivedAt, null);
  });

  it('changes the directory ETag after the cached payload changes', async () => {
    await waitForDirectoryCache();
    const before = await getDirectory();
    const listed = await seedDirectoryClub(uniqueName('Directory ETag'), { listed: true });
    assert.ok(listed.clubId);
    await waitForDirectoryCache();
    const after = await getDirectory();
    assert.notEqual(after.headers.etag, before.headers.etag);
  });
});
