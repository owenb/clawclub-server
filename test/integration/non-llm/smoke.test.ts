import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { TestHarness } from '../harness.ts';

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
  it('owner can call session.getContext and see their club', async () => {
    const owner = await h.seedOwner('smokeclub', 'SmokeClub');
    const result = await h.apiOk(owner.token, 'session.getContext', {});
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
        businessErrors?: Array<{ code: string; meaning: string; recovery: string }>;
        input: unknown;
        notes?: string[];
        output: unknown;
        scopeRules?: string[];
      }>;
    };
    assert.ok(data.version, 'schema should have a version');
    assert.ok(data.actions.length > 50, 'schema should expose a substantial action surface');

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
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

    // Verify key actions across all auth levels
    assert.ok(names.includes('session.getContext'), 'should include session.getContext');
    assert.ok(names.includes('content.create'), 'should include content.create');
    assert.ok(names.some(n => n.startsWith('clubadmin.')), 'should include clubadmin.*');
    assert.ok(names.some(n => n.startsWith('superadmin.')), 'should include superadmin.*');
    assert.ok(!names.some(n => n.startsWith('admin.')), 'should not include admin.*');

    const sessionGetContext = data.actions.find((a) => a.action === 'session.getContext');
    assert.ok(sessionGetContext?.notes?.some((note) => /authenticated envelope/i.test(note) && /actor/i.test(note)), 'session.getContext should document actor-envelope notes');

    const messagesSend = data.actions.find((a) => a.action === 'messages.send');
    assert.ok(messagesSend?.scopeRules?.some((rule) => /not club-scoped/i.test(rule)), 'messages.send should document DM scope rules');

    const contentCreate = data.actions.find((a) => a.action === 'content.create');
    const contentCreateErrorCodes = new Set(contentCreate?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(contentCreateErrorCodes.has('quota_exceeded'), 'content.create should document quota_exceeded');
    assert.ok(contentCreateErrorCodes.has('illegal_content'), 'content.create should document illegal_content');
    assert.ok(contentCreateErrorCodes.has('gate_unavailable'), 'content.create should document gate_unavailable');
    assert.ok(contentCreateErrorCodes.has('invalid_mentions'), 'content.create should document invalid_mentions');

    const contentUpdate = data.actions.find((a) => a.action === 'content.update');
    const contentUpdateErrorCodes = new Set(contentUpdate?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(contentUpdateErrorCodes.has('invalid_mentions'), 'content.update should document invalid_mentions');
    assert.ok(contentUpdateErrorCodes.has('forbidden'), 'content.update should document forbidden');

    const messagesSendAction = data.actions.find((a) => a.action === 'messages.send');
    const messagesSendErrorCodes = new Set(messagesSendAction?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(messagesSendErrorCodes.has('invalid_mentions'), 'messages.send should document invalid_mentions');

    const accountsRegister = data.actions.find((a) => a.action === 'accounts.register');
    assert.ok(accountsRegister, 'accounts.register should exist');
    assert.ok(accountsRegister?.notes?.some((note) => /only anonymous action/i.test(note)), 'accounts.register should document its anonymous role');
    assert.ok(accountsRegister?.notes?.some((note) => /Proof-of-work/i.test(note)), 'accounts.register should point schema readers at the PoW algorithm note');
    assert.ok(accountsRegister?.notes?.some((note) => /returns the member bearer exactly once/i.test(note)), 'accounts.register should document one-time bearer delivery');
    assert.ok(accountsRegister?.notes?.some((note) => /updates\.list/i.test(note)), 'accounts.register should direct clients to poll updates.list');
    const accountsRegisterInput = accountsRegister?.input as Record<string, unknown> | undefined;
    const accountsRegisterVariants = (
      (accountsRegisterInput?.oneOf as Array<Record<string, unknown>> | undefined)
      ?? (accountsRegisterInput?.anyOf as Array<Record<string, unknown>> | undefined)
      ?? []
    );
    const discoverBranch = accountsRegisterVariants.find((branch) => {
      const mode = ((branch.properties as Record<string, Record<string, unknown>> | undefined)?.mode?.enum as string[] | undefined)?.[0];
      return mode === 'discover';
    });
    const discoverRequired = new Set((discoverBranch?.required as string[] | undefined) ?? []);
    assert.ok(discoverRequired.has('mode'), 'accounts.register discover branch should require mode');
    assert.equal(discoverRequired.has('clientKey'), false, 'accounts.register discover branch should not require clientKey');
    assert.equal(names.includes('activity.list'), false, 'activity.list should be removed in favor of updates.list');
    assert.equal(names.includes('notifications.list'), false, 'notifications.list should be removed in favor of updates.list');
    assert.equal(names.includes('messages.getInbox'), false, 'messages.getInbox should be removed in favor of updates.list');
    assert.equal(names.includes('profile.list'), false, 'profile.list should be removed in favor of members.get');
    assert.equal(names.includes('members.updateIdentity'), false, 'members.updateIdentity should be renamed to accounts.updateIdentity');
    assert.equal(names.includes('events.cancelRsvp'), false, 'events.cancelRsvp should be merged into events.setRsvp');
    assert.equal(names.includes('content.reopenLoop'), false, 'content.reopenLoop should be merged into content.setLoopState');
    assert.equal(names.includes('clubadmin.memberships.create'), false, 'clubadmin.memberships.create should be removed; only superadmin direct-add remains');

    const clubsListPublic = data.actions.find((a) => a.action === 'clubs.list');
    assert.equal(clubsListPublic, undefined, 'clubs.list must not exist — clubs are private, only superadmin.clubs.list enumerates them');

    const clubsApply = data.actions.find((a) => a.action === 'clubs.apply');
    assert.ok(clubsApply?.notes?.some((note) => /existing bearer-authenticated account/i.test(note) || /Registration happens separately/i.test(note)), 'clubs.apply should document register-then-apply separation');
    const clubsApplyErrorCodes = new Set(clubsApply?.businessErrors?.map((error) => error.code) ?? []);
    assert.deepEqual(
      clubsApplyErrorCodes,
      new Set([
        'quota_exceeded',
        'application_limit_reached',
        'application_in_flight',
        'application_blocked',
        'member_already_active',
        'membership_exists',
        'application_not_mutable',
        'invitation_ambiguous',
        'invitation_not_found',
        'client_key_conflict',
      ]),
      'clubs.apply should document the real application-entry errors',
    );
    const clubsApplyInput = clubsApply?.input as Record<string, unknown> | undefined;
    const clubsApplyProperties = clubsApplyInput?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.ok(clubsApplyProperties?.clubSlug, 'clubs.apply should take clubSlug');
    assert.equal('clubId' in (clubsApplyProperties ?? {}), false, 'clubs.apply should not take clubId');
    assert.match(String(clubsApplyProperties?.clubSlug?.description ?? ''), /no public directory/i, 'clubs.apply clubSlug description should make clear clubs are private');
    assert.match(String(clubsApplyProperties?.clientKey?.description ?? ''), /same payload replays the stored response/i, 'clubs.apply clientKey description should explain replay semantics');
    assert.match(
      String((((clubsApplyProperties?.draft as Record<string, unknown> | undefined)?.properties as Record<string, Record<string, unknown>> | undefined)?.socials?.description) ?? ''),
      /empty is fine/i,
      'clubs.apply socials description should allow empty strings',
    );
    const clubsApplyOutput = clubsApply?.output as Record<string, unknown> | undefined;
    const clubsApplyApplication = ((clubsApplyOutput?.properties as Record<string, Record<string, unknown>> | undefined)?.application as Record<string, unknown> | undefined);
    const clubsApplyApplicationProperties = clubsApplyApplication?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.match(String(clubsApplyApplicationProperties?.submissionPath?.description ?? ''), /historical metadata/i, 'submissionPath should be explained as historical metadata');

    const clubsApplicationsRevise = data.actions.find((a) => a.action === 'clubs.applications.revise');
    const clubsApplicationsReviseErrors = new Set(clubsApplicationsRevise?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(clubsApplicationsReviseErrors.has('client_key_conflict'), 'clubs.applications.revise should document client_key_conflict');

    const invitationsRedeem = data.actions.find((a) => a.action === 'invitations.redeem');
    assert.ok(invitationsRedeem, 'invitations.redeem should exist');
    const invitationsRedeemErrors = new Set(invitationsRedeem?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(invitationsRedeemErrors.has('application_limit_reached'), 'invitations.redeem should document application_limit_reached');
    assert.ok(invitationsRedeemErrors.has('application_in_flight'), 'invitations.redeem should document application_in_flight');
    assert.ok(invitationsRedeemErrors.has('application_blocked'), 'invitations.redeem should document application_blocked');
    assert.ok(invitationsRedeemErrors.has('member_already_active'), 'invitations.redeem should document member_already_active');
    assert.ok(invitationsRedeemErrors.has('membership_exists'), 'invitations.redeem should document membership_exists');
    assert.ok(invitationsRedeemErrors.has('application_not_mutable'), 'invitations.redeem should document application_not_mutable');
    assert.ok(invitationsRedeemErrors.has('client_key_conflict'), 'invitations.redeem should document client_key_conflict');
    assert.equal(invitationsRedeemErrors.has('invite_email_mismatch'), false, 'invitations.redeem should not require an email match');
    const invitationsRedeemInput = invitationsRedeem?.input as Record<string, unknown> | undefined;
    const invitationsRedeemProperties = invitationsRedeemInput?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.match(
      String((((invitationsRedeemProperties?.draft as Record<string, unknown> | undefined)?.properties as Record<string, Record<string, unknown>> | undefined)?.socials?.description) ?? ''),
      /empty is fine/i,
      'invitations.redeem socials description should allow empty strings',
    );

    const invitationsIssue = data.actions.find((a) => a.action === 'invitations.issue');
    const invitationsIssueErrors = new Set(invitationsIssue?.businessErrors?.map((error) => error.code) ?? []);
    assert.ok(invitationsIssueErrors.has('invitation_already_open'), 'invitations.issue should document invitation_already_open');
    const invitationsIssueInput = invitationsIssue?.input as Record<string, unknown> | undefined;
    const invitationsIssueProperties = invitationsIssueInput?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.ok(invitationsIssueProperties?.clubId, 'invitations.issue should take clubId');
    assert.ok(invitationsIssueProperties?.candidateMemberId, 'invitations.issue should support inviting an existing registered member by memberId');
    assert.equal('clubSlug' in (invitationsIssueProperties ?? {}), false, 'invitations.issue should not take clubSlug');
    assert.match(String(invitationsIssueProperties?.clubId?.description ?? ''), /session\.getContext\.activeMemberships/i, 'invitations.issue clubId description should point at active memberships');

    const clubadminApplicationsList = data.actions.find((a) => a.action === 'clubadmin.applications.list');
    const clubadminApplicationsListInput = clubadminApplicationsList?.input as Record<string, unknown> | undefined;
    const clubadminApplicationsListProperties = clubadminApplicationsListInput?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.ok(clubadminApplicationsListProperties?.clubId, 'clubadmin.applications.list should take clubId');
    assert.equal('clubSlug' in (clubadminApplicationsListProperties ?? {}), false, 'clubadmin.applications.list should not take clubSlug');
    assert.match(String(clubadminApplicationsListProperties?.clubId?.description ?? ''), /session\.getContext\.activeMemberships/i, 'clubadmin.applications.list clubId description should point at active memberships');

    const superadminClubsUpdate = data.actions.find((a) => a.action === 'superadmin.clubs.update');
    const superadminClubsUpdateInput = superadminClubsUpdate?.input as Record<string, unknown> | undefined;
    const superadminClubsUpdateProperties = superadminClubsUpdateInput?.properties as Record<string, Record<string, unknown>> | undefined;
    assert.ok(superadminClubsUpdateProperties?.clubId, 'superadmin.clubs.update should take clubId');
    assert.equal('clubSlug' in (superadminClubsUpdateProperties ?? {}), false, 'superadmin.clubs.update should not take clubSlug');
    assert.match(String(superadminClubsUpdateProperties?.clubId?.description ?? ''), /session\.getContext\.activeMemberships/i, 'superadmin.clubs.update clubId description should point at active memberships');

    const eventsList = data.actions.find((a) => a.action === 'events.list') as Record<string, unknown> | undefined;
    assert.ok(eventsList, 'events.list should exist');
    assert.equal('businessErrors' in eventsList, false, 'actions without metadata should omit empty businessErrors arrays');
    assert.equal('scopeRules' in eventsList, false, 'actions without metadata should omit empty scopeRules arrays');
    assert.equal('notes' in eventsList, false, 'actions without metadata should omit empty notes arrays');

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

  it('rejects top-level parameters outside input (content.list)', async () => {
    const owner = await h.seedOwner('transport-contents', 'TransportEntities');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'content.list', clubId: owner.club.id });
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
    const admin = await h.seedSuperadmin('Transport Admin');
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
    const { status, body } = await rawPost(h.port, null, { action: 'accounts.register' });
    // Should be 400 from the ACTION's validation (missing mode/clientKey), not from transport validation.
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
    assert.ok(endpoints.stream, 'should have stream endpoint');

    // Auth
    const auth = transport.auth as Record<string, unknown>;
    assert.equal(auth.type, 'bearer');
    assert.ok(Array.isArray(auth.unauthenticatedActions));
    assert.equal(
      (auth.unauthenticatedActions as string[]).includes('clubs.list'),
      false,
      'clubs.list must not be advertised — clubs are private, there is no public directory',
    );

    // Request envelope
    const envelope = transport.requestEnvelope as Record<string, unknown>;
    assert.ok(envelope.schema, 'should have request envelope schema');
    assert.ok(envelope.example, 'should have request envelope example');

    // Response envelopes
    const envelopes = transport.responseEnvelopes as Record<string, unknown>;
    assert.ok(envelopes.authenticatedSuccess);
    assert.ok(envelopes.unauthenticatedSuccess);
    assert.ok(envelopes.error);

    // Stream
    const stream = transport.stream as Record<string, unknown>;
    const events = stream.events as Record<string, unknown>;
    assert.ok(events.ready, 'should have stream ready event schema');
    assert.ok(events.activity, 'should have stream activity event schema');
    assert.ok(events.message, 'should have stream message event schema');
    assert.ok(events.notifications_dirty, 'should have stream notifications_dirty event schema');

    // Stream contract
    const streamQp = stream.queryParameters as Record<string, unknown>;
    assert.ok(streamQp.after, 'stream should document after param');
    assert.ok(streamQp.limit, 'stream should document limit param');
    assert.ok(stream.resumeHeaders, 'stream should document resume headers');
    assert.ok(stream.sseIdBehavior, 'stream should document SSE id behavior');
    assert.ok(stream.heartbeat, 'stream should document heartbeat');
    assert.ok(typeof stream.maxConcurrentStreamsPerMember === 'number', 'stream should document max concurrent streams');
    assert.ok(transport.acknowledgment, 'transport should document acknowledgment semantics');

    // Transport error codes
    const errorCodes = transport.transportErrorCodes as Array<Record<string, unknown>>;
    assert.ok(errorCodes.length >= 12, 'should have all transport error codes');
    const codes = errorCodes.map(e => e.code);
    assert.ok(codes.includes('invalid_input'));
    assert.ok(codes.includes('unauthorized'));
    assert.ok(codes.includes('unknown_action'));
    assert.ok(codes.includes('not_found'), 'should include not_found for unsupported routes');
    assert.equal(codes.includes('too_many_streams'), false, 'should not advertise retired stream-cap errors');
    assert.ok(codes.includes('not_available'), 'should include not_available for missing capabilities');
    assert.ok(codes.includes('stale_client'), 'should include stale_client for schema refresh mismatches');

    // schemaHash covers full payload
    assert.ok(typeof data.schemaHash === 'string');
    assert.ok((data.schemaHash as string).length > 0);
  });

  it('error response includes requestTemplate for wrong envelope', async () => {
    const owner = await h.seedOwner('template-envelope', 'TemplateEnvelope');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'session.getContext', bogusKey: 'x' });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_input');
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, 'session.getContext');
    assert.ok(template.input !== undefined, 'template should have input');
  });

  it('error response includes requestTemplate for missing required fields', async () => {
    const owner = await h.seedOwner('template-fields', 'TemplateFields');
    const { status, body } = await rawPost(h.port, owner.token, { action: 'content.create', input: {} });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_input');
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, 'content.create');
    const input = template.input as Record<string, string>;
    assert.ok(input.kind, 'template should show kind');
    assert.ok(input.kind.includes('one of'), 'kind should be described as the required enum selector');
    assert.equal(input.clubId, '(string, optional)');
  });

  it('accounts.register discriminator errors name the accepted modes and provide a useful template', async () => {
    const { status, body } = await rawPost(h.port, null, { action: 'accounts.register', input: {} });
    assert.equal(status, 400);
    const error = body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_input');
    assert.match(String(error.message), /expected one of 'discover' \| 'submit'/i);

    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, 'accounts.register');
    const input = template.input as Record<string, string>;
    assert.match(String(input.mode), /one of: discover, submit/i);
    assert.equal(input.clientKey, undefined, 'discover template should not invent a clientKey requirement');
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
    assert.match(String(error.message), /server has been updated/i);
    assert.match(String(error.message), /curl .*\/skill/i);
    assert.match(String(error.message), /curl .*\/api\/schema/i);
    const template = error.requestTemplate as Record<string, unknown>;
    assert.ok(template, 'should include requestTemplate');
    assert.equal(template.action, '(action name)');
    assert.deepEqual(template.input, {});
  });

  it('GET /api/schema matches committed snapshot', async () => {
    const { body } = await h.getSchema();
    const packageJsonPath = new URL('../../../package.json', import.meta.url).pathname;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
    const snapshotPath = new URL('../../snapshots/api-schema.json', import.meta.url).pathname;
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    const schema = body.data as Record<string, unknown>;
    assert.equal(schema.version, packageJson.version);
    const { version: _snapshotVersion, ...snapshotWithoutVersion } = snapshot;
    const { version: _schemaVersion, ...schemaWithoutVersion } = schema;
    assert.deepEqual(schemaWithoutVersion, snapshotWithoutVersion,
      'Schema output changed. If intentional, regenerate the snapshot:\n' +
      '  node --eval "const d=JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')); process.stdout.write(JSON.stringify(d.data,null,2))" < <(curl -s http://127.0.0.1:8787/api/schema) > test/snapshots/api-schema.json');
  });
});
