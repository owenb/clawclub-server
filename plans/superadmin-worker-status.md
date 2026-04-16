# Plan: Extend `superadmin.diagnostics.getHealth` with worker status

Roll worker observability into the **existing** diagnostics endpoint. No new action, no new capability, no new repository method.

## Decision — firm

An earlier draft of this plan proposed a new `superadmin.workers.getStatus` action with its own `adminGetWorkerStatus` capability. **Rolled back.** The final decision is: extend the response of `superadmin.diagnostics.getHealth` (`src/schemas/superadmin.ts:166-192`, backing method `src/postgres.ts:1500-1523`) with worker fields. Reasons:

- One fewer public API surface to maintain.
- Dashboard already fetches diagnostics; widening the shape is free for callers.
- The capability/method-split concern that drove the prior design is moot when there's only one method and one capability backing one action.

**Do not create a new action.** **Do not add a new capability to the `RepositoryCapability` union.** **Do not add a new repository method.** If the worker-specific design notes in the prior plan tempt you to split, resist — the intention has been settled.

## Context

`superadmin.diagnostics.getHealth` exists and returns DB-level stats (migrations, table counts, member/club counts, DB size). It does not surface any worker state. This PR adds worker fields to the same response.

## Why DB-backed, not HTTP fan-out to workers

The obvious-but-wrong design is "have the API server hit each worker's `/health` endpoint and aggregate." Don't:

1. **Workers are separate Railway services.** No service discovery, no auth tokens, no configured URLs. Worker `/health` (`src/workers/runner.ts:180-189`) is reachable only inside its own container.
2. **Adding service discovery + auth + timeouts + retry/error handling** is far more code than the DB-backed alternative.
3. **The DB already has every signal we need** — workers persist state to shared tables (`worker_state`, `ai_embedding_jobs`, `signal_recompute_queue`, `signal_background_matches`, `club_activity`).
4. **Operationally robust.** If the API server can talk to Postgres, the endpoint works. Worker process being down is exactly what we're trying to detect — detection must not depend on the worker being up.

The one thing this approach can't do is distinguish "worker process running but stuck" from "worker process dead." Cursor `updated_at` ages approximate it but aren't authoritative. Heartbeat table is out of scope; see "Out of scope."

## Critical worker-specific design points (do NOT collapse — each was flagged in review)

**1. `entityPublicationBacklog` with correct null-cursor handling.**

The synchronicity worker only consumes `topic = 'entity.version.published'` from `club_activity` (`src/workers/synchronicity.ts:222`) and only advances `activity_seq` when one of those rows exists (line 321). `MAX(seq) - activity_seq` over the whole table is wrong — unrelated activity inflates "lag" while the worker is idle and healthy. Right metric:

```sql
SELECT count(*)::text as pending_count,
       extract(epoch from (now() - min(created_at)))::text as oldest_pending_age_seconds
FROM club_activity
WHERE topic = 'entity.version.published' AND seq > $1::bigint
```

**Null-cursor handling — do NOT pass `0`.** If `activity_seq` is missing from `worker_state` (fresh deploy, cleared state), the worker's bootstrap seeds the cursor to current `MAX(seq)` and processes **no historical publications** (`synchronicity.ts:208-212`). Passing `0` would surface every entity publication ever as "backlog" — falsely showing a huge backlog the worker intentionally skips on first run. Instead: set both `pendingCount` and `oldestPendingAgeSeconds` to `null` and skip the query. Schema doc: "`null` means the synchronicity worker has not yet seeded its cursor; the backlog cannot be computed." See test 1a for the regression net.

**2. `retryErrorSample` (not `recentErrors`), with explicit scope doc.**

`last_error` is set only by `retryJobs` (`src/workers/embedding.ts:127-135`) on **work errors**. The release path (`embedding.ts:225-231` for missing API key, `embedding.ts:244-249` for config-class provider errors like quota/billing/auth) does NOT set `last_error`. Those failures persist no DB error and only appear in Railway logs. So this field cannot replace Railway logs for those outage classes; it can only show retryable provider errors.

Also: order by `attempt_count DESC, next_attempt_at ASC` ("most-troubled jobs needing attention"), **not** `next_attempt_at DESC` ("furthest future").

**3. Typed cursors, not raw `worker_state` dump.**

Real synchronicity state keys (verified against `src/workers/synchronicity.ts`):
- `activity_seq` (numeric, line 204)
- `profile_artifact_at` (timestamp, line 333)
- `profile_artifact_member_id` (opaque internal pagination pointer, line 334) — **do NOT surface raw**; would leak a member id
- `membership_scan_at` (timestamp, line 425)
- `backstop_sweep_at` (timestamp, line 965)

Surface typed nested fields per cursor, filter out opaque internals.

**4. Include `signal_recompute_queue` — mutually exclusive partitions.**

The worker enqueues recompute work (`synchronicity.ts:106`) and claims it via 5-minute lease (lines 120-138). If recompute is wedged before match creation, `pendingMatchesCount` stays zero while work piles up invisibly. Partitions:

- **Ready**: `recompute_after <= now() AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')`
- **In-flight**: `recompute_after <= now() AND claimed_at >= now() - interval '5 minutes'`
- **Scheduled**: `recompute_after > now() AND claimed_at IS NULL`

Under normal worker behavior these sum to total queue depth. Degenerate states (e.g., future-dated fresh-lease) are excluded from all three.

**5. `collectedAt` from Postgres `now()`, no app-server fallback.**

Source `collectedAt` from a Postgres aggregate so the timestamp doesn't drift with the app server's wall clock. Do NOT add `?? new Date().toISOString()` — the aggregate query always returns exactly one row, so the fallback is unreachable in practice but would reintroduce the drift this field exists to avoid if someone "cleaned up" the aggregate later.

Schema doc: "The queries underlying this snapshot run in parallel and may complete tens of milliseconds apart. `collectedAt` is approximate — adequate for human observability, not for transaction-consistent reasoning."

## The change

### Extend the `AdminDiagnostics` type (`src/contract.ts`, near line 1160)

Widen the existing type. Keep all current fields unchanged:

```typescript
type AdminDiagnostics = {
  // existing (unchanged):
  migrationCount: number;
  latestMigration: string | null;
  memberCount: number;
  clubCount: number;
  tablesWithRls: number;
  totalAppTables: number;
  databaseSize: string;

  // NEW:
  workers: {
    embedding: {
      queue: {
        claimable: number;
        scheduledFuture: number;
        atOrOverMaxAttempts: number;
      };
      oldestClaimableAgeSeconds: number | null;
      byModel: Array<{
        model: string;
        dimensions: number;
        claimable: number;
        scheduledFuture: number;
        atOrOverMaxAttempts: number;
      }>;
      retryErrorSample: Array<{
        // Only captures retry-class errors. Config-class failures (no API key,
        // quota, billing, auth) release jobs without writing last_error and
        // only appear in Railway logs.
        jobId: string;
        subjectKind: 'member_club_profile_version' | 'entity_version';
        model: string;
        attemptCount: number;
        lastError: string;   // truncated to 500 chars
        nextAttemptAt: string;
      }>;
    };
    synchronicity: {
      cursors: {
        activitySeq: { value: number | null; updatedAt: string | null; ageSeconds: number | null };
        profileArtifactAt: { value: string | null; updatedAt: string | null; ageSeconds: number | null };
        membershipScanAt: { value: string | null; updatedAt: string | null; ageSeconds: number | null };
        backstopSweepAt: { value: string | null; updatedAt: string | null; ageSeconds: number | null };
      };
      entityPublicationBacklog: {
        // Both null when activity_seq cursor is unseeded — backlog cannot be computed
        // because the worker will seed to MAX(seq) and skip historical rows.
        pendingCount: number | null;
        oldestPendingAgeSeconds: number | null;
      };
      recomputeQueue: {
        // Mutually exclusive partitions under normal worker behavior.
        readyCount: number;
        inFlightCount: number;
        scheduledCount: number;
      };
      pendingMatchesCount: number;
    };
  };
  collectedAt: string;  // Postgres now(); approximate — see snapshot-semantics caveat
};
```

### Extend `adminDiagnostics` zod schema in `src/schemas/responses.ts`

Add the new `workers` and `collectedAt` fields to the existing schema. Keep the existing shape intact.

### Extend `adminGetDiagnostics` repo method (`src/postgres.ts:1500-1523`)

Keep the existing five queries. Add the worker queries to the same implementation. The activity_seq cursor must be read first (sequentially) because the entity-backlog query depends on it; the rest run parallel.

Sketch — fold this into the existing method body:

```typescript
async adminGetDiagnostics() {
  const MAX_ATTEMPTS = 5;  // mirror src/workers/embedding.ts
  const RECOMPUTE_LEASE_INTERVAL = `interval '5 minutes'`;  // mirror src/workers/synchronicity.ts:114

  // Sequential first: read synchronicity cursors because the entity-backlog query needs activity_seq.
  const cursorResult = await pool.query<{ state_key: string; state_value: string; updated_at: string; age_seconds: string }>(
    `select state_key, state_value, updated_at::text as updated_at,
            extract(epoch from (now() - updated_at))::text as age_seconds
     from worker_state
     where worker_id = 'synchronicity'
       and state_key in ('activity_seq', 'profile_artifact_at', 'membership_scan_at', 'backstop_sweep_at')`,
  );
  const cursorMap = new Map(cursorResult.rows.map((r) => [r.state_key, r]));
  // CRITICAL: do not default to '0' — see design point 1.
  const activitySeqValue = cursorMap.get('activity_seq')?.state_value ?? null;

  const entityBacklogQuery = activitySeqValue !== null
    ? pool.query<{ pending_count: string; oldest_pending_age_seconds: string | null }>(
        `select count(*)::text as pending_count,
                extract(epoch from (now() - min(created_at)))::text as oldest_pending_age_seconds
         from club_activity
         where topic = 'entity.version.published' and seq > $1::bigint`,
        [activitySeqValue],
      )
    : Promise.resolve({ rows: [{ pending_count: null, oldest_pending_age_seconds: null }] as Array<{ pending_count: string | null; oldest_pending_age_seconds: string | null }> });

  // All the rest in parallel. Includes the existing five queries unchanged + the new worker queries.
  const [
    migrationResult, memberCount, clubCount, tableCount, dbSize,  // existing
    queueCounts, byModelRows, oldestClaimable, retryErrorRows, entityBacklog, recomputeQueueCounts, pendingMatchesRow,  // new
  ] = await Promise.all([
    // ── existing five (unchanged, copied from current impl) ──
    pool.query(/* migrations */).catch(() => ({ rows: [{ count: '0', latest: null }] })),
    pool.query(/* members */),
    pool.query(/* clubs */),
    pool.query(/* tables */),
    pool.query(/* db size */),

    // ── new ──
    pool.query<{ collected_at: string; claimable: string; scheduled_future: string; at_or_over_max: string }>(
      `select now()::text as collected_at,
              count(*) filter (where attempt_count < $1 and next_attempt_at <= now())::text as claimable,
              count(*) filter (where attempt_count < $1 and next_attempt_at > now())::text as scheduled_future,
              count(*) filter (where attempt_count >= $1)::text as at_or_over_max
       from ai_embedding_jobs`,
      [MAX_ATTEMPTS],
    ),

    pool.query<{ model: string; dimensions: number; claimable: string; scheduled_future: string; at_or_over_max: string }>(
      `select model, dimensions,
              count(*) filter (where attempt_count < $1 and next_attempt_at <= now())::text as claimable,
              count(*) filter (where attempt_count < $1 and next_attempt_at > now())::text as scheduled_future,
              count(*) filter (where attempt_count >= $1)::text as at_or_over_max
       from ai_embedding_jobs
       group by model, dimensions
       order by model, dimensions`,
      [MAX_ATTEMPTS],
    ),

    pool.query<{ age_seconds: string | null }>(
      `select extract(epoch from (now() - min(created_at)))::text as age_seconds
       from ai_embedding_jobs
       where attempt_count < $1 and next_attempt_at <= now()`,
      [MAX_ATTEMPTS],
    ),

    pool.query<{ id: string; subject_kind: string; model: string; attempt_count: number; last_error: string | null; next_attempt_at: string }>(
      `select id, subject_kind::text as subject_kind, model, attempt_count,
              substring(last_error from 1 for 500) as last_error,
              next_attempt_at::text as next_attempt_at
       from ai_embedding_jobs
       where last_error is not null
       order by attempt_count desc, next_attempt_at asc
       limit 10`,
    ),

    entityBacklogQuery,

    pool.query<{ ready_count: string; in_flight_count: string; scheduled_count: string }>(
      `select
         count(*) filter (where recompute_after <= now() and (claimed_at is null or claimed_at < now() - ${RECOMPUTE_LEASE_INTERVAL}))::text as ready_count,
         count(*) filter (where recompute_after <= now() and claimed_at >= now() - ${RECOMPUTE_LEASE_INTERVAL})::text as in_flight_count,
         count(*) filter (where recompute_after > now() and claimed_at is null)::text as scheduled_count
       from signal_recompute_queue
       where queue_name = 'introductions'`,
    ),

    pool.query<{ count: string }>(
      `select count(*)::text as count from signal_background_matches where state = 'pending'`,
    ),
  ]);

  const cursorOf = (key: string, parseValue: (s: string) => unknown) => {
    const row = cursorMap.get(key);
    if (!row) return { value: null, updatedAt: null, ageSeconds: null };
    return {
      value: parseValue(row.state_value),
      updatedAt: row.updated_at,
      ageSeconds: Math.round(Number(row.age_seconds)),
    };
  };

  return {
    // existing fields (unchanged):
    migrationCount: Number(migrationResult.rows[0]?.count ?? 0),
    latestMigration: migrationResult.rows[0]?.latest ?? null,
    memberCount: Number(memberCount.rows[0]?.count ?? 0),
    clubCount: Number(clubCount.rows[0]?.count ?? 0),
    tablesWithRls: 0,
    totalAppTables: Number(tableCount.rows[0]?.count ?? 0),
    databaseSize: dbSize.rows[0]?.size ?? '0 bytes',

    // new:
    workers: {
      embedding: {
        queue: {
          claimable: Number(queueCounts.rows[0]?.claimable ?? 0),
          scheduledFuture: Number(queueCounts.rows[0]?.scheduled_future ?? 0),
          atOrOverMaxAttempts: Number(queueCounts.rows[0]?.at_or_over_max ?? 0),
        },
        oldestClaimableAgeSeconds: oldestClaimable.rows[0]?.age_seconds
          ? Math.round(Number(oldestClaimable.rows[0].age_seconds)) : null,
        byModel: byModelRows.rows.map((r) => ({
          model: r.model,
          dimensions: r.dimensions,
          claimable: Number(r.claimable),
          scheduledFuture: Number(r.scheduled_future),
          atOrOverMaxAttempts: Number(r.at_or_over_max),
        })),
        retryErrorSample: retryErrorRows.rows.map((r) => ({
          jobId: r.id,
          subjectKind: r.subject_kind as 'member_club_profile_version' | 'entity_version',
          model: r.model,
          attemptCount: r.attempt_count,
          lastError: r.last_error ?? '',
          nextAttemptAt: r.next_attempt_at,
        })),
      },
      synchronicity: {
        cursors: {
          activitySeq: cursorOf('activity_seq', (s) => Number(s)),
          profileArtifactAt: cursorOf('profile_artifact_at', (s) => s),
          membershipScanAt: cursorOf('membership_scan_at', (s) => s),
          backstopSweepAt: cursorOf('backstop_sweep_at', (s) => s),
        },
        entityPublicationBacklog: {
          pendingCount: entityBacklog.rows[0]?.pending_count !== null && entityBacklog.rows[0]?.pending_count !== undefined
            ? Number(entityBacklog.rows[0].pending_count) : null,
          oldestPendingAgeSeconds: entityBacklog.rows[0]?.oldest_pending_age_seconds
            ? Math.round(Number(entityBacklog.rows[0].oldest_pending_age_seconds)) : null,
        },
        recomputeQueue: {
          readyCount: Number(recomputeQueueCounts.rows[0]?.ready_count ?? 0),
          inFlightCount: Number(recomputeQueueCounts.rows[0]?.in_flight_count ?? 0),
          scheduledCount: Number(recomputeQueueCounts.rows[0]?.scheduled_count ?? 0),
        },
        pendingMatchesCount: Number(pendingMatchesRow.rows[0]?.count ?? 0),
      },
    },
    collectedAt: queueCounts.rows[0].collected_at,  // queueCounts is non-group-by aggregate; rows[0] always exists
  };
}
```

### Action, capability, interface — no change

`superadmin.diagnostics.getHealth` action definition stays identical. The `adminGetDiagnostics` capability and repository-method declaration don't change — they already point to the one method we're extending.

## Required tests

### Unit test — extend `test/unit/admin.test.ts:228` (`superadmin.diagnostics.getHealth returns system diagnostics`)

The stub `adminGetDiagnostics` currently returns only the existing fields. Extend it to return the new worker fields too, and assert the response includes them. This replaces any idea of a separate worker-status unit test.

### Integration tests — `test/integration/non-llm/admin.test.ts`

Extend the existing `describe('superadmin.diagnostics.getHealth', ...)` block. All test cases below call the same `superadmin.diagnostics.getHealth` action and assert fields under `body.data.diagnostics.workers`:

1. **Empty state.** No embedding jobs, no `worker_state` rows, no recompute queue, no pending matches. Assert all counts 0, all arrays empty, all cursors `{ value: null, updatedAt: null, ageSeconds: null }`, `entityPublicationBacklog === { pendingCount: null, oldestPendingAgeSeconds: null }`. Assert `collectedAt` is a parseable ISO string. Existing DB-level fields still correct.

1a. **Null-cursor with activity present.** No `worker_state` row for `activity_seq`, but insert several `club_activity` rows with `topic='entity.version.published'`. Assert `entityPublicationBacklog.pendingCount === null` (NOT the count of inserted rows). Regression test for the "passing 0 falsely shows huge backlog" bug.

2. **Embedding queue populated.** Insert:
   - Row at `attempt_count=0, next_attempt_at=now() - interval '1 minute'` → `claimable`.
   - Row at `attempt_count=2, next_attempt_at=now() + interval '5 minutes'` → `scheduledFuture`.
   - Row at `attempt_count=5` → `atOrOverMaxAttempts`.
   - Row with `last_error='simulated provider failure'`, `attempt_count=3, next_attempt_at=now() + interval '1 minute'` → appears in `retryErrorSample`.
   Assert exact counts. `oldestClaimableAgeSeconds >= 60`. `retryErrorSample` entry with `lastError` truncated correctly when given a 1000-char input.

3. **By-model breakdown.** Insert two embedding jobs with different `(model, dimensions)`. Assert `byModel` has two rows with right counts.

4. **Retry-error ordering.** Insert two rows with `last_error` set: one at `attempt_count=2, next_attempt_at=now()+interval '10 minutes'`, one at `attempt_count=4, next_attempt_at=now()+interval '1 minute'`. Assert `retryErrorSample[0]` is the `attempt_count=4` row.

5. **Synchronicity typed cursors.** Insert into `worker_state` for `worker_id='synchronicity'` with the four real keys. Assert each appears under the right typed field; `activitySeq.value` is a number (cast happened); ages within ±5s of expected. Also insert a row with key `profile_artifact_member_id` → assert it does NOT appear in the response (opaque internals filtered out).

6. **Entity-publication backlog uses topic filter.** Read current `MAX(seq) FROM club_activity` first and set `worker_state.activity_seq` to that value. Then insert 5 rows with `topic='entity.version.published'` and 5 rows with another topic. Assert `pendingCount === 5`.

7. **Recompute queue partitioning.** Insert:
   - Ready (unclaimed, due): `recompute_after = now() - interval '1 minute', claimed_at = NULL`.
   - Ready (stale-leased, due): `recompute_after = now() - interval '10 minutes', claimed_at = now() - interval '10 minutes'`.
   - In-flight (fresh-leased, due): `recompute_after = now() - interval '1 minute', claimed_at = now() - interval '1 minute'`.
   - Scheduled (unclaimed, future): `recompute_after = now() + interval '10 minutes', claimed_at = NULL`.
   - Degenerate (fresh-leased, future): should be excluded from ALL three.
   Assert `readyCount === 2`, `inFlightCount === 1`, `scheduledCount === 1`. Also assert `readyCount + inFlightCount + scheduledCount === 4` even though 5 rows exist, documenting the "degenerate excluded" semantics.

8. **Pending matches.** Insert one `signal_background_matches` row with `state='pending'` and one with `state='delivered'`. Assert `pendingMatchesCount === 1`.

9. **`collectedAt` is fresh.** Assert `Date.parse(response.data.diagnostics.collectedAt)` is within 60 seconds of `Date.now()`.

### Existing auth-gate tests cover auth

No new auth-gate test needed — the existing `superadmin.diagnostics.getHealth` auth test (admin.test.ts:1168-1174 area, regular member → 403) already covers the whole endpoint.

## Schema snapshot

`test/snapshots/api-schema.json` must be regenerated — `superadmin.diagnostics.getHealth`'s response shape changes.

## Known residual risk

Embedding queue counts will overstate "claimable" once the dimension-filter fix from `plans/worker-reliability-wins.md` (Fix 5) lands. Old `(model, dimensions)` tuples will sit in `ai_embedding_jobs` forever — counted as claimable here but never actually claimable by the worker. `byModel` exposes the underlying stranded tuples. Out of scope here; revisit when that fix ships (preferred direction: add a separate `staleConfigCount` field).

## Out of scope (deliberately)

1. Heartbeat table.
2. `pg_locks` lock-held check.
3. Per-worker error log table.
4. Manual operations (retry dead-lettered, advance cursor, etc.).
5. API server background tasks.
6. Embedding-backfill worker status.
7. True transactional snapshot.

## Shared steps for the PR

1. **Type-check:** `npx tsc --noEmit` clean.
2. **Unit tests:** `npm run test:unit` green.
3. **Integration tests:** `npm run test:integration:non-llm` green.
4. **Schema snapshot regenerated** for the widened response.
5. **Bump patch version** in `package.json`.
6. **Commit message:** `Extend superadmin.diagnostics.getHealth with worker queue depth, cursor freshness, and recompute backlog`
7. **Do NOT push** — wait for explicit user approval per the per-push rule in CLAUDE.md.

## Notes the implementer must NOT change without checking

- **Do NOT add a new action or capability.** Firm decision — see the "Decision" section.
- **Backlog metric is filtered by `topic='entity.version.published'`.**
- **Missing `activity_seq` MUST yield `null` backlog, NOT `0`.** Test 1a is the regression net.
- **`retryErrorSample` is intentionally scoped** — not a complete error log. Do not rename to `recentErrors` or drop the scope disclaimer.
- **Cursors are typed, not raw rows.** `profile_artifact_member_id` must be filtered out.
- **Recompute queue buckets are mutually exclusive partitions.** Filters are explicit in the SQL above.
- **`collectedAt` comes from Postgres `now()` via the queue-counts aggregate.** Do not introduce an app-server-clock fallback.
