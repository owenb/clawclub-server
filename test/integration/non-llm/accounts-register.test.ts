import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TestHarness } from '../harness.ts';
import { findPowNonce, prepareAccountRegistration, registerWithPow } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

beforeEach(() => {
  h.__resetRateLimitForTests();
});

function rawPostWithHeaders(
  port: number,
  jsonBody: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(jsonBody));
    req.end();
  });
}

describe('accounts.register', () => {
  it('discovers a PoW challenge and registers a zero-membership bearer holder', async () => {
    const challenge = await prepareAccountRegistration(h, 'register-discover-1');
    assert.ok(challenge.challengeBlob);
    assert.ok(challenge.challengeId);
    assert.ok(challenge.difficulty > 0);

    const registered = await registerWithPow(h, {
      name: 'Fresh Member',
      email: 'fresh@example.com',
      clientKey: 'register-submit-1',
    });

    assert.ok(registered.bearerToken.startsWith('clawclub_'));

    const session = await h.apiOk(registered.bearerToken, 'session.getContext', {});
    const actor = session.actor as Record<string, unknown>;
    const memberships = actor.activeMemberships as Array<Record<string, unknown>>;
    assert.equal(actor.member.id, registered.memberId);
    assert.deepEqual(memberships, []);

    const updates = await h.getUpdates(registered.bearerToken, {});
    const notifications = ((updates.body.data as Record<string, unknown>).notifications as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(
      notifications.some((notification) => notification.topic === 'account.registered'),
      'registration should fan out a welcome notification on updates.list',
    );

    const refs = await h.sql<{
      ref_role: string;
      ref_kind: string;
      ref_id: string;
    }>(
      `select nr.ref_role, nr.ref_kind, nr.ref_id
         from notification_refs nr
         join member_notifications mn on mn.id = nr.notification_id
        where mn.recipient_member_id = $1
          and mn.topic = 'account.registered'
        order by nr.ref_role, nr.ref_kind, nr.ref_id`,
      [registered.memberId],
    );
    assert.deepEqual(refs, [
      { ref_role: 'subject', ref_kind: 'member', ref_id: registered.memberId },
    ]);
  });

  it('same-clientKey retry never replays the bearer token', async () => {
    const challenge = await prepareAccountRegistration(h, 'register-replay');
    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
    const first = await h.apiOk(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'register-replay',
      name: 'Replay Member',
      email: 'replay@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
    });
    const firstData = first.data as Record<string, unknown>;
    assert.equal(firstData.phase, 'registered');
    assert.equal((firstData.credentials as Record<string, unknown>).kind, 'member_bearer');

    const replay = await h.apiOk(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'register-replay',
      name: 'Replay Member',
      email: 'replay@example.com',
      challengeBlob: challenge.challengeBlob,
      nonce,
    });

    const data = replay.data as Record<string, unknown>;
    assert.equal(data.phase, 'registration_already_completed');
    assert.equal('credentials' in data, false, 'replayed register response must never include the bearer');
  });

  it('rejects duplicate email registration case-insensitively', async () => {
    await registerWithPow(h, {
      name: 'First Email Holder',
      email: 'duplicate@example.com',
      clientKey: 'register-duplicate-email-1',
    });

    const challenge = await prepareAccountRegistration(h, 'register-duplicate-email-2');
    const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
    const err = await h.apiErr(null, 'accounts.register', {
      mode: 'submit',
      clientKey: 'register-duplicate-email-2',
      name: 'Second Email Holder',
      email: ' Duplicate@Example.com ',
      challengeBlob: challenge.challengeBlob,
      nonce,
    });

    assert.equal(err.status, 409);
    assert.equal(err.code, 'email_already_registered');
  });

  it('registered zero-membership bearers cannot access clubs they do not belong to', async () => {
    const owner = await h.seedOwner('registered-scope-club', 'Registered Scope Club');
    const registered = await registerWithPow(h, {
      name: 'Scoped Member',
      email: 'scoped@example.com',
      clientKey: 'register-scoped',
    });

    const err = await h.apiErr(registered.bearerToken, 'members.list', {
      clubId: owner.club.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('rate-limits unauthenticated discover calls by validated client IP', async () => {
    const results: Array<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(await rawPostWithHeaders(
        h.port,
        { action: 'accounts.register', input: { mode: 'discover' } },
        { 'x-forwarded-for': '203.0.113.44' },
      ));
    }

    const successes = results.filter((result) => result.status === 200);
    const limited = results.filter((result) => result.status === 429);
    assert.equal(successes.length, 20);
    assert.equal(limited.length, 5);
    for (const result of limited) {
      assert.equal(result.headers['retry-after'], '60');
      assert.equal(result.body.ok, false);
      assert.equal(((result.body.error as Record<string, unknown>).code), 'rate_limited');
    }
  });
});

describe('accounts.updateContactEmail', () => {
  it('updates the member contact email', async () => {
    const registered = await registerWithPow(h, {
      name: 'Email Update Member',
      email: 'before@example.com',
      clientKey: 'register-email-update',
    });

    const result = await h.apiOk(registered.bearerToken, 'accounts.updateContactEmail', {
      newEmail: 'after@example.com',
      clientKey: 'update-email-1',
    });
    const member = (result.data as Record<string, unknown>).member as Record<string, unknown>;
    assert.equal(member.email, 'after@example.com');

    const [row] = await h.sql<{ email: string }>(
      `select email from members where id = $1`,
      [registered.memberId],
    );
    assert.equal(row?.email, 'after@example.com');
  });

  it('rejects updating contact email to one already used by another member', async () => {
    await registerWithPow(h, {
      name: 'Occupied Email Owner',
      email: 'occupied@example.com',
      clientKey: 'register-occupied-email-owner',
    });
    const registered = await registerWithPow(h, {
      name: 'Updater Person',
      email: 'updater@example.com',
      clientKey: 'register-email-collision-target',
    });

    const err = await h.apiErr(registered.bearerToken, 'accounts.updateContactEmail', {
      newEmail: ' OCCUPIED@example.com ',
      clientKey: 'update-email-collision',
    });

    assert.equal(err.status, 409);
    assert.equal(err.code, 'email_already_registered');
  });
});

describe('application drafting ergonomics', () => {
  it('accepts empty socials when submitting a club application', async () => {
    const owner = await h.seedOwner('empty-socials-club', 'Empty Socials Club');
    const applicant = await registerWithPow(h, {
      name: 'No Socials Person',
      email: 'nosocials@example.com',
      clientKey: 'register-empty-socials',
    });

    const result = await h.apiOk(applicant.bearerToken, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: {
        name: 'No Socials Person',
        socials: '',
        application: 'I would like to join because I can contribute thoughtful discussion.',
      },
      clientKey: 'apply-empty-socials-1',
    });

    const data = result.data as Record<string, unknown>;
    const draft = data.draft as Record<string, unknown>;
    assert.equal(draft.socials, '');
  });
});
