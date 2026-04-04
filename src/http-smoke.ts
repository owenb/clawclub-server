import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createServer } from './server.ts';
import { buildBearerToken } from './token.ts';

type SessionDescribeResponse = {
  ok: true;
  action: 'session.describe';
  actor: {
    member: {
      id: string;
      handle: string | null;
      publicName: string;
    };
    activeMemberships: Array<{
      clubId: string;
    }>;
  };
  data: Record<string, never>;
};

type UpdatesResponse = {
  ok: true;
  member: {
    id: string;
  };
  requestScope: {
    activeClubIds: string[];
  };
  updates: {
    items: unknown[];
    nextAfter: string | null;
    polledAt: string;
  };
};

async function assertUpdatesStreamReady(baseUrl: string, bearerToken: string): Promise<void> {
  const abortController = new AbortController();

  try {
    const response = await fetch(`${baseUrl}/updates/stream`, {
      headers: {
        authorization: `Bearer ${bearerToken}`,
      },
      signal: abortController.signal,
    });

    assert.equal(response.status, 200, 'GET /updates/stream should return 200');
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = response.body?.getReader();
    assert.ok(reader, 'GET /updates/stream should expose a readable body');

    const decoder = new TextDecoder();
    let transcript = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      transcript += decoder.decode(chunk.value, { stream: true });
      if (/event: ready/.test(transcript)) {
        break;
      }
    }

    assert.match(transcript, /event: ready/, 'GET /updates/stream should emit a ready event');
    await reader.cancel().catch(() => {});
  } finally {
    abortController.abort();
  }
}

function requireRuntimeDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for the HTTP smoke test');
  }
  return databaseUrl;
}

function getSetupDatabaseUrl(runtimeDatabaseUrl: string): string {
  return process.env.DATABASE_MIGRATOR_URL ?? runtimeDatabaseUrl;
}

function readSmokeHandle(): string {
  const configuredHandle = process.env.CLAWCLUB_HTTP_SMOKE_HANDLE?.trim();
  return configuredHandle && configuredHandle.length > 0 ? configuredHandle : 'owen-barnes';
}

async function resolveMemberId(pool: Pool, handle: string): Promise<string> {
  const result = await pool.query<{ id: string | null }>(
    `select app.resolve_active_member_id_by_handle($1) as id`,
    [handle],
  );

  const memberId = result.rows[0]?.id;
  if (!memberId) {
    throw new Error(`No active member found for handle ${handle}`);
  }

  return memberId;
}

async function mintBearerToken(pool: Pool, memberId: string, label: string): Promise<{ tokenId: string; bearerToken: string }> {
  const token = buildBearerToken();

  await pool.query(
    `
      insert into app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
      values ($1, $2, $3, $4, '{}'::jsonb)
    `,
    [token.tokenId, memberId, label, token.tokenHash],
  );

  return {
    tokenId: token.tokenId,
    bearerToken: token.bearerToken,
  };
}

async function revokeBearerToken(pool: Pool, tokenId: string): Promise<void> {
  await pool.query(
    `
      update app.member_bearer_tokens
      set revoked_at = coalesce(revoked_at, now())
      where id = $1
    `,
    [tokenId],
  );
}

async function listenOnLoopback(server: ReturnType<typeof createServer>['server']): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Server did not bind to a TCP port');
  return address.port;
}

async function postAction(baseUrl: string, bearerToken: string, action: string, input: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, input }),
  });

  const bodyText = await response.text();
  let body: Record<string, any>;

  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    throw new Error(`HTTP smoke ${action} returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP smoke ${action} failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  assert.equal(body.ok, true, `HTTP smoke ${action} should return ok=true`);
  assert.equal(body.action, action, `HTTP smoke ${action} should echo the action name`);
  return body;
}

async function getUpdates(baseUrl: string, bearerToken: string, limit: number): Promise<UpdatesResponse> {
  const response = await fetch(`${baseUrl}/updates?limit=${limit}`, {
    headers: {
      authorization: `Bearer ${bearerToken}`,
    },
  });

  const bodyText = await response.text();
  let body: Record<string, any>;

  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    throw new Error(`HTTP smoke GET /updates returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP smoke GET /updates failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  assert.equal(body.ok, true, 'HTTP smoke GET /updates should return ok=true');
  return body as UpdatesResponse;
}

export async function runHttpSmoke(): Promise<{
  memberId: string;
  clubId: string;
  actions: string[];
}> {
  const runtimeDatabaseUrl = requireRuntimeDatabaseUrl();
  const setupPool = new Pool({ connectionString: getSetupDatabaseUrl(runtimeDatabaseUrl) });
  const memberHandle = readSmokeHandle();
  const actions = ['GET /updates', 'GET /updates/stream', 'session.describe', 'members.fullTextSearch', 'profile.get', 'messages.inbox', 'entities.list', 'events.list'];
  let tokenId: string | null = null;
  let shutdown: (() => Promise<void>) | null = null;

  try {
    const memberId = await resolveMemberId(setupPool, memberHandle);
    const token = await mintBearerToken(setupPool, memberId, 'http-smoke');
    tokenId = token.tokenId;

    const serverState = createServer();
    shutdown = serverState.shutdown;
    const port = await listenOnLoopback(serverState.server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const session = await postAction(baseUrl, token.bearerToken, 'session.describe', {}) as SessionDescribeResponse;
    assert.equal(session.actor.member.id, memberId);
    assert.ok(session.actor.activeMemberships.length > 0, 'HTTP smoke member must have at least one active membership');

    const clubId = session.actor.activeMemberships[0]!.clubId;
    const updates = await getUpdates(baseUrl, token.bearerToken, 5);
    assert.equal(updates.member.id, memberId);
    assert.ok(Array.isArray(updates.updates.items), 'GET /updates should return an items array');
    assert.ok(updates.updates.nextAfter === null || typeof updates.updates.nextAfter === 'string', 'GET /updates should return a string nextAfter cursor when present');
    assert.equal(typeof updates.updates.polledAt, 'string');
    assert.ok(updates.requestScope.activeClubIds.includes(clubId), 'GET /updates should reflect actor club scope');

    await assertUpdatesStreamReady(baseUrl, token.bearerToken);

    const memberQuery = session.actor.member.handle ?? session.actor.member.publicName.split(/\s+/)[0] ?? memberHandle;

    const members = await postAction(baseUrl, token.bearerToken, 'members.fullTextSearch', {
      query: memberQuery,
      clubId,
      limit: 5,
    });
    assert.ok(Array.isArray(members.data?.results), 'members.fullTextSearch should return a results array');

    const profile = await postAction(baseUrl, token.bearerToken, 'profile.get', {});
    assert.equal(profile.data?.memberId, memberId);

    const inbox = await postAction(baseUrl, token.bearerToken, 'messages.inbox', {
      clubId,
      limit: 5,
    });
    assert.ok(Array.isArray(inbox.data?.results), 'messages.inbox should return a results array');

    const entities = await postAction(baseUrl, token.bearerToken, 'entities.list', {
      clubId,
      limit: 5,
    });
    assert.ok(Array.isArray(entities.data?.results), 'entities.list should return a results array');

    const events = await postAction(baseUrl, token.bearerToken, 'events.list', {
      clubId,
      limit: 5,
    });
    assert.ok(Array.isArray(events.data?.results), 'events.list should return a results array');

    return {
      memberId,
      clubId,
      actions,
    };
  } finally {
    if (shutdown) {
      await shutdown();
    }

    if (tokenId) {
      await revokeBearerToken(setupPool, tokenId);
    }

    await setupPool.end();
  }
}

async function main() {
  const result = await runHttpSmoke();
  console.log('ok - http smoke');
  console.log(`  memberId: ${result.memberId}`);
  console.log(`  clubId: ${result.clubId}`);
  console.log(`  actions: ${result.actions.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
