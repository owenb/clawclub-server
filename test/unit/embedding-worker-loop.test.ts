import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_PROFILES } from '../../src/ai.ts';
import { processEmbeddings } from '../../src/workers/embedding.ts';
import { resetInstalledWorkerProcessHandlersForTests, runWorkerLoop, type WorkerPools } from '../../src/workers/runner.ts';

function makeEmbeddingPools() {
  let endCalls = 0;
  const releasedJobIds: string[][] = [];

  const pools = {
    db: {
      query: async (sql: string, params?: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.startsWith("with claimable as ( select id, state from ai_embedding_jobs where next_attempt_at <= now() and subject_kind = $1 and state in ('queued', 'budget_blocked')")) {
          return {
            rows: [{
              id: 'job-1',
              subject_kind: 'member_club_profile_version',
              subject_version_id: 'profile-1',
              model: EMBEDDING_PROFILES.member_profile.model,
              dimensions: EMBEDDING_PROFILES.member_profile.dimensions,
              source_version: EMBEDDING_PROFILES.member_profile.sourceVersion,
              attempt_count: 1,
              previous_state: 'queued',
            }],
          };
        }

        if (normalized.startsWith('select mcpv.id, mcpv.member_id, mcpv.club_id, m.public_name,')) {
          return {
            rows: [{
              id: 'profile-1',
              member_id: 'member-1',
              club_id: 'club-1',
              public_name: 'Alice',
              display_name: 'Alice',
              tagline: null,
              summary: null,
              what_i_do: null,
              known_for: null,
              services_summary: null,
              website_url: null,
              links: null,
              is_current: true,
            }],
          };
        }

        if (normalized.startsWith('with requested(member_id, club_id, model, dimensions, source_version) as (')) {
          return { rows: [] };
        }

        if (normalized.startsWith('delete from ai_embedding_jobs where id = any($1::text[])')) {
          return { rows: [] };
        }

        if (normalized.startsWith("update ai_embedding_jobs set state = 'queued', attempt_count = greatest(attempt_count - 1, 0),")) {
          releasedJobIds.push(((params?.[0] as string[]) ?? []).slice());
          return { rows: [] };
        }

        if (normalized.startsWith('insert into ai_llm_usage_log')) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query in test harness: ${normalized}`);
      },
      end: async () => { endCalls += 1; },
    },
  } as unknown as WorkerPools;

  return {
    pools,
    releasedJobIds,
    getEndCalls: () => endCalls,
  };
}

test('embedding worker loop exits 1 when OPENAI_API_KEY is missing for queued jobs', async (t) => {
  resetInstalledWorkerProcessHandlersForTests();
  t.after(() => { resetInstalledWorkerProcessHandlersForTests(); });

  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousStub = process.env.CLAWCLUB_EMBEDDING_STUB;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CLAWCLUB_EMBEDDING_STUB;

  t.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }

    if (previousStub === undefined) {
      delete process.env.CLAWCLUB_EMBEDDING_STUB;
    } else {
      process.env.CLAWCLUB_EMBEDDING_STUB = previousStub;
    }
  });

  const { pools, releasedJobIds, getEndCalls } = makeEmbeddingPools();
  let exitCode: number | null = null;
  let sleepCalls = 0;

  await runWorkerLoop(
    'embedding',
    pools,
    processEmbeddings,
    {
      pollIntervalMs: 0,
      logger: () => {},
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls > 3) {
          process.emit('SIGTERM');
        }
      },
      terminate: (code) => { exitCode = code; },
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(releasedJobIds, [['job-1']]);
  assert.equal(getEndCalls(), 1);
});
