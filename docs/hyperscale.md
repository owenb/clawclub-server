# Hyperscale Architecture

These are potential avenues to explore if ClawClub takes off or reliability becomes more important than portability. We're not committing to anything here - just thinking out loud.

This document presents two target architectures — **Cloudflare-first** and **single-vendor AWS** — along with a shared migration strategy. Both preserve the existing feature surface and API contract.

---

## What stays the same regardless of direction

- The action dispatch model and API contract (`POST /api`, `GET /api/schema`)
- Single unified Postgres database
- Append-only versioned data model
- Application-layer authorization (no RLS)
- LLM legality gate via OpenAI (`gpt-5.4-nano`)
- `/updates` polling as the authoritative catch-up path
- Database as the source of truth, not the socket
- TypeScript codebase — no Rust rewrite

---

## Why consider either architecture

The current system has known single-node ceilings:

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
- `src/rate-limit.ts` — in-memory buckets become either Workers Rate Limiting or a Postgres-backed approach
- `src/member-updates-notifier.ts` — removed entirely (replaced by Durable Objects)

### Connection pooling: Hyperdrive

Hyperdrive sits between Workers and Postgres. It handles connection pooling and supports transaction-mode pooling including `SET` within a transaction.

If using Neon as the database, use Hyperdrive as the **only** pooler. Do not stack Neon's built-in pooler on top of Hyperdrive — Neon explicitly advises against this.

### Real-time: Durable Objects

Durable Objects replace the LISTEN/NOTIFY + SSE infrastructure. A DO is a single-threaded, globally unique JavaScript object that can hold WebSocket connections and hibernate when idle.

Two DO classes:

**ClubDO** — one per club. Holds WebSocket connections for online members of that club. When the API Worker writes club-wide content (content published, event created), it sends one message to the club's DO. The DO fans out to connected members. A single DO supports up to 32,768 hibernating WebSockets with a soft limit of ~1,000 req/s — more than sufficient for bounded club sizes.

**MemberDO** — one per member. Holds WebSocket connections for that member's personal inbox (DMs, synchronicity signals, admission decisions). No fan-out — targeted delivery only.

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
- Full Postgres (not "compatible" — actual Postgres engine). Migrations, custom domains (`short_id`, `new_id()`), triggers, pgvector — all work unchanged
- Serverless: scales to zero when idle, scales up under load
- Built-in connection pooling (use via Hyperdrive, not stacked)
- Branching: instant copy-on-write database clones for testing and migration previews
- Point-in-time recovery with automated backups
- Read replicas for scaling reads
- One Neon project for the database

**Aurora Serverless v2** is the more conservative option — more battle-tested HA and failover, Global Database for cross-region disaster recovery, but more operational surface (RDS console, VPC configuration, security groups).

If true "sleep at night" data durability matters more than operational simplicity, Aurora wins. If low-ops matters more, Neon is viable.

### Vectors: keep in Postgres initially

Do not externalize vectors to Qdrant or Vectorize on day one. pgvector in the database (`profile_embeddings` and `content_embeddings`) is simpler and avoids a sync problem between the relational store and an external vector index.

When to reconsider:
- When semantic search latency becomes noticeable in production
- When one search scope approaches hundreds of thousands of artifacts
- When vector index rebuilds interfere with relational query performance

If externalizing later, evaluate **Cloudflare Vectorize** (GA, up to 10M vectors per index, metadata filtering, lower vendor count) before Qdrant Cloud (stronger specialist product, higher vendor count).

### Background workers: keep DB-backed jobs initially

Do not replace `FOR UPDATE SKIP LOCKED` job queues with Cloudflare Queues blindly. The current worker model in `src/workers/` uses transaction-local state and advisory locks (`pg_advisory_xact_lock` in `src/workers/synchronicity.ts`). Cloudflare Queues does not guarantee publish order and retries batches unless messages are individually acked — you would still need idempotency and an outbox pattern.

Keep the current approach:
- `ai_embedding_jobs` table for embedding work
- `signal_recompute_queue` table for debounced introduction recomputation  
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
├── Neon or Aurora (full Postgres)
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
- RDS Proxy pins PostgreSQL sessions on `SET` and `set_config` — the codebase uses `set_config` for session-scoped configuration variables in some paths. This causes pinning, which limits connection reuse. Audit and remove `set_config` usage before migrating to Lambda
- Lambda is not "fresh every request" — AWS reuses execution environments. Similar mental model to Workers: mostly stateless, not guaranteed pristine
- The `--once` mode on workers (`src/workers/synchronicity.ts`, `src/workers/embedding.ts`) already fits Lambda-style invocation

What changes:
- `src/server.ts` — replace with a Lambda handler that calls `dispatch()`
- Remove `set_config` usage to avoid RDS Proxy pinning
- Workers run as separate Lambda functions triggered by EventBridge Scheduler

### Database: Aurora Serverless v2

Aurora cluster. Auto-scaling ACUs, multi-AZ automated failover (<35s), automated backups with 35-day point-in-time recovery.

For cross-region disaster recovery: Aurora Global Database. Writes go to one region, reads replicate with <1s lag, promote a secondary in <1 minute if the primary region fails.

RDS Proxy in front of the cluster for connection pooling.

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
├── Aurora Serverless v2 (full Postgres)
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
| Cost at low traffic | Very cheap (Workers free tier, Neon scale-to-zero) | Minimum Aurora ACU cost ~$50/mo |
| Cost at high traffic | Workers stay cheap ($0.30/M requests) | Lambda can get expensive at sustained high throughput |

---

## Migration strategy (shared across both variants)

The migration is incremental. Each step is independently deployable and reversible. The order matters — later steps depend on earlier ones.

### Phase 1: Unblock multi-instance (do first regardless of direction)

This is prerequisite work that improves the current Railway deployment and unblocks either target architecture.

1. **Postgres-backed rate limiting** — replace in-memory buckets.
2. **Remove SSE stream accounting dependency on in-memory state** — either move to Postgres-backed stream leases or accept that SSE will be replaced in Phase 2.
3. **Audit `set_config` usage** — needed for Lambda/RDS Proxy (AWS path) and clean for Workers too.

Modules affected: `src/server.ts`, `src/rate-limit.ts`

### Phase 2: Replace real-time transport

Replace LISTEN/NOTIFY + SSE with the target real-time system (Durable Objects or AppSync Events).

1. Add publish calls after database writes — fire-and-forget with outbox fallback
2. Add outbox table to the database
3. Add outbox sweep worker
4. Remove `src/member-updates-notifier.ts` entirely
5. Remove `/updates/stream` SSE endpoint from `src/server.ts`
6. Keep `/updates` polling as the authoritative catch-up path

Modules removed: `src/member-updates-notifier.ts`
Modules changed: `src/server.ts`, action handlers that trigger notifications

### Phase 3: Move API compute

Migrate the API from Railway to the target compute platform.

**Cloudflare path:**
- Wrap `dispatch()` in a Workers `fetch()` handler
- Configure Hyperdrive for the database
- Deploy via `wrangler`
- Configure Workers Placement for database proximity

**AWS path:**
- Wrap `dispatch()` in a Lambda handler
- Configure RDS Proxy for the Aurora cluster
- Deploy via CloudFormation/Terraform
- Configure API Gateway

Modules changed: `src/server.ts` (replaced with platform-specific entry point)

### Phase 4: Migrate database (if changing from Railway Postgres)

Move the database to the target managed Postgres.

**Cloudflare path:** `pg_dump` / `pg_restore` to Neon. Update Hyperdrive connection string.

**AWS path:** `pg_dump` / `pg_restore` to Aurora. Configure RDS Proxy.

No code changes — the `pg` driver connects to Postgres regardless of where it runs.

### Phase 5 (future): Externalize vectors

Only if vector search latency or index size becomes a real bottleneck.

1. Set up external vector index (Vectorize, Qdrant, or OpenSearch)
2. Modify embedding worker to write to both Postgres and the external index
3. Modify similarity queries (`src/workers/similarity.ts`) to query the external index
4. Once validated, drop pgvector artifacts from Postgres
5. Modify `members.searchBySemanticSimilarity` and `content.searchBySemanticSimilarity` to query the external index

Modules changed: `src/workers/similarity.ts`, `src/clubs/index.ts`, embedding worker

### Phase 6 (future): Event-driven workers

Only if poll-based workers become a bottleneck or you want push-based invocation.

1. Implement outbox consumers that publish to queues (Cloudflare Queues or SQS)
2. Implement queue consumer workers with idempotent processing
3. Remove polling loops from `src/workers/synchronicity.ts`, `src/workers/embedding.ts`
4. Remove `ai_embedding_jobs` table (queue replaces it)
5. Remove `signal_recompute_queue` table (queue replaces it)

Modules changed: `src/workers/*.ts`, new queue consumer entry points

---

## The DSQL question

DSQL is Amazon's serverless distributed SQL database with multi-region active-active writes and strong consistency. It uses the Postgres wire protocol but deliberately excludes most Postgres-specific schema features.

### What DSQL would eliminate

Standard Postgres does not scale horizontally on its own. As the dataset grows, you eventually face manual sharding decisions, capacity planning, connection pooling tuning, and failover choreography.

DSQL removes this entire problem category:
- **No sharding.** Automatic horizontal scaling — no manual shard routing or partitioning decisions
- **No capacity planning.** Serverless scaling with no ACU configuration, no right-sizing clusters
- **No failover configuration.** Multi-region active-active by default — not a read replica promoted in an emergency, but actual multi-region writes with strong consistency
- **No connection pooling.** No RDS Proxy, no Hyperdrive, no PgBouncer — DSQL manages connections natively

### What DSQL would require

The schema is built on Postgres-the-database-engine, not just Postgres-the-wire-protocol. A DSQL migration requires moving substantial logic from the database into the application layer:

| DSQL limitation | ClawClub usage | Scope |
|---|---|---|
| No custom domains | `short_id` is the ID type for every table | pervasive |
| No enum types | `content_kind`, `membership_state`, `content_state`, `edge_kind`, `rsvp_state`, etc. | 41 types |
| No stored functions | `new_id()`, trigger functions, etc. | 90+ functions |
| No triggers | Data consistency guards, search vector updates | 23 triggers |
| No views | `current_content_versions`, `current_club_memberships`, `accessible_club_memberships`, etc. | 40+ views |
| No foreign keys | Referential integrity across every relationship | 100+ FKs |
| No sequences / IDENTITY | `club_activity.seq`, `signal_deliveries.seq` | 4 sequences |
| No custom schemas | Everything lives in `public` | every table |
| No full-text search | `tsvector`/`tsquery` + GIN indexes for `members.searchByFullText` | active feature |
| No `set_config` | Trigger coordination in `src/identity/clubs.ts` | 15+ uses |
| No LISTEN/NOTIFY | Real-time wakeup in `src/member-updates-notifier.ts` | planned for removal anyway |
| No pgvector | Embedding similarity in `src/workers/similarity.ts` | planned for externalization anyway |

Concretely, the migration work is:
- Replace `short_id` domain with `text` + application-layer validation
- Replace 41 enum types with `text` columns (CHECK constraints are supported)
- Move 90+ stored functions into TypeScript (most are already thin wrappers around queries)
- Move 23 triggers into pre/post-write logic in action handlers
- Inline 40+ views as CTEs or subqueries (or use application-layer query builders)
- Drop 100+ foreign keys — rely on application-layer referential integrity
- Replace `GENERATED ALWAYS AS IDENTITY` with application-generated IDs (e.g. Snowflake-style or the existing `new_id()` logic moved to TypeScript)
- Move full-text search to an external service or application-layer implementation
- Remove `set_config` coordination (already planned for other reasons)

This is a large rewrite, but it is a **one-time cost**. Once done, the schema is simpler (plain SQL, no Postgres-specific features), and the application layer is more portable.

### Open-source alternatives: CockroachDB and YugabyteDB

DSQL is not the only distributed SQL option. Two open-source databases offer the same core value proposition — horizontal scaling without manual sharding, multi-region active-active writes — without permanent vendor lock-in.

**CockroachDB**

BSL license (converts to Apache 2.0 after 3 years) — source-available and self-hostable on any cloud or bare metal. Also available as a managed serverless tier (CockroachDB Cloud).

CockroachDB supports significantly more Postgres features than DSQL:

| Feature | DSQL | CockroachDB |
|---|---|---|
| Enum types | No | Yes |
| Views | No | Yes |
| Foreign keys | No | Yes |
| Sequences | No | Yes (distributed, with performance caveats) |
| User-defined functions | No | Yes |
| Triggers | No | Yes |
| Stored procedures | No | Yes |
| Custom schemas | No | Yes |
| LISTEN/NOTIFY | No | No |
| Advisory locks | No | No |
| pgvector | No | No |
| Custom domains (`CREATE DOMAIN`) | No | Unverified — needs testing |
| Full-text search (tsvector) | No | Limited |

The migration from the current schema would be materially smaller than a DSQL migration. Enums, views, foreign keys, functions, triggers, and custom schemas all survive. The remaining gaps (LISTEN/NOTIFY, advisory locks, pgvector) are already planned for removal or externalization.

**YugabyteDB**

Apache 2.0 license — genuinely open source. Self-hostable or available as a managed service (YugabyteDB Managed).

Claims the highest Postgres compatibility among distributed SQL databases. Supports foreign keys, views, triggers, stored procedures, functions, enums, sequences, custom schemas, and has some extension support including pgvector compatibility.

Does not support LISTEN/NOTIFY or advisory locks — same gaps as CockroachDB, already planned for removal.

The migration might be even smaller than CockroachDB — potentially close to a drop-in for much of the schema, though "supports triggers" doesn't always mean "supports the exact trigger patterns you use." The current compatibility claims should be verified against the actual migration SQL before committing.

**Why these matter**

Both are self-hostable. If the company behind either one disappears, you still have the software. If pricing changes, you move to a different host or run it yourself. This eliminates DSQL's primary downside (permanent vendor lock-in) while preserving its primary benefit (no sharding, no replication, horizontal scaling).

The trade-off vs DSQL: you take on operational responsibility for the distributed database cluster (or pay for a managed tier), whereas DSQL is fully serverless with zero cluster management. The trade-off vs Aurora: you still do a migration (smaller than DSQL, but not zero), but you eliminate sharding complexity permanently.

### The trade-off, honestly stated

| | Aurora (+ sharding) | DSQL | CockroachDB / YugabyteDB |
|---|---|---|---|
| Schema migration | None | Large rewrite | Moderate (mostly LISTEN/NOTIFY, advisory locks, FTS) |
| Ongoing complexity | Single database, manual sharding if needed | One database, no sharding | One database, no sharding |
| Scaling ceiling | Manual sharding decisions | Infinite, serverless | Infinite, but you manage the cluster (or pay for managed) |
| Multi-region | Read replicas only, writes pinned to one region | Active-active writes | Active-active writes |
| Vendor lock-in | None — standard Postgres | Permanent (AWS-only) | None — open source, self-hostable |
| Postgres compatibility | Full | Minimal | High (CockroachDB) / Higher (YugabyteDB) |
| Failure modes you manage | Capacity planning, shard routing (if sharded), failover coordination | Almost none (AWS manages everything) | Cluster health, node failures (or managed tier handles it) |

**The distributed SQL path is not dismissed.** If ClawClub grows to the point where manual sharding becomes necessary on standard Postgres, the one-time cost of migrating to a distributed SQL database may be worth paying to eliminate that complexity permanently.

The decision comes down to: **is the migration cost worth eliminating sharding forever?** And if so: **is vendor lock-in (DSQL) acceptable, or is operational responsibility for a distributed cluster (CockroachDB/YugabyteDB) the better trade?** These are business questions, not technical ones.

## What we would NOT do

- **Rewrite in Rust.** The bottleneck is I/O (database, LLM API), not CPU. The TypeScript codebase is thin and stateless.
- **Add Kafka or Redis as primary infrastructure.** The append-only `club_activity` + targeted inbox design is already the right pattern. Redis only if needed as a Centrifugo broker or ephemeral cache — never as a durable store.
- **Use SQS for real-time push.** SQS is a pull-based queue, not a socket fan-out system. It works for worker jobs, not for pushing to end-user WebSocket connections.
- **Over-shard early.** One Postgres cluster handles millions of rows. Shard when evidence demands it.
- **Force the full migration at once.** Each phase is independently valuable. Stop at any point and have a better architecture than launch.

---

## Recommendation

If the priority is **simplest compute and real-time with acceptable database risk**: Cloudflare Workers + Durable Objects + Hyperdrive + Neon. Do the real-time migration (Phase 2) first, then move compute (Phase 3). Keep DB-backed workers and pgvector until real pressure appears.

If the priority is **strongest data plane with proven HA**: AWS Lambda + AppSync Events + Aurora Serverless v2 + RDS Proxy. More operational surface, but each component is individually battle-tested.

Either way: DOs/AppSync first, compute second, outbox-based delivery throughout, and delay vector externalization and queue migration until the bottleneck is real.
