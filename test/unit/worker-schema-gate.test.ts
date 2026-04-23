import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.ts';
import { assertWorkerSchemaReady, type WorkerPools } from '../../src/workers/runner.ts';

function makeSchemaGatePools(options: {
  hasSchemaMigrationsTable?: boolean;
  migrationFilenames?: string[];
  latestMigration?: string | null;
} = {}): WorkerPools {
  const hasSchemaMigrationsTable = options.hasSchemaMigrationsTable ?? true;
  const migrationFilenames = new Set(options.migrationFilenames ?? []);
  const latestMigration = options.latestMigration ?? null;

  return {
    db: {
      query: async (sql: string, params?: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.includes('from information_schema.tables')) {
          return { rows: [{ exists: hasSchemaMigrationsTable }] };
        }

        if (normalized.includes('from public.schema_migrations where filename = $1')) {
          const filename = String(params?.[0] ?? '');
          return {
            rows: [{
              has_required: migrationFilenames.has(filename),
              latest: latestMigration,
            }],
          };
        }

        throw new Error(`Unexpected query in test harness: ${normalized}`);
      },
      end: async () => {},
    },
  } as unknown as WorkerPools;
}

test('assertWorkerSchemaReady throws when schema_migrations does not exist', async () => {
  const pools = makeSchemaGatePools({ hasSchemaMigrationsTable: false });

  await assert.rejects(
    assertWorkerSchemaReady('embedding', pools, '018_drift_cleanup.sql'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.kind, 'worker_fatal');
      assert.match(String(error.message), /public\.schema_migrations does not exist/);
      return true;
    },
  );
});

test('assertWorkerSchemaReady throws when the required migration row is missing', async () => {
  const pools = makeSchemaGatePools({
    migrationFilenames: ['017_rename_entities_to_contents.sql'],
    latestMigration: '017_rename_entities_to_contents.sql',
  });

  await assert.rejects(
    assertWorkerSchemaReady('embedding', pools, '018_drift_cleanup.sql'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.kind, 'worker_fatal');
      assert.match(String(error.message), /requires migration 018_drift_cleanup\.sql but database latest is 017_rename_entities_to_contents\.sql/);
      return true;
    },
  );
});

test('assertWorkerSchemaReady allows the required migration', async () => {
  const pools = makeSchemaGatePools({
    migrationFilenames: ['018_drift_cleanup.sql'],
    latestMigration: '018_drift_cleanup.sql',
  });

  await assert.doesNotReject(
    assertWorkerSchemaReady('embedding', pools, '018_drift_cleanup.sql'),
  );
});

test('assertWorkerSchemaReady allows newer schemas that still include the required migration', async () => {
  const pools = makeSchemaGatePools({
    migrationFilenames: ['018_drift_cleanup.sql', '019_future_change.sql'],
    latestMigration: '019_future_change.sql',
  });

  await assert.doesNotReject(
    assertWorkerSchemaReady('example-worker', pools, '018_drift_cleanup.sql'),
  );
});
