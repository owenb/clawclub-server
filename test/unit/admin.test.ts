import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.ts';
import { assertActionRepository, type Repository } from '../../src/repository.ts';
import { makeAdminAuthResult, makeAuthResult, makeRepository, makeUpdatesNotifier } from './fixtures.ts';

const passthroughGate = async () => ({
  status: 'passed' as const,
  usage: { promptTokens: 1, completionTokens: 1 },
});

function makeNonAdminAuthResult() {
  return makeAuthResult({ globalRoles: [] });
}

async function postAction(port: number, token: string, action: string, input: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, input }),
  });
  const body = await response.json();
  return { response, body };
}

test('superadmin.platform.getOverview returns platform stats for superadmin', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetOverview() {
      return {
        totalMembers: 42,
        activeMembers: 30,
        totalClubs: 3,
        totalEntities: 150,
        totalMessages: 500,
        pendingApplications: 10,
        recentMembers: [{
          memberId: 'member-1',
          publicName: 'Alice',
          createdAt: '2026-03-14T10:00:00Z',
        }],
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.platform.getOverview');
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.overview.totalMembers, 42);
    assert.equal(body.data.overview.totalClubs, 3);
    assert.equal(body.data.overview.recentMembers.length, 1);
  } finally {
    await shutdown();
  }
});

test('admin actions reject non-superadmin users with 403', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_user' ? makeNonAdminAuthResult() : null;
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_user', 'superadmin.platform.getOverview');
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'forbidden_role');
  } finally {
    await shutdown();
  }
});

test('superadmin.members.list returns paginated member list', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListMembers({ limit }) {
      assert.equal(limit, 5);
      return { results: [{
        memberId: 'member-1',
        publicName: 'Alice',
        state: 'active',
        createdAt: '2026-03-14T10:00:00Z',
        membershipCount: 2,
        tokenCount: 1,
      }], hasMore: false, nextCursor: null };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.members.list', { limit: 5 });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.results.length, 1);
    assert.equal(body.data.results[0].publicName, 'Alice');
    assert.equal(body.data.results[0].membershipCount, 2);
    assert.equal(body.data.hasMore, false);
    assert.equal(body.data.nextCursor, null);
  } finally {
    await shutdown();
  }
});

test('superadmin.members.get returns full member detail', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetMember({ memberId }) {
      if (memberId !== 'member-1') return null;
      return {
        memberId: 'member-1',
        publicName: 'Alice',
        state: 'active',
        createdAt: '2026-03-14T10:00:00Z',
        memberships: [{
          membershipId: 'ms-1',
          clubId: 'club-1',
          clubName: 'Alpha',
          clubSlug: 'alpha',
          role: 'member',
          status: 'active',
          joinedAt: '2026-03-14T10:00:00Z',
        }],
        tokenCount: 2,
        profile: null,
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.members.get', { memberId: 'member-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.member.memberships.length, 1);
    assert.equal(body.data.member.tokenCount, 2);

    const { response: notFound } = await postAction(port, 'cc_live_admin', 'superadmin.members.get', { memberId: 'nonexistent' });
    assert.equal(notFound.status, 404);
  } finally {
    await shutdown();
  }
});

test('admin.clubs.stats returns club statistics', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetClubStats({ clubId }) {
      if (clubId !== 'club-1') return null;
      return {
        clubId: 'club-1',
        slug: 'alpha',
        name: 'Alpha',
        archivedAt: null,
        memberCounts: { active: 10, applying: 2 },
        contentCount: 25,
        messageCount: 100,
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'clubadmin.clubs.getStatistics', { clubId: 'club-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.stats.contentCount, 25);
    assert.deepEqual(body.data.stats.memberCounts, { active: 10, applying: 2 });
  } finally {
    await shutdown();
  }
});

test('superadmin.diagnostics.getHealth returns system diagnostics', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetDiagnostics() {
      return {
        migrationCount: 43,
        latestMigration: '018_drift_cleanup.sql',
        memberCount: 42,
        clubCount: 3,
        totalAppTables: 18,
        databaseSize: '24 MB',
        workers: {
          embedding: {
            queue: {
              claimable: 2,
              scheduledFuture: 1,
              atOrOverMaxAttempts: 3,
            },
            failedEmbeddingJobs: 3,
            oldestClaimableAgeSeconds: 60,
            byModel: [{
              model: 'text-embedding-3-small',
              dimensions: 1536,
              claimable: 2,
              scheduledFuture: 1,
              atOrOverMaxAttempts: 3,
            }],
            retryErrorSample: [{
              jobId: 'retryjob123456',
              subjectKind: 'content_version',
              model: 'text-embedding-3-small',
              attemptCount: 4,
              lastError: 'transient provider failure',
              nextAttemptAt: '2026-03-14T12:05:00Z',
            }],
          },
        },
        collectedAt: '2026-03-14T12:00:00Z',
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.diagnostics.getHealth');
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.diagnostics.migrationCount, 43);
    assert.equal(body.data.diagnostics.totalAppTables, 18);
    assert.equal(body.data.diagnostics.databaseSize, '24 MB');
    assert.equal(body.data.diagnostics.workers.embedding.queue.claimable, 2);
    assert.equal(body.data.diagnostics.workers.embedding.failedEmbeddingJobs, 3);
    assert.equal(body.data.diagnostics.collectedAt, '2026-03-14T12:00:00.000Z');
  } finally {
    await shutdown();
  }
});

test('superadmin.members.list returns 400 for invalid cursor', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListMembers() {
      return { results: [], hasMore: false, nextCursor: null };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.members.list', { limit: 5, cursor: 'not-valid-base64-json' });
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'invalid_input');
  } finally {
    await shutdown();
  }
});

test('admin.accessTokens.revoke revokes a token for any member', async () => {
  let capturedInput: { memberId: string; tokenId: string } | null = null;
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminRevokeMemberToken(input) {
      capturedInput = input;
      return {
        tokenId: input.tokenId,
        memberId: input.memberId,
        label: 'test-token',
        createdAt: '2026-03-14T10:00:00Z',
        lastUsedAt: null,
        revokedAt: '2026-03-14T12:00:00Z',
        expiresAt: null,
        metadata: {},
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.accessTokens.revoke', {
      memberId: 'member-99',
      tokenId: 'token-42',
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(capturedInput?.memberId, 'member-99');
    assert.equal(capturedInput?.tokenId, 'token-42');
  } finally {
    await shutdown();
  }
});

// ── superadmin.clubs.list ───────────────────────────────

test('superadmin.clubs.list returns paginated clubs', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async listClubs({ includeArchived }) {
      assert.equal(includeArchived, false);
      return {
        results: [{
        clubId: 'club-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First club',
        admissionPolicy: null,
        archivedAt: null,
        owner: { memberId: 'member-1', publicName: 'Alice', email: null },
        version: { no: 1, createdAt: '2026-03-14T10:00:00Z', creatorMemberId: 'member-1' },
        }],
        hasMore: false,
        nextCursor: null,
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.list', {});
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.results.length, 1);
    assert.equal(body.data.results[0].slug, 'alpha');
    assert.equal(body.data.results[0].owner.publicName, 'Alice');
  } finally {
    await shutdown();
  }
});

test('action repository boundary rejects missing required action methods at construction', () => {
  const repository = {
    ...makeRepository(),
    listClubs: undefined,
  };

  assert.throws(
    () => assertActionRepository(repository),
    /Repository is missing required action method\(s\): listClubs/,
  );
});

test('superadmin.clubs.get returns club detail with AI budget usage', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetClub({ clubId }) {
      if (clubId !== 'club-1') return null;
      return {
        clubId: 'club-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First club',
        admissionPolicy: null,
        archivedAt: null,
        owner: { memberId: 'member-1', publicName: 'Alice', email: null },
        version: {
          no: 1,
          status: 'active',
          reason: null,
          createdAt: '2026-03-14T10:00:00Z',
          createdByMember: { memberId: 'member-1', publicName: 'Alice' },
        },
        memberCounts: { active: 4, removed: 1 },
        contentCount: 12,
        messageCount: 28,
        aiSpend: {
          budget: {
            dailyMaxCents: 100,
            weeklyMaxCents: 450,
            monthlyMaxCents: 1800,
          },
          usage: [{
            window: 'day',
            usedMicroCents: 1095,
            remainingMicroCents: 99_998_905,
          }, {
            window: 'week',
            usedMicroCents: 1095,
            remainingMicroCents: 449_998_905,
          }, {
            window: 'month',
            usedMicroCents: 1095,
            remainingMicroCents: 1_799_998_905,
          }],
        },
        llmOutputTokens: {
          scope: 'per_club_member',
          perMemberBudget: {
            dailyMax: 10_000,
            weeklyMax: 45_000,
            monthlyMax: 180_000,
          },
          usage: [{
            window: 'day',
            usedTokens: 7,
          }, {
            window: 'week',
            usedTokens: 7,
          }, {
            window: 'month',
            usedTokens: 7,
          }],
        },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.get', { clubId: 'club-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.club.slug, 'alpha');
    assert.equal(body.data.club.aiSpend.budget.dailyMaxCents, 100);
    assert.equal(body.data.club.aiSpend.usage[0].usedMicroCents, 1095);
    assert.equal(body.data.club.llmOutputTokens.usage[0].usedTokens, 7);
  } finally {
    await shutdown();
  }
});

// ── superadmin.clubs.create ──────────────────���────────────

test('superadmin.clubs.create returns new club', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async findClubBySlug() {
      return null;
    },
    async adminGetMember() {
      return {
        memberId: 'member-1',
        publicName: 'Owner',
        state: 'active',
        createdAt: '2026-03-14T10:00:00Z',
        membershipCount: 0,
        tokenCount: 0,
      };
    },
    async createClub({ slug, name, summary, ownerMemberId, clientKey, usesFreeAllowance, memberCap }) {
      assert.equal(clientKey, 'club-create-1');
      assert.equal(usesFreeAllowance, true);
      assert.equal(memberCap, null);
      return {
        clubId: 'club-new',
        slug,
        name,
        summary,
        admissionPolicy: null,
        usesFreeAllowance: true,
        memberCap: 5,
        archivedAt: null,
        owner: { memberId: ownerMemberId, publicName: 'Owner', email: null },
        version: {
          no: 1,
          status: 'active',
          reason: null,
          createdAt: '2026-03-14T10:00:00Z',
          createdByMember: { memberId: 'admin-1', publicName: 'Admin One' },
        },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    llmGate: passthroughGate,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.create', {
      clientKey: 'club-create-1',
      slug: 'new-club',
      name: 'New Club',
      summary: 'A new club',
      ownerMemberId: 'member-1',
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.club.slug, 'new-club');
    assert.equal(body.data.club.name, 'New Club');
    assert.equal(body.data.club.owner.memberId, 'member-1');
  } finally {
    await shutdown();
  }
});

test('superadmin.clubs.create returns 404 for non-existent owner', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async findClubBySlug() {
      return null;
    },
    async adminGetMember() {
      return null;
    },
    async createClub() {
      throw new Error('createClub should not be reached when owner lookup fails');
    },
  };

  const { server, shutdown } = createServer({
    repository,
    llmGate: passthroughGate,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.create', {
      clientKey: 'club-create-404',
      slug: 'ghost-club',
      name: 'Ghost Club',
      summary: 'No owner',
      ownerMemberId: 'nonexistent',
    });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
  } finally {
    await shutdown();
  }
});

// ── superadmin.clubs.archive ──────────────��───────────────

test('superadmin.clubs.archive returns archived club', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async archiveClub({ clubId }) {
      return {
        clubId,
        slug: 'archived',
        name: 'Archived Club',
        summary: 'Gone',
        admissionPolicy: null,
        archivedAt: '2026-03-14T12:00:00Z',
        owner: { memberId: 'member-1', publicName: 'Alice', email: null },
        version: { no: 1, createdAt: '2026-03-14T10:00:00Z', creatorMemberId: 'member-1' },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.archive', { clubId: 'club-1', clientKey: 'archive-club-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.data.club.archivedAt !== null);
  } finally {
    await shutdown();
  }
});

test('superadmin.clubs.archive returns 404 for non-existent club', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async archiveClub() {
      return null;
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.archive', { clubId: 'ghost', clientKey: 'archive-ghost' });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
  } finally {
    await shutdown();
  }
});

// ── superadmin.clubs.assignOwner ──────────────────────────

test('superadmin.clubs.assignOwner returns updated club', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async assignClubOwner({ clubId, ownerMemberId }) {
      return {
        clubId,
        slug: 'transferred',
        name: 'Transferred Club',
        summary: 'Now yours',
        admissionPolicy: null,
        archivedAt: null,
        owner: { memberId: ownerMemberId, publicName: 'New Owner', email: null },
        version: { no: 2, createdAt: '2026-03-14T12:00:00Z', creatorMemberId: 'admin-1' },
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.assignOwner', {
      clubId: 'club-1',
      ownerMemberId: 'member-2',
      clientKey: 'assign-owner-1',
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.club.owner.memberId, 'member-2');
    assert.equal(body.data.club.version.no, 2);
  } finally {
    await shutdown();
  }
});

test('superadmin.clubs.assignOwner returns 404 for non-existent club or member', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async assignClubOwner() {
      return null;
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.assignOwner', {
      clubId: 'ghost',
      ownerMemberId: 'ghost',
      clientKey: 'assign-owner-ghost',
    });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
  } finally {
    await shutdown();
  }
});

// ── admin.content.list ─────────��──────────────────────────

test('admin.content.list returns paginated content', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListContent({ limit }) {
      assert.equal(limit, 10);
      return { results: [{
        id: 'content-1',
        clubId: 'club-1',
        clubSlug: 'alpha',
        kind: 'post' as const,
        title: 'Hello',
        authorMemberId: 'member-1',
        authorPublicName: 'Alice',
        authorHandle: 'alice',
        state: 'published',
        createdAt: '2026-03-14T10:00:00Z',
        archivedAt: null,
      }], hasMore: false, nextCursor: null };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.content.list', { limit: 10 });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.results.length, 1);
    assert.equal(body.data.results[0].title, 'Hello');
  } finally {
    await shutdown();
  }
});

// ── admin.messages.threads ────────────────────────────────

test('admin.messages.threads returns thread list', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListThreads({ limit }) {
      assert.equal(limit, 10);
      return { results: [{
        threadId: 'thread-1',
        clubId: 'club-1',
        clubSlug: 'alpha',
        messageCount: 5,
        latestActivityAt: '2026-03-14T12:00:00Z',
        participants: [
          { memberId: 'member-1', publicName: 'Alice' },
          { memberId: 'member-2', publicName: 'Bob' },
        ],
      }], hasMore: false, nextCursor: null };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.list', { limit: 10 });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.results.length, 1);
    assert.equal(body.data.results[0].messageCount, 5);
  } finally {
    await shutdown();
  }
});

// ── admin.messages.get ───────���───────────────────────────

test('admin.messages.get returns thread with messages', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminReadThread({ threadId }) {
      return {
        thread: {
          threadId,
          clubId: 'club-1',
          clubSlug: 'alpha',
          messageCount: 1,
          latestActivityAt: '2026-03-14T12:00:00Z',
          participants: [
            { memberId: 'member-1', publicName: 'Alice' },
          ],
        },
        messages: [{
          messageId: 'msg-1',
          threadId,
          senderMemberId: 'member-1',
          senderPublicName: 'Alice',
          senderHandle: 'alice',
          messageText: 'Hello',
          createdAt: '2026-03-14T12:00:00Z',
        }],
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.get', { threadId: 'thread-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.thread.threadId, 'thread-1');
    assert.equal(body.data.messages.length, 1);
    assert.equal(body.data.messages[0].messageText, 'Hello');
  } finally {
    await shutdown();
  }
});

test('admin.messages.get returns 404 for non-existent thread', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminReadThread() {
      return null;
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.get', { threadId: 'ghost' });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
  } finally {
    await shutdown();
  }
});

// Superadmin removal actions deleted — superadmins use clubadmin.content.remove,
// clubadmin.events.remove, clubadmin.messages.remove instead.

// ── admin.accessTokens.list ────────────────────��────────────────

test('admin.accessTokens.list returns tokens for a member', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListMemberTokens({ memberId }) {
      return {
        results: [{
          tokenId: 'token-1',
          memberId,
          label: 'default',
          createdAt: '2026-03-14T10:00:00Z',
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          metadata: {},
        }],
        hasMore: false,
        nextCursor: null,
      };
    },
  };

  const { server, shutdown } = createServer({
    repository,
    updatesNotifier: makeUpdatesNotifier(),
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.accessTokens.list', { memberId: 'member-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.results.length, 1);
    assert.equal(body.data.results[0].label, 'default');
  } finally {
    await shutdown();
  }
});
