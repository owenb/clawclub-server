import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

  it('GET /api/schema returns deterministic aiExposed action schemas', async () => {
    const { status, body } = await h.getSchema();
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const data = body.data as { version: string; actions: Array<{ action: string; aiExposed: boolean; input: unknown; output: unknown }> };
    assert.equal(data.version, '1.0');
    assert.ok(data.actions.length > 0, 'schema should have actions');

    // All returned actions must be aiExposed
    for (const a of data.actions) {
      assert.equal(a.aiExposed, true, `${a.action} should be aiExposed`);
      assert.ok(a.input, `${a.action} should have input schema`);
      assert.ok(a.output, `${a.action} should have output schema`);
    }

    // Actions must be sorted by name (deterministic)
    const names = data.actions.map(a => a.action);
    assert.deepEqual(names, [...names].sort());

    // Verify a known action is present
    assert.ok(names.includes('session.describe'), 'should include session.describe');
    assert.ok(names.includes('entities.create'), 'should include entities.create');

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
    const fullData = fullBody.data as { actions: Array<{ action: string; aiExposed: boolean }> };
    assert.ok(fullData.actions.length > publicActions.length, 'full schema should have more actions than public');

    // Full schema includes non-aiExposed actions
    const nonExposed = fullData.actions.filter(a => !a.aiExposed);
    assert.ok(nonExposed.length > 0, 'full schema should include non-aiExposed actions');

    // Full schema still sorted
    const names = fullData.actions.map(a => a.action);
    assert.deepEqual(names, [...names].sort());
  });
});
