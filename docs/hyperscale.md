# Hyperscale Architecture

These are potential avenues to explore if ClawClub takes off or reliability becomes more important than portability. Nothing here is committed. The current Railway single-node deployment with three local Postgres databases is the right shape for launch.

This document presents two target architectures — **Cloudflare-first** and **single-vendor AWS** — along with a shared migration strategy. Both preserve the existing feature surface, API contract, and three-database split (identity, messaging, clubs).

---

## What stays the same regardless of direction

- The action dispatch model and API contract (`POST /api`, `GET /api/schema`)
- Three logical databases: identity, messaging, clubs
- Append-only versioned data model
- Application-layer authorization (no RLS)
- LLM legality gate via OpenAI (`gpt-5.4-nano`)
- `/updates` polling as the authoritative catch-up path
- Database as the source of truth, not the socket
- TypeScript codebase — no Rust rewrite

---

## Why consider either architecture

The current system has known single-node ceilings documented in `docs/scaling-todo.md`:

- **In-memory rate limiting** (`src/server.ts`) — does not survive restarts, does not work across instances
- **In-memory SSE stream tracking** (`activeStreams` map in `src/server.ts`) — per-process only
- **Postgres LISTEN/NOTIFY** for real-time wakeup (`src/member-updates-notifier.ts`) — requires a persistent connection per process, does not coordinate across instances
- **Single Railway container** — no redundancy, no auto-failover

These are acceptable for launch. They become blockers when:
1. You need more than one app instance (redundancy or throughput)
2. You need automatic recovery from instance/region failure
3. Real-time push latency matters to end users or agents

---

## Variant A: Cloudflare-first

This is **Cloudflare-first compute and real-time with external data services**, not "all-in Cloudflare." Cloudflare does not have a first-party Postgres equivalent for this workload (D1 is SQLite-based). The database remains an external managed service.

### Compute: Cloudflare Workers

Workers are V8 isolates with near-zero cold start (~5ms, not 200-500ms like Lambda). The current API is pure request-response dispatch — a natural fit.

Key facts:
- Workers support `nodejs_compat` with `node:http`, `node:net`, `node:fs`, and the `pg` driver
- Isolates may handle multiple requests and may be reused or evicted — the right mental model is "fast, mostly stateless serverless," not "guaranteed fresh process per request"
- The migration is: replace `node:http.createServer` with a `fetch()` export, update connection handling to use Hyperdrive
- Workers run on 300+ edge locations globally — no load balancer configuration needed
- Workers Placement (Smart Placement) can pin compute near the database to reduce latency

What changes in the codebase:
- `src/server.ts` — replace HTTP server with Workers `fetch()` handler
- `src/rate-limit.ts` — in-memory buckets become either Workers Rate Limiting or a Postgres-backed approach (see `docs/scaling-todo.md` item 7)
- `src/member-updates-notifier.ts` — removed entirely (replaced by Durable Objects)

### Connection pooling: Hyperdrive

Hyperdrive sits between Workers and Postgres. It handles connection pooling and supports transaction-mode pooling including `SET` within a transaction.

If using Neon as the database, use Hyperdrive as the **only** pooler. Do not stack Neon's built-in pooler on top of Hyperdrive — Neon explicitly advises against this.

### Real-time: Durable Objects

Durable Objects replace the LISTEN/NOTIFY + SSE infrastructure. A DO is a single-threaded, globally unique JavaScript object that can hold WebSocket connections and hibernate when idle.

Two DO classes:

**ClubDO** — one per club. Holds WebSocket connections for online members of that club. When the API Worker writes club-wide content (entity published, event created), it sends one message to the club's DO. The DO fans out to connected members. A single DO supports up to 32,768 hibernating WebSockets with a soft limit of ~1,000 req/s — more than sufficient for bounded club sizes.

**MemberDO** — one per member. Holds WebSocket connections for that member's personal inbox (DMs, serendipity signals, admission decisions). No fan-out — targeted delivery only.

```
API Worker writes to DB
  ├── club-wide event → ClubDO.publish(clubId, payload)
  └── targeted inbox  → MemberDO.publish(memberId, payload)
```

The DOs hibernate when no WebSockets are connected (costs nothing). On reconnect, clients catch up from their cursor via `/updates` polling — the database remains the source of truth.

What changes in the codebase:
- `src/member-updates-notifier.ts` — removed entirely
- `src/server.ts` — remove `/updates/stream` SSE endpoint, remove LISTEN connections
- Add ~150 lines per DO class (WebSocket accept, message fan-out, hibernation)
- Add publish calls in action handlers after database commits (fire-and-forget with outbox fallback)

### Database: Neon (serverless Postgres) or Aurora

**Neon** is the lower-ops option:
- Full Postgres (not "compatible" — actual Postgres engine). Migrations, custom domains (`app.short_id`, `app.new_id()`), triggers, pgvector — all work unchanged
- Serverless: scales to zero when idle, scales up under load
- Built-in connection pooling (use via Hyperdrive, not stacked)
- Branching: instant copy-on-write database clones for testing and migration previews
- Point-in-time recovery with automated backups
- Read replicas for scaling reads
- Three Neon projects map to the three databases

**Aurora Serverless v2** is the more conservative option — more battle-tested HA and failover, Global Database for cross-region disaster recovery, but more operational surface (RDS console, VPC configuration, security groups).

If true "sleep at night" data durability matters more than operational simplicity, Aurora wins. If low-ops matters more, Neon is viable.

### Vectors: keep in Postgres initially

Do not externalize vectors to Qdrant or Vectorize on day one. pgvector in the clubs database (`embeddings_entity_artifacts`) and identity database (`embeddings_member_profile_artifacts`) is simpler and avoids a sync problem between the relational store and an external vector index.

When to reconsider:
- When semantic search latency becomes noticeable in production
- When one search scope approaches hundreds of thousands of artifacts
- When vector index rebuilds interfere with relational query performance

If externalizing later, evaluate **Cloudflare Vectorize** (GA, up to 10M vectors per index, metadata filtering, lower vendor count) before Qdrant Cloud (stronger specialist product, higher vendor count).

### Background workers: keep DB-backed jobs initially

Do not replace `FOR UPDATE SKIP LOCKED` job queues with Cloudflare Queues blindly. The current worker model in `src/workers/` uses transaction-local state and advisory locks (`pg_advisory_xact_lock` in `src/workers/serendipity.ts`). Cloudflare Queues does not guarantee publish order and retries batches unless messages are individually acked — you would still need idempotency and an outbox pattern.

Keep the current approach:
- `embeddings_jobs` table for embedding work
- `recompute_queue` table for debounced introduction recomputation  
- `worker_state` table for cursor persistence
- Workers run as separate processes (Cron Triggers or always-on Fargate/Fly tasks)

Evaluate Queues later when:
- The polling overhead of `FOR UPDATE SKIP LOCKED` becomes measurable
- You want event-driven (push) instead of poll-based worker invocation
- You are willing to implement an outbox pattern for publish reliability

### Outbox pattern for DO delivery

When a Worker writes to the database and then publishes to a DO, the publish can fail while the write succeeds. To prevent lost notifications:

1. Write an outbox row in the same database transaction as the content write
2. After commit, attempt DO publish and mark the outbox row as delivered
3. A background sweep retries undelivered outbox rows

This is the same outbox pattern already implicit in the `club_activity` design — the activity row is the durable record, the notification is best-effort.

### Full Cloudflare-first stack

```
Cloudflare
├── Workers (API dispatch, polling endpoint, schema)
├── Durable Objects (ClubDO for activity, MemberDO for inbox)
├── Cron Triggers (worker scheduling)
└── Hyperdrive (connection pooling)

External
├── Neon or Aurora (identity, messaging, clubs — full Postgres)
├── OpenAI (legality gate, embeddings)
└── [Later] Vectorize or Qdrant (if vectors externalized)
```

---

## Variant B: Single-vendor AWS

If true single-vendor matters most, AWS is the cleaner answer. Every component is an AWS service with unified IAM, billing, and monitoring.

### Compute: Lambda + API Gateway

Lambda runs your dispatch function per-request. Cold starts are 200-500ms for Node.js (acceptable for an agent API, noticeable for human-facing UX).

Key considerations:
- RDS Proxy is required between Lambda and Aurora for connection pooling
- RDS Proxy pins PostgreSQL sessions on `SET` and `set_config` — the codebase uses `set_config` for `app.current_member_id` in some paths. This causes pinning, which limits connection reuse. Audit and remove `set_config` usage before migrating to Lambda
- Lambda is not "fresh every request" — AWS reuses execution environments. Similar mental model to Workers: mostly stateless, not guaranteed pristine
- The `--once` mode on workers (`src/workers/serendipity.ts`, `src/workers/embedding.ts`) already fits Lambda-style invocation

What changes:
- `src/server.ts` — replace with a Lambda handler that calls `dispatch()`
- Remove `set_config` usage to avoid RDS Proxy pinning
- Workers run as separate Lambda functions triggered by EventBridge Scheduler

### Database: Aurora Serverless v2

Three Aurora clusters (identity, messaging, clubs). Auto-scaling ACUs, multi-AZ automated failover (<35s), automated backups with 35-day point-in-time recovery.

For cross-region disaster recovery: Aurora Global Database. Writes go to one region, reads replicate with <1s lag, promote a secondary in <1 minute if the primary region fails.

RDS Proxy in front of each cluster for connection pooling.

### Real-time: AppSync Events

AppSync Events is AWS-managed WebSocket pub/sub. You publish via HTTP API, clients subscribe to channels via WebSocket. AWS manages connections, fan-out, and scaling.

Channel model:
- `club/{clubId}/activity` — club-wide events
- `member/{memberId}/inbox` — targeted DMs, signals

Compared to Durable Objects:
- Fully managed (no custom fan-out code)
- Less flexible (no custom logic on the connection node)
- Newer service (launched late 2024) — less battle-tested
- 24-hour WebSocket connection limit

### Background workers: SQS + Lambda or keep DB-backed

**Option 1: Keep DB-backed jobs.** Workers run as Lambda functions on EventBridge Scheduler (equivalent to cron). The `--once` mode already supports this.

**Option 2: SQS + Lambda.** API writes a message to SQS after database commit. Lambda triggers on the message, processes the job. No polling, no lease management. Requires an outbox pattern for reliable publish (same as the DO case — database commit + queue publish is a two-phase problem).

### Full AWS stack

```
AWS
├── Lambda + API Gateway (API dispatch)
├── AppSync Events (real-time WebSocket pub/sub)
├── Aurora Serverless v2 (identity, messaging, clubs)
├── RDS Proxy (connection pooling)
├── SQS or EventBridge (worker triggers)
└── CloudWatch (monitoring, alarms)

External
├── OpenAI (legality gate, embeddings)
└── [Later] Qdrant or OpenSearch Serverless (if vectors externalized)
```

---

## Comparison

| Concern | Cloudflare-first | AWS |
|---------|-----------------|-----|
| Cold start | ~5ms (V8 isolate) | 200-500ms (Lambda container) |
| Vendor purity | External DB required (Neon or Aurora) | True single-vendor possible |
| Real-time model | Durable Objects (~300 lines of custom code) | AppSync Events (managed, less flexible) |
| Connection pooling | Hyperdrive (managed, simple) | RDS Proxy (watch for session pinning) |
| Global distribution | Built-in (300+ edge locations) | Multi-region is a project |
| Operational surface | Fewer moving parts, less proven at enterprise scale | More moving parts, each individually battle-tested |
| Database HA story | Neon (good, younger) or Aurora (proven) | Aurora (proven, Global Database) |
| Deployment | `wrangler deploy` | CloudFormation/Terraform + ECR + IAM |
| Cost at low traffic | Very cheap (Workers free tier, Neon scale-to-zero) | Minimum Aurora ACU cost ~$50/mo per cluster |
| Cost at high traffic | Workers stay cheap ($0.30/M requests) | Lambda can get expensive at sustained high throughput |

---

## Migration strategy (shared across both variants)

The migration is incremental. Each step is independently deployable and reversible. The order matters — later steps depend on earlier ones.

### Phase 1: Unblock multi-instance (do first regardless of direction)

This is prerequisite work that improves the current Railway deployment and unblocks either target architecture.

1. **Postgres-backed rate limiting** — replace in-memory buckets. Design already exists in `docs/scaling-todo.md` item 7.
2. **Remove SSE stream accounting dependency on in-memory state** — either move to Postgres-backed stream leases or accept that SSE will be replaced in Phase 2.
3. **Audit `set_config` usage** — needed for Lambda/RDS Proxy (AWS path) and clean for Workers too.

Modules affected: `src/server.ts`, `src/rate-limit.ts`

### Phase 2: Replace real-time transport

Replace LISTEN/NOTIFY + SSE with the target real-time system (Durable Objects or AppSync Events).

1. Add publish calls after database writes — fire-and-forget with outbox fallback
2. Add outbox table to clubs and messaging databases
3. Add outbox sweep worker
4. Remove `src/member-updates-notifier.ts` entirely
5. Remove `/updates/stream` SSE endpoint from `src/server.ts`
6. Keep `/updates` polling as the authoritative catch-up path

Modules removed: `src/member-updates-notifier.ts`
Modules changed: `src/server.ts`, `src/postgres/updates.ts`, action handlers that trigger notifications

### Phase 3: Move API compute

Migrate the API from Railway to the target compute platform.

**Cloudflare path:**
- Wrap `dispatch()` in a Workers `fetch()` handler
- Configure Hyperdrive for each database
- Deploy via `wrangler`
- Configure Workers Placement for database proximity

**AWS path:**
- Wrap `dispatch()` in a Lambda handler
- Configure RDS Proxy for each Aurora cluster
- Deploy via CloudFormation/Terraform
- Configure API Gateway

Modules changed: `src/server.ts` (replaced with platform-specific entry point)

### Phase 4: Migrate database (if changing from Railway Postgres)

Move the three databases to the target managed Postgres.

**Cloudflare path:** `pg_dump` / `pg_restore` to Neon. Update Hyperdrive connection strings. Three Neon projects.

**AWS path:** `pg_dump` / `pg_restore` to Aurora. Configure RDS Proxy. Three Aurora clusters.

No code changes — the `pg` driver connects to Postgres regardless of where it runs.

### Phase 5 (future): Externalize vectors

Only if vector search latency or index size becomes a real bottleneck.

1. Set up external vector index (Vectorize, Qdrant, or OpenSearch)
2. Modify embedding worker to write to both Postgres and the external index
3. Modify similarity queries (`src/workers/similarity.ts`) to query the external index
4. Once validated, drop pgvector artifacts from Postgres
5. Modify `members.findViaEmbedding` and `entities.findViaEmbedding` to query the external index

Modules changed: `src/workers/similarity.ts`, `src/postgres/embeddings.ts`, embedding worker

### Phase 6 (future): Event-driven workers

Only if poll-based workers become a bottleneck or you want push-based invocation.

1. Implement outbox consumers that publish to queues (Cloudflare Queues or SQS)
2. Implement queue consumer workers with idempotent processing
3. Remove polling loops from `src/workers/serendipity.ts`, `src/workers/embedding.ts`
4. Remove `embeddings_jobs` table (queue replaces it)
5. Remove `recompute_queue` table (queue replaces it)

Modules changed: `src/workers/*.ts`, new queue consumer entry points

---

## What we would NOT do

- **Rewrite in Rust.** The bottleneck is I/O (database, LLM API), not CPU. The TypeScript codebase is thin and stateless.
- **Use Aurora DSQL.** No pgvector, no custom types/domains, no triggers, no foreign keys, 3,000-row DML transaction limits. Aurora PostgreSQL is the right database.
- **Add Kafka or Redis as primary infrastructure.** The append-only `club_activity` + targeted inbox design is already the right pattern. Redis only if needed as a Centrifugo broker or ephemeral cache — never as a durable store.
- **Use SQS for real-time push.** SQS is a pull-based queue, not a socket fan-out system. It works for worker jobs, not for pushing to end-user WebSocket connections.
- **Over-shard early.** One Postgres cluster per database handles millions of rows. Shard when evidence demands it.
- **Force the full migration at once.** Each phase is independently valuable. Stop at any point and have a better architecture than launch.

---

## Recommendation

If the priority is **simplest compute and real-time with acceptable database risk**: Cloudflare Workers + Durable Objects + Hyperdrive + Neon. Do the real-time migration (Phase 2) first, then move compute (Phase 3). Keep DB-backed workers and pgvector until real pressure appears.

If the priority is **strongest data plane with proven HA**: AWS Lambda + AppSync Events + Aurora Serverless v2 + RDS Proxy. More operational surface, but each component is individually battle-tested.

Either way: DOs/AppSync first, compute second, outbox-based delivery throughout, and delay vector externalization and queue migration until the bottleneck is real.
