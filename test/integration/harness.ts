/**
 * Integration test harness for ClawClub.
 *
 * Manages a real Postgres database, real app-role permissions, a real HTTP server
 * on a random port, and real bearer-token authentication.
 *
 * Usage:
 *   const h = await TestHarness.start();
 *   const owner = await h.seedOwner('DogClub');
 *   const result = await h.api(owner.token, 'session.getContext', {});
 *   await h.stop();
 */

import { Pool, type PoolClient } from 'pg';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createServer } from '../../src/server.ts';
import { DEFAULT_CONFIG_V1, initializeConfigForTests, resetConfigForTests, type AppConfig } from '../../src/config/index.ts';
import { createRepository } from '../../src/postgres.ts';
import { createPostgresMemberUpdateNotifier } from '../../src/member-updates-notifier.ts';
import { buildInvitationCode } from '../../src/token.ts';
import { z } from 'zod';
import { getAction } from '../../src/schemas/registry.ts';
import type { LlmGateFn } from '../../src/dispatch.ts';
import { registerWithPow } from './helpers.ts';
import { findNonCanonicalTimestampPaths } from '../../src/timestamps.ts';
import {
  authenticatedSuccessEnvelope,
  unauthenticatedSuccessEnvelope,
  errorEnvelope,
  sseReadyEvent,
  sseActivityEvent,
  sseMessageEvent,
  sseNotificationsDirtyEvent,
} from '../../src/schemas/transport.ts';

// Trigger schema registration by importing the dispatch module
import '../../src/dispatch.ts';

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Recursively apply .strict() to all ZodObject schemas in a type tree.
 * This catches extra/unexpected fields in test responses — Zod strips
 * unknown keys by default, so without strict mode, extra fields silently pass.
 */
function strictify(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const strictShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(shape)) {
      strictShape[key] = strictify(value as z.ZodTypeAny);
    }
    return z.object(strictShape).catchall(z.never());
  }
  if (schema instanceof z.ZodArray) {
    return z.array(strictify(schema.element as z.ZodTypeAny));
  }
  if (schema instanceof z.ZodNullable) {
    return strictify(schema.unwrap() as z.ZodTypeAny).nullable();
  }
  if (schema instanceof z.ZodOptional) {
    return strictify(schema.unwrap() as z.ZodTypeAny).optional();
  }
  // ZodIntersection, ZodUnion, ZodLazy, etc. — pass through as-is.
  return schema;
}

function assertCanonicalTimestamps(action: string, label: string, value: unknown): Error | null {
  const invalidPaths = findNonCanonicalTimestampPaths(value);
  if (invalidPaths.length === 0) {
    return null;
  }
  return new Error(`[contract] ${action} ${label} contains non-canonical timestamps at: ${invalidPaths.join(', ')}`);
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

export type SeededInvitation = {
  id: string;
  clubId: string;
  sponsorId: string;
  candidateName: string;
  candidateEmail: string;
  code: string;
  expiresAt: string;
  usedAt: string | null;
  usedMembershipId: string | null;
  revokedAt: string | null;
};

export type LeakAuditContext = {
  testClub: SeededClub;
  regularMember: SeededMember & { membership: SeededMembership };
  otherMember: SeededMember & { membership: SeededMembership };
  applicant: SeededMember;
  otherClub: SeededClub;
  ownApplicationMembership: { id: string };
  threadId: string;
  contentId: string;
  dmThreadId: string;
  invitation: SeededInvitation;
};

type SeedClubMembershipStatus =
  | 'active'
  | 'cancelled'
  | 'removed'
  | 'banned'
;

type SeedClubMembershipOptions = {
  role?: 'member' | 'clubadmin';
  status?: SeedClubMembershipStatus;
  access?: 'comped' | 'paid' | 'none';
  approvedPriceAmount?: number | null;
  approvedPriceCurrency?: string | null;
  metadata?: Record<string, unknown>;
  reason?: string | null;
};

type SeedApplicationOptionsBase = {
  phase?: 'revision_required' | 'awaiting_review' | 'active' | 'declined' | 'banned' | 'removed' | 'withdrawn';
  draftName?: string;
  draftSocials?: string;
  draftApplication?: string;
  generatedProfileDraft?: Record<string, unknown> | null;
  gateVerdict?: 'passed' | 'needs_revision' | 'not_run' | 'unavailable' | null;
  gateFeedback?: Record<string, unknown> | null;
  adminNote?: string | null;
  adminWorkflowStage?: string | null;
  createdAt?: string | null;
  submittedAt?: string | null;
  decidedAt?: string | null;
  decidedByMemberId?: string | null;
  activatedMembershipId?: string | null;
};

type SeedColdApplicationOptions = SeedApplicationOptionsBase & {
  submissionPath?: 'cold';
  sponsorId?: null;
  invitationId?: null;
};

type SeedInvitedApplicationOptions = SeedApplicationOptionsBase & {
  submissionPath: 'invitation';
  sponsorId: string;
  invitationId: string;
};

type SeedApplicationOptions = SeedColdApplicationOptions | SeedInvitedApplicationOptions;

export class TestHarness {
  pools: { super: Pool; app: Pool };
  private dbName: string;
  private httpServer: ReturnType<typeof createServer>['server'];
  private shutdown: () => Promise<void>;
  private resetRateLimitForTests: () => void;
  port: number;
  private previousEmbeddingStub: string | undefined;
  private previousPowDifficulty: string | undefined;

  private constructor(
    pools: { super: Pool; app: Pool },
    dbName: string,
    httpServer: ReturnType<typeof createServer>['server'],
    shutdown: () => Promise<void>,
    resetRateLimitForTests: () => void,
    port: number,
    previousEmbeddingStub: string | undefined,
    previousPowDifficulty: string | undefined,
  ) {
    this.pools = pools;
    this.dbName = dbName;
    this.httpServer = httpServer;
    this.shutdown = shutdown;
    this.resetRateLimitForTests = resetRateLimitForTests;
    this.port = port;
    this.previousEmbeddingStub = previousEmbeddingStub;
    this.previousPowDifficulty = previousPowDifficulty;
  }

  static async start(options: {
    llmGate?: LlmGateFn;
    streamScopeRefreshMs?: number;
    embeddingStub?: boolean;
    config?: AppConfig;
  } = {}): Promise<TestHarness> {
    const dbName = createDbName();
    const previousEmbeddingStub = process.env.CLAWCLUB_EMBEDDING_STUB;
    const previousPowDifficulty = process.env.CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY;
    if (options.embeddingStub ?? true) {
      process.env.CLAWCLUB_EMBEDDING_STUB = '1';
    } else if (previousEmbeddingStub === undefined) {
      delete process.env.CLAWCLUB_EMBEDDING_STUB;
    }
    if (previousPowDifficulty === undefined) {
      process.env.CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY = '3';
    }
    initializeConfigForTests(options.config ?? DEFAULT_CONFIG_V1);

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
      `CLAWCLUB_DB_APP_PASSWORD="${APP_PASSWORD}" CLAWCLUB_DB_NAME="${dbName}" DATABASE_URL="postgresql://localhost/${dbName}" ${ROOT}/scripts/provision-app-role.sh`,
      { stdio: 'pipe' },
    );

    const privilegePool = new Pool({ connectionString: 'postgresql://localhost/postgres' });
    try {
      await privilegePool.query(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdentifier(dbName)} TO ${quoteIdentifier(APP_ROLE)}`);
    } finally {
      await privilegePool.end();
    }

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
      app: new Pool({
        connectionString: `postgresql://${APP_ROLE}:${APP_PASSWORD}@localhost/${dbName}`,
        application_name: 'clawclub_server_main',
      }),
    };

    // 6. Create repository, notifier, and start server
    const repository = createRepository(pools.app);

    const updatesNotifier = createPostgresMemberUpdateNotifier(
      `postgresql://localhost/${dbName}`,
    );

    const serverInstance = createServer({
      repository,
      updatesNotifier,
      llmGate: options.llmGate,
      streamScopeRefreshMs: options.streamScopeRefreshMs,
    });
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
      serverInstance.__resetRateLimitForTests,
      port,
      previousEmbeddingStub,
      previousPowDifficulty,
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
      if (this.previousEmbeddingStub === undefined) {
        delete process.env.CLAWCLUB_EMBEDDING_STUB;
      } else {
        process.env.CLAWCLUB_EMBEDDING_STUB = this.previousEmbeddingStub;
      }
      if (this.previousPowDifficulty === undefined) {
        delete process.env.CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY;
      } else {
        process.env.CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY = this.previousPowDifficulty;
      }
      resetConfigForTests();
    }
  }

  __resetRateLimitForTests(): void {
    this.resetRateLimitForTests();
  }

  // ── SQL helper (run as superuser) ──

  async sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pools.super.query<T>(query, params);
    return result.rows;
  }

  private async withSuperTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pools.super.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async readExistingCurrentMembership(
    client: PoolClient,
    clubId: string,
    memberId: string,
  ): Promise<SeededMembership | null> {
    const result = await client.query<{
      membership_id: string;
      role: string;
      status: string;
    }>(
      `select cm.id as membership_id, cm.role::text as role, cm.status::text as status
       from current_club_memberships cm
       where cm.club_id = $1 and cm.member_id = $2
         and cm.status in ('active', 'cancelled')
       limit 1`,
      [clubId, memberId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.membership_id,
      clubId,
      memberId,
      role: row.role,
      status: row.status,
    };
  }

  private async insertMembershipStateVersion(
    client: PoolClient,
    membershipId: string,
    status: string,
    creatorMemberId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       select $1::short_id, $2::membership_state, $3, coalesce(max(version_no), 0) + 1, $4::short_id
       from club_membership_state_versions
       where membership_id = $1::short_id`,
      [membershipId, status, reason, creatorMemberId],
    );
  }

  private async ensureMembershipProfileVersion(
    client: PoolClient,
    membershipId: string,
    clubId: string,
    memberId: string,
    creatorMemberId: string,
  ): Promise<void> {
    await client.query(
      `insert into member_club_profile_versions (
         membership_id,
         member_id,
         club_id,
         version_no,
         created_by_member_id,
         generation_source
       )
       select $1::short_id, $2::short_id, $3::short_id, 1, $4::short_id, 'membership_seed'
       where not exists (
         select 1
         from member_club_profile_versions
         where membership_id = $1::short_id
       )`,
      [membershipId, memberId, clubId, creatorMemberId],
    );
  }

  // Convenience aliases used in tests that interact with specific domain tables
  sqlClubs = this.sql.bind(this);
  sqlMessaging = this.sql.bind(this);

  // ── Seeding helpers ──

  async seedMember(publicName: string, email?: string): Promise<SeededMember> {
    const fallbackEmail = `${publicName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '')}.${randomUUID().slice(0, 8)}@test.clawclub.local`;
    const registrationName = /\s/.test(publicName) ? publicName : `${publicName} Member`;
    const registered = await registerWithPow(this, {
      name: registrationName,
      email: email ?? fallbackEmail,
      clientKey: `seed-member:${publicName}:${randomUUID()}`,
    });
    return { id: registered.memberId, publicName, token: registered.bearerToken };
  }

  async seedSuperadmin(publicName: string): Promise<SeededMember> {
    const member = await this.seedMember(publicName);
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

    await this.withSuperTransaction(async (client) => {
      const existing = await this.readExistingCurrentMembership(client, clubId, ownerMemberId);
      if (existing) {
        await client.query(
          `update club_memberships
           set is_comped = true,
               comped_at = coalesce(comped_at, now()),
               comped_by_member_id = null
           where id = $1 and is_comped = false`,
          [existing.id],
        );
        return;
      }

      const insertedMembership = await client.query<{ id: string }>(
        `insert into club_memberships (
           club_id,
           member_id,
           role,
           status,
           joined_at,
           metadata,
           is_comped,
           comped_at,
           comped_by_member_id
         )
         values ($1::short_id, $2::short_id, 'clubadmin', 'active', now(), '{}'::jsonb, true, now(), null)
         returning id`,
        [clubId, ownerMemberId],
      );
      const membershipId = insertedMembership.rows[0]?.id;
      if (!membershipId) {
        throw new Error('seedClub failed to create owner membership');
      }

      await this.ensureMembershipProfileVersion(client, membershipId, clubId, ownerMemberId, ownerMemberId);
      await this.insertMembershipStateVersion(client, membershipId, 'active', ownerMemberId, 'seed owner membership');
    });

    // Club version (needed by current_club_versions view)
    await this.sql(
      `INSERT INTO club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
       VALUES ($1::short_id, $2::short_id, $3, $4, null, 1, $2::short_id) ON CONFLICT DO NOTHING`,
      [clubId, ownerMemberId, name, `Test club ${slug}`],
    );

    return { id: clubId, slug, name, ownerMemberId };
  }

  async seedClubMembership(
    clubId: string,
    memberId: string,
    options: SeedClubMembershipOptions = {},
  ): Promise<SeededMembership> {
    const role = options.role ?? 'member';
    const status = options.status ?? 'active';
    const accessGrantingStatuses = new Set<SeedClubMembershipStatus>(['active']);
    const joinedStatuses = new Set<SeedClubMembershipStatus>(['active', 'cancelled', 'removed', 'banned']);
    const access = role === 'clubadmin' ? 'none' : options.access ?? 'none';

    if (role === 'clubadmin' && status !== 'active') {
      throw new Error(`seedClubMembership does not support clubadmin status ${status}`);
    }
    if (accessGrantingStatuses.has(status) && role !== 'clubadmin' && !options.access) {
      throw new Error(
        `seedClubMembership status ${status} requires explicit access semantics (use access='comped' or access='paid')`,
      );
    }
    if (!accessGrantingStatuses.has(status) && access !== 'none') {
      throw new Error(`seedClubMembership status ${status} cannot use access=${access}`);
    }

    return this.withSuperTransaction(async (client) => {
      const existing = await this.readExistingCurrentMembership(client, clubId, memberId);
      if (existing) {
        if (existing.role !== role || existing.status !== status) {
          throw new Error(
            `seedClubMembership found existing current membership ${existing.id} in state ${existing.status}/${existing.role}; refusing to reuse for requested ${status}/${role}`,
          );
        }
        if (role === 'clubadmin' || accessGrantingStatuses.has(status)) {
          await this.ensureMembershipProfileVersion(client, existing.id, clubId, memberId, memberId);
        }
        if (role !== 'clubadmin' && access === 'comped') {
          await client.query(
            `update club_memberships
             set is_comped = true,
                 comped_at = coalesce(comped_at, now())
             where id = $1`,
            [existing.id],
          );
        }
        if (role !== 'clubadmin' && access === 'paid') {
          await client.query(
            `insert into club_subscriptions (
               membership_id,
               payer_member_id,
               status,
               amount,
               currency,
               current_period_end
             )
             select $1::short_id, $2::short_id, 'active', $3, $4, now() + interval '30 days'
             where not exists (
               select 1
               from club_subscriptions
               where membership_id = $1::short_id
             )`,
            [
              existing.id,
              memberId,
              options.approvedPriceAmount ?? 29,
              options.approvedPriceCurrency ?? 'USD',
            ],
          );
        }
        return existing;
      }

      const insertedMembership = await client.query<{ id: string }>(
        `insert into club_memberships (
           club_id,
           member_id,
           role,
           status,
           joined_at,
           metadata
         )
         values (
           $1::short_id,
           $2::short_id,
           $3::membership_role,
           $4::membership_state,
           $5::timestamptz,
           $6::jsonb
         )
         returning id`,
        [
          clubId,
          memberId,
          role,
          status,
          joinedStatuses.has(status) || role === 'clubadmin' ? new Date().toISOString() : null,
          JSON.stringify(options.metadata ?? {}),
        ],
      );
      const membershipId = insertedMembership.rows[0]?.id;
      if (!membershipId) {
        throw new Error('seedClubMembership failed to create membership');
      }

      if (role === 'clubadmin' || accessGrantingStatuses.has(status)) {
        await this.ensureMembershipProfileVersion(client, membershipId, clubId, memberId, memberId);
      }

      await this.insertMembershipStateVersion(client, membershipId, status, memberId, options.reason ?? 'seed membership');

      if (role !== 'clubadmin' && access === 'comped') {
        await client.query(
          `update club_memberships
           set is_comped = true,
               comped_at = now()
           where id = $1`,
          [membershipId],
        );
      }

      if (role !== 'clubadmin' && access === 'paid') {
        await client.query(
          `insert into club_subscriptions (
             membership_id,
             payer_member_id,
             status,
             amount,
             currency,
             current_period_end
           )
           values ($1::short_id, $2::short_id, 'active', $3, $4, now() + interval '30 days')`,
          [
            membershipId,
            memberId,
            options.approvedPriceAmount ?? 29,
            options.approvedPriceCurrency ?? 'USD',
          ],
        );
      }

      return { id: membershipId, clubId, memberId, role, status };
    });
  }

  async seedCompedMembership(
    clubId: string,
    memberId: string,
    options: Omit<SeedClubMembershipOptions, 'access'> = {},
  ): Promise<SeededMembership> {
    return this.seedClubMembership(clubId, memberId, {
      ...options,
      access: 'comped',
    });
  }

  async seedPaidMembership(
    clubId: string,
    memberId: string,
    options: Omit<SeedClubMembershipOptions, 'access'> = {},
  ): Promise<SeededMembership> {
    return this.seedClubMembership(clubId, memberId, {
      ...options,
      access: 'paid',
    });
  }

  async seedInvitation(
    clubId: string,
    sponsorId: string,
    candidateEmail: string,
    options: {
      candidateName?: string;
      reason?: string;
      expiresAt?: string;
      expiredAt?: string | null;
      usedAt?: string | null;
      usedMembershipId?: string | null;
      revokedAt?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<SeededInvitation> {
    const code = buildInvitationCode();
    const candidateName = options.candidateName ?? 'Invited Candidate';
    const reason = options.reason ?? 'Seed invitation';
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows = await this.sql<{
      id: string;
      expires_at: string;
      used_at: string | null;
      used_membership_id: string | null;
      revoked_at: string | null;
    }>(
      `insert into invite_requests (
         club_id,
         sponsor_member_id,
         candidate_name,
         candidate_email,
         candidate_member_id,
         target_source,
         reason,
         delivery_kind,
         expires_at,
         expired_at,
         used_at,
         used_membership_id,
         revoked_at,
         support_withdrawn_at,
         metadata
       )
       values (
         $1::short_id,
         $2::short_id,
         $3,
         $4,
         null,
         'email',
         $5,
         'code',
         $6::timestamptz,
         $7::timestamptz,
         $8::timestamptz,
         $9::short_id,
         $10::timestamptz,
         null,
         $11::jsonb
       )
       returning id, expires_at::text, used_at::text, used_membership_id, revoked_at::text`,
      [
        clubId,
        sponsorId,
        candidateName,
        candidateEmail,
        reason,
        expiresAt,
        options.expiredAt ?? null,
        options.usedAt ?? null,
        options.usedMembershipId ?? null,
        options.revokedAt ?? null,
        JSON.stringify(options.metadata ?? {}),
      ],
    );

    const row = rows[0]!;
    await this.sql(
      `insert into invite_codes (invite_request_id, code)
       values ($1::short_id, $2)`,
      [row.id, code],
    );
    return {
      id: row.id,
      clubId,
      sponsorId,
      candidateName,
      candidateEmail,
      code,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedMembershipId: row.used_membership_id,
      revokedAt: row.revoked_at,
    };
  }

  async seedApplication(
    clubId: string,
    applicantMemberId: string,
    options: SeedApplicationOptions = {},
  ): Promise<{
    id: string;
    clubId: string;
    applicantMemberId: string;
    phase: string;
    invitationId: string | null;
    sponsorId: string | null;
  }> {
    const phase = options.phase ?? 'awaiting_review';
    const submissionPath = options.submissionPath ?? 'cold';
    const sponsorId = options.sponsorId ?? null;
    const invitationId = options.invitationId ?? null;
    if (submissionPath === 'invitation') {
      if (!sponsorId || !invitationId) {
        throw new Error('seedApplication: invitation applications require both sponsorId and invitationId');
      }
    } else if (sponsorId !== null || invitationId !== null) {
      throw new Error('seedApplication: cold applications cannot set sponsorId or invitationId');
    }
    let sponsorNameSnapshot: string | null = null;
    let inviteReasonSnapshot: string | null = null;
    let inviteMode: 'internal' | 'external' | null = null;
    if (submissionPath === 'invitation') {
      const [invitationRow] = await this.sql<{
        sponsor_name_snapshot: string | null;
        invite_reason_snapshot: string;
        invite_mode: 'internal' | 'external';
      }>(
        `select
            sponsor.public_name as sponsor_name_snapshot,
            ir.reason as invite_reason_snapshot,
            case when ir.delivery_kind = 'notification' then 'internal' else 'external' end as invite_mode
         from invite_requests ir
         left join members sponsor on sponsor.id = ir.sponsor_member_id
         where ir.id = $1::short_id
         limit 1`,
        [invitationId],
      );
      sponsorNameSnapshot = invitationRow?.sponsor_name_snapshot ?? null;
      inviteReasonSnapshot = invitationRow?.invite_reason_snapshot ?? null;
      inviteMode = invitationRow?.invite_mode ?? null;
    }
    const createdAt = options.createdAt ?? new Date().toISOString();
    const submittedAt = options.submittedAt ?? createdAt;
    const draftName = options.draftName ?? 'Applicant';
    const draftSocials = options.draftSocials ?? '@applicant';
    const draftApplication = options.draftApplication ?? 'I would like to join.';
    const gateVerdict = options.gateVerdict ?? (phase === 'revision_required' ? 'needs_revision' : 'passed');
    const gateFeedback = options.gateFeedback ?? (
      phase === 'revision_required'
        ? { message: 'Please add more detail.', missingItems: ['why_now'] }
        : null
    );

    const rows = await this.sql<{
      id: string;
      club_id: string;
      applicant_member_id: string;
      phase: string;
      invitation_id: string | null;
      sponsor_member_id: string | null;
    }>(
      `with inserted as (
         insert into club_applications (
           club_id,
           applicant_member_id,
           submission_path,
           invitation_id,
           sponsor_member_id,
           sponsor_name_snapshot,
           invite_reason_snapshot,
           invite_mode,
           phase,
           draft_name,
           draft_socials,
           draft_application,
           generated_profile_draft,
           gate_verdict,
           gate_feedback,
           gate_last_run_at,
           admin_note,
           admin_workflow_stage,
           created_at,
           updated_at,
           submitted_at,
           decided_at,
           decided_by_member_id,
           activated_membership_id
         )
         values (
           $1,
           $2,
           $3,
           $4::short_id,
           $5::short_id,
           $6,
           $7,
           $8,
           $9,
           $10,
           $11,
           $12,
           $13::jsonb,
           $14,
           $15::jsonb,
           $16::timestamptz,
           $17,
           $18,
           $19::timestamptz,
           $20::timestamptz,
           $21::timestamptz,
           $22::timestamptz,
           $23,
           $24
         )
         returning id, club_id, applicant_member_id, phase, invitation_id, sponsor_member_id
       )
       insert into club_application_revisions (
         application_id,
         version_no,
         draft_name,
         draft_socials,
         draft_application,
         gate_verdict,
         gate_feedback,
         created_by_member_id,
         created_at
       )
         select
           inserted.id,
           1,
           $10,
           $11,
           $12,
           $14,
           $15::jsonb,
           $2,
           $19::timestamptz
       from inserted
       returning application_id`,
      [
        clubId,
        applicantMemberId,
        submissionPath,
        invitationId,
        sponsorId,
        sponsorNameSnapshot,
        inviteReasonSnapshot,
        inviteMode,
        phase,
        draftName,
        draftSocials,
        draftApplication,
        JSON.stringify(options.generatedProfileDraft ?? null),
        gateVerdict,
        JSON.stringify(gateFeedback),
        createdAt,
        options.adminNote ?? null,
        options.adminWorkflowStage ?? null,
        createdAt,
        createdAt,
        submittedAt,
        options.decidedAt ?? null,
        options.decidedByMemberId ?? null,
        options.activatedMembershipId ?? null,
      ],
    );

    const [row] = await this.sql<{
      id: string;
      club_id: string;
      applicant_member_id: string;
      phase: string;
      invitation_id: string | null;
      sponsor_member_id: string | null;
    }>(
      `select id, club_id, applicant_member_id, phase::text, invitation_id, sponsor_member_id
         from club_applications
        where club_id = $1
          and applicant_member_id = $2
          and submitted_at = $3::timestamptz
        order by created_at desc
        limit 1`,
      [clubId, applicantMemberId, submittedAt],
    );
    if (!row) {
      throw new Error('seedApplication failed to create application row');
    }
    return {
      id: row.id,
      clubId: row.club_id,
      applicantMemberId: row.applicant_member_id,
      phase: row.phase,
      invitationId: row.invitation_id,
      sponsorId: row.sponsor_member_id,
    };
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
                const expectsUnauthenticatedEnvelope = def?.auth === 'none' || (def?.auth === 'optional_member' && !token);
                if (expectsUnauthenticatedEnvelope) {
                  const envResult = strictify(unauthenticatedSuccessEnvelope).safeParse(parsed);
                  if (!envResult.success) {
                    reject(new Error(`[contract] ${action} unauthenticated envelope validation failed: ${envResult.error.message}`));
                    return;
                  }
                  const timestampError = assertCanonicalTimestamps(action, 'unauthenticated envelope', envResult.data);
                  if (timestampError) {
                    reject(timestampError);
                    return;
                  }
                } else {
                  const envResult = strictify(authenticatedSuccessEnvelope).safeParse(parsed);
                  if (!envResult.success) {
                    reject(new Error(`[contract] ${action} authenticated envelope validation failed: ${envResult.error.message}`));
                    return;
                  }
                  const timestampError = assertCanonicalTimestamps(action, 'authenticated envelope', envResult.data);
                  if (timestampError) {
                    reject(timestampError);
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

  async internalProducerRequest(
    producerId: string,
    secret: string,
    path: '/internal/notifications/deliver' | '/internal/notifications/acknowledge',
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-clawclub-producer-id': producerId,
            authorization: `Bearer ${secret}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: res.statusCode ?? 0,
                body: text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {},
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  internalProducerDeliver(
    producerId: string,
    secret: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.internalProducerRequest(producerId, secret, '/internal/notifications/deliver', body);
  }

  internalProducerAcknowledge(
    producerId: string,
    secret: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.internalProducerRequest(producerId, secret, '/internal/notifications/acknowledge', body);
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
    opts: { publicName?: string } = {},
  ): Promise<SeededMember & { club: SeededClub }> {
    const publicName = opts.publicName ?? `Owner of ${clubName ?? clubSlug}`;
    const member = await this.seedMember(publicName);
    const club = await this.seedClub(clubSlug, clubName ?? clubSlug, member.id);
    return { ...member, club };
  }

  // ── Convenience: seed named members in specific access states ──

  async seedCompedMember(
    clubId: string,
    publicName: string,
    options: Omit<SeedClubMembershipOptions, 'role' | 'access'> = {},
  ): Promise<SeededMember & { membership: SeededMembership }> {
    const member = await this.seedMember(publicName);
    const membership = await this.seedCompedMembership(clubId, member.id, options);
    return { ...member, membership };
  }

  async seedPaidMember(
    clubId: string,
    publicName: string,
    options: Omit<SeedClubMembershipOptions, 'role' | 'access'> = {},
  ): Promise<SeededMember & { membership: SeededMembership }> {
    const member = await this.seedMember(publicName);
    const membership = await this.seedPaidMembership(clubId, member.id, options);
    return { ...member, membership };
  }

  async seedLeakAuditScenario(): Promise<LeakAuditContext> {
    const owner = await this.seedOwner('leak-audit-club', 'Leak Audit Club');
    const regularMember = await this.seedCompedMember(owner.club.id, 'Leak Audit Caller');
    const otherMember = await this.seedCompedMember(owner.club.id, 'Leak Audit Other');
    const applicant = await this.seedMember('Leak Audit Applicant', 'applicant@leak-audit.test');
    await this.seedApplication(owner.club.id, applicant.id, {
      phase: 'awaiting_review',
      submissionPath: 'cold',
      draftName: 'Leak Audit Applicant',
      draftSocials: '@leak-applicant',
      draftApplication: 'This should never leak to regular members.',
      generatedProfileDraft: {
        tagline: 'Draft tagline',
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      },
    });
    const otherClubOwner = await this.seedOwner('leak-audit-other-club', 'Leak Audit Other Club');
    const ownApplicationMembership = await this.seedApplication(otherClubOwner.club.id, regularMember.id, {
      phase: 'awaiting_review',
      submissionPath: 'cold',
      draftName: 'Leak Audit Caller',
      draftSocials: '@caller',
      draftApplication: 'Own application content',
      generatedProfileDraft: {
        tagline: 'Own draft tagline',
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      },
    });

    const content = await this.apiOk(regularMember.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'ask',
      title: 'Leak audit thread',
      body: 'Leak audit content body',
    });
    const contentItem = ((content.data as Record<string, unknown>).content ?? {}) as Record<string, unknown>;
    const message = await this.apiOk(regularMember.token, 'messages.send', {
      recipientMemberId: otherMember.id,
      messageText: 'Leak audit DM',
    });
    const messageData = ((message.data as Record<string, unknown>).message ?? {}) as Record<string, unknown>;
    const invitation = await this.seedInvitation(owner.club.id, regularMember.id, 'invitee@leak-audit.test', {
      candidateName: 'Leak Audit Invitee',
    });

    await this.apiOk(otherMember.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: regularMember.id,
      reason: 'Known to follow through.',
    });

    return {
      testClub: owner.club,
      regularMember,
      otherMember,
      applicant,
      otherClub: otherClubOwner.club,
      ownApplicationMembership,
      threadId: String(contentItem.threadId),
      contentId: String(contentItem.id),
      dmThreadId: String(messageData.threadId),
      invitation,
    };
  }

  // ── GET endpoints ──

  async getActivity(
    token: string,
    params: { clubId?: string; limit?: number; after?: string | 'latest' | number } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const activity: Record<string, unknown> = {};
    if (params.limit !== undefined) activity.limit = params.limit;
    if (params.after !== undefined) activity.after = String(params.after);
    return this.getUpdates(token, {
      ...(params.clubId !== undefined ? { clubId: params.clubId } : {}),
      activity,
    });
  }

  async getNotifications(
    token: string,
    params: { limit?: number; after?: string | null } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const notifications: Record<string, unknown> = {};
    if (params.limit !== undefined) notifications.limit = params.limit;
    if (params.after !== undefined) notifications.after = params.after;
    return this.getUpdates(token, { notifications });
  }

  async getInbox(
    token: string,
    params: { limit?: number; unreadOnly?: boolean; cursor?: string | null } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const inbox: Record<string, unknown> = {};
    if (params.limit !== undefined) inbox.limit = params.limit;
    if (params.unreadOnly !== undefined) inbox.unreadOnly = params.unreadOnly;
    if (params.cursor !== undefined) inbox.cursor = params.cursor;
    return this.getUpdates(token, { inbox });
  }

  async getUpdates(
    token: string,
    params: {
      clubId?: string;
      activity?: { limit?: number; after?: string | null };
      notifications?: { limit?: number; after?: string | null };
      inbox?: { limit?: number; unreadOnly?: boolean; cursor?: string | null };
    } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const input: Record<string, unknown> = {};
    if (params.clubId !== undefined) input.clubId = params.clubId;
    if (params.activity !== undefined) input.activity = params.activity;
    if (params.notifications !== undefined) input.notifications = params.notifications;
    if (params.inbox !== undefined) input.inbox = params.inbox;
    return this.api(token, 'updates.list', input);
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
    params: { after?: string | number | 'latest'; limit?: number; lastEventId?: string } = {},
  ): {
    events: Array<{ event: string; data: Record<string, unknown>; id?: string }>;
    close: () => void;
    waitForEvents: (count: number, timeoutMs?: number) => Promise<void>;
    closed: Promise<void>;
  } {
    const qs = new URLSearchParams();
    if (params.after !== undefined) qs.set('after', String(params.after));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const path = `/stream${qs.toString() ? `?${qs}` : ''}`;

    const events: Array<{ event: string; data: Record<string, unknown>; id?: string }> = [];
    const sseValidationErrors: string[] = [];
    const waiters: Array<{ target: number; resolve: () => void }> = [];
    let resolveClosed: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

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
        res.on('end', () => resolveClosed());
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
                  } else {
                    const timestampError = assertCanonicalTimestamps('GET /stream', 'ready event', result.data);
                    if (timestampError) sseValidationErrors.push(timestampError.message);
                  }
                } else if (event === 'activity') {
                  const result = strictify(sseActivityEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE activity event validation failed: ${result.error.message}`);
                  } else {
                    const timestampError = assertCanonicalTimestamps('GET /stream', 'activity event', result.data);
                    if (timestampError) sseValidationErrors.push(timestampError.message);
                  }
                } else if (event === 'message') {
                  const result = strictify(sseMessageEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE message event validation failed: ${result.error.message}`);
                  } else {
                    const timestampError = assertCanonicalTimestamps('GET /stream', 'message event', result.data);
                    if (timestampError) sseValidationErrors.push(timestampError.message);
                  }
                } else if (event === 'notifications_dirty') {
                  const result = strictify(sseNotificationsDirtyEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE notifications_dirty event validation failed: ${result.error.message}`);
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
      closed,
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
