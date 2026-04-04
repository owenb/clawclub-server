import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('healthcheck script reports migration status and skipped api check without a health token', async () => {
  const tmpDir = '/tmp/clawclub-healthcheck-test';
  await mkdir(tmpDir, { recursive: true });

  const stubDir = join(tmpDir, 'bin');
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    join(stubDir, 'psql'),
    '#!/usr/bin/env bash\nif printf "%s\\n" "$*" | grep -q "select current_user, rolsuper, rolbypassrls"; then\necho "runtime_role|f|f"\nelif printf "%s\\n" "$*" | grep -q "from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner"; then\necho "0|"\nelif printf "%s\\n" "$*" | grep -q "from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner"; then\necho "0|"\nelif printf "%s\\n" "$*" | grep -q "relrowsecurity"; then\necho "0|"\nelif printf "%s\\n" "$*" | grep -q "pg_catalog.*schema_migrations"; then\necho "1"\nelif printf "%s\\n" "$*" | grep -q "schema_migrations"; then\necho "applied:0017_membership_state_compatibility_sync"\nelse\nexit 0\nfi\n',
    { mode: 0o755 },
  );

  const { stdout } = await execFileAsync('./scripts/healthcheck.sh', {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      DATABASE_URL: 'postgres://example.test/clawclub',
    },
  });

  assert.match(stdout, /== migration status ==/);
  assert.match(stdout, /applied:0017_membership_state_compatibility_sync/);
  assert.match(stdout, /== database role safety ==\s+ok: role=runtime_role superuser=f bypassrls=f/s);
  assert.match(stdout, /== projection view ownership ==\s+ok: all app views owned by non-superuser, non-BYPASSRLS roles/s);
  assert.match(stdout, /== security definer ownership ==\s+ok: all app security definer functions owned by non-superuser, non-BYPASSRLS roles/s);
  assert.match(stdout, /== table RLS coverage ==\s+ok: all app tables enforce RLS and FORCE RLS/s);
  assert.match(stdout, /== api session.describe ==\s+skipped \(set CLAWCLUB_HEALTH_TOKEN to enable\)/s);
});

test('healthcheck prefers DATABASE_MIGRATOR_URL for migration checks and can fail on unsafe runtime roles', async () => {
  const tmpDir = '/tmp/clawclub-healthcheck-migrator-test';
  await mkdir(tmpDir, { recursive: true });

  const stubDir = join(tmpDir, 'bin');
  await mkdir(stubDir, { recursive: true });
  const logFile = join(tmpDir, 'psql.log');
  await writeFile(
    join(stubDir, 'psql'),
    `#!/usr/bin/env bash
echo "$1|$*" >> ${JSON.stringify(logFile)}
if printf "%s\\n" "$*" | grep -q "select current_user, rolsuper, rolbypassrls"; then
  echo "runtime_role|t|t"
elif printf "%s\\n" "$*" | grep -q "from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner"; then
  echo "2|current_applications:postgres, live_entities:postgres"
elif printf "%s\\n" "$*" | grep -q "from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner"; then
  echo "1|actor_has_club_access:target_club_id app.short_id:postgres"
elif printf "%s\\n" "$*" | grep -q "relrowsecurity"; then
  echo "1|embeddings:rls=f,force=f"
elif printf "%s\\n" "$*" | grep -q "pg_catalog.*schema_migrations"; then
  echo "1"
elif printf "%s\\n" "$*" | grep -q "schema_migrations"; then
  echo applied:0017_membership_state_compatibility_sync
else
  exit 0
fi
`,
    { mode: 0o755 },
  );

  await assert.rejects(
    execFileAsync('./scripts/healthcheck.sh', {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        DATABASE_URL: 'postgres://runtime.test/clawclub',
        DATABASE_MIGRATOR_URL: 'postgres://migrator.test/clawclub',
        CLAWCLUB_REQUIRE_SAFE_DB_ROLE: '1',
      },
    }),
  );

  const log = await readFile(logFile, 'utf-8');
  assert.match(log, /postgres:\/\/migrator\.test\/clawclub/);
  assert.match(log, /postgres:\/\/runtime\.test\/clawclub/);
});
