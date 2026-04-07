import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('healthcheck reports database status and skips api check without a health token', async () => {
  const tmpDir = '/tmp/clawclub-healthcheck-test';
  await mkdir(tmpDir, { recursive: true });

  const stubDir = join(tmpDir, 'bin');
  await mkdir(stubDir, { recursive: true });
  // Stub psql to return plausible values for each check
  await writeFile(
    join(stubDir, 'psql'),
    '#!/usr/bin/env bash\n' +
    'if printf "%s\\n" "$*" | grep -q "select 1"; then\n  echo "1"\n' +
    'elif printf "%s\\n" "$*" | grep -q "current_user, rolsuper"; then\n  echo "clawclub_app|f"\n' +
    'elif printf "%s\\n" "$*" | grep -q "count.*schema_migrations"; then\n  echo "1"\n' +
    'elif printf "%s\\n" "$*" | grep -q "max.*schema_migrations"; then\n  echo "0001_init.sql"\n' +
    'elif printf "%s\\n" "$*" | grep -q "information_schema.tables"; then\n  echo "10"\n' +
    'else\n  exit 0\nfi\n',
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

  assert.match(stdout, /== database ==/);
  assert.match(stdout, /role=clawclub_app/);
  assert.match(stdout, /migrations: 1 applied/);
  assert.match(stdout, /tables: 10 in app schema/);
  assert.match(stdout, /skipped \(set CLAWCLUB_HEALTH_TOKEN to enable\)/);
});

test('healthcheck skips database with missing URL', async () => {
  const { stdout } = await execFileAsync('./scripts/healthcheck.sh', {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: '',
    },
  });

  assert.match(stdout, /SKIP: DATABASE_URL not set/);
});
