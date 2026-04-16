# Plan: Worker reliability surgical wins

One PR, six independent worker-side fixes. No migrations. No schema changes. Touches only `src/workers/runner.ts`, `src/workers/synchronicity.ts` (entry point only), and `src/workers/embedding.ts`.

## Context

Six items from `plans/BUGS.md` (one P0, two P1, three P2) that are all surgical, all touching worker code only, and none of which touch synchronicity's match/recompute engine internals. The synchronicity engine is about to get a full overhaul — this PR must leave the match lifecycle, cursor-advance pattern, and recompute-queue semantics untouched.

## Optional split

Technically coherent as one PR. Natural seam if reviewers want two smaller PRs:

- **Runner/harness reliability** — Fixes 1–4 (all touch `runner.ts` plus synchronicity entry point)
- **Embedding correctness/visibility** — Fixes 5–6 (isolated to `embedding.ts`)

Default is one PR. Split only if review feedback asks for it.

## Scope exclusions (explicit)

These worker-adjacent bugs are **out of scope** for this PR:

- BUGS.md P0 "Match destruction on worker restart" — synchronicity engine logic
- BUGS.md P1 "New entity matches lost when embedding worker is behind" — synchronicity engine logic
- BUGS.md P1 "Recompute queue drops signals while a claim is in flight" — synchronicity engine logic
- BUGS.md P2 "No global unhandledRejection/uncaughtException handler" — API server, separate PR
- BUGS.md P2 "No abortSignal on outbound LLM/embedding calls" — crosses worker/server boundary, separate PR

All five will be tackled later. Do not bundle them in.

## Prior art to mirror

The worker process-handlers PR (commits `57ba2ca` and `69dae2d`) established the patterns we follow here:

- **Factor the logic into testable factories** (see `createWorkerPoolErrorHandler` in `runner.ts` at the time of writing). Extract the behavior into a pure function that takes its dependencies (logger, timer, clock) as injected options, then have the production code call it with defaults. This makes unit tests trivial and keeps the wiring thin.
- **Add a wiring regression test** for each place the factory is attached to real infrastructure (pool, process, loop). Factory tests alone don't catch a deleted `db.on('error', handler)` line — the wiring test does.

Use these two patterns throughout.

---

## Fix 1: Synchronicity horizontal-scale guard (BUGS.md P0)

### The bug

`src/workers/synchronicity.ts` entry point (around line 1014–1026 at time of writing). The synchronicity worker reads and advances a single `worker_state` cursor with no lease, no `FOR UPDATE`, no advisory lock. Two replicas — or any deploy overlap window where old + new processes run briefly together — race the same cursor and corrupt match state silently (same root cause as the match-destruction bug). Safe today only because we run `replicas=1`. First time anyone sets `replicas: 2`, it's an invisible time bomb.

### Railway restart policy — why this needs retry-with-backoff, not single-try

`railway.json` in this repo sets:

```json
{
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

Railway's `ON_FAILURE` semantics:
- **Exit 0** → Railway treats this as "service completed normally." **Does not restart.**
- **Exit 1** → Railway restarts the container, up to 10 times, then gives up.

This interacts badly with a naive "single try, exit on lock held" design. Railway's rolling-deploy pattern has an overlap window: the new container starts while the old one is still running, and the old one only receives SIGTERM once the new one is up. During that overlap, the new container's `pg_try_advisory_lock` returns `false` because the old still holds it.

If the new container exits **0** on that first failure, Railway sees "successful completion" and does not bring it back. The old container eventually gets SIGTERM, its session-scoped lock releases with its TCP connection — but there's no new container to take over. **Silent deploy failure.** We'd only notice when the deployed version stops matching `main`.

Right design:
- Retry in-process for long enough to cover the deploy overlap (~60s is plenty — old container's SIGTERM grace window is 30s). This absorbs every normal deploy without Railway restarts.
- If we still can't acquire after that in-process retry window, exit **1** so Railway's `ON_FAILURE` policy kicks in. Total recovery budget then becomes ~10 minutes (60s × 10 retries) — far more than any legitimate deploy overlap.

Don't use the blocking `pg_advisory_lock` here — if the old container is wedged instead of terminating, a blocking acquire has no upper bound and the new container never gives up.

### The fix

At the synchronicity worker's entry point, **before** `runWorkerLoop` or `runWorkerOnce` is called, acquire a session-scoped Postgres advisory lock on a dedicated connection, with bounded retry. Exit 1 if we can't acquire.

Implementation:

1. Add a new export in `runner.ts`:

```typescript
import { Client } from 'pg';

export type ExclusiveLockResult =
  | { acquired: true; client: Client }
  | { acquired: false; attempts: number };

export type AcquireExclusiveWorkerLockOptions = {
  databaseUrl?: string;
  logger?: WorkerLogger;
  maxAttempts?: number;      // default 30
  retryDelayMs?: number;     // default 2000 → ~60s total window
  sleep?: (ms: number) => Promise<void>;  // injectable for tests
};

/**
 * Acquires a session-scoped Postgres advisory lock on a dedicated connection,
 * retrying to cover the brief overlap window during a Railway rolling deploy.
 *
 * On success: returns the connected Client. Caller MUST keep it alive for the
 *   worker's lifetime and close it on shutdown — closing releases the lock.
 * On final failure: returns { acquired: false, attempts }. Caller should
 *   exit(1) so Railway's ON_FAILURE policy retries the container.
 */
export async function acquireExclusiveWorkerLock(
  lockKey: string,
  options: AcquireExclusiveWorkerLockOptions = {},
): Promise<ExclusiveLockResult> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  const logger = options.logger ?? console.error;
  const maxAttempts = options.maxAttempts ?? 30;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const { rows } = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtext($1)) as acquired`,
      [lockKey],
    );
    if (rows[0]?.acquired) return { acquired: true, client };
    await client.end().catch(() => {});
    if (attempt === 1) {
      logger(`[${lockKey}] lock held by another instance, retrying up to ${maxAttempts} times every ${retryDelayMs}ms...`);
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  return { acquired: false, attempts: maxAttempts };
}
```

Implementation notes:
- **Fresh `Client` per attempt.** Keeping one open across attempts would complicate cleanup if the server closed it mid-wait. New-client-per-attempt against localhost/same-region Postgres is a few milliseconds — negligible.
- **Log once on the first miss, not per retry.** 30 log lines per deploy is noise; one line plus eventual success-or-exit is enough.
- **`sleep` is injectable** so the retry-behavior unit test doesn't wait real seconds.

2. In `src/workers/synchronicity.ts`, update the `if (import.meta.url === ...)` block to call it first, and **wrap the run in try/finally** to close the lock client:

```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const lock = await acquireExclusiveWorkerLock('clawclub:synchronicity');
  if (!lock.acquired) {
    console.error(
      `[synchronicity] failed to acquire advisory lock after ${lock.attempts} attempts — exiting 1 so Railway's ON_FAILURE policy retries the container`,
    );
    process.exit(1);
  }
  const pools = createPools({ name: 'synchronicity' });
  try {
    if (process.argv.includes('--once')) {
      await runWorkerOnce('synchronicity', pools, processSynchronicity);
    } else {
      await runWorkerLoop('synchronicity', pools, processSynchronicity, {
        pollIntervalMs: POLL_INTERVAL_MS,
        healthPort,
      });
    }
  } finally {
    // Release the advisory lock by closing its dedicated connection.
    // CRITICAL for `--once` mode: without this, the process hangs with
    // an open Postgres connection instead of exiting after the run completes.
    // In loop mode this only runs on graceful shutdown (exit or SIGTERM).
    await lock.client.end().catch(() => {});
  }
}
```

**Exit code 1, not 0, on final failure.** See the Railway section above. A previous draft of this plan said to exit 0 on the theory that "lock already held" is expected behavior and shouldn't look like an error. That reasoning is wrong here: Railway's `ON_FAILURE` policy only retries on non-zero exit, so exit 0 during a rolling deploy would leave us with the old container still running and no replacement — a silent deploy failure. Exit 1 lets the restart policy do its job.

The `try/finally` pattern is load-bearing. An earlier draft of this plan suggested skipping explicit lock-client cleanup on the theory that process death releases the lock anyway. That's true for loop mode (where the process actually dies on shutdown), but wrong for `--once` mode: `runWorkerOnce` returns and the script continues to top-level, and the dedicated `Client` keeps its TCP connection open, so the Node event loop can't drain and the process hangs.

**Why the `client.end()` error is swallowed — do not "clean this up" in review.** We intentionally `.catch(() => {})` on `client.end()` for two reasons. First, this is the worker's exit path — there is nothing useful to do with an error here, and re-throwing would mask whatever the real error is (the one in the `try` block, if any). Second, the advisory lock is **session-scoped**: the Postgres backend releases it automatically when the TCP connection terminates, whether that's a clean `end()` or an abrupt process exit. So even if `client.end()` throws, the lock will still be released by connection teardown. A future refactor that removes the `.catch` to "surface the error properly" is a regression — leave the comment explaining why it's swallowed.

### Required regression tests

**Retry-loop unit test** in `test/unit/worker-exclusive-lock-retry.test.ts` (no DB; pure logic). Mock or stub the `pg.Client` so every `query` returns `{ acquired: false }`; pass a fake `sleep` spy via the `sleep` option:

- Call `acquireExclusiveWorkerLock('test', { databaseUrl: 'postgresql://stub', maxAttempts: 5, retryDelayMs: 1000, sleep: fakeSleep })`.
- Assert the result is `{ acquired: false, attempts: 5 }`.
- Assert `fakeSleep` was called exactly **4** times (between attempts 1→2, 2→3, 3→4, 4→5 — not after the final attempt) with `1000`.
- Assert the logger was called **once** (not 5 times).

This test exercises the retry loop without needing a real DB. The cleanest way to stub the Client is to dependency-inject a Client factory — if that's too invasive for this PR, leave the retry test as a real-DB test in `unit-db` and rely on `maxAttempts: 2, retryDelayMs: 10` to keep it fast.

**Real-DB tests** in `test/unit-db/worker-exclusive-lock.test.ts`:
- First call acquires the lock against the real test DB.
- While held, a second call with the **same key** and `{ maxAttempts: 2, retryDelayMs: 10 }` returns `{ acquired: false, attempts: 2 }` after roughly 10ms (proves the retry actually ran, not just short-circuited).
- After the first client is `end()`'d, a third call with that key succeeds.
- A concurrent call with a **different** key against the held first lock succeeds immediately (proves the lock is keyed, not global).
- Teardown ends all clients cleanly so other tests don't see lingering locks.

**Wiring test** — same `unit-db` file: two in-process concurrent `acquireExclusiveWorkerLock` calls with the same key and `{ maxAttempts: 1 }`. Assert exactly one gets `{ acquired: true }`; the other gets `{ acquired: false, attempts: 1 }`. This proves the factory is wired to a real Postgres advisory lock and not a no-op stub.

---

## Fix 2: Cancellable worker sleep (BUGS.md P2 "Worker sleep is not cancellable")

### The bug

`src/workers/runner.ts:133-135`. `sleep(ms)` is a plain `setTimeout` promise with no abort path. In `runWorkerLoop`, SIGTERM sets `shutdownRequested = true`, but the loop only re-checks the flag when it wakes up. Synchronicity's poll interval is 30s and Railway's SIGTERM grace window is also 30s — so workers caught mid-sleep regularly get SIGKILLed, which leaks pool connections and can interrupt an in-flight transaction on the next poll.

### The fix

Replace the internal `sleep` with an abort-aware version and plumb an `AbortController` through `runWorkerLoop`. Triggered by SIGTERM/SIGINT (in addition to the existing `shutdownRequested` flag, which stays as the authoritative loop-exit check).

Concrete changes in `runner.ts`:

```typescript
// Replace the current `sleep` (line 133-135) with:
export function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// In runWorkerLoop, replace the current sleep calls AND add listener cleanup:
const shutdownController = new AbortController();
const requestShutdown = () => {
  shutdownRequested = true;
  shutdownController.abort();
};
process.on('SIGTERM', requestShutdown);
process.on('SIGINT', requestShutdown);

try {
  while (!shutdownRequested) {
    try {
      const processed = await processFn(pools);
      if (processed === 0 && !shutdownRequested) {
        await cancellableSleep(opts.pollIntervalMs, shutdownController.signal);
      }
    } catch (err) {
      console.error(`Worker ${name} error:`, err);
      if (!shutdownRequested) await cancellableSleep(opts.pollIntervalMs, shutdownController.signal);
    }
  }
} finally {
  // Remove the SIGTERM/SIGINT listeners this loop installed so repeated
  // in-process invocations (tests) don't leave stale handlers on the process.
  process.off('SIGTERM', requestShutdown);
  process.off('SIGINT', requestShutdown);
  if (health) health.close();
  await closePools(pools);
}
```

The existing `runWorkerLoop` already does `health.close()` and `closePools(pools)` at the bottom — move those into the new `finally` block and delete the originals. No behavioral regression for production (the finally runs on normal exit); the only functional change is the new `process.off` calls and the finally semantics on error paths (which is an improvement — connections don't leak on a thrown error escaping the loop, though in practice that shouldn't happen with the inner try/catch in place).

### Required regression tests

Unit test in `test/unit/worker-cancellable-sleep.test.ts`:
- `cancellableSleep(10_000, signal)` resolves in <50ms when `controller.abort()` is fired mid-sleep. (Assert wall-clock duration to prove the abort actually shortened the sleep.)
- `cancellableSleep(50, signal)` resolves on timer when the signal is not aborted.
- `cancellableSleep(10_000, signal)` resolves immediately (<10ms) when the signal is already aborted before the call.
- After resolve, no dangling timer keeps the event loop alive (assert via `t.after` that the test completes cleanly).

Wiring test — same file: start `runWorkerLoop` with a fake `processFn` returning 0 and a 5s poll interval; `process.emit('SIGTERM')`; assert loop exits within 100ms. This proves the SIGTERM handler is actually wired to the abort controller.

**Test hygiene matters here.** `runner.ts` attaches `process.on('SIGTERM'/'SIGINT')` listeners inside `runWorkerLoop`. The updated implementation above removes them in the loop's `finally` block — without that, every test that invokes `runWorkerLoop` leaves a stale listener on the process, and subsequent tests in the same file get their `shutdownRequested` flipped by residue signals from earlier tests. Run `resetInstalledWorkerProcessHandlersForTests()` in `t.after` for every test in this file (for belt-and-suspenders — that helper handles unhandledRejection/uncaughtException, and the new `process.off` in `runWorkerLoop`'s finally handles SIGTERM/SIGINT). Assert `process.listenerCount('SIGTERM')` is unchanged after loop exit.

---

## Fix 3: Worker DB pools need `statement_timeout` (BUGS.md P2)

### The bug

`src/workers/runner.ts:108`. `createPools` builds `new Pool({ connectionString, max })` with no `options` param. The HTTP server pool sets `options: '-c statement_timeout=30000'`; worker pools don't. A pathological or stuck query holds a connection forever; with `max=3`, three stuck queries soft-deadlock the worker with no visible error.

### The fix

In `createPools`:

```typescript
const db = new Pool({
  connectionString: databaseUrl,
  max,
  options: '-c statement_timeout=60000',
});
```

60 seconds, not 30, because worker batches (synchronicity match computation, embedding insertion with upserts) can legitimately take longer than an HTTP request. If 60s turns out too short, revisit — but don't start at 30s just to match the HTTP server.

### Required regression test

Unit-DB test in `test/unit-db/worker-pool-statement-timeout.test.ts` (needs real Postgres to run `SHOW`):

```typescript
test('createPools configures statement_timeout on the worker pool', async () => {
  // Set DATABASE_URL to local test DB, construct pool via createPools.
  // Acquire a client and run: SHOW statement_timeout
  // Assert the value is '1min' (Postgres normalizes 60000ms to '1min').
  // Close pool in finally.
});
```

This exact-value test catches: the options string being missing, being wrong syntax (silently ignored by Postgres), or having the wrong number. A grep test isn't enough — the runtime behavior is what matters.

---

## Fix 4: Exponential backoff on `processFn` exceptions (BUGS.md P2 "Worker processFn exception path has no backoff")

### The bug

`src/workers/runner.ts:162-165`. On any exception from `processFn`, the loop logs the error and sleeps for `pollIntervalMs` (e.g. 5 seconds for embedding). A permanently-failing upstream (Postgres unavailable, OpenAI rate-limiting, poison row) produces 12 error logs per minute forever — noisy, expensive on DB reconnect attempts, and hides the actual problem under log spam.

### The fix

Track consecutive failures in `runWorkerLoop`. On exception, sleep for `min(pollIntervalMs * 2^(failures-1), MAX_BACKOFF_MS)`. Reset the counter on any successful `processFn` call (even if it returned 0 — "successfully saw no work" is success). Cap: 5 minutes.

Extract the backoff calculation as a pure function so it's unit-testable:

```typescript
const MAX_BACKOFF_MS = 5 * 60_000;

export function computeBackoffMs(
  pollIntervalMs: number,
  consecutiveFailures: number,
  maxBackoffMs: number = MAX_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return pollIntervalMs;
  return Math.min(pollIntervalMs * Math.pow(2, consecutiveFailures - 1), maxBackoffMs);
}
```

Loop change:

```typescript
let consecutiveFailures = 0;
while (!shutdownRequested) {
  try {
    const processed = await processFn(pools);
    consecutiveFailures = 0;
    if (processed === 0 && !shutdownRequested) {
      await cancellableSleep(opts.pollIntervalMs, shutdownController.signal);
    }
  } catch (err) {
    consecutiveFailures += 1;
    console.error(`Worker ${name} error (attempt ${consecutiveFailures}):`, err);
    if (!shutdownRequested) {
      const backoff = computeBackoffMs(opts.pollIntervalMs, consecutiveFailures);
      await cancellableSleep(backoff, shutdownController.signal);
    }
  }
}
```

No jitter. The worker is a singleton (enforced by Fix 1 for synchronicity; embedding is naturally serialized by the advisory-lock-free claim-skip-locked pattern). Jitter's benefit is thundering-herd avoidance, which doesn't apply.

**Limitation worth being explicit about:** backoff only fires for exceptions that **escape** `processFn`. The embedding worker's handled-error paths at `embedding.ts:242-252` catch OpenAI errors internally and return `0` — those count as "success with no work" from the loop's perspective and will NOT trigger backoff. That's fine behaviorally (handled errors are already throttled by `next_attempt_at` updates in the DB), but don't expect this fix to quiet repeated OpenAI rate-limit log lines from embedding. Bringing those under backoff is a separate change.

### Required regression tests

Unit test in `test/unit/worker-backoff.test.ts`:
- `computeBackoffMs(5000, 0)` === 5000 (no failures yet, sleep at poll interval).
- `computeBackoffMs(5000, 1)` === 5000.
- `computeBackoffMs(5000, 2)` === 10000.
- `computeBackoffMs(5000, 3)` === 20000.
- `computeBackoffMs(5000, 10)` === MAX_BACKOFF_MS (clamped).
- `computeBackoffMs(1000, 100)` === MAX_BACKOFF_MS (clamped at high counts).

Wiring test — same file: call `runWorkerLoop` with a fake `processFn` that throws 3 times then returns 0, capture the sleep call arguments (inject a fake `cancellableSleep` via options or monkey-patch), assert the sequence is `[5000, 10000, 20000, 5000]` (three backoffs + one post-success poll), then SIGTERM to exit. This proves the counter actually increments on failure and resets on success in the real loop path.

**Note on monkey-patching:** if `cancellableSleep` can't be cleanly injected as an option without churning the public signature, a lighter wiring test is acceptable: fake `processFn` throws N times with timestamps captured, assert the gaps between calls are monotonically increasing (and within expected ranges). The point is to prove the backoff shape shows up in the real loop, not just in the pure function.

---

## Fix 5: Embedding batches silently mix model dimensions (BUGS.md P1)

### The bug

`src/workers/embedding.ts:63-84` (`claimJobs`), `198-262` (`processPlane`). `claimJobs` filters only by `subject_kind`. Inside `processPlane`, `embedManyDocuments` receives a fixed `profile: 'member_profile' | 'entity'` — which resolves to the currently-configured `EMBEDDING_PROFILES[profile].model` and dimensions. But each individual job row carries its own `model` and `dimensions` columns, captured at enqueue time. During a model migration, jobs enqueued under the old config are claimed together with jobs enqueued under the new config. All get embedded with the **current** profile model, but the stored artifact is labeled with each **job's** historical model/dimensions. Result: vectors and labels disagree.

This isn't actively firing today (the config has been stable), but it's a silent-corruption trap waiting on the next model change.

### The fix

Filter `claimJobs` by the current profile's `(model, dimensions)` tuple. Jobs with a different tuple are left in the table — they'll age out or be cleaned up by a future housekeeping pass, but they will never be claimed and embedded against the wrong model.

Signature change:

```typescript
async function claimJobs(
  pool: Pool,
  subjectKind: EmbeddingJob['subject_kind'],
  model: string,
  dimensions: number,
  limit: number,
): Promise<EmbeddingJob[]> {
  const result = await pool.query<EmbeddingJob>(
    `update ai_embedding_jobs
     set attempt_count = attempt_count + 1,
         next_attempt_at = now() + interval '5 minutes'
     where id in (
       select id from ai_embedding_jobs
       where attempt_count < $1
         and next_attempt_at <= now()
         and subject_kind = $2
         and model = $3
         and dimensions = $4
       order by next_attempt_at asc
       limit $5
       for update skip locked
     )
     returning id, subject_kind, subject_version_id, model, dimensions, source_version, attempt_count`,
    [MAX_ATTEMPTS, subjectKind, model, dimensions, limit],
  );
  return result.rows;
}
```

Callers in `processPlane` need to pass the current profile config:

```typescript
const profile = subjectKind === 'member_club_profile_version' ? EMBEDDING_PROFILES.member_profile : EMBEDDING_PROFILES.entity;
const jobs = await claimJobs(pool, subjectKind, profile.model, profile.dimensions, BATCH_SIZE);
```

Adjust the import in `embedding.ts` if `EMBEDDING_PROFILES.entity` isn't already imported.

### Required regression test

Unit-DB test in `test/unit-db/embedding-claim-jobs-dimension-filter.test.ts` (no HTTP harness needed — just DB):

- Seed two embedding jobs:
  - Job A: `subject_kind='member_club_profile_version'`, `model='text-embedding-3-small'`, `dimensions=1536` (matches current config).
  - Job B: same `subject_kind`, but `model='text-embedding-legacy'`, `dimensions=768` (doesn't match).
- Call `claimJobs(pool, 'member_club_profile_version', 'text-embedding-3-small', 1536, 10)`.
- Assert exactly one job returned, with id matching Job A.
- Query `ai_embedding_jobs` directly: assert Job B is still present, untouched (attempt_count unchanged).

This test, when run against `main`, will return both jobs from `claimJobs` — proving the bug. After the fix, it returns only Job A.

**Heads up:** `claimJobs` is not currently exported. Either export it for this test, or write the test at the `processPlane` level using a stub `embedManyDocuments` to avoid real LLM calls. Exporting is simpler — it mirrors what `runner.ts` does with `createWorkerPoolErrorHandler` etc.

**Side effect worth flagging explicitly:** this fix intentionally leaves dimension-mismatch jobs sitting in `ai_embedding_jobs` forever — never claimed, never dead-lettered. They do NOT appear in Fix 6's `embeddingDeadLetterCount` (which counts rows where `attempt_count >= MAX_ATTEMPTS`, and these rows never have their attempt_count incremented because they're excluded at claim time). A future PR should either add housekeeping to drop mismatched-config rows, or expose a separate `embeddingStaleConfigCount` on `/health`. Out of scope here; worth a one-line TODO in a comment near the new filter.

---

## Fix 6: Embedding dead-letter visibility (BUGS.md P1)

### The bug

`src/workers/embedding.ts:63-84` (`claimJobs`) and `127-135` (`retryJobs`). After `attempt_count` reaches `MAX_ATTEMPTS` (5), `claimJobs`'s `attempt_count < $1` filter excludes the row permanently. No alert, no metric, no admin surface. A poison row goes silent after 5 tries and the embedding for that subject never materializes — invisibly blocking downstream match/search for that profile or entity forever.

### The fix

Two-part, both narrow:

**Part A: loud log on the attempt that tipped over the cap.** In `processPlane`, when an exception from `embedManyDocuments` or `insertArtifact` results in a `retryJobs` call, inspect each affected job's `attempt_count` (already in `prepared[i].job.attempt_count`, which reflects the post-increment value from `claimJobs`). If it equals `MAX_ATTEMPTS`, emit a distinguishable log line:

```typescript
function logIfDeadLettered(job: EmbeddingJob, errorMsg: string): void {
  if (job.attempt_count >= MAX_ATTEMPTS) {
    console.error('[embedding] job dead-lettered after max attempts', {
      jobId: job.id,
      subjectKind: job.subject_kind,
      subjectVersionId: job.subject_version_id,
      model: job.model,
      dimensions: job.dimensions,
      attempts: job.attempt_count,
      lastError: errorMsg.slice(0, 500),
    });
  }
}
```

Call it inside the two error paths: the batch `retryJobs` call (after `embedManyDocuments` fails with a non-config error), and the per-job `retryJobs` call (after `insertArtifact` fails).

**Part B: expose an at-or-over-cap count via `/health`.** Currently `startHealthServer` in `runner.ts` only returns `{ worker: name, status: 'running' }`. Widen it to accept an optional `metricsFn` that can return additional fields:

**Semantics worth being precise about:** the count query is literally "rows where `attempt_count >= MAX_ATTEMPTS`." Today that approximates a dead-letter queue, because no other code path touches `attempt_count` once it's at the cap — a row there is effectively stuck and can't be reclaimed without manual intervention. But the metric is "at-or-over-cap," not "guaranteed-dead." If future work introduces a `failed` state, a manual-retry flow, or any background process that decrements or resets `attempt_count`, the metric's semantics change without the query changing. Document this in a comment on the metric function so a future reviewer doesn't read "dead-letter" as a stronger guarantee than the query provides. The exposed field name `embeddingDeadLetterCount` is idiomatic and fine to keep — the looseness is in the underlying definition, not the label.

```typescript
// In runner.ts:
type HealthMetricsFn = () => Promise<Record<string, unknown>>;

function startHealthServer(port: number, name: string, metricsFn?: HealthMetricsFn): http.Server {
  const server = http.createServer(async (_req, res) => {
    let metrics: Record<string, unknown> = {};
    if (metricsFn) {
      try { metrics = await metricsFn(); } catch (err) {
        metrics = { metrics_error: err instanceof Error ? err.message : String(err) };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ worker: name, status: 'running', ...metrics }));
  });
  server.listen(port, () => console.log(`Health endpoint for ${name} on :${port}`));
  return server;
}

// WorkerLoopOptions gains:
export type WorkerLoopOptions = {
  pollIntervalMs: number;
  healthPort?: number;
  healthMetrics?: HealthMetricsFn;
};
```

In `embedding.ts`, pass a `healthMetrics` that returns the dead-letter count:

```typescript
await runWorkerLoop('embedding', pools, processEmbeddings, {
  pollIntervalMs: POLL_INTERVAL_MS,
  healthPort,
  healthMetrics: async () => {
    const { rows } = await pools.db.query<{ count: string }>(
      `select count(*)::text as count from ai_embedding_jobs where attempt_count >= $1`,
      [MAX_ATTEMPTS],
    );
    return { embeddingDeadLetterCount: Number(rows[0]?.count ?? 0) };
  },
});
```

### Required regression tests

Unit test in `test/unit/embedding-dead-letter-log.test.ts`:
- Factor `logIfDeadLettered` as exported pure fn. Test: job with `attempt_count = 4` → no log. Job with `attempt_count = 5` → one log with stable prefix `[embedding] job dead-lettered after max attempts`. Job with `attempt_count = 6` → one log (guard is `>= MAX_ATTEMPTS`, not `===`).
- Inject the logger; assert exactly one call with the expected shape.

Unit-DB test in `test/unit-db/embedding-health-deadletter.test.ts` (needs real Postgres, no HTTP harness):
- Seed one `ai_embedding_jobs` row with `attempt_count = 5` (at cap, dead-lettered).
- Seed one row with `attempt_count = 2` (still claimable).
- Call the `healthMetrics` function directly (simplest) — or, for a fuller wiring test, start `runWorkerLoop` with `healthPort: 0` and HTTP GET the resulting URL.
- Assert `embeddingDeadLetterCount === 1`.

The direct-function path validates that the count query is correct. The HTTP path additionally validates that `healthMetrics` is actually wired into `startHealthServer`. Prefer the direct-function test as the primary, and add the HTTP variant if it's cheap to write.

**Caveat worth flagging — do not treat this as a strong liveness signal.** The dead-letter count runs a DB query on every `/health` hit. If the worker pool is itself wedged (which is when you'd want `/health` to tell you something), the request hangs waiting for a connection and the endpoint stops responding. This is a "show me the number when things are working" metric, not a liveness probe. If real liveness is needed later, keep a cheap in-memory heartbeat alongside.

---

## Shared steps for the PR

1. **Type-check**: `npx tsc --noEmit` must pass cleanly. If unrelated in-flight work (quality-gate redesign, etc.) leaves the tree red, check with the user before proceeding.
2. **Unit tests**: `npm run test:unit`
3. **Unit-DB tests**: `npm run test:unit:db` (Fix 1's exclusive-lock test lives here — needs real Postgres).
4. **Integration tests**: `npm run test:integration:non-llm` — should stay green (this PR adds no integration tests, but we must not regress the existing ones).
5. **Prove the new tests actually catch the bugs** — safely.

   The working tree is dirty with concurrent workstreams. **CLAUDE.md forbids both destructive git commands AND worktrees** — all work stays on `main`. Do not run `git checkout --`, `git stash`, `git restore`, or `git worktree add`.

   For each regression test, verify it fails on main using a **temporary clone**:

   ```bash
   git clone /Users/owen/Work/ClawClub/clawclub-server /tmp/clawclub-main-verify
   cd /tmp/clawclub-main-verify
   git checkout main   # safe here — this is a fresh clone, no working-tree changes
   # copy ONLY the new test files from the working repo (not the fixes):
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit/worker-cancellable-sleep.test.ts test/unit/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit/worker-backoff.test.ts test/unit/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit/embedding-dead-letter-log.test.ts test/unit/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit/worker-exclusive-lock-retry.test.ts test/unit/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit-db/worker-exclusive-lock.test.ts test/unit-db/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit-db/worker-pool-statement-timeout.test.ts test/unit-db/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit-db/embedding-claim-jobs-dimension-filter.test.ts test/unit-db/
   cp /Users/owen/Work/ClawClub/clawclub-server/test/unit-db/embedding-health-deadletter.test.ts test/unit-db/
   npm install
   npm run test:unit      # these should fail where the fix hasn't landed
   npm run test:unit:db
   ```

   For each new test, confirm it fails in the clone. If a test passes against main, it's not catching the bug — rewrite until it does. Then return to the working repo, confirm everything green, and `rm -rf /tmp/clawclub-main-verify`.

   **Watch out for the "import error passing as bug detection" trap:** if your fix adds a new export (like `cancellableSleep`, `computeBackoffMs`, `acquireExclusiveWorkerLock`), a test that imports it will fail on main simply because the import fails — not because the behavior is wrong. If someone kept the export but deleted the wiring line that uses it, the import still succeeds and your test still passes.

   **Mitigation:** for each new fix, one of the regression tests must not depend on the new exports. For example:
   - Fix 3 (statement_timeout) tests runtime behavior via `SHOW statement_timeout` — independent of imports.
   - Fix 5 (dimension filter) tests actual DB rows returned by `claimJobs` — the test body needs the export, but the observable behavior being tested is "Job B is not claimed," which would fail-by-timeout or fail-by-wrong-rows even if the export existed without the filter.
   - Fix 6 (dead-letter) tests the `/health` response shape — independent of any new export.

   The prior worker-handlers PR shipped a follow-up commit (`69dae2d`) adding exactly this kind of test for `createPools`. Do not repeat that miss here.

6. **Bump patch version** in `package.json`.
7. **Commit** with message:
   `Harden worker reliability: advisory lock, cancellable sleep, pool timeout, backoff, embedding correctness`
8. **Do NOT push** — wait for explicit approval from the user.

## Notes on line numbers

Line numbers throughout reflect the tree at plan-writing time. If the tree has shifted (concurrent workstreams), trust the code — find the relevant bits by pattern:
- `sleep(` definition in `runner.ts`
- `claimJobs` function in `embedding.ts`
- the `if (import.meta.url === ...)` entry block in `synchronicity.ts`
- `startHealthServer` in `runner.ts`

The fixes themselves are unambiguous.
