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

test('admin.overview returns platform stats for superadmin', async () => {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.overview');
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

    const { response, body } = await postAction(port, 'cc_live_user', 'admin.overview');
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'forbidden');
  } finally {
    await shutdown();
  }
});

test('admin.members.list returns paginated member list', async () => {
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminListMembers({ limit, offset }) {
      assert.equal(limit, 5);
      assert.equal(offset, 10);
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.members.list', { limit: 5, offset: 10 });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.members.length, 1);
    assert.equal(body.data.members[0].publicName, 'Alice');
    assert.equal(body.data.members[0].membershipCount, 2);
  } finally {
    await shutdown();
  }
});

test('admin.members.get returns full member detail', async () => {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.members.get', { memberId: 'member-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.member.memberships.length, 1);
    assert.equal(body.data.member.tokenCount, 2);

    const { response: notFound } = await postAction(port, 'cc_live_admin', 'admin.members.get', { memberId: 'nonexistent' });
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.clubs.stats', { clubId: 'club-1' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.stats.entityCount, 25);
    assert.deepEqual(body.data.stats.memberCounts, { active: 10, invited: 2 });
  } finally {
    await shutdown();
  }
});

test('admin.content.archive archives an entity', async () => {
  let archivedEntityId: string | null = null;
  const repository: Repository = {
    ...makeRepository(),
    async authenticateBearerToken(token) {
      return token === 'cc_live_admin' ? makeAdminAuthResult() : null;
    },
    async adminArchiveEntity({ entityId }) {
      archivedEntityId = entityId;
      return { entityId };
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.content.archive', { entityId: 'entity-42' });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(archivedEntityId, 'entity-42');
  } finally {
    await shutdown();
  }
});

test('admin.diagnostics.health returns system diagnostics', async () => {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.diagnostics.health');
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.diagnostics.migrationCount, 43);
    assert.equal(body.data.diagnostics.tablesWithRls, 15);
    assert.equal(body.data.diagnostics.databaseSize, '24 MB');
  } finally {
    await shutdown();
  }
});

test('admin.members.list returns 400 for invalid offset', async () => {
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.members.list', { limit: 5, offset: -1 });
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

    const { response, body } = await postAction(port, 'cc_live_admin', 'admin.tokens.revoke', {
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
