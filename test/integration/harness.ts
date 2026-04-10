/**
 * Integration test harness for ClawClub.
 *
 * Manages a real Postgres database, real app-role permissions, a real HTTP server
 * on a random port, and real bearer-token authentication.
 *
 * Usage:
 *   const h = await TestHarness.start();
 *   const owen = await h.seedOwner('DogClub');
 *   const result = await h.api(owen.token, 'session.getContext', {});
 *   await h.stop();
 */

import { Pool } from 'pg';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createServer } from '../../src/server.ts';
import { createRepository } from '../../src/postgres.ts';
import { createPostgresMemberUpdateNotifier } from '../../src/member-updates-notifier.ts';
import { buildBearerToken } from '../../src/token.ts';
import { z } from 'zod';
import { getAction } from '../../src/schemas/registry.ts';
import type { QualityGateFn } from '../../src/dispatch.ts';
import {
  authenticatedSuccessEnvelope,
  unauthenticatedSuccessEnvelope,
  errorEnvelope,
  sseReadyEvent,
} from '../../src/schemas/transport.ts';
import { pendingUpdate } from '../../src/schemas/responses.ts';

// Trigger schema registration by importing the dispatch module
import '../../src/dispatch.ts';

/**
 * Recursively apply .strict() to all ZodObject schemas in a type tree.
 * This catches extra/unexpected fields in test responses — Zod strips
 * unknown keys by default, so without strict mode, extra fields silently pass.
 */
function strictify(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const strictShape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(shape)) {
      strictShape[key] = strictify(value as z.ZodType);
    }
    return z.object(strictShape).catchall(z.never());
  }
  if (schema instanceof z.ZodArray) {
    return z.array(strictify(schema.element));
  }
  if (schema instanceof z.ZodNullable) {
    return strictify(schema.unwrap()).nullable();
  }
  if (schema instanceof z.ZodOptional) {
    return strictify(schema.unwrap()).optional();
  }
  // ZodIntersection, ZodUnion, ZodLazy, etc. — pass through as-is.
  return schema;
}

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const DB_NAME_PREFIX = 'clawclub_test';
const APP_ROLE = 'clawclub_app';
const APP_PASSWORD = 'integration_test';
let dbCounter = 0;

function createDbName(): string {
  dbCounter += 1;
  const suffix = `${process.pid}_${dbCounter}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  return `${DB_NAME_PREFIX}_${suffix}`;
}

export type SeededMember = {
  id: string;
  handle: string;
  publicName: string;
  token: string;
};

export type SeededClub = {
  id: string;
  slug: string;
  name: string;
  ownerMemberId: string;
};

export type SeededMembership = {
  id: string;
  clubId: string;
  memberId: string;
  role: string;
  status: string;
};

export class TestHarness {
  pools: { super: Pool; app: Pool };
  private dbName: string;
  private httpServer: ReturnType<typeof createServer>['server'];
  private shutdown: () => Promise<void>;
  port: number;

  private constructor(
    pools: { super: Pool; app: Pool },
    dbName: string,
    httpServer: ReturnType<typeof createServer>['server'],
    shutdown: () => Promise<void>,
    port: number,
  ) {
    this.pools = pools;
    this.dbName = dbName;
    this.httpServer = httpServer;
    this.shutdown = shutdown;
    this.port = port;
  }

  static async start(options: { qualityGate?: QualityGateFn } = {}): Promise<TestHarness> {
    const dbName = createDbName();

    // 1. Create database (terminate stale connections first)
    const bootstrapPool = new Pool({ connectionString: 'postgresql://localhost/postgres' });
    try {
      await bootstrapPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await bootstrapPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await bootstrapPool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await bootstrapPool.end();
    }

    // 2. Provision app role (must exist before init.sql so the schema
    //    can be created under clawclub_app's ownership).
    execSync(
      `CLAWCLUB_DB_APP_PASSWORD="${APP_PASSWORD}" DATABASE_URL="postgresql://localhost/${dbName}" ${ROOT}/scripts/provision-app-role.sh`,
      { stdio: 'pipe' },
    );

    // 3. Apply unified schema (uses SET SESSION AUTHORIZATION clawclub_app
    //    so all objects are owned by the app role).
    execSync(
      `psql "postgresql://localhost/${dbName}" -v ON_ERROR_STOP=1 --single-transaction -f "${ROOT}/db/init.sql"`,
      { stdio: 'pipe' },
    );

    // 4. Run migrations as clawclub_app — this is the same code path
    //    Railway uses on every deploy. If a migration would fail in
    //    production it must fail here too.
    execSync(
      `DATABASE_URL="postgresql://${APP_ROLE}:${APP_PASSWORD}@localhost/${dbName}" ${ROOT}/scripts/migrate.sh`,
      { stdio: 'pipe' },
    );

    // 5. Open pools
    const pools = {
      super: new Pool({ connectionString: `postgresql://localhost/${dbName}` }),
      app: new Pool({ connectionString: `postgresql://${APP_ROLE}:${APP_PASSWORD}@localhost/${dbName}` }),
    };

    // 6. Create repository, notifier, and start server
    const repository = createRepository(pools.app);

    const updatesNotifier = createPostgresMemberUpdateNotifier(
      `postgresql://localhost/${dbName}`,
    );

    const serverInstance = createServer({ repository, updatesNotifier, qualityGate: options.qualityGate });
    const port = await new Promise<number>((resolve) => {
      serverInstance.server.listen(0, () => {
        const addr = serverInstance.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    return new TestHarness(
      pools,
      dbName,
      serverInstance.server,
      serverInstance.shutdown,
      port,
    );
  }

  async stop(): Promise<void> {
    await this.shutdown();
    await this.pools.app.end();
    await this.pools.super.end();

    const bootstrapPool = new Pool({ connectionString: 'postgresql://localhost/postgres' });
    try {
      await bootstrapPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [this.dbName],
      );
      await bootstrapPool.query(`DROP DATABASE IF EXISTS ${this.dbName}`);
    } finally {
      await bootstrapPool.end();
    }
  }

  // ── SQL helper (run as superuser) ──

  async sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pools.super.query<T>(query, params);
    return result.rows;
  }

  // Convenience aliases used in tests that interact with specific domain tables
  sqlClubs = this.sql.bind(this);
  sqlMessaging = this.sql.bind(this);

  // ── Seeding helpers ──

  private async ensureClubProfile(memberId: string, clubId: string): Promise<void> {
    await this.sql(
      `insert into member_club_profile_versions (
         member_id, club_id, version_no, created_by_member_id, generation_source
       )
       select
         $1::short_id,
         $2::short_id,
         coalesce((
           select max(version_no) + 1 from member_club_profile_versions where member_id = $1::short_id and club_id = $2::short_id
         ), 1),
         $1::short_id,
         'membership_seed'
       where not exists (
         select 1 from current_member_club_profiles where member_id = $1::short_id and club_id = $2::short_id
       )`,
      [memberId, clubId],
    );
  }

  async seedMember(publicName: string, handle: string): Promise<SeededMember> {
    const rows = await this.sql<{ id: string }>(
      `INSERT INTO members (public_name, display_name, handle, state)
       VALUES ($1, $1, $2, 'active')
       ON CONFLICT (handle) DO UPDATE
         SET public_name = excluded.public_name,
             display_name = excluded.display_name
       RETURNING id`,
      [publicName, handle],
    );
    const id = rows[0]!.id;

    const token = await this.createToken(id);
    return { id, handle, publicName, token };
  }

  async seedSuperadmin(publicName: string, handle: string): Promise<SeededMember> {
    const member = await this.seedMember(publicName, handle);
    await this.sql(
      `INSERT INTO member_global_role_versions (member_id, role, version_no, created_by_member_id)
       VALUES ($1, 'superadmin', 1, $1) ON CONFLICT DO NOTHING`,
      [member.id],
    );
    return member;
  }

  async seedClub(slug: string, name: string, ownerMemberId: string): Promise<SeededClub> {
    const rows = await this.sql<{ id: string }>(
      `INSERT INTO clubs (slug, name, owner_member_id, summary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [slug, name, ownerMemberId, `A club called ${name}.`],
    );
    const clubId = rows[0]!.id;

    // Owner membership + state
    await this.sql(
      `INSERT INTO club_memberships (club_id, member_id, role)
       VALUES ($1::short_id, $2::short_id, 'clubadmin') ON CONFLICT (club_id, member_id) DO NOTHING`,
      [clubId, ownerMemberId],
    );
    const membershipRows = await this.sql<{ id: string }>(
      `SELECT id FROM club_memberships WHERE club_id = $1 AND member_id = $2`,
      [clubId, ownerMemberId],
    );
    const membershipId = membershipRows[0]!.id;
    await this.sql(
      `INSERT INTO club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       SELECT $1::short_id, 'active', 'seed', coalesce(max(version_no), 0) + 1, $2::short_id
       FROM club_membership_state_versions WHERE membership_id = $1::short_id`,
      [membershipId, ownerMemberId],
    );
    await this.ensureClubProfile(ownerMemberId, clubId);

    // Club version (needed by current_club_versions view)
    await this.sql(
      `INSERT INTO club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
       VALUES ($1::short_id, $2::short_id, $3, $4, null, 1, $2::short_id) ON CONFLICT DO NOTHING`,
      [clubId, ownerMemberId, name, `Test club ${slug}`],
    );

    return { id: clubId, slug, name, ownerMemberId };
  }

  async seedMembership(
    clubId: string,
    memberId: string,
    options: { role?: string; status?: string; sponsorId?: string } = {},
  ): Promise<SeededMembership> {
    const role = options.role ?? 'member';
    const status = options.status ?? 'active';
    const sponsorId = options.sponsorId ?? null;

    await this.sql(
      `INSERT INTO club_memberships (club_id, member_id, role, sponsor_member_id)
       VALUES ($1::short_id, $2::short_id, $3::membership_role, $4::short_id) ON CONFLICT (club_id, member_id) DO NOTHING`,
      [clubId, memberId, role, sponsorId],
    );
    const rows = await this.sql<{ id: string }>(
      `SELECT id FROM club_memberships WHERE club_id = $1 AND member_id = $2`,
      [clubId, memberId],
    );
    const membershipId = rows[0]!.id;

    await this.sql(
      `INSERT INTO club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       SELECT $1::short_id, $2::membership_state, 'seed', coalesce(max(version_no), 0) + 1, $3::short_id
       FROM club_membership_state_versions WHERE membership_id = $1::short_id`,
      [membershipId, status, memberId],
    );

    // Comp non-owners with active status so they get access
    if (role !== 'clubadmin' && status === 'active') {
      await this.sql(
        `UPDATE club_memberships SET is_comped = true, comped_at = now() WHERE id = $1`,
        [membershipId],
      );
    }

    await this.ensureClubProfile(memberId, clubId);

    return { id: membershipId, clubId, memberId, role, status };
  }

  async createToken(memberId: string, label = 'test'): Promise<string> {
    const token = buildBearerToken();
    await this.sql(
      `INSERT INTO member_bearer_tokens (id, member_id, label, token_hash, metadata)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [token.tokenId, memberId, label, token.tokenHash],
    );
    return token.bearerToken;
  }

  // ── API helpers ──

  async api(
    token: string | null,
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = JSON.stringify({ action, input });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/api',
          method: 'POST',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              const parsed = JSON.parse(text);

              // ── Test-enforced contract validation ──
              if (parsed.ok === true) {
                const def = getAction(action);
                if (def?.auth === 'none') {
                  const envResult = strictify(unauthenticatedSuccessEnvelope).safeParse(parsed);
                  if (!envResult.success) {
                    reject(new Error(`[contract] ${action} unauthenticated envelope validation failed: ${envResult.error.message}`));
                    return;
                  }
                } else {
                  const envResult = strictify(authenticatedSuccessEnvelope).safeParse(parsed);
                  if (!envResult.success) {
                    reject(new Error(`[contract] ${action} authenticated envelope validation failed: ${envResult.error.message}`));
                    return;
                  }
                }

                if (def?.wire?.output) {
                  const dataResult = strictify(def.wire.output).safeParse(parsed.data);
                  if (!dataResult.success) {
                    reject(new Error(`[contract] ${action} wire.output validation failed: ${dataResult.error.message}`));
                    return;
                  }
                }
              } else if (parsed.ok === false) {
                const errResult = strictify(errorEnvelope).safeParse(parsed);
                if (!errResult.success) {
                  reject(new Error(`[contract] ${action} error envelope validation failed: ${errResult.error.message}`));
                  return;
                }
              }

              resolve({ status: res.statusCode ?? 0, body: parsed });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  async apiOk(
    token: string | null,
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { status, body } = await this.api(token, action, input);
    if (status !== 200 || !body.ok) {
      throw new Error(
        `Expected OK from ${action} but got ${status}: ${JSON.stringify(body.error ?? body)}`,
      );
    }
    return body;
  }

  async apiErr(
    token: string | null,
    action: string,
    input: Record<string, unknown> = {},
    expectedCode?: string,
  ): Promise<{ status: number; code: string; message: string }> {
    const { status, body } = await this.api(token, action, input);
    if (body.ok) {
      throw new Error(`Expected error from ${action} but got OK: ${JSON.stringify(body)}`);
    }
    const error = body.error as { code: string; message: string };
    if (expectedCode && error.code !== expectedCode) {
      throw new Error(
        `Expected error code ${expectedCode} from ${action} but got ${error.code}: ${error.message}`,
      );
    }
    return { status, code: error.code, message: error.message };
  }

  // ── Convenience: seed a complete owner + club setup ──

  async seedOwner(
    clubSlug: string,
    clubName?: string,
    opts: { handle?: string; publicName?: string } = {},
  ): Promise<SeededMember & { club: SeededClub }> {
    const handle = opts.handle ?? `owner-${clubSlug}`;
    const publicName = opts.publicName ?? `Owner of ${clubName ?? clubSlug}`;
    const member = await this.seedMember(publicName, handle);
    const club = await this.seedClub(clubSlug, clubName ?? clubSlug, member.id);
    return { ...member, club };
  }

  // ── Convenience: seed a regular member with club access ──

  async seedClubMember(
    clubId: string,
    publicName: string,
    handle: string,
    options: { status?: string; sponsorId?: string } = {},
  ): Promise<SeededMember & { membership: SeededMembership }> {
    const member = await this.seedMember(publicName, handle);
    const membership = await this.seedMembership(clubId, member.id, {
      status: options.status ?? 'active',
      sponsorId: options.sponsorId,
    });
    return { ...member, membership };
  }

  // ── GET endpoints ──

  async getUpdates(
    token: string,
    params: { limit?: number; after?: number | 'latest' } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const input: Record<string, unknown> = {};
    if (params.limit !== undefined) input.limit = params.limit;
    if (params.after !== undefined) input.after = String(params.after);

    const { status, body } = await this.api(token, 'updates.list', input);

    // Unwrap: callers expect { status, body: { ok, updates: { items, nextAfter } } }
    // The action envelope is { ok, member, requestScope, data: { updates: { items, nextAfter } } }.
    // Re-shape so body.updates = body.data.updates (the inner updates payload).
    if (body.ok === true && body.data) {
      const data = body.data as Record<string, unknown>;
      const reshaped: Record<string, unknown> = { ok: true, updates: data.updates };
      return { status, body: reshaped };
    }
    return { status, body };
  }

  async getSchema(): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: this.port, path: '/api/schema', method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({ status: res.statusCode ?? 0, body: parsed });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Connect to the SSE stream and collect events until `done` resolves or timeout.
   * Returns parsed SSE events as { event, data, id? } objects.
   */
  connectStream(
    token: string,
    params: { after?: number | 'latest'; limit?: number; lastEventId?: string } = {},
  ): {
    events: Array<{ event: string; data: Record<string, unknown>; id?: string }>;
    close: () => void;
    waitForEvents: (count: number, timeoutMs?: number) => Promise<void>;
  } {
    const qs = new URLSearchParams();
    if (params.after !== undefined) qs.set('after', String(params.after));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const path = `/updates/stream${qs.toString() ? `?${qs}` : ''}`;

    const events: Array<{ event: string; data: Record<string, unknown>; id?: string }> = [];
    const sseValidationErrors: string[] = [];
    const waiters: Array<{ target: number; resolve: () => void }> = [];

    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (params.lastEventId) headers['last-event-id'] = params.lastEventId;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: this.port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const parts = buffer.split('\n\n');
          buffer = parts.pop()!;
          for (const part of parts) {
            if (!part.trim() || part.trim().startsWith(':')) continue;
            let event = 'message';
            let data = '';
            let id: string | undefined;
            for (const line of part.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
              else if (line.startsWith('id: ')) id = line.slice(4);
            }
            if (data) {
              try {
                const parsed = JSON.parse(data);
                if (event === 'ready') {
                  const result = strictify(sseReadyEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE ready event validation failed: ${result.error.message}`);
                  }
                } else if (event === 'update') {
                  const result = strictify(pendingUpdate).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE update event validation failed: ${result.error.message}`);
                  }
                }
                events.push({ event, data: parsed, id });
              } catch { /* ignore non-JSON */ }
            }
            for (const w of [...waiters]) {
              if (events.length >= w.target) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve();
              }
            }
          }
        });
      },
    );
    req.on('error', () => {});
    req.end();

    return {
      events,
      close: () => req.destroy(),
      waitForEvents(count: number, timeoutMs = 5000): Promise<void> {
        const checkErrors = () => {
          if (sseValidationErrors.length > 0) {
            throw new Error(sseValidationErrors.join('\n'));
          }
        };
        if (events.length >= count) { checkErrors(); return Promise.resolve(); }
        return new Promise((resolve, reject) => {
          const waiter = { target: count, resolve };
          waiters.push(waiter);
          const timer = setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(new Error(`Timed out waiting for ${count} events (got ${events.length})`));
          }, timeoutMs);
          const origResolve = waiter.resolve;
          waiter.resolve = () => { clearTimeout(timer); checkErrors(); origResolve(); };
        });
      },
    };
  }
}
