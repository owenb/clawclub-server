import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
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

/**
 * Verifies the provision script produces a role that can do exactly what
 * the single-role schema model requires:
 *   - log in,
 *   - not be a superuser,
 *   - hold CONNECT + USAGE + CREATE on schema public so init.sql and
 *     migrations can create / alter / drop objects under its ownership.
 *
 * The integration harness exercises the full bootstrap chain
 * (provision → init.sql → migrations) end-to-end. This test is the
 * narrower unit check on the provisioning step itself.
 */
async function assertProvisionedRoleHasExpectedShape({
  suffix,
  roleName,
  password,
}: {
  suffix: string;
  roleName: string;
  password: string;
}) {
  const adminUrl = requireDatabaseUrl();
  const adminPool = new Pool({ connectionString: adminUrl });
  const adminClient = await adminPool.connect();

  await execFileAsync('./scripts/provision-app-role.sh', {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      CLAWCLUB_DB_APP_ROLE: roleName,
      CLAWCLUB_DB_APP_PASSWORD: password,
    },
  });

  try {
    const roleResult = await adminClient.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         from pg_roles where rolname = $1`,
      [roleName],
    );

    assert.deepEqual(roleResult.rows[0], {
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });

    const databaseName = (await adminClient.query<{ db: string }>(
      `select current_database() as db`,
    )).rows[0]!.db;

    const connectGranted = (await adminClient.query<{ has: boolean }>(
      `select has_database_privilege($1, $2, 'CONNECT') as has`,
      [roleName, databaseName],
    )).rows[0]!.has;
    assert.equal(connectGranted, true, 'role should have CONNECT on the database');

    const schemaUsage = (await adminClient.query<{ has: boolean }>(
      `select has_schema_privilege($1, 'public', 'USAGE') as has`,
      [roleName],
    )).rows[0]!.has;
    const schemaCreate = (await adminClient.query<{ has: boolean }>(
      `select has_schema_privilege($1, 'public', 'CREATE') as has`,
      [roleName],
    )).rows[0]!.has;
    assert.equal(schemaUsage, true, 'role should have USAGE on schema public');
    assert.equal(schemaCreate, true, 'role should have CREATE on schema public');
  } finally {
    adminClient.release();
    await adminPool.end();
  }

  // Now connect as the freshly-provisioned role and verify it can actually
  // create + alter + drop a table on its own — this is the contract the
  // schema-management flow depends on.
  const adminUrlObj = new URL(adminUrl);
  const roleUrl = new URL(adminUrl);
  roleUrl.username = roleName;
  roleUrl.password = password;
  const rolePool = new Pool({ connectionString: roleUrl.toString() });
  const roleClient = await rolePool.connect();
  const probeTable = `provision_probe_${suffix}`;
  try {
    await roleClient.query(
      `create table ${quoteIdentifier(probeTable)} (id int primary key, label text)`,
    );
    await roleClient.query(
      `insert into ${quoteIdentifier(probeTable)} (id, label) values (1, 'ok')`,
    );
    const rows = await roleClient.query<{ label: string }>(
      `select label from ${quoteIdentifier(probeTable)} where id = 1`,
    );
    assert.equal(rows.rows[0]?.label, 'ok');
    await roleClient.query(
      `alter table ${quoteIdentifier(probeTable)} add column extra text`,
    );
    await roleClient.query(`drop table ${quoteIdentifier(probeTable)}`);
  } finally {
    roleClient.release();
    await rolePool.end();

    const cleanupPool = new Pool({ connectionString: adminUrl });
    try {
      await cleanupPool.query(`drop table if exists ${quoteIdentifier(probeTable)}`);
      await cleanupPool.query(`drop role if exists ${quoteIdentifier(roleName)}`);
    } catch {
      // best effort
    } finally {
      await cleanupPool.end();
    }
    void adminUrlObj;
  }
}

test('provision-app-role script creates a self-sufficient app role', { concurrency: false }, async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `clawclub_app_${suffix}`;
  const password = `pw_${suffix}`;
  await assertProvisionedRoleHasExpectedShape({ suffix, roleName, password });
});
