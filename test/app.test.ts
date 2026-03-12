import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, buildApp, type ActorContext, type MemberSearchResult, type Repository } from '../src/app.ts';

function makeActor(): ActorContext {
  return {
    member: {
      id: 'member-1',
      authSubject: 'auth|member-1',
      handle: 'member-one',
      publicName: 'Member One',
    },
    networks: [
      {
        membershipId: 'membership-1',
        networkId: 'network-1',
        slug: 'alpha',
        name: 'Alpha',
        summary: 'First network',
        manifestoMarkdown: null,
        role: 'member',
        status: 'active',
        sponsorMemberId: 'member-2',
        joinedAt: '2026-03-12T00:00:00Z',
      },
      {
        membershipId: 'membership-2',
        networkId: 'network-2',
        slug: 'beta',
        name: 'Beta',
        summary: 'Second network',
        manifestoMarkdown: null,
        role: 'member',
        status: 'active',
        sponsorMemberId: 'member-3',
        joinedAt: '2026-03-12T00:00:00Z',
      },
    ],
  };
}

function makeRepository(results: MemberSearchResult[] = []): Repository {
  return {
    async getActorContextByAuthSubject(authSubject: string) {
      if (authSubject !== 'auth|member-1') {
        return null;
      }

      return makeActor();
    },
    async searchMembers() {
      return results;
    },
  };
}

test('session.describe returns the current member and accessible networks', async () => {
  const app = buildApp({ repository: makeRepository() });
  const result = await app.handleAction({
    authSubject: 'auth|member-1',
    action: 'session.describe',
  });

  assert.equal(result.action, 'session.describe');
  assert.equal(result.data.member.id, 'member-1');
  assert.equal(result.data.accessibleNetworks.length, 2);
  assert.deepEqual(
    result.data.accessibleNetworks.map((network) => network.networkId),
    ['network-1', 'network-2'],
  );
});

test('members.search narrows scope when a permitted network is requested', async () => {
  let capturedNetworkIds: string[] = [];

  const repository: Repository = {
    async getActorContextByAuthSubject() {
      return makeActor();
    },
    async searchMembers({ networkIds }) {
      capturedNetworkIds = networkIds;
      return [];
    },
  };

  const app = buildApp({ repository });
  const result = await app.handleAction({
    authSubject: 'auth|member-1',
    action: 'members.search',
    payload: {
      query: 'Chris',
      networkId: 'network-2',
      limit: 3,
    },
  });

  assert.equal(result.action, 'members.search');
  assert.deepEqual(capturedNetworkIds, ['network-2']);
  assert.equal(result.data.networkScope.length, 1);
  assert.equal(result.data.networkScope[0]?.networkId, 'network-2');
});

test('members.search rejects a network outside the actor scope', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        authSubject: 'auth|member-1',
        action: 'members.search',
        payload: {
          query: 'Chris',
          networkId: 'network-999',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden');
      return true;
    },
  );
});

test('members.search rejects unknown bearer tokens', async () => {
  const app = buildApp({ repository: makeRepository() });

  await assert.rejects(
    () =>
      app.handleAction({
        authSubject: 'auth|nobody',
        action: 'session.describe',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'unauthorized');
      return true;
    },
  );
});
