# Horizontal Scaling Plan

Target scenario: 1,000 new clubs/day, up to 500K members per club.

## Goals and constraints

- ClawClub is still greenfield. We should optimize for reversibility, not maximum scale today.
- Postgres and RLS are non-negotiable.
- We should not add major new infrastructure until product demand justifies it.
- We should make the small number of early decisions that prevent a rewrite later.

## Product and API posture

This is the key product decision that drives the scaling plan:

- **Writes and canonical truth are club-scoped.**
- **Member-facing home/read UX is cross-club by default.**
- We should **not** force `clubId` on core member-facing read surfaces purely for sharding convenience.
- Cross-club UX should be served through **deliberate projections and indexes**, not by assuming one global database forever.
- The merged updates surface should distinguish **`source: "activity"`** vs **`source: "inbox"`**. Only inbox items are explicitly ackable; `updates.acknowledge` should be forgiving and ignore activity IDs.

In practice:

- “Create an event in Club X” is club-scoped.
- “Are any events going on tonight?” is member-scoped and cross-club.
- “What happened while I was away?” is member-scoped and cross-club.
- “Open this specific event/post/thread” routes back to the owning club shard for canonical detail.

## Current architecture strengths

- **Stateless HTTP layer** — no durable app-server session state.
- **Club-scoped canonical data model** — core writes still belong to one club.
- **RLS enforced in the database** — same security model works on one Postgres or many shards.
- **Append-only facts and versions** — good fit for replication, projections, and auditability.
- **Async embedding pipeline** — already lease-based and horizontally scalable.
- **Direct SQL** — no ORM assumptions blocking routing or query reshaping later.

## Critical scaling decision already made: split activity from inbox

The original hard wall was per-recipient fanout in `member_updates`: one club-wide event created one row per member plus one `NOTIFY` per row.

That is now fixed.

- **`club_activity`** is the append-only log for club-wide events such as `entity.version.published`, `entity.version.archived`, and `entity.redacted`.
- **`member_updates`** is now the targeted inbox for DMs and similar recipient-specific items.
- **`club_activity_cursors`** track per-member club activity position.
- `/updates` and `/updates/stream` merge both sources behind an opaque compound cursor.

Result:

- A club-wide post in a 500K-member club is now **1 INSERT + 1 NOTIFY**, not 500K of each.
- The future cross-club experience can be built on top of `club_activity` without reintroducing recipient fanout.

## Tier 1: Multi-instance readiness (hours)

Once these are done, the app layer scales horizontally behind a load balancer with no sticky sessions.

| Item | Status |
|------|--------|
| JSON response compaction (remove pretty-print) | **Done** |
| `statement_timeout` on connection pool (30s default) | **Done** |
| Keyset pagination for admin queries | **Done** |
| LATERAL -> CTE optimization in membership reviews | **Done** |
| `member_updates(created_at)` index for retention | **Done** |
| Postgres-backed rate limiting (replace in-memory buckets) | TODO |
| Shared SSE stream counter (replace in-memory Map) | TODO |

## Tier 2: Single-database scaling (days)

Stay on one Postgres cluster as long as possible.

- **PgBouncer** in transaction mode for the normal request path.
- **Direct or session-pooled connection for `LISTEN`** because the notifier cannot use transaction-mode pooling.
- **Read replicas** for read-only actions.
- **Partitioning + retention** for inbox/receipt tables as they grow.
- **Pool tuning** per environment (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`).

Still **do not** add Redis, Citus, Kafka, or service sprawl at this stage.

## Tier 3: Formalize the logical split now, but keep one database

Do this in code before doing it in infrastructure.

### Query/control plane

This is more than an auth server. It is the central member-facing query plane.

It should own:

- bearer tokens
- member identity and profiles
- global roles
- `club_routing`
- `member_club_access`
- first-class cross-club projections

### Club data plane

This owns canonical club truth:

- clubs
- memberships
- entities
- events
- messages
- `club_activity`
- targeted inbox updates
- admissions
- edges
- quotas/subscriptions

Today both planes can still point at the same physical Postgres. The win is that the code learns the boundary now, so a later split is operational, not architectural.

## Tier 4: Decide which cross-club experiences are first-class

A **first-class projection** is a deliberate derived read model for a member-centric cross-club experience.

We should make only a small number of these first-class at first.

### First-class now or soon

- **Unified inbox / notifications**
  - member-specific
  - read-optimized
  - sourced from targeted inbox updates plus selected derived facts

- **Cross-club events index**
  - supports questions like “Are any events going on tonight?”
  - stores event facts keyed by `club_id`, `starts_at`, and event identity
  - filtered by `member_club_access` at read time

- **Cross-club activity index**
  - supports questions like “What happened while I was away?”
  - derived from `club_activity`
  - not per-member fanout
  - filtered by `member_club_access` at read time

- **Optional daily brief**
  - summarization product surface on top of the same projections

### Do not make first-class yet

- global people search across all clubs
- global content search across all clubs
- broad recommendation/ranking systems

Those may become valuable later, but they should not define the architecture now.

## Tier 5: Physical split when growth justifies it

### Query/control plane (central)

Single Postgres cluster plus read replicas.

It should hold:

- auth/tokens/profiles/global roles
- `club_routing`
- `member_club_access`
- central cross-club projections

Example:

```sql
CREATE TABLE app.member_club_access (
  member_id   app.short_id NOT NULL,
  club_id     app.short_id NOT NULL,
  shard_id    smallint NOT NULL,
  role        text NOT NULL,
  status      text NOT NULL,
  PRIMARY KEY (member_id, club_id)
);
```

### Club data plane (sharded by `club_id`)

Each shard runs the same Postgres schema and the same RLS model.

- Pack many small clubs onto shared shards.
- Promote hot clubs to dedicated shards.
- Rebalance by moving a whole club between shards.

### Request flow after split

1. Request hits any stateless API server.
2. API server authenticates against the query/control plane.
3. Query/control plane returns member identity, roles, and accessible-club routing facts.
4. If the action is club-scoped, route to the owning club shard and execute there under RLS.
5. If the action is a member-scoped cross-club read, answer from the central query plane projection/index.

This is the core idea:

- **writes route to a shard**
- **member-first reads often hit the central query plane**

## Tier 6: Projection pipeline

Cross-club UX should not depend on scatter-gather for hot paths.

The likely shape:

1. Canonical write commits on a club shard.
2. Same transaction writes a shard-local outbox row.
3. Projector workers consume outbox rows.
4. Projectors update central query-plane tables.

This gives us:

- club shards remain the source of truth
- member-first reads are fast
- eventual consistency is acceptable for most home/read surfaces

Important constraint:

- **Do not reintroduce per-member fanout for club activity.**
- A club-wide event should be written once on the shard, then projected centrally as a club-scoped fact.
- The central read path filters by `member_club_access` at query time.

## Technology choices later, not now

### Redis

Reasonable later for **ephemeral shared state only**:

- distributed rate limits
- shared SSE/WebSocket counters
- short-lived caches
- idempotency keys
- lightweight locks

Do **not** make Redis a second durable source of truth for feeds or projections.

### Citus

Not the plan of record.

The current schema still fits plain Postgres shards better than transparent distributed Postgres. Consider Citus only later if the key/constraint model is intentionally reshaped for it.

### Kafka / microservices

Not needed for the current plan.

## Priority order if growth hits fast

1. Keep the current feed split (`club_activity` + targeted inbox).
2. Finish multi-instance correctness work (shared rate limits, shared stream caps).
3. Add PgBouncer and read replicas.
4. Formalize query/control plane vs club data plane boundaries in code.
5. Build only the narrow set of first-class cross-club projections: inbox, notifications, events, recent activity.
6. Split the central query/control plane physically when one database is no longer comfortable.
7. Shard club data by `club_id` with app-level routing.
8. Add Redis later only for ephemeral shared state if multi-node pressure warrants it.

## Bottom line

The long-term path is now:

- **club-scoped canonical writes**
- **member-scoped cross-club reads**
- **central query/control plane for first-class cross-club UX**
- **club shards for truth**
- **Postgres + RLS all the way through**

This is the right direction to commit to now, even if we do none of the infrastructure work yet.
