import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TestHarness } from './harness.ts';

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
    assert.equal(data.actions.length, 58, 'schema should have all 58 actions');

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

  it('GET /api/schema matches committed snapshot', async () => {
    const { body } = await h.getSchema();
    const snapshotPath = new URL('../snapshots/api-schema.json', import.meta.url).pathname;
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.deepEqual(body.data, snapshot,
      'Schema output changed. If intentional, regenerate the snapshot:\n' +
      '  node --eval "const d=JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')); process.stdout.write(JSON.stringify(d.data,null,2))" < <(curl -s http://127.0.0.1:8787/api/schema) > test/snapshots/api-schema.json');
  });
});
