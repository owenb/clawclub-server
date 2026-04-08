import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import type { Repository } from '../src/contract.ts';
import { makeAdminAuthResult, makeAuthResult, makeRepository, makeUpdatesNotifier } from './fixtures.ts';

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

test('superadmin.overview returns platform stats for superadmin', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetOverview() {
      return {
        totalMembers: 42,
        totalClubs: 3,
        totalEntities: 150,
        totalMessages: 500,
        totalApplications: 10,
        recentMembers: [{
          memberId: 'member-1',
          publicName: 'Alice',
          handle: 'alice',
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
    assert.equal(body.error.code, 'forbidden');
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
      return [{
        memberId: 'member-1',
        publicName: 'Alice',
        handle: 'alice',
        state: 'active',
        createdAt: '2026-03-14T10:00:00Z',
        membershipCount: 2,
        tokenCount: 1,
      }];
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
    assert.equal(body.data.members.length, 1);
    assert.equal(body.data.members[0].publicName, 'Alice');
    assert.equal(body.data.members[0].membershipCount, 2);
    assert.equal(typeof body.data.nextCursor, 'string');
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
        handle: 'alice',
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
        memberCounts: { active: 10, invited: 2 },
        entityCount: 25,
        messageCount: 100,
        applicationCounts: { submitted: 3, accepted: 5 },
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
    assert.equal(body.data.stats.entityCount, 25);
    assert.deepEqual(body.data.stats.memberCounts, { active: 10, invited: 2 });
  } finally {
    await shutdown();
  }
});

test('superadmin.diagnostics.health returns system diagnostics', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminGetDiagnostics() {
      return {
        migrationCount: 43,
        latestMigration: '0043_rls_security_hardening.sql',
        memberCount: 42,
        clubCount: 3,
        tablesWithRls: 15,
        totalAppTables: 18,
        databaseSize: '24 MB',
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
    assert.equal(body.data.diagnostics.tablesWithRls, 15);
    assert.equal(body.data.diagnostics.databaseSize, '24 MB');
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
      return [];
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

test('admin.tokens.revoke revokes a token for any member', async () => {
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

// ── superadmin.clubs.list ──��──────────────────────────────

test('superadmin.clubs.list returns clubs array', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async listClubs({ includeArchived }) {
      return [{
        clubId: 'club-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First club',
        admissionPolicy: null,
        archivedAt: null,
        owner: { memberId: 'member-1', publicName: 'Alice', handle: 'alice', email: null },
        version: { versionNo: 1, createdAt: '2026-03-14T10:00:00Z', createdByMemberId: 'member-1' },
      }];
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
    assert.equal(body.data.clubs.length, 1);
    assert.equal(body.data.clubs[0].slug, 'alpha');
    assert.equal(body.data.clubs[0].owner.publicName, 'Alice');
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
    async createClub({ slug, name, summary, ownerMemberId }) {
      return {
        clubId: 'club-new',
        slug,
        name,
        summary,
        admissionPolicy: null,
        archivedAt: null,
        owner: { memberId: ownerMemberId, publicName: 'Owner', handle: 'owner', email: null },
        version: { versionNo: 1, createdAt: '2026-03-14T10:00:00Z', createdByMemberId: 'admin-1' },
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.create', {
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
    async createClub() {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.create', {
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
        owner: { memberId: 'member-1', publicName: 'Alice', handle: 'alice', email: null },
        version: { versionNo: 1, createdAt: '2026-03-14T10:00:00Z', createdByMemberId: 'member-1' },
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.archive', { clubId: 'club-1' });
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.clubs.archive', { clubId: 'ghost' });
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
        owner: { memberId: ownerMemberId, publicName: 'New Owner', handle: 'new-owner', email: null },
        version: { versionNo: 2, createdAt: '2026-03-14T12:00:00Z', createdByMemberId: 'admin-1' },
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
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.club.owner.memberId, 'member-2');
    assert.equal(body.data.club.version.versionNo, 2);
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
      return [{
        entityId: 'entity-1',
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
      }];
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
    assert.equal(body.data.content.length, 1);
    assert.equal(body.data.content[0].title, 'Hello');
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
      return [{
        threadId: 'thread-1',
        clubId: 'club-1',
        clubSlug: 'alpha',
        messageCount: 5,
        latestMessageAt: '2026-03-14T12:00:00Z',
        participants: [
          { memberId: 'member-1', publicName: 'Alice', handle: 'alice' },
          { memberId: 'member-2', publicName: 'Bob', handle: 'bob' },
        ],
      }];
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.listThreads', { limit: 10 });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.threads.length, 1);
    assert.equal(body.data.threads[0].messageCount, 5);
  } finally {
    await shutdown();
  }
});

// ── admin.messages.read ───────���───────────────────────────

test('admin.messages.read returns thread with messages', async () => {
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
          latestMessageAt: '2026-03-14T12:00:00Z',
          participants: [
            { memberId: 'member-1', publicName: 'Alice', handle: 'alice' },
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.getThread', { threadId: 'thread-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.thread.threadId, 'thread-1');
    assert.equal(body.data.messages.length, 1);
    assert.equal(body.data.messages[0].messageText, 'Hello');
  } finally {
    await shutdown();
  }
});

test('admin.messages.read returns 404 for non-existent thread', async () => {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'superadmin.messages.getThread', { threadId: 'ghost' });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
  } finally {
    await shutdown();
  }
});

// Superadmin removal actions deleted — superadmins use clubadmin.entities.remove,
// clubadmin.events.remove, clubadmin.messages.remove instead.

// ── admin.tokens.list ────────────────────��────────────────

test('admin.tokens.list returns tokens for a member', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListMemberTokens({ memberId }) {
      return [{
        tokenId: 'token-1',
        memberId,
        label: 'default',
        createdAt: '2026-03-14T10:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        metadata: {},
      }];
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
    assert.equal(body.data.tokens.length, 1);
    assert.equal(body.data.tokens[0].label, 'default');
  } finally {
    await shutdown();
  }
});
