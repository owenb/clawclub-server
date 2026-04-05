# Identity / Club Database Split

Physical separation of the single ClawClub Postgres database into two: an **Identity Database** (the platform control plane) and a **Club Database** (the first content shard). Logical replication from identity to club gives each shard read access to platform data. RLS removed from both databases. Club routing table from day one.

This is a committed architectural decision.

---

## For the Reviewing Agent

Read these files before reviewing:

- `docs/horizontal-scaling-plan.md` — the 6-tier scaling vision. This split implements Tiers 3-5.
- `src/postgres.ts` — repository composition, auth flow (`readActorByMemberId`), `applyActorContext`.
- `src/contract.ts` — the `Repository` interface (does not change).
- `src/dispatch.ts` — authorization helpers (`requireAccessibleClub`, `requireMembershipOwner`, `requireSuperadmin`). These already enforce access control before queries run.
- `db/migrations/0001_init.sql` — the core schema, RLS policies (being removed), security definer functions (being removed), views, triggers.
- `src/postgres/membership.ts` — admissions, memberships, vouches.
- `src/postgres/platform.ts` — club CRUD, owner assignment (joins members + private contacts for owner display).
- `src/postgres/profile.ts` — profile reads/writes.
- `src/postgres/messages.ts` — DM threads/messages (joins members for counterpart display, filters `m.state = 'active'`).

Focus your review on: table assignments, replication scope, saga correctness, and whether removing RLS leaves any authorization gap.

---

## Architecture

The identity DB is the **platform control plane**. It is the source of truth for who exists, which clubs exist, and who belongs to which club. It never shards.

The club DB is the **first content shard**. It stores all club-scoped activity: content, messages, events, admissions, activity streams. When a shard fills up, clone the schema and route new clubs to the new shard.

**Logical replication** (Postgres native, identity → club) gives each shard a read-only copy of platform data. Club queries JOIN replicated tables directly — virtually unchanged from today. Writes go to the canonical source.

**No RLS** on either database. Application-layer authorization (`dispatch.ts`) is the single source of truth. This makes the club data layer storage-agnostic (could move to ScyllaDB/CockroachDB later if write throughput demands it).

---

## Why Split Now

1. **Two connection pools make cross-plane coupling a compile-time error.** You cannot accidentally write a cross-plane JOIN.
2. **The club DB becomes the shard template.** Every future shard has the same schema, same replication subscription.
3. **The cost is near-zero.** Both databases on the same Postgres instance. Same host, same backup.
4. **The cost of not splitting grows daily.** Every new query, table, or feature is another potential coupling.

## Why Remove RLS

1. **Authorization is already in dispatch.ts.** `requireAccessibleClub`, `requireMembershipOwner`, `requireSuperadmin` run before any query.
2. **RLS ties the club plane to Postgres.** Without it, club shards are storage-agnostic.
3. **RLS complicates every shard.** Session variables, security definer functions, policy chains — multiplied by shard count.
4. **RLS was the main obstacle to splitting.** Without it, the split is straightforward.
5. **All or nothing.** Having RLS on one database and not the other creates two mental models. We either use it everywhere or nowhere.

## The Trade-Off: Authorization Gaps Must Be Filled

`dispatch.ts` has club/owner/superadmin gates but three access checks are currently only in RLS:

1. **Member visibility** — `actor_can_access_member()`: self, superadmin, shared club, owner visibility into pending members, admissions-related access. Five paths.
2. **Thread privacy** — `actor_can_access_thread()`: actor must be thread participant.
3. **Private contact access** — `member_private_contacts` RLS: self or superadmin only.

These must be built as explicit application-level functions **before** RLS removal. This is a prerequisite, not a follow-up.

---

## Table Assignments

### Identity Database (Control Plane)

The platform's source of truth. Knows who exists, which clubs exist, and who belongs where.

| Table | Purpose |
|-------|---------|
| `members` | Core identity: id, handle, public_name, state |
| `member_bearer_tokens` | API authentication tokens |
| `member_global_role_versions` | Superadmin role tracking |
| `member_private_contacts` | Private emails (**not replicated** — sensitive data stays identity-only) |
| `member_profile_versions` | Profiles + full-text search vector |
| `clubs` | Club definitions and settings |
| `club_owner_versions` | Ownership change history |
| `club_memberships` | Member ↔ Club relationships |
| `club_membership_state_versions` | Membership state transition history |
| `subscriptions` | Billing/subscription records |
| `club_routing` | Shard routing: club_id → shard_id (NEW — day one, all set to 1) |
| `embeddings_member_profile_artifacts` | Profile vector embeddings |
| `embeddings_jobs` | Profile embedding job queue |

Views:
- `current_member_profiles`, `current_member_global_roles`
- `current_club_memberships` → `active_club_memberships` → `accessible_club_memberships`
- `current_club_owners`, `current_club_membership_states`

Characteristics:
- Small. Bounded by member count and club count, not activity volume.
- One-hop auth. Token validation + member identity + global roles + memberships + club metadata — all in one query.
- Never shards. Single Postgres instance + read replicas.
- **No RLS.**

### Club Database (First Content Shard)

Club-scoped activity data. This is the shard template.

**Canonical tables (owned by this shard):**

| Table | Purpose |
|-------|---------|
| `entities` + `entity_versions` | Content: posts, asks, opportunities, services, events, comments |
| `event_rsvps` | Event attendance |
| `edges` | Vouches and relationship graph |
| `dm_threads` + `dm_messages` | Direct messaging |
| `redactions` | Content moderation records |
| `club_activity` + `club_activity_cursors` | Activity stream |
| `member_updates` + `member_update_receipts` | Targeted inbox |
| `admissions` + `admission_versions` | Application workflow |
| `admission_challenges` + `admission_attempts` | Cold application challenges + quality gate log |
| `club_quota_policies` | Per-club write rate limits |
| `embeddings_entity_artifacts` | Entity vector embeddings |
| `embeddings_jobs` | Entity embedding job queue |
| `llm_usage_log` | LLM gate audit trail |

**Replicated tables (read-only, from identity DB via logical replication):**

| Table | Why replicated |
|-------|---------------|
| `members` | Display name JOINs (message senders, entity authors, RSVP attendees), `state = 'active'` filtering |
| `member_profile_versions` | Rich profile data for `members.list`, FTS via `search_vector`, member search |
| `clubs` | Club metadata in content queries (name, slug, summary) |
| `club_memberships` | Membership-based content queries, access views |
| `club_membership_state_versions` | Membership state in views |
| `subscriptions` | Subscription status in access views |
| `club_owner_versions` | Ownership checks |
| `embeddings_member_profile_artifacts` | Member semantic search (embedding similarity) |

Views (local, defined in club DB over replicated + local data):
- `current_member_profiles` — same definition as today
- `current_club_memberships` → `accessible_club_memberships` — same definitions
- `current_entity_versions` → `live_entities` — over local entity data
- `current_event_rsvps`, `current_admissions`, `pending_member_updates` — same

Characteristics:
- Large, fast-growing. Bounded by activity volume.
- Write-heavy (content creation, messages, activity).
- Club queries are virtually unchanged — they JOIN the same table names.
- **No RLS, no session variables, no security definer functions.**
- This is the shard template. Adding shard 2 = clone schema + set up replication subscription.

### Why Memberships Live in the Identity Database

1. **One-hop auth.** The identity DB has everything needed for `AuthResult`: token, member, roles, memberships, club metadata. No second database round-trip on every request.
2. **Member visibility is identity-local.** `canAccessMember()` checks shared clubs — all in identity DB.
3. **Membership transitions are single-DB.** No saga needed for state changes, subscription updates, or owner transfers.
4. **Cross-club reads are identity-local.** "What clubs am I in?" and "What's my role everywhere?" don't touch any shard.
5. **Sharding is cleaner.** The control plane knows the full membership graph. Shards just store content. No "which shard has this membership?" problem.

The trade-off: admission acceptance becomes a two-database saga (identity creates member + membership, club updates admission status). This is a low-frequency, owner-initiated action.

---

## Logical Replication

Postgres logical replication streams row-level changes (INSERT/UPDATE/DELETE) from publisher to subscriber in near-real-time.

### Setup

```
Identity DB (publisher) ──replication──▶ Club DB (subscriber)
```

One-directional. Identity publishes; each club shard subscribes. No bidirectional replication.

### What it replaces

- **`member_directory` table** — eliminated. Club queries JOIN the replicated `members` table directly.
- **Dual-write sync code** — eliminated. No application code for keeping projections in sync.
- **Batched identity enrichment** — eliminated. Club DB has full `member_profile_versions` locally.
- **"Member directory is too thin" problem** — eliminated. The full table is replicated.
- **Two-step member search** — eliminated. FTS and embedding search run locally in the club DB.

### What it doesn't replicate

- **`member_private_contacts`** — sensitive data. Email stays identity-only. If a superadmin needs an email, the application queries identity DB directly.
- **`member_bearer_tokens`** — tokens are identity-only. No reason for shards to see them.
- **`member_global_role_versions`** — superadmin status is determined during auth (identity DB). Shards don't need it.
- **`club_routing`** — routing is application-level, not replicated.
- **`embeddings_jobs`** — each DB has its own job queue.

### Replication lag

Sub-second on the same host, low seconds across hosts. This affects display freshness, not access control:
- Access decisions use the auth result (from identity DB — always fresh).
- Club queries use replicated data for JOINs (display names, profile data). A just-updated profile might show stale data for a fraction of a second.
- A just-created membership won't appear in club-side member listings for a brief moment. Acceptable.

---

## Authentication Flow

### Current (single database)

```
Bearer token
  → authenticate_member_bearer_token(tokenId, secretHash)
  → readActorByMemberId()  [members + global_roles + club_memberships + clubs + subscriptions]
  → AuthResult { actor, requestScope, sharedContext }
```

### After split

```
Identity DB (single query, virtually unchanged):
  → Validate bearer token → member_id
  ��� readActorByMemberId()  [same tables, same query, all in identity DB now]
  → AuthResult { actor, requestScope, sharedContext }
```

**One hop.** The auth query barely changes. It joins members, global roles, accessible memberships, and clubs — all now in the identity DB. The existing `readActorByMemberId` function in `postgres.ts:122-158` works against the identity pool with minimal modification.

---

## What Happens to RLS Infrastructure

**Removed entirely:** All `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, ~60 `CREATE POLICY` statements, session variable functions (`current_actor_member_id`, `current_actor_is_superadmin`), RLS helper functions (`actor_has_club_access`, `actor_is_club_owner`, `actor_can_access_member`, `actor_can_access_thread`, `membership_belongs_to_current_actor`), `applyActorContext()` in `postgres.ts`, special DB roles (`clawclub_security_definer_owner`, `clawclub_cold_application_owner`, `clawclub_view_owner`).

**Kept:** Sync triggers (`sync_club_membership_compatibility_state`, `sync_club_owner_compatibility_state` — use `NEW` row data, not session vars). Search vector trigger. NOTIFY triggers (for SSE). `lock_club_membership_mutation()` trigger guard (uses `app.allow_club_membership_state_sync` session var — not RLS-related, stays in identity DB with club_memberships).

**Simplified to regular functions:** `authenticate_member_bearer_token()`, `create_member_from_admission()`, `create_comped_subscription()`, `membership_has_live_subscription()`, admission challenge functions, `count_member_writes_today()`, `entity_is_currently_published()`, etc. No SECURITY DEFINER needed without RLS.

**`withActorContext` becomes `withTransaction`** — a plain transaction helper with no session variable setup.

---

## Application-Layer Authorization

New functions in `src/authorization.ts`, called from repository methods:

| Function | Replaces | Logic |
|----------|----------|-------|
| `canAccessMember(actor, targetMemberId, identityPool)` | `actor_can_access_member()` | Self, superadmin, shared club, owner visibility, admissions-related. All checked against identity DB (memberships are local). |
| `canAccessThread(actor, threadId, clubPool)` | `actor_can_access_thread()` | Actor is `created_by_member_id` or `counterpart_member_id` on thread, and has club access. |
| `canAccessPrivateContacts(actor, targetMemberId)` | `member_private_contacts` RLS | Self or superadmin only. |

Note: `canAccessMember` queries the identity DB (where memberships live). `canAccessThread` queries the club DB (where threads live). Both are called from repository methods before querying sensitive data.

---

## Cross-Plane Operations

### Most operations are now single-database

With memberships in identity DB and replication giving club DB read access to platform data, most operations are single-database:

| Operation | Database | Notes |
|-----------|----------|-------|
| Auth | Identity | One hop, unchanged query |
| Profile read/update | Identity | Profiles are identity-owned |
| Token CRUD | Identity | Tokens are identity-owned |
| Membership transition | Identity | Memberships are identity-owned |
| Club creation | Identity | Club + owner membership in one transaction |
| Club owner assignment | Identity | Club ownership + membership changes in one transaction |
| Member search (FTS/embedding) | Club (replicated data) | Full profiles + search_vector available locally |
| Entity CRUD | Club | Content is club-owned |
| Message send/read | Club | Messages are club-owned |
| Event CRUD/RSVP | Club | Events are club-owned |
| Activity/updates stream | Club | Streams are club-owned |
| Cold admission (challenge/apply) | Club | Admissions are club-owned |

### Admission acceptance (the one saga)

When a cold applicant is accepted:

1. **Identity DB (single transaction):** Create member via `create_member_from_admission()` (if outsider). Create `club_membership` + `club_membership_state_version` + comped `subscription`.
2. **Club DB (single transaction):** Update `admission_versions` status to `accepted`. Link `membership_id` on the admission record.

**Failure modes:**
- Step 1 fails: nothing happened. Retry.
- Step 2 fails after step 1 succeeds: **member has club access but admission still shows pending.** This is confusing for the club owner but not harmful — the member can access the club, the admission just shows wrong status. The retry must be explicit and idempotent: check if membership already exists for this admission before retrying step 1, then retry step 2 unconditionally (UPDATE is idempotent on status).

For sponsored admissions where `applicant_member_id` is already set, step 1 skips member creation — just creates the membership.

### Admin queries

`adminGetOverview` counts members (identity) and entities (club). Two queries, combined in application. Low-frequency.

---

## Embedding Workers

One worker per database:

- **Identity embedding worker:** Connects to identity DB. Processes profile embedding jobs. Reads profile text, calls OpenAI, writes to `embeddings_member_profile_artifacts`.
- **Club embedding worker (per shard):** Connects to one club DB. Processes entity embedding jobs. Reads entity text, calls OpenAI, writes to `embeddings_entity_artifacts`.

For now: two workers total (one identity, one club). When shard 2 is added, spin up another club worker. Identity worker stays singular.

Each database has its own `embeddings_jobs` table. `profile.update` enqueues profile jobs in the identity DB transaction. Entity create/update enqueues entity jobs in the club DB transaction. No cross-database job enqueueing.

---

## Operational Concerns

### Migration coordination for replicated tables

Logical replication replicates DML (data changes) but **not DDL (schema changes)**. When you add a column to `members` in the identity DB, you must also add it to the replica table in the club DB.

**Required ordering:** Apply the schema change to the subscriber (club DB) **first**, then the publisher (identity DB). If the publisher gets the column first, it starts replicating data for a column the subscriber doesn't have, and replication breaks.

This is a new discipline. Today: one migration directory, one `migrate.sh` run. After: two migration directories, and changes to replicated tables need careful sequencing. Document this in a REPLICATION.md or similar.

### Replication monitoring

- **WAL growth:** If the club DB goes down or the replication slot falls behind, the identity DB's WAL grows unboundedly. Need alerting on replication lag and slot size.
- **Slot cleanup:** If a shard is permanently removed, its replication slot must be dropped from the identity DB or WAL will never be reclaimed.

### Don't replicate `member_private_contacts`

Emails are sensitive. The club DB should never have them, even as a read-only replica. Club-side functions that need owner display info use the replicated `members` table for `public_name`. If a superadmin needs an email, the application queries identity DB directly.

---

## Connection Management

### Two pools in `server.ts`

```typescript
const identityPool = new Pool({
    connectionString: process.env.IDENTITY_DATABASE_URL,
    max: parseInt(process.env.IDENTITY_DB_POOL_MAX ?? '10'),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

const clubPool = new Pool({
    connectionString: process.env.CLUB_DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX ?? '20'),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});
```

### Repository architecture

```typescript
export function createSplitRepository({ identityPool, clubPool }): Repository {
    return {
        authenticateBearerToken: async (bearerToken) => {
            // Identity DB only — one hop
        },
        // Identity-plane repos
        ...buildTokenRepository({ pool: identityPool }),
        ...buildProfileRepository({ pool: identityPool }),
        ...buildMembershipRepository({ pool: identityPool, clubPool }),
        ...buildPlatformRepository({ pool: identityPool }),
        // Club-plane repos
        ...buildEntitiesRepository({ pool: clubPool }),
        ...buildEventsRepository({ pool: clubPool }),
        ...buildMessagesRepository({ pool: clubPool }),
        ...buildUpdatesRepository({ pool: clubPool }),
        ...buildRedactionsRepository({ pool: clubPool }),
        ...buildQuotaRepository({ pool: clubPool }),
        // Both pools
        ...buildAdminRepository({ identityPool, clubPool }),
        ...buildEmbeddingsRepository({ identityPool, clubPool }),
    };
}
```

The `Repository` interface in `contract.ts` does not change. `dispatch.ts` does not change. The split is invisible above the repository layer.

### SSE streaming

`MemberUpdateNotifier` uses `LISTEN/NOTIFY` on the club DB (where `member_updates` and `club_activity` live). No change.

---

## Migration System

### Two migration directories

```
db/migrations/identity/   ← identity DB (platform tables + replication publication)
db/migrations/clubs/      ← club DB (content tables + replication subscription)
```

**Critical rule for replicated tables:** Schema changes to replicated tables must be applied to the subscriber (club DB) **before** the publisher (identity DB). See "Operational Concerns" above.

### Scripts

- `scripts/migrate-identity.sh` — runs identity migrations
- `scripts/migrate-clubs.sh` — runs club migrations
- `scripts/provision-app-role.sh` — simplified (no RLS roles), runs against both DBs
- `scripts/setup-replication.sh` — NEW: creates publication on identity DB, subscription on club DB

### Foreign keys across the boundary

Club tables that reference `members(id)` or `clubs(id)` can still use FK constraints — because the replicated tables exist locally in the club DB. The FK points to the local replica, not across databases.

However, the replica tables are read-only. If a foreign key has `ON DELETE CASCADE`, the cascade would need to originate from the identity DB (which owns the canonical data). Replica-side cascades don't apply. In practice: don't rely on cross-boundary cascades. Use application-level cleanup.

---

## Local Development

```bash
IDENTITY_DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_identity_dev"
CLUB_DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_clubs_dev"
```

Both on the same Postgres instance. Logical replication works between databases on the same instance.

### Setup script

```bash
# Create databases
psql -h localhost -d postgres \
  -c "DROP DATABASE IF EXISTS clawclub_identity_dev;" \
  -c "DROP DATABASE IF EXISTS clawclub_clubs_dev;" \
  -c "CREATE DATABASE clawclub_identity_dev;" \
  -c "CREATE DATABASE clawclub_clubs_dev;"

# Run migrations
./scripts/migrate-identity.sh
./scripts/migrate-clubs.sh

# Provision app role on both
CLAWCLUB_DB_APP_PASSWORD="localdev" DATABASE_URL="postgresql://localhost/clawclub_identity_dev" ./scripts/provision-app-role.sh
CLAWCLUB_DB_APP_PASSWORD="localdev" DATABASE_URL="postgresql://localhost/clawclub_clubs_dev" ./scripts/provision-app-role.sh

# Set up replication
./scripts/setup-replication.sh

# Seed + create tokens
```

### Test harness

Creates `clawclub_test_identity` and `clawclub_test_clubs`. Sets up replication between them. Same create/migrate/teardown lifecycle, doubled.

---

## Path to Multi-Shard

### Day one: Identity DB + Club Shard 1

Both on same Postgres instance. `club_routing` table exists with all clubs mapped to `shard_id = 1`. Replication proven working.

### When growth hits

1. **Read replicas** for identity DB (auth offloading).
2. **PgBouncer** for club shard (connection pooling).
3. **Partitioning** on large club tables (member_updates, club_activity).

### Adding shard 2

1. Spin up new Postgres instance with club schema.
2. Set up replication subscription from identity DB.
3. Move clubs from shard 1 to shard 2 (pg_dump per club, delete from shard 1).
4. Update `club_routing`.
5. Application reads `club_routing` (cached) and routes club-scoped requests to the right pool.

Each shard gets the same identity replication — the full membership graph, all member profiles, all club metadata. This is small relative to content volume.

### Cross-club projections (later)

The identity DB already has the full membership graph. Cross-club reads ("what events are happening tonight across my clubs?") query identity DB for the member's clubs + routing, then fan out to relevant shards for content. Projection tables on the identity DB can cache cross-club summaries.

---

## What NOT to Do

- **Don't add Redis.** Not needed for the split. Separate concern (Tier 2).
- **Don't build cross-club projection pipeline.** That's Tier 6.
- **Don't use `postgres_fdw`.** Logical replication is simpler and faster.
- **Don't replicate `member_private_contacts`.** Emails stay identity-only.
- **Don't do bidirectional replication.** One direction: identity → club shards.
- **Don't worry about SSE fleet topology.** That's orthogonal to the data split.

---

## Full Implementation Surface

### SQL helper functions

**Move to identity DB (as regular functions):**
- `authenticate_member_bearer_token()`, `create_member_from_admission()`, `get_member_public_contact()`, `member_is_active()`, `resolve_active_member_id_by_handle()`, `issue_admission_access()`, `create_comped_subscription()`, `membership_has_live_subscription()`, `lock_club_membership_mutation()` (trigger), `sync_club_membership_compatibility_state()` (trigger)

**Stay in club DB (as regular functions):**
- `consume_admission_challenge()`, `create_admission_challenge()`, `get_admission_challenge()`, `delete_admission_challenge()`, `count_member_writes_today()`, `entity_is_currently_published()`, `sync_club_owner_compatibility_state()` (trigger — wait, club_owner_versions moved to identity... this trigger moves too)

**Refactored in club DB (use replicated `members` instead of `get_member_public_contact()`):**
- `list_publicly_listed_clubs()` — JOIN replicated `members` for owner name; drop `owner_email` from return
- `list_admission_eligible_clubs()`, `get_admission_eligible_club()` — same

**Removed entirely:**
- `current_actor_member_id()`, `current_actor_is_superadmin()`, `actor_has_club_access()`, `actor_is_club_owner()`, `actor_can_access_member()`, `actor_can_access_thread()`, `membership_belongs_to_current_actor()`

### Scripts, tools, and config

- `src/server.ts` — two connection pools
- `src/embedding-worker.ts` → split into identity worker + club worker (or parameterized)
- `src/embedding-backfill.ts` → same
- `src/token-cli.ts` → `IDENTITY_DATABASE_URL`
- `src/http-smoke.ts` → both URLs
- `scripts/migrate.sh` → parameterized migrations directory
- `scripts/provision-app-role.sh` → simplified, both DBs
- `scripts/bootstrap.sh`, `add-member.sh`, `reset-dev.sh`, `healthcheck.sh`, `smoke-test.sh`, `pressure-test.sh`, `migration-status.sh` → updated for both URLs
- `ops/systemd/clawclub-api.service`, `clawclub-embedding-worker.service` → both `DATABASE_URL` vars
- `test/integration/harness.ts` → two test databases + replication
- `test/postgres-rls.test.ts` → replaced by authorization tests
- `db/seeds/dev-clubs.sql` → writes to both databases
- `CLAUDE.md` — new local dev instructions

---

## Implementation Phases

### Phase 1: Schema and Migrations

- Write identity DB initial migration: all platform tables, types, views, functions (no RLS).
- Write club DB initial migration: all content tables, types, views, triggers (no RLS). Include replica table definitions for the replicated tables (same schema, no data — replication fills them).
- Write `scripts/setup-replication.sh`: creates publication on identity DB, subscription on club DB.
- Write `club_routing` table (identity DB) with initial data (all clubs → shard 1).
- Update `scripts/migrate.sh` for configurable migrations directory.
- Create `scripts/migrate-identity.sh` and `scripts/migrate-clubs.sh`.
- Simplify `scripts/provision-app-role.sh` (no RLS roles).

### Phase 2: Authorization Layer

Build before removing RLS:

- `canAccessMember(actor, targetMemberId, identityPool)` — 5 access paths, queries identity DB (memberships are local).
- `canAccessThread(actor, threadId, clubPool)` — thread participant check, queries club DB.
- `canAccessPrivateContacts(actor, targetMemberId)` �� self or superadmin.

These live in `src/authorization.ts`.

### Phase 3: Repository Split

- Refactor `postgres.ts` → `createSplitRepository({ identityPool, clubPool })`.
- Auth: `authenticateBearerToken` queries identity DB only (one hop, existing query with minimal changes).
- Remove `applyActorContext`. Replace `withActorContext` with `withTransaction`.
- `buildTokenRepository` → identity pool.
- `buildProfileRepository` → identity pool. Profile writes enqueue embedding jobs in same transaction.
- `buildMembershipRepository` → identity pool for membership writes. Admission acceptance becomes saga (identity creates member + membership, club updates admission).
- `buildPlatformRepository` → identity pool. `listClubs` JOINs local data (clubs + members + memberships all in identity DB). Owner email via `canAccessPrivateContacts` check then identity DB query.
- `buildEntitiesRepository`, `buildEventsRepository`, `buildMessagesRepository`, `buildUpdatesRepository`, `buildRedactionsRepository`, `buildQuotaRepository` → club pool. Queries JOIN replicated tables (members, profiles, clubs, memberships) — virtually unchanged.
- `buildAdminRepository` → both pools where needed.
- `buildEmbeddingsRepository` → identity pool for profile search, club pool for entity search.

### Phase 4: Infrastructure

- `server.ts` — two pools.
- Embedding workers — one per database.
- All scripts, CLI tools, systemd services, seed data — updated for two URLs.
- Test harness — two test databases + replication setup.

### Phase 5: Authorization Tests

Explicit integration tests for every boundary RLS previously enforced:

- Club access boundary (member of Club A cannot access Club B data)
- Member visibility (5 access paths: self, superadmin, shared club, owner, admissions)
- Thread privacy (only participants can read)
- Private contacts (self + superadmin only)
- Owner-only operations, superadmin-only operations, self-only operations
- Admission scoping

### Phase 6: Verification

- All existing integration tests pass against two-database setup with replication.
- All new authorization tests pass.
- Admission saga works end-to-end with explicit retry on partial failure.
- Replication lag is sub-second on same-host Postgres.
- `club_routing` table works (even though everything maps to shard 1).
- Test with two separate Postgres instances to verify cross-host replication.
