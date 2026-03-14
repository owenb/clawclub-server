import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for app-role provisioning tests');
  }
  return databaseUrl;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isRetriableProvisionError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'message' in error
    && typeof error.message === 'string'
    && (
      (error.code === '42501' && error.message.includes('permission denied for table members'))
      || (error.code === 'XX000' && error.message.includes('tuple concurrently updated'))
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertProvisionedRoleWorks({
  suffix,
  roleName,
  password,
}: {
  suffix: string;
  roleName: string;
  password: string;
}) {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const client = await pool.connect();

  await execFileAsync('./scripts/provision-app-role.sh', {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_MIGRATOR_URL: requireDatabaseUrl(),
      CLAWCLUB_DB_APP_ROLE: roleName,
      CLAWCLUB_DB_APP_PASSWORD: password,
    },
  });

  try {
    const roleResult = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `
        select rolcanlogin, rolsuper, rolbypassrls
        from pg_roles
        where rolname = $1
      `,
      [roleName],
    );

    assert.deepEqual(roleResult.rows[0], {
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
    });

    await client.query('begin');

    const ownerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
      [`Provision Owner ${suffix}`, `auth|provision-owner-${suffix}`, `provision-owner-${suffix}`],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
        values ($1, 'superadmin', 'active', 1, $1)
      `,
      [ownerId],
    );

    await client.query(
      `select set_config('app.actor_member_id', $1, true)`,
      [ownerId],
    );

    const networkId = (await client.query<{ id: string }>(
      `insert into app.networks (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
      [`provision-network-${suffix}`, `Provision Network ${suffix}`, ownerId, 'Provision script test'],
    )).rows[0]!.id;

    const membershipId = (await client.query<{ id: string }>(
      `
        insert into app.network_memberships (network_id, member_id, role)
        values ($1, $2, 'owner')
        returning id
      `,
      [networkId, ownerId],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.network_membership_state_versions (
          membership_id,
          status,
          version_no,
          created_by_member_id
        )
        values ($1, 'active', 1, $2)
      `,
      [membershipId, ownerId],
    );

    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await client.query(
      `select set_config('app.actor_member_id', $1, true)`,
      [ownerId],
    );

    const visibleSelf = await client.query<{ id: string }>(
      `select id from app.members where id = $1`,
      [ownerId],
    );
    assert.deepEqual(visibleSelf.rows.map((row) => row.id), [ownerId]);

    const resolvedByHandle = await client.query<{ id: string | null }>(
      `select app.resolve_active_member_id_by_handle($1) as id`,
      [`provision-owner-${suffix}`],
    );
    assert.equal(resolvedByHandle.rows[0]?.id, ownerId);

    const tokenInsert = await client.query<{ member_id: string }>(
      `
        insert into app.member_bearer_tokens (member_id, label, token_hash, metadata)
        values ($1, 'provision-test', $2, '{}'::jsonb)
        returning member_id
      `,
      [ownerId, `hash-${suffix}`],
    );
    assert.equal(tokenInsert.rows[0]?.member_id, ownerId);

    await client.query('reset session authorization');
    await client.query('rollback');
  } finally {
    await client.query(`drop role if exists ${quoteIdentifier(roleName)}`).catch(() => {});
    client.release();
    await pool.end();
  }
}

test('provision-app-role script creates a safe runtime role with app grants', { concurrency: false }, async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const roleName = `clawclub_app_${suffix}`;
    const password = `pw_${suffix}`;

    try {
      await assertProvisionedRoleWorks({ suffix, roleName, password });
      return;
    } catch (error) {
      if (!isRetriableProvisionError(error) || attempt === 2) {
        throw error;
      }

      await sleep(50 * (attempt + 1));
    }
  }
});
