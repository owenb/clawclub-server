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
    assert.equal(memberships[0].role, 'owner');
  });

  it('GET /api/schema returns deterministic non-superadmin action schemas', async () => {
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
    assert.equal(data.version, '1.0');
    assert.ok(data.actions.length > 0, 'schema should have actions');

    // No superadmin actions in public schema
    for (const a of data.actions) {
      assert.notEqual(a.auth, 'superadmin', `${a.action} should not be superadmin`);
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

    // Public schema should have exactly 38 non-superadmin actions (admissions.clubs moved to superadmin)
    assert.equal(data.actions.length, 38, 'public schema should have 38 actions');

    // Verify key actions are present — including ones that were previously hidden
    assert.ok(names.includes('session.describe'), 'should include session.describe');
    assert.ok(names.includes('entities.create'), 'should include entities.create');
    assert.ok(names.includes('entities.update'), 'should include entities.update');
    assert.ok(!names.includes('admissions.clubs'), 'admissions.clubs should NOT be in public schema');
    assert.ok(names.includes('admissions.challenge'), 'should include admissions.challenge');
    assert.ok(names.includes('updates.acknowledge'), 'should include updates.acknowledge');
    assert.ok(names.includes('memberships.list'), 'should include memberships.list');
    assert.ok(names.includes('memberships.create'), 'should include memberships.create');
    assert.ok(names.includes('memberships.transition'), 'should include memberships.transition');
    assert.ok(names.includes('admissions.issueAccess'), 'should include admissions.issueAccess');
    assert.ok(names.includes('members.list'), 'should include members.list');
    assert.ok(names.includes('tokens.list'), 'should include tokens.list');
    assert.ok(names.includes('messages.list'), 'should include messages.list');
    assert.ok(names.includes('messages.redact'), 'should include messages.redact');
    assert.ok(names.includes('entities.redact'), 'should include entities.redact');

    // No clubs.* or admin.* in public schema
    assert.ok(!names.some(n => n.startsWith('clubs.')), 'should not include clubs.*');
    assert.ok(!names.some(n => n.startsWith('admin.')), 'should not include admin.*');

    // Verify a second call returns identical output (cached, stable)
    const { body: body2 } = await h.getSchema();
    assert.deepEqual(body, body2);
  });

  it('GET /api/schema?full=1 requires superadmin auth', async () => {
    const owner = await h.seedOwner('schemaclub', 'SchemaClub');
    const admin = await h.seedSuperadmin('Schema Admin', 'schema-admin');
    const adminToken = await h.createToken(admin.id, 'schema-test');

    // Non-superadmin with ?full=1 gets public schema (same as default)
    const { body: publicBody } = await h.getSchema();
    const { body: ownerBody } = await h.getSchema(owner.token, { full: true });
    const publicActions = (publicBody.data as { actions: unknown[] }).actions;
    const ownerActions = (ownerBody.data as { actions: unknown[] }).actions;
    assert.deepEqual(ownerActions, publicActions, 'non-superadmin ?full=1 should return public schema');

    // Superadmin with ?full=1 gets all actions
    const { status, body: fullBody } = await h.getSchema(adminToken, { full: true });
    assert.equal(status, 200);
    const fullData = fullBody.data as { actions: Array<{ action: string; auth: string }> };

    // Full schema should have all 56 actions (admissions.clubs is now superadmin)
    assert.equal(fullData.actions.length, 56, 'full schema should have 56 actions');
    assert.equal(publicActions.length, 38, 'public schema should have 38 actions');

    // Full schema includes superadmin actions (17 original + admissions.clubs = 18)
    const superadminActions = fullData.actions.filter(a => a.auth === 'superadmin');
    assert.equal(superadminActions.length, 18, 'full schema should have 18 superadmin actions');

    // Full schema includes clubs.* and admin.*
    const names = fullData.actions.map(a => a.action);
    assert.ok(names.some(n => n.startsWith('clubs.')), 'full schema should include clubs.*');
    assert.ok(names.some(n => n.startsWith('admin.')), 'full schema should include admin.*');

    // Full schema still sorted
    assert.deepEqual(names, [...names].sort());
  });

  it('GET /api/schema matches committed snapshot', async () => {
    const { body } = await h.getSchema();
    const snapshotPath = new URL('../snapshots/api-schema-public.json', import.meta.url).pathname;
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.deepEqual(body.data, snapshot,
      'Schema output changed. If intentional, regenerate the snapshot:\n' +
      '  curl -s http://127.0.0.1:8787/api/schema | node -e "process.stdin.pipe(require(\'stream\').pipeline(process.stdin, require(\'fs\').createWriteStream(\'test/snapshots/api-schema-public.json\')))"\n' +
      'Or run: node --eval "const d=JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')); process.stdout.write(JSON.stringify(d.data,null,2))" < <(curl -s http://127.0.0.1:8787/api/schema) > test/snapshots/api-schema-public.json');
  });
});
