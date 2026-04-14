import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createServer } from './server.ts';
import { buildBearerToken } from './token.ts';

type SessionDescribeResponse = {
  ok: true;
  action: 'session.getContext';
  actor: {
    member: {
      id: string;
      publicName: string;
    };
    activeMemberships: Array<{
      clubId: string;
    }>;
  };
  data: Record<string, never>;
};

async function assertStreamReady(baseUrl: string, bearerToken: string): Promise<void> {
  const abortController = new AbortController();

  try {
    const response = await fetch(`${baseUrl}/stream`, {
      headers: {
        authorization: `Bearer ${bearerToken}`,
      },
      signal: abortController.signal,
    });

    assert.equal(response.status, 200, 'GET /stream should return 200');
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = response.body?.getReader();
    assert.ok(reader, 'GET /stream should expose a readable body');

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

    assert.match(transcript, /event: ready/, 'GET /stream should emit a ready event');
    await reader.cancel().catch(() => {});
  } finally {
    abortController.abort();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the HTTP smoke test`);
  return value;
}

function readSmokeMemberName(): string {
  const configured = process.env.CLAWCLUB_HTTP_SMOKE_MEMBER_NAME?.trim();
  return configured && configured.length > 0 ? configured : 'Owen Barnes';
}

async function resolveMemberId(pool: Pool, publicName: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `select id from members where public_name = $1 and state = 'active' limit 1`,
    [publicName],
  );

  const memberId = result.rows[0]?.id;
  if (!memberId) {
    throw new Error(`No active member found with public_name ${publicName}`);
  }

  return memberId;
}

async function mintBearerToken(pool: Pool, memberId: string, label: string): Promise<{ tokenId: string; bearerToken: string }> {
  const token = buildBearerToken();

  await pool.query(
    `
      insert into member_bearer_tokens (id, member_id, label, token_hash, metadata)
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
      update member_bearer_tokens
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

async function getSchemaHash(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/schema`);
  const body = await response.json() as { data?: { schemaHash?: string } };

  assert.equal(response.status, 200, 'GET /api/schema should return 200');
  const headerHash = response.headers.get('clawclub-schema-hash');
  assert.ok(headerHash, 'GET /api/schema should return ClawClub-Schema-Hash');
  assert.equal(body.data?.schemaHash, headerHash, 'schema hash header should match the schema payload');
  return headerHash;
}

async function postAction(
  baseUrl: string,
  bearerToken: string,
  action: string,
  input: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
      ...extraHeaders,
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

export async function runHttpSmoke(): Promise<{
  memberId: string;
  clubId: string;
  actions: string[];
}> {
  const identityUrl = requireEnv('DATABASE_URL');
  const setupPool = new Pool({ connectionString: identityUrl });
  const memberName = readSmokeMemberName();
  const actions = ['GET /api/schema', 'GET /stream', 'session.getContext', 'session.getContext (stale_client)', 'members.searchByFullText', 'profile.list', 'messages.getInbox', 'content.list', 'events.list'];
  let tokenId: string | null = null;
  let shutdown: (() => Promise<void>) | null = null;

  try {
    const memberId = await resolveMemberId(setupPool, memberName);
    const token = await mintBearerToken(setupPool, memberId, 'http-smoke');
    tokenId = token.tokenId;

    const serverState = createServer();
    shutdown = serverState.shutdown;
    const port = await listenOnLoopback(serverState.server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const schemaHash = await getSchemaHash(baseUrl);

    const session = await postAction(baseUrl, token.bearerToken, 'session.getContext', {}, {
      'clawclub-schema-seen': schemaHash,
    }) as SessionDescribeResponse;
    assert.equal(session.actor.member.id, memberId);
    assert.ok(session.actor.activeMemberships.length > 0, 'HTTP smoke member must have at least one active membership');

    const staleClient = await fetch(`${baseUrl}/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.bearerToken}`,
        'content-type': 'application/json',
        'clawclub-schema-seen': 'stale-schema-hash',
      },
      body: JSON.stringify({ action: 'session.getContext', input: {} }),
    });
    const staleBody = await staleClient.json() as { error?: { code?: string; message?: string } };
    assert.equal(staleClient.status, 409, 'mismatched ClawClub-Schema-Seen should return 409');
    assert.equal(staleBody.error?.code, 'stale_client', 'mismatched schema hash should return stale_client');
    assert.match(staleBody.error?.message ?? '', /GET \/api\/schema/, 'stale_client should instruct agents to refetch the schema');
    assert.match(staleBody.error?.message ?? '', /GET \/skill/, 'stale_client should instruct agents to refetch the skill');

    const clubId = session.actor.activeMemberships[0]!.clubId;

    await assertStreamReady(baseUrl, token.bearerToken);

    const memberQuery = session.actor.member.publicName.split(/\s+/)[0] ?? memberName;

    const members = await postAction(baseUrl, token.bearerToken, 'members.searchByFullText', {
      query: memberQuery,
      clubId,
      limit: 5,
    }, {
      'clawclub-schema-seen': schemaHash,
    });
    assert.ok(Array.isArray(members.data?.results), 'members.searchByFullText should return a results array');

    const profile = await postAction(baseUrl, token.bearerToken, 'profile.list', {}, {
      'clawclub-schema-seen': schemaHash,
    });
    assert.equal(profile.data?.memberId, memberId);
    assert.ok(Array.isArray(profile.data?.profiles), 'profile.list should return a profiles array');

    const inbox = await postAction(baseUrl, token.bearerToken, 'messages.getInbox', {
      clubId,
      limit: 5,
    }, {
      'clawclub-schema-seen': schemaHash,
    });
    assert.ok(Array.isArray(inbox.data?.results), 'messages.getInbox should return a results array');

    const entities = await postAction(baseUrl, token.bearerToken, 'content.list', {
      clubId,
      limit: 5,
    }, {
      'clawclub-schema-seen': schemaHash,
    });
    assert.ok(Array.isArray(entities.data?.results), 'content.list should return a results array');

    const events = await postAction(baseUrl, token.bearerToken, 'events.list', {
      clubId,
      limit: 5,
    }, {
      'clawclub-schema-seen': schemaHash,
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
