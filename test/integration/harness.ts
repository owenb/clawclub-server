/**
 * Integration test harness for ClawClub.
 *
 * Manages a real Postgres database, real app-role RLS, a real HTTP server
 * on a random port, and real bearer-token authentication.
 *
 * Usage:
 *   const h = await TestHarness.start();
 *   const owen = await h.seedOwner('DogClub');
 *   const result = await h.api(owen.token, 'session.describe', {});
 *   await h.stop();
 */

import { Pool } from 'pg';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createServer } from '../../src/server.ts';
import { buildBearerToken } from '../../src/token.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const DB_NAME = 'clawclub_test';
const APP_ROLE = 'clawclub_app';
const APP_PASSWORD = 'integration_test';

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
  private superPool: Pool;
  private appPool: Pool;
  private httpServer: ReturnType<typeof createServer>['server'];
  private shutdown: () => Promise<void>;
  private dbName: string;
  port: number;

  private constructor(
    superPool: Pool,
    appPool: Pool,
    httpServer: ReturnType<typeof createServer>['server'],
    shutdown: () => Promise<void>,
    port: number,
    dbName: string,
  ) {
    this.superPool = superPool;
    this.appPool = appPool;
    this.httpServer = httpServer;
    this.shutdown = shutdown;
    this.port = port;
    this.dbName = dbName;
  }

  static async start(): Promise<TestHarness> {
    const dbName = DB_NAME;
    const superuserUrl = `postgresql://localhost/${dbName}`;
    const appUrl = `postgresql://${APP_ROLE}:${APP_PASSWORD}@localhost/${dbName}`;

    // 1. Create database (terminate any stale connections first)
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

    // 2. Run migrations
    execSync(
      `DATABASE_URL="${superuserUrl}" ${ROOT}/scripts/migrate.sh`,
      { stdio: 'pipe' },
    );

    // 3. Provision app role
    execSync(
      `CLAWCLUB_DB_APP_PASSWORD="${APP_PASSWORD}" DATABASE_URL="${superuserUrl}" ${ROOT}/scripts/provision-app-role.sh`,
      { stdio: 'pipe' },
    );

    // 4. Open pools
    const superPool = new Pool({ connectionString: superuserUrl });
    const appPool = new Pool({ connectionString: appUrl });

    // 5. Start server on random port (using the real app-role pool)
    process.env.DATABASE_URL = appUrl;
    const serverInstance = createServer();
    const port = await new Promise<number>((resolve) => {
      serverInstance.server.listen(0, () => {
        const addr = serverInstance.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    return new TestHarness(
      superPool,
      appPool,
      serverInstance.server,
      serverInstance.shutdown,
      port,
      dbName,
    );
  }

  async stop(): Promise<void> {
    await this.shutdown();
    await this.appPool.end();
    await this.superPool.end();

    const bootstrapPool = new Pool({ connectionString: 'postgresql://localhost/postgres' });
    try {
      await bootstrapPool.query(`DROP DATABASE IF EXISTS ${this.dbName}`);
    } finally {
      await bootstrapPool.end();
    }
  }

  // ── SQL helpers (run as superuser, bypasses RLS) ──

  async sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.superPool.query<T>(query, params);
    return result.rows;
  }

  // ── Seeding helpers ──

  async seedMember(publicName: string, handle: string): Promise<SeededMember> {
    const rows = await this.sql<{ id: string }>(
      `INSERT INTO app.members (public_name, handle, state)
       VALUES ($1, $2, 'active')
       ON CONFLICT (handle) DO UPDATE SET public_name = excluded.public_name
       RETURNING id`,
      [publicName, handle],
    );
    const id = rows[0]!.id;

    await this.sql(
      `INSERT INTO app.member_profile_versions (member_id, version_no, display_name, created_by_member_id)
       VALUES ($1, 1, $2, $1) ON CONFLICT DO NOTHING`,
      [id, publicName.split(' ')[0]],
    );

    const token = await this.createToken(id);
    return { id, handle, publicName, token };
  }

  async seedSuperadmin(publicName: string, handle: string): Promise<SeededMember> {
    const member = await this.seedMember(publicName, handle);
    await this.sql(
      `INSERT INTO app.member_global_role_versions (member_id, role, version_no, created_by_member_id)
       VALUES ($1, 'superadmin', 1, $1) ON CONFLICT DO NOTHING`,
      [member.id],
    );
    return member;
  }

  async seedClub(slug: string, name: string, ownerMemberId: string): Promise<SeededClub> {
    const rows = await this.sql<{ id: string }>(
      `INSERT INTO app.clubs (slug, name, owner_member_id, summary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [slug, name, ownerMemberId, `A club called ${name}.`],
    );
    const clubId = rows[0]!.id;

    // Owner membership + state
    await this.sql(
      `INSERT INTO app.club_memberships (club_id, member_id, role)
       VALUES ($1::app.short_id, $2::app.short_id, 'owner') ON CONFLICT (club_id, member_id) DO NOTHING`,
      [clubId, ownerMemberId],
    );
    const membershipRows = await this.sql<{ id: string }>(
      `SELECT id FROM app.club_memberships WHERE club_id = $1 AND member_id = $2`,
      [clubId, ownerMemberId],
    );
    const membershipId = membershipRows[0]!.id;
    await this.sql(
      `INSERT INTO app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       SELECT $1::app.short_id, 'active', 'seed', coalesce(max(version_no), 0) + 1, $2::app.short_id
       FROM app.club_membership_state_versions WHERE membership_id = $1::app.short_id`,
      [membershipId, ownerMemberId],
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
      `INSERT INTO app.club_memberships (club_id, member_id, role, sponsor_member_id)
       VALUES ($1::app.short_id, $2::app.short_id, $3::app.membership_role, $4::app.short_id) ON CONFLICT (club_id, member_id) DO NOTHING`,
      [clubId, memberId, role, sponsorId],
    );
    const rows = await this.sql<{ id: string }>(
      `SELECT id FROM app.club_memberships WHERE club_id = $1 AND member_id = $2`,
      [clubId, memberId],
    );
    const membershipId = rows[0]!.id;

    await this.sql(
      `INSERT INTO app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       SELECT $1::app.short_id, $2::app.membership_state, 'seed', coalesce(max(version_no), 0) + 1, $3::app.short_id
       FROM app.club_membership_state_versions WHERE membership_id = $1::app.short_id`,
      [membershipId, status, memberId],
    );

    // Comped subscription for non-owners with active status
    if (role !== 'owner' && status === 'active') {
      // Temporarily disable force RLS so superuser can insert
      await this.sql(`ALTER TABLE app.subscriptions DISABLE ROW LEVEL SECURITY`);
      const ownerRows = await this.sql<{ owner_member_id: string }>(
        `SELECT owner_member_id FROM app.clubs WHERE id = $1`,
        [clubId],
      );
      await this.sql(
        `INSERT INTO app.subscriptions (membership_id, payer_member_id, status, amount, currency)
         VALUES ($1, $2, 'active', 0, 'GBP')`,
        [membershipId, ownerRows[0]!.owner_member_id],
      );
      await this.sql(`ALTER TABLE app.subscriptions ENABLE ROW LEVEL SECURITY`);
      await this.sql(`ALTER TABLE app.subscriptions FORCE ROW LEVEL SECURITY`);
    }

    return { id: membershipId, clubId, memberId, role, status };
  }

  async createToken(memberId: string, label = 'test'): Promise<string> {
    const token = buildBearerToken();
    await this.sql(
      `INSERT INTO app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
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
    params: { limit?: number; after?: number } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.after !== undefined) qs.set('after', String(params.after));
    const path = `/updates${qs.toString() ? `?${qs}` : ''}`;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        },
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
}
