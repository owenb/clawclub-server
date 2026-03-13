import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('healthcheck script reports migration status, worker token presence, and skipped api check without a health token', async () => {
  const tmpDir = '/tmp/clawclub-healthcheck-test';
  await mkdir(tmpDir, { recursive: true });

  const stubDir = join(tmpDir, 'bin');
  await mkdir(stubDir, { recursive: true });
  await writeFile(join(stubDir, 'psql'), '#!/usr/bin/env bash\necho applied:0015_delivery_worker_tokens\n', { mode: 0o755 });

  const { stdout } = await execFileAsync('./scripts/healthcheck.sh', {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      DATABASE_URL: 'postgres://example.test/clawclub',
      CLAWCLUB_WORKER_BEARER_TOKEN: 'cc_live_test_worker',
    },
  });

  assert.match(stdout, /== migration status ==/);
  assert.match(stdout, /applied:0015_delivery_worker_tokens/);
  assert.match(stdout, /== worker token env ==\s+present/s);
  assert.match(stdout, /== api session.describe ==\s+skipped \(set CLAWCLUB_HEALTH_TOKEN to enable\)/s);
});
