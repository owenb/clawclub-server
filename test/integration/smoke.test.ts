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

  it('GET /api/schema includes self-sufficient transport section', async () => {
    const { body } = await h.getSchema();
    const data = body.data as Record<string, unknown>;
    const transport = data.transport as Record<string, unknown>;
    assert.ok(transport, 'schema should have transport');

    // Endpoints
    const endpoints = transport.endpoints as Record<string, unknown>;
    assert.ok(endpoints.action, 'should have action endpoint');
    assert.ok(endpoints.schema, 'should have schema endpoint');
    assert.ok(endpoints.updates, 'should have updates endpoint');
    assert.ok(endpoints.stream, 'should have stream endpoint');

    // Auth
    const auth = transport.auth as Record<string, unknown>;
    assert.equal(auth.type, 'bearer');
    assert.ok(Array.isArray(auth.unauthenticatedActions));

    // Request envelope
    const envelope = transport.requestEnvelope as Record<string, unknown>;
    assert.ok(envelope.schema, 'should have request envelope schema');
    assert.ok(envelope.example, 'should have request envelope example');

    // Response envelopes
    const envelopes = transport.responseEnvelopes as Record<string, unknown>;
    assert.ok(envelopes.authenticatedSuccess);
    assert.ok(envelopes.unauthenticatedSuccess);
    assert.ok(envelopes.error);

    // Updates
    const updates = transport.updates as Record<string, unknown>;
    const polling = updates.polling as Record<string, unknown>;
    assert.ok(polling.responseSchema, 'should have polling response schema');
    const stream = updates.stream as Record<string, unknown>;
    const events = stream.events as Record<string, unknown>;
    assert.ok(events.ready, 'should have stream ready event schema');
    assert.ok(events.update, 'should have stream update event schema');

    // Transport error codes
    const errorCodes = transport.transportErrorCodes as Array<Record<string, unknown>>;
    assert.ok(errorCodes.length >= 8, 'should have transport error codes');
    const codes = errorCodes.map(e => e.code);
    assert.ok(codes.includes('invalid_input'));
    assert.ok(codes.includes('unauthorized'));
    assert.ok(codes.includes('unknown_action'));

    // schemaHash covers full payload
    assert.ok(typeof data.schemaHash === 'string');
    assert.ok((data.schemaHash as string).length > 0);
  });

  it('error response includes requestTemplate for wrong envelope', async () => {
    const owner = await h.seedOwner('template-envelope', 'TemplateEnvelope');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'session.describe', bogusKey: 'x' });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_input');
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, 'session.describe');
    assert.ok(template.input !== undefined, 'template should have input');
  });

  it('error response includes requestTemplate for missing required fields', async () => {
    const owner = await h.seedOwner('template-fields', 'TemplateFields');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'entities.create', input: {} });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_input');
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, 'entities.create');
    const input = template.input as Record<string, string>;
    assert.ok(input.clubId, 'template should show clubId');
    assert.ok(input.clubId.includes('required'), 'clubId should be marked required');
  });

  it('error response includes generic requestTemplate when action is missing', async () => {
    const { status, body } = await rawPost(h.port, null, { notAction: 'hello' });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, '(action name)');
    assert.deepEqual(template.input, {});
  });

  it('error response includes generic requestTemplate for unknown action', async () => {
    const owner = await h.seedOwner('template-unknown', 'TemplateUnknown');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'bogus.nonexistent' });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'unknown_action');
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, '(action name)');
    assert.deepEqual(template.input, {});
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
