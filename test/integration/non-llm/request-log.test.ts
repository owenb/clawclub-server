import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';
import { processApiRequestLogRetention } from '../../../src/workers/request-log-retention.ts';

type RawResponse = {
  status: number;
  body: Record<string, unknown>;
};

async function rawPost(
  port: number,
  token: string | null,
  jsonBody: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...extraHeaders,
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(jsonBody));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestLogs(
  h: TestHarness,
  memberId: string,
  expectedCount: number,
): Promise<Array<{ memberId: string; actionName: string; ipAddress: string | null }>> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const rows = await h.sql<{ memberId: string; actionName: string; ipAddress: string | null }>(
      `select member_id as "memberId",
              action_name as "actionName",
              host(ip_address) as "ipAddress"
       from api_request_log
       where member_id = $1
       order by created_at asc, id asc`,
      [memberId],
    );

    if (rows.length === expectedCount) {
      return rows;
    }

    await sleep(50);
  }

  return h.sql<{ memberId: string; actionName: string; ipAddress: string | null }>(
    `select member_id as "memberId",
            action_name as "actionName",
            host(ip_address) as "ipAddress"
     from api_request_log
     where member_id = $1
     order by created_at asc, id asc`,
    [memberId],
  );
}

async function waitForActionRequestLogs(
  h: TestHarness,
  memberId: string,
  actionName: string,
  expectedCount: number,
): Promise<Array<{ memberId: string; actionName: string; ipAddress: string | null }>> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const rows = await h.sql<{ memberId: string; actionName: string; ipAddress: string | null }>(
      `select member_id as "memberId",
              action_name as "actionName",
              host(ip_address) as "ipAddress"
         from api_request_log
        where member_id = $1
          and action_name = $2
        order by created_at asc, id asc`,
      [memberId, actionName],
    );

    if (rows.length === expectedCount) {
      return rows;
    }

    await sleep(50);
  }

  return h.sql<{ memberId: string; actionName: string; ipAddress: string | null }>(
    `select member_id as "memberId",
            action_name as "actionName",
            host(ip_address) as "ipAddress"
       from api_request_log
      where member_id = $1
        and action_name = $2
      order by created_at asc, id asc`,
    [memberId, actionName],
  );
}

async function activeAppConnectionsByName(h: TestHarness): Promise<Map<string, number>> {
  const rows = await h.sql<{ applicationName: string; activeCount: string }>(
    `select application_name as "applicationName",
            count(*)::text as "activeCount"
       from pg_stat_activity
      where datname = current_database()
        and usename = 'clawclub_app'
        and state = 'active'
        and application_name in ('clawclub_server_main', 'clawclub_request_log')
      group by application_name`,
  );
  return new Map(rows.map((row) => [row.applicationName, Number(row.activeCount)]));
}

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('api request log', () => {
  it('logs authenticated requests with the forwarded client IP', async () => {
    const owner = await h.seedOwner('request-log-ip', 'Request Log Ip');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
      { 'x-forwarded-for': '203.0.113.10, 10.0.0.9' },
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      memberId: owner.id,
      actionName: 'session.getContext',
      ipAddress: '203.0.113.10',
    });
  });

  it('falls back to the socket IP when the forwarded client IP is invalid', async () => {
    const owner = await h.seedOwner('request-log-invalid-ip', 'Request Log Invalid Ip');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
      { 'x-forwarded-for': 'definitely-not-an-ip' },
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ipAddress, '127.0.0.1');
  });

  it('stores the socket IP when X-Forwarded-For is absent', async () => {
    const owner = await h.seedOwner('request-log-no-forwarded', 'Request Log No Forwarded');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ipAddress, '127.0.0.1');
  });

  it('logs forwarded IPv6 client addresses', async () => {
    const owner = await h.seedOwner('request-log-ipv6', 'Request Log IPv6');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
      { 'x-forwarded-for': '2001:db8::123' },
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.deepEqual(rows, [{
      memberId: owner.id,
      actionName: 'session.getContext',
      ipAddress: '2001:db8::123',
    }]);
  });

  it('logs requests that fail validation after auth succeeds', async () => {
    const owner = await h.seedOwner('request-log-parse-fail', 'Request Log Parse Fail');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: { unexpected: true } },
      { 'x-forwarded-for': '203.0.113.22' },
    );

    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal((body.error as { code?: string }).code, 'invalid_input');

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      memberId: owner.id,
      actionName: 'session.getContext',
      ipAddress: '203.0.113.22',
    });
  });

  it('logs authenticated unknown_action requests', async () => {
    const owner = await h.seedOwner('request-log-unknown-action', 'Request Log Unknown Action');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'bogus.nonexistent', input: {} },
      { 'x-forwarded-for': '203.0.113.23' },
    );

    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal((body.error as { code?: string }).code, 'unknown_action');

    const rows = await waitForActionRequestLogs(h, owner.id, 'bogus.nonexistent', 1);
    assert.deepEqual(rows, [{
      memberId: owner.id,
      actionName: 'bogus.nonexistent',
      ipAddress: '203.0.113.23',
    }]);
  });

  it('logs preGate rejections on llm-gated actions after auth succeeds', async () => {
    const owner = await h.seedOwner('request-log-pregate', 'Request Log Pregate');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      {
        action: 'content.create',
        input: {
          kind: 'post',
          body: 'Missing club scope should fail in preGate before the LLM gate.',
        },
      },
      { 'x-forwarded-for': '203.0.113.24' },
    );

    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal((body.error as { code?: string }).code, 'invalid_input');

    const rows = await waitForActionRequestLogs(h, owner.id, 'content.create', 1);
    assert.deepEqual(rows, [{
      memberId: owner.id,
      actionName: 'content.create',
      ipAddress: '203.0.113.24',
    }]);
  });

  it('does not log requests when authentication fails before actor binding', async () => {
    const beforeRows = await h.sql<{ count: string }>('select count(*)::text as count from api_request_log');

    const { status, body } = await rawPost(
      h.port,
      null,
      { action: 'session.getContext', input: {} },
      { 'x-forwarded-for': '203.0.113.33' },
    );

    assert.equal(status, 401);
    assert.equal(body.ok, false);
    assert.equal((body.error as { code?: string }).code, 'unauthenticated');

    await sleep(250);

    const afterRows = await h.sql<{ count: string }>('select count(*)::text as count from api_request_log');
    assert.equal(afterRows[0]?.count, beforeRows[0]?.count);
  });

  it('does not log auth:none actions', async () => {
    const beforeRows = await h.sql<{ count: string }>('select count(*)::text as count from api_request_log');

    const { status, body } = await rawPost(
      h.port,
      null,
      { action: 'accounts.register', input: { mode: 'discover' } },
      { 'x-forwarded-for': '203.0.113.34' },
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    await sleep(250);

    const afterRows = await h.sql<{ count: string }>('select count(*)::text as count from api_request_log');
    assert.equal(afterRows[0]?.count, beforeRows[0]?.count);
  });

  it('does not drop rows under a burst of concurrent authenticated requests', async () => {
    const owner = await h.seedOwner('request-log-burst', 'Request Log Burst');

    const requests = Array.from({ length: 20 }, () => rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
      { 'x-forwarded-for': '203.0.113.44' },
    ));

    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
    }

    const rows = await waitForRequestLogs(h, owner.id, 20);
    assert.equal(rows.length, 20);
    assert.ok(rows.every((row) => row.actionName === 'session.getContext'));
    assert.ok(rows.every((row) => row.ipAddress === '203.0.113.44'));
  });

  it('logs an idempotent replay only once', async () => {
    const owner = await h.seedOwner('request-log-replay', 'Request Log Replay');
    const superadmin = await h.seedSuperadmin('Request Log Replay Admin');

    await h.apiOk(superadmin.token, 'superadmin.clubs.archive', {
      clientKey: randomUUID(),
      clubId: owner.club.id,
    });

    const first = await rawPost(
      h.port,
      superadmin.token,
      {
        action: 'superadmin.clubs.remove',
        input: {
          clubId: owner.club.id,
          confirmSlug: owner.club.slug,
          reason: 'request log replay test',
          clientKey: 'request-log-replay-key',
        },
      },
      { 'x-forwarded-for': '203.0.113.66' },
    );
    const second = await rawPost(
      h.port,
      superadmin.token,
      {
        action: 'superadmin.clubs.remove',
        input: {
          clubId: owner.club.id,
          confirmSlug: owner.club.slug,
          reason: 'request log replay test',
          clientKey: 'request-log-replay-key',
        },
      },
      { 'x-forwarded-for': '203.0.113.66' },
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const rows = await waitForActionRequestLogs(h, superadmin.id, 'superadmin.clubs.remove', 1);
    assert.deepEqual(rows, [{
      memberId: superadmin.id,
      actionName: 'superadmin.clubs.remove',
      ipAddress: '203.0.113.66',
    }]);
  });

  it('logs stale-client rejections before returning 409', async () => {
    const owner = await h.seedOwner('request-log-stale', 'Request Log Stale');

    const { status, body } = await rawPost(
      h.port,
      owner.token,
      { action: 'session.getContext', input: {} },
      {
        'x-forwarded-for': '203.0.113.77',
        'clawclub-schema-seen': 'stale-schema-hash',
      },
    );

    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.equal((body.error as { code?: string }).code, 'stale_client');

    const rows = await waitForRequestLogs(h, owner.id, 1);
    assert.deepEqual(rows, [{
      memberId: owner.id,
      actionName: 'stale_client',
      ipAddress: '203.0.113.77',
    }]);
  });

  it('prunes request-log rows older than 90 days during the retention sweep', async () => {
    const owner = await h.seedOwner('request-log-retention', 'Request Log Retention');

    await h.sql(
      `insert into api_request_log (member_id, action_name, ip_address, created_at)
       values
         ($1, 'session.getContext', inet '203.0.113.88', now() - interval '100 days'),
         ($1, 'content.list', inet '203.0.113.89', now())`,
      [owner.id],
    );

    const deleted = await processApiRequestLogRetention({ db: h.pools.app });
    assert.equal(deleted, 1);

    const rows = await h.sql<{ actionName: string }>(
      `select action_name as "actionName"
         from api_request_log
        where member_id = $1
        order by created_at asc, id asc`,
      [owner.id],
    );
    assert.deepEqual(rows, [{ actionName: 'content.list' }]);

    const stateRows = await h.sql<{ stateValue: string }>(
      `select state_value as "stateValue"
         from worker_state
        where worker_id = 'request_log_retention'
          and state_key = 'api_request_log_retention_at'`,
    );
    assert.equal(stateRows.length, 1);
    assert.ok(stateRows[0]?.stateValue);
  });

  it('keeps stalled log inserts off the main HTTP pool', async () => {
    const owner = await h.seedOwner('request-log-pool', 'Request Log Pool');

    await h.sql(
      `create or replace function public.test_sleep_api_request_log() returns trigger
       language plpgsql
       as $$
       begin
         perform pg_sleep(5);
         return new;
       end;
       $$`,
    );
    await h.sql(
      `create trigger api_request_log_test_sleep
       before insert on public.api_request_log
       for each row execute function public.test_sleep_api_request_log()`,
    );

    try {
      const requests = Array.from({ length: 5 }, () => rawPost(
        h.port,
        owner.token,
        { action: 'session.getContext', input: {} },
        { 'x-forwarded-for': '203.0.113.90' },
      ));

      const responses = await Promise.all(requests);
      for (const response of responses) {
        assert.equal(response.status, 200);
      }

      await sleep(250);

      const connections = await activeAppConnectionsByName(h);
      assert.equal(connections.get('clawclub_server_main') ?? 0, 0);
      assert.ok((connections.get('clawclub_request_log') ?? 0) >= 1);
      assert.ok((connections.get('clawclub_request_log') ?? 0) <= 2);
    } finally {
      await h.sql(`drop trigger if exists api_request_log_test_sleep on public.api_request_log`);
      await h.sql(`drop function if exists public.test_sleep_api_request_log()`);
      await sleep(2_250);
    }
  });

  it('keeps request-log rows when the member record is deleted later', async () => {
    const [member] = await h.sql<{ id: string }>(
      `insert into members (public_name, display_name, email, state)
       values ('Request Log Deleted Member', 'Request Log Deleted Member', 'request-log-deleted@test.clawclub.local', 'active')
       returning id`,
    );
    const memberId = member?.id;
    assert.ok(memberId);

    await h.sql(
      `insert into api_request_log (member_id, action_name, ip_address)
       values ($1, 'session.getContext', inet '203.0.113.55')`,
      [memberId],
    );

    await h.sql(`delete from members where id = $1`, [memberId]);

    const [logRow] = await h.sql<{ memberId: string | null; actionName: string; ipAddress: string | null }>(
      `select member_id as "memberId",
              action_name as "actionName",
              host(ip_address) as "ipAddress"
         from api_request_log
        where action_name = 'session.getContext'
          and ip_address = inet '203.0.113.55'
        order by created_at desc, id desc
        limit 1`,
      [],
    );

    assert.equal(logRow?.memberId, null);
    assert.equal(logRow?.actionName, 'session.getContext');
    assert.equal(logRow?.ipAddress, '203.0.113.55');
  });
});
