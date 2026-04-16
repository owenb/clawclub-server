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

import { Pool, type PoolClient } from 'pg';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createServer } from '../../src/server.ts';
import { createRepository } from '../../src/postgres.ts';
import { createPostgresMemberUpdateNotifier } from '../../src/member-updates-notifier.ts';
import { buildBearerToken, buildInvitationCode } from '../../src/token.ts';
import { z } from 'zod';
import { getAction } from '../../src/schemas/registry.ts';
import type { LlmGateFn } from '../../src/dispatch.ts';
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
  sponsorMemberId: string;
  candidateName: string;
  candidateEmail: string;
  invitationCode: string;
  expiresAt: string;
  usedAt: string | null;
  usedMembershipId: string | null;
  revokedAt: string | null;
};

type SeedClubMembershipStatus =
  | 'active'
  | 'renewal_pending'
  | 'cancelled'
  | 'payment_pending'
  | 'expired'
  | 'removed'
  | 'banned'
  | 'declined'
  | 'withdrawn';

type SeedPendingMembershipStatus =
  | 'applying'
  | 'submitted'
  | 'interview_scheduled'
  | 'interview_completed';

type SeedClubMembershipOptions = {
  role?: 'member' | 'clubadmin';
  status?: SeedClubMembershipStatus;
  access?: 'comped' | 'paid' | 'none';
  approvedPriceAmount?: number | null;
  approvedPriceCurrency?: string | null;
  metadata?: Record<string, unknown>;
  reason?: string | null;
};

type SeedPendingMembershipOptions = {
  status: SeedPendingMembershipStatus;
  submissionPath: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated';
  proofKind: 'pow' | 'invitation' | 'none';
  applicationEmail: string;
  applicationName: string;
  applicationSocials?: string | null;
  applicationText?: string | null;
  appliedAt?: string | null;
  applicationSubmittedAt?: string | null;
  generatedProfileDraft?: Record<string, unknown> | null;
  sponsorMemberId?: string | null;
  invitationId?: string | null;
  metadata?: Record<string, unknown>;
  reason?: string | null;
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

  static async start(options: { llmGate?: LlmGateFn; streamScopeRefreshMs?: number } = {}): Promise<TestHarness> {
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

    const serverInstance = createServer({ repository, updatesNotifier, llmGate: options.llmGate, streamScopeRefreshMs: options.streamScopeRefreshMs });
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
         and cm.status not in ('declined', 'withdrawn', 'expired', 'removed', 'banned')
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
    createdByMemberId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       select $1::short_id, $2::membership_state, $3, coalesce(max(version_no), 0) + 1, $4::short_id
       from club_membership_state_versions
       where membership_id = $1::short_id`,
      [membershipId, status, reason, createdByMemberId],
    );
  }

  private async ensureMembershipProfileVersion(
    client: PoolClient,
    membershipId: string,
    clubId: string,
    memberId: string,
    createdByMemberId: string,
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
      [membershipId, memberId, clubId, createdByMemberId],
    );
  }

  // Convenience aliases used in tests that interact with specific domain tables
  sqlClubs = this.sql.bind(this);
  sqlMessaging = this.sql.bind(this);

  // ── Seeding helpers ──

  async seedMember(publicName: string): Promise<SeededMember> {
    const rows = await this.sql<{ id: string }>(
      `INSERT INTO members (public_name, display_name, state)
       VALUES ($1, $1, 'active')
       RETURNING id`,
      [publicName],
    );
    const id = rows[0]!.id;

    const token = await this.createToken(id);
    return { id, publicName, token };
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
    const accessGrantingStatuses = new Set<SeedClubMembershipStatus>(['active', 'renewal_pending', 'cancelled']);
    const joinedStatuses = new Set<SeedClubMembershipStatus>(['active', 'renewal_pending', 'cancelled', 'expired', 'removed', 'banned']);
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
           approved_price_amount,
           approved_price_currency,
           metadata
         )
         values (
           $1::short_id,
           $2::short_id,
           $3::membership_role,
           $4::membership_state,
           $5::timestamptz,
           $6,
           $7,
           $8::jsonb
         )
         returning id`,
        [
          clubId,
          memberId,
          role,
          status,
          joinedStatuses.has(status) || role === 'clubadmin' ? new Date().toISOString() : null,
          options.approvedPriceAmount ?? null,
          options.approvedPriceCurrency ?? null,
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

  async seedPendingMembership(
    clubId: string,
    memberId: string,
    options: SeedPendingMembershipOptions,
  ): Promise<SeededMembership> {
    if (options.submissionPath === 'cold' && options.proofKind !== 'pow') {
      throw new Error('seedPendingMembership cold applications must use proofKind=pow');
    }
    if (options.submissionPath === 'cross_apply' && options.proofKind !== 'pow') {
      throw new Error('seedPendingMembership cross-apply applications must use proofKind=pow');
    }
    if (options.submissionPath === 'owner_nominated' && options.proofKind !== 'none') {
      throw new Error('seedPendingMembership owner-nominated applications must use proofKind=none');
    }
    if (options.submissionPath === 'invitation') {
      if (!options.sponsorMemberId) {
        throw new Error('seedPendingMembership requires sponsorMemberId for invitation-backed memberships');
      }
      if (!options.invitationId) {
        throw new Error('seedPendingMembership requires invitationId for invitation-backed memberships');
      }
      if (options.proofKind !== 'invitation') {
        throw new Error('seedPendingMembership invitation-backed memberships must use proofKind=invitation');
      }
    } else if (options.sponsorMemberId || options.invitationId) {
      throw new Error(`seedPendingMembership forbids sponsorMemberId/invitationId for submissionPath=${options.submissionPath}`);
    }

    return this.withSuperTransaction(async (client) => {
      const existing = await this.readExistingCurrentMembership(client, clubId, memberId);
      if (existing) {
        throw new Error(
          `seedPendingMembership found existing current membership ${existing.id} in state ${existing.status}; delete or transition it before seeding a new pending membership`,
        );
      }

      const appliedAt = options.appliedAt ?? new Date().toISOString();
      const applicationSubmittedAt = options.applicationSubmittedAt
        ?? (options.status === 'applying' ? null : appliedAt);

      const insertedMembership = await client.query<{ id: string }>(
        `insert into club_memberships (
           club_id,
           member_id,
           sponsor_member_id,
           role,
           status,
           application_name,
           application_email,
           application_socials,
           application_text,
           applied_at,
           application_submitted_at,
           submission_path,
           proof_kind,
           invitation_id,
           generated_profile_draft,
           metadata
         )
         values (
           $1::short_id,
           $2::short_id,
           $3::short_id,
           'member',
           $4::membership_state,
           $5,
           $6,
           $7,
           $8,
           $9::timestamptz,
           $10::timestamptz,
           $11,
           $12,
           $13::short_id,
           $14::jsonb,
           $15::jsonb
         )
         returning id`,
        [
          clubId,
          memberId,
          options.sponsorMemberId ?? null,
          options.status,
          options.applicationName,
          options.applicationEmail,
          options.applicationSocials ?? null,
          options.applicationText ?? null,
          appliedAt,
          applicationSubmittedAt,
          options.submissionPath,
          options.proofKind,
          options.invitationId ?? null,
          JSON.stringify(options.generatedProfileDraft ?? null),
          JSON.stringify(options.metadata ?? {}),
        ],
      );
      const membershipId = insertedMembership.rows[0]?.id;
      if (!membershipId) {
        throw new Error('seedPendingMembership failed to create membership');
      }

      await this.insertMembershipStateVersion(client, membershipId, options.status, memberId, options.reason ?? 'seed pending membership');

      return { id: membershipId, clubId, memberId, role: 'member', status: options.status };
    });
  }

  async seedInvitation(
    clubId: string,
    sponsorMemberId: string,
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
    const invitation = buildInvitationCode();
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
      `insert into invitations (
         id,
         club_id,
         sponsor_member_id,
         candidate_name,
         candidate_email,
         reason,
         code_hash,
         expires_at,
         expired_at,
         used_at,
         used_membership_id,
         revoked_at,
         metadata
       )
       values (
         $1::short_id,
         $2::short_id,
         $3::short_id,
         $4,
         $5,
         $6,
         $7,
         $8::timestamptz,
         $9::timestamptz,
         $10::timestamptz,
         $11::short_id,
         $12::timestamptz,
         $13::jsonb
       )
       returning id, expires_at::text, used_at::text, used_membership_id, revoked_at::text`,
      [
        invitation.tokenId,
        clubId,
        sponsorMemberId,
        candidateName,
        candidateEmail,
        reason,
        invitation.tokenHash,
        expiresAt,
        options.expiredAt ?? null,
        options.usedAt ?? null,
        options.usedMembershipId ?? null,
        options.revokedAt ?? null,
        JSON.stringify(options.metadata ?? {}),
      ],
    );

    const row = rows[0]!;
    return {
      id: row.id,
      clubId,
      sponsorMemberId,
      candidateName,
      candidateEmail,
      invitationCode: invitation.invitationCode,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedMembershipId: row.used_membership_id,
      revokedAt: row.revoked_at,
    };
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
                const expectsUnauthenticatedEnvelope = def?.auth === 'none' || (def?.auth === 'optional_member' && !token);
                if (expectsUnauthenticatedEnvelope) {
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

  async seedPendingMember(
    clubId: string,
    publicName: string,
    options: SeedPendingMembershipOptions,
  ): Promise<SeededMember & { membership: SeededMembership }> {
    const member = await this.seedMember(publicName);
    const membership = await this.seedPendingMembership(clubId, member.id, options);
    return { ...member, membership };
  }

  // ── GET endpoints ──

  async getActivity(
    token: string,
    params: { clubId?: string; limit?: number; after?: string | 'latest' | number } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const input: Record<string, unknown> = {};
    if (params.clubId !== undefined) input.clubId = params.clubId;
    if (params.limit !== undefined) input.limit = params.limit;
    if (params.after !== undefined) input.after = String(params.after);

    return this.api(token, 'activity.list', input);
  }

  async getNotifications(
    token: string,
    params: { limit?: number; after?: string | null } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const input: Record<string, unknown> = {};
    if (params.limit !== undefined) input.limit = params.limit;
    if (params.after !== undefined) input.after = params.after;
    return this.api(token, 'notifications.list', input);
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
                  }
                } else if (event === 'activity') {
                  const result = strictify(sseActivityEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE activity event validation failed: ${result.error.message}`);
                  }
                } else if (event === 'message') {
                  const result = strictify(sseMessageEvent).safeParse(parsed);
                  if (!result.success) {
                    sseValidationErrors.push(`[contract] SSE message event validation failed: ${result.error.message}`);
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
