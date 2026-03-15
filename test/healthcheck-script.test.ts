import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('healthcheck script reports migration status and skipped api check without a health token', async () => {
  const tmpDir = '/tmp/clawclub-healthcheck-test';
  await mkdir(tmpDir, { recursive: true });

  const stubDir = join(tmpDir, 'bin');
  await mkdir(stubDir, { recursive: true });
  await writeFile(join(stubDir, 'psql'), '#!/usr/bin/env bash\nif printf "%s\\n" "$*" | grep -q "select current_user, rolsuper, rolbypassrls"; then\necho "runtime_role|f|f"\nelse\necho applied:0017_membership_state_compatibility_sync\nfi\n', { mode: 0o755 });

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
else
  echo applied:0017_membership_state_compatibility_sync
fi
`,
    { mode: 0o755 },
  );

  await assert.rejects(
    execFileAsync('./scripts/healthcheck.sh', {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        DATABASE_URL: 'postgres://runtime.test/clawclub',
        DATABASE_MIGRATOR_URL: 'postgres://migrator.test/clawclub',
        CLAWCLUB_REQUIRE_SAFE_DB_ROLE: '1',
      },
    }),
  );

  const log = await execFileAsync('cat', [logFile], { cwd: repoRoot });
  assert.match(log.stdout, /postgres:\/\/migrator\.test\/clawclub/);
  assert.match(log.stdout, /postgres:\/\/runtime\.test\/clawclub/);
});
