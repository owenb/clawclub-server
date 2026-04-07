import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { TestHarness } from './harness.ts';

/** Send raw JSON to the API, bypassing the harness's structured api() method. */
function rawPost(port: number, token: string | null, jsonBody: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(jsonBody));
  });
}

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('smoke', () => {
  it('owner can call session.describe and see their club', async () => {
    const owen = await h.seedOwner('smokeclub', 'SmokeClub');
    const result = await h.apiOk(owen.token, 'session.describe', {});
    const actor = result.actor as Record<string, unknown>;
    const memberships = actor.activeMemberships as Array<Record<string, unknown>>;
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].slug, 'smokeclub');
    assert.equal(memberships[0].role, 'clubadmin');
    assert.equal(memberships[0].isOwner, true);
  });

  it('GET /api/schema returns all actions including superadmin', async () => {
    const { status, body } = await h.getSchema();
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const data = body.data as {
      version: string;
      actions: Array<{
        action: string;
        auth: string;
        input: unknown;
        output: unknown;
      }>;
    };
    assert.ok(data.version, 'schema should have a version');
    assert.equal(data.actions.length, 59, 'schema should have all 59 actions');

    for (const a of data.actions) {
      assert.ok(a.input, `${a.action} should have input schema`);
      assert.ok(a.output, `${a.action} should have output schema`);
    }

    // No aiExposed field in schema output
    for (const a of data.actions) {
      assert.equal('aiExposed' in (a as Record<string, unknown>), false, `${a.action} should not have aiExposed`);
    }

    // Actions must be sorted by name (deterministic)
    const names = data.actions.map(a => a.action);
    assert.deepEqual(names, [...names].sort());

    // Verify key actions across all auth levels
    assert.ok(names.includes('session.describe'), 'should include session.describe');
    assert.ok(names.includes('entities.create'), 'should include entities.create');
    assert.ok(names.some(n => n.startsWith('clubadmin.')), 'should include clubadmin.*');
    assert.ok(names.some(n => n.startsWith('superadmin.')), 'should include superadmin.*');
    assert.ok(!names.some(n => n.startsWith('admin.')), 'should not include admin.*');

    // Verify a second call returns identical output (cached, stable)
    const { body: body2 } = await h.getSchema();
    assert.deepEqual(body, body2);
  });

  it('rejects top-level parameters outside input (members.list)', async () => {
    const owner = await h.seedOwner('transport-members', 'TransportMembers');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'members.list', clubId: owner.club.id, limit: 50 });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match((body.error as any).message, /top-level/i);
  });

  it('rejects top-level parameters outside input (entities.list)', async () => {
    const owner = await h.seedOwner('transport-entities', 'TransportEntities');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'entities.list', clubId: owner.club.id });
    assert.equal(status, 400);
    assert.match((body.error as any).message, /top-level/i);
  });

  it('rejects top-level parameters outside input (events.list)', async () => {
    const owner = await h.seedOwner('transport-events', 'TransportEvents');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'events.list', clubId: owner.club.id });
    assert.equal(status, 400);
    assert.match((body.error as any).message, /top-level/i);
  });

  it('rejects top-level parameters outside input (superadmin.members.list)', async () => {
    const admin = await h.seedSuperadmin('Transport Admin', 'transport-admin');
    const { status, body } = await rawPost(h.port, admin.token, { action: 'superadmin.members.list', limit: 10 });
    assert.equal(status, 400);
    assert.match((body.error as any).message, /top-level/i);
  });

  it('accepts well-formed request with input', async () => {
    const owner = await h.seedOwner('transport-ok', 'TransportOk');
    const result = await h.apiOk(owner.token, 'members.list', { clubId: owner.club.id });
    assert.ok(result.data);
  });

  it('accepts request without input key (treated as empty input)', async () => {
    const { status, body } = await rawPost(h.port, null, { action: 'admissions.challenge' });
    // Should be 400 from the ACTION's validation (missing clubSlug), not from transport validation.
    // The key indicator: if the transport rejected it, the error code would be 'invalid_input' with 'top-level'.
    // The action rejection gives 'invalid_input' about the missing required field.
    assert.equal(status, 400);
    assert.ok(!(body.error as any).message.includes('top-level'), 'should not be a transport rejection');
  });

  it('GET /api/schema matches committed snapshot', async () => {
    const { body } = await h.getSchema();
    const snapshotPath = new URL('../snapshots/api-schema.json', import.meta.url).pathname;
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.deepEqual(body.data, snapshot,
      'Schema output changed. If intentional, regenerate the snapshot:\n' +
      '  node --eval "const d=JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')); process.stdout.write(JSON.stringify(d.data,null,2))" < <(curl -s http://127.0.0.1:8787/api/schema) > test/snapshots/api-schema.json');
  });
});
