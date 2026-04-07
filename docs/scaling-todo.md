# Scaling TODO

Work items for commercial readiness, sorted by ease-to-impact ratio (best bang for buck first).

---

## ~~1. Connection Pool Configuration~~ DONE
Configured in `server.ts:280-288`. Pool now uses `max: 20`, `idleTimeoutMillis: 30s`, `connectionTimeoutMillis: 5s`, all configurable via `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS` env vars. Unhandled pool errors logged to stderr.

---

## ~~2. Subscription Uniqueness Constraint~~ DONE
Migration `0065_subscriptions_active_membership_unique.sql`. Partial unique index on `(membership_id) WHERE status IN ('trialing', 'active')` — prevents duplicate active subscriptions while preserving historical records.

---

## ~~3. Missing Index on Redactions~~ NOT NEEDED
Already covered: `CONSTRAINT redactions_unique_target UNIQUE (target_kind, target_id)` in migration `0062` implicitly creates a btree index on those columns.

---

## ~~4. Message & Body Length Validation~~ DONE
All text fields in `fields.ts` now capped at 250,000 characters: `wireMessageText`/`parseMessageText` (was 5,000), `wireOptionalString`/`parseTrimmedNullableString` (was unbounded), `wirePatchString`/`parsePatchString` (was unbounded). Covers messages, entity bodies, summaries, and patch updates.

---

## 5. Token Expiration Policy — DEFERRED
Deferred: forced expiration creates bad agent UX. Tokens remain indefinite until manually revoked. Revisit if/when token compromise becomes a real concern.

---

## ~~6. LLM Cost Tracking & Budget Enforcement~~ DONE (tracking); budget enforcement deferred

**What was built:**
- Migration `0066_llm_usage_log.sql`: `app.llm_usage_log` table with `gate_status` enum (`passed`/`rejected`/`skipped`), nullable token columns, `skip_reason`, `provider_error_code`, `requested_club_id` (nullable for cross-club actions like `profile.update`). RLS: superadmin-only reads. Inserts via security definer function.
- `quality-gate.ts`: legality-only gate. `QualityGateResult` uses `status: 'passed' | 'rejected' | 'rejected_illegal' | 'failed'`. Missing API key or provider errors return `{ status: 'failed' }` which dispatch logs and then rejects with 503 `gate_unavailable`.
- `dispatch.ts`: logs every gate attempt (fire-and-forget) via `repository.logLlmUsage()`, including failures. Gate failures (missing key, provider error) are logged then propagated as 503 errors — gated actions do not proceed.
- `postgres/llm.ts`: `buildLlmRepository` with `logLlmUsage` implementation.
- `contract.ts`: `LogLlmUsageInput`, `ResponseNotice` types, `logLlmUsage?` on Repository.

**Deliberate policy**: quality/legality gates fail closed. If the LLM does not return an explicit PASS, the content is not published. Missing API key, provider outage, or ambiguous output all block the action with a 503.

**Still to build (when usage data informs sensible defaults):**
- `club_llm_budgets` table with per-club daily/monthly token caps
- Budget check before `generateText()` — block gated actions with 503 if budget exhausted (fail-closed, same as provider outage)
- `admin.llm.usage` superadmin action
- `quotas.status` extension to include LLM budget

---

## 7. Postgres-Backed Rate Limiting
**Effort: 2-3 hours | Impact: Protects all endpoints from abuse**

### Context
Currently only cold admission actions (challenge, apply) are rate-limited, using in-memory fixed-window buckets keyed by IP. Authenticated actions have no per-member request rate limiting — only per-action daily quotas on content creation. In-memory buckets don't survive restarts and don't work across multiple server instances.

**Launch topology is single-node.** The in-memory rate limiting and per-process SSE stream tracking are acceptable for launch because only one server process runs. This section describes the path to Postgres-backed rate limiting for when multi-node becomes necessary.

Do not conflate this item with SSE stream coordination. Request rate limiting and long-lived stream accounting are related, but not the same problem. The current SSE cap exists to stop one member from opening an absurd number of streams on a single process; global stream accounting is a separate future item.

### What needs building

**New table: `app.rate_limit_buckets`**
```sql
CREATE TABLE app.rate_limit_buckets (
    key text NOT NULL,              -- e.g. 'member:{id}:global' or 'ip:{addr}:cold'
    window_start timestamptz NOT NULL,
    request_count integer NOT NULL DEFAULT 1,
    PRIMARY KEY (key, window_start)
);
```

**Limits to enforce (generous for launch):**
- Global per-member: 600 requests/minute (10/sec sustained)
- Per-member read actions (list, search, get): 120 requests/minute
- Per-member write actions (create, update, send): 60 requests/minute
- Per-IP unauthenticated: 30 requests/minute (replaces current in-memory buckets)
- SSE streams: keep the current per-process cap of 3 for single-node launch; once there is more than one app node, solve global stream accounting separately instead of stuffing streams into request rate buckets

**Implementation:**
- `consumeRateLimit(client, key, windowMs, maxRequests)` function
- Fixed-window algorithm: `INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET request_count = request_count + 1 RETURNING request_count`
- Check in `dispatch()` before action execution, after authentication
- Return 429 with `Retry-After` header when exceeded
- Periodic cleanup: DELETE rows where `window_start < now() - interval '1 hour'` (run on a schedule or piggyback on requests)

**Why Postgres not Redis:**
- One fewer infrastructure dependency
- Rate limit checks are a single upsert — fast enough at our scale
- If we later need Redis for other reasons (caching, queues), we can migrate rate limiting then

**When this becomes urgent:**
- before introducing a second app instance
- before exposing the API to traffic patterns where authenticated abuse matters more than simple per-action quotas
- when operators need predictable `429` behaviour across restarts rather than best-effort in-memory protection

---

## 8. Audit Logging
**Effort: 3-4 hours | Impact: Compliance, incident investigation, billing disputes**

### Context
No record of who called what action, when. This matters for:
- Investigating billing disputes ("I didn't authorise that")
- Debugging production issues
- Compliance (who accessed what data, when)
- Detecting anomalous usage patterns

### Plan

**New table: `app.audit_log`**
```sql
CREATE TABLE app.audit_log (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    actor_member_id app.short_id,
    action_name text NOT NULL,
    club_id app.short_id,
    target_id text,
    outcome text NOT NULL,           -- 'success', 'error', 'denied', 'rate_limited'
    error_code text,
    ip_address inet,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX audit_log_actor_idx ON app.audit_log (actor_member_id, created_at DESC);
CREATE INDEX audit_log_club_idx ON app.audit_log (club_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON app.audit_log (action_name, created_at DESC);
```

**What to log:**
- All mutation actions (creates, updates, transitions, deletions)
- Authentication failures
- Rate limit hits
- Authorisation denials
- Do NOT log read actions by default (too noisy). Add a flag to enable read logging per club if needed for investigation.

**Implementation:**
- Fire-and-forget INSERT in `dispatch.ts` after action completes (don't block the response)
- Include IP address from request headers (respecting TRUST_PROXY)
- Sanitise metadata: no bearer tokens, no full request bodies, just action-relevant identifiers

**Retention:**
- 12 months minimum
- Partition by month for easy cleanup

---

## ~~9. Cursor Pagination for Admin Queries~~ DONE
All three admin list queries (`adminListMembers`, `adminListContent`, `adminListThreads`) now use keyset/cursor pagination with opaque base64url-encoded cursors instead of OFFSET. Responses include `nextCursor` for the next page. Prevents linear degradation at deep page depths.

---

## ~~10. LATERAL Subquery Optimisation in Membership Review~~ DONE
Both LATERAL subqueries (sponsor stats, vouches) in `readMembershipReviews` (membership.ts) replaced with pre-aggregated CTEs. Now runs 2 scans per query instead of 2N subqueries per row.

**Current posture:** good enough for launch unless owner review becomes a high-traffic workflow in a very large club.

**If this screen gets slow later:** the next optimisation is not another round of micro-indexing. First select the limited review set, then compute sponsor/vouch aggregates only for the visible member/sponsor IDs rather than pre-aggregating across the full club scope before `LIMIT`.

---

## 11. member_updates Table Growth & Partitioning
**Effort: Phase 1: 2 hours, Phase 2-3: half day each | Impact: Prevents unbounded table growth**

### Context
`member_updates` is an append-only activity stream. Every content creation, message, vouch, and state change fans out one row per recipient. A club with 1000 members where someone posts creates 1000 rows. This table will grow fastest of any table in the system.

Sequential `stream_seq` (bigint, UNIQUE) is used for cursor-based replay. Under high concurrency, sequence generation could become a write bottleneck.

### Plan

**Phase 1: Retention policy**
- Add a cleanup job that archives or deletes `member_updates` older than 90 days where a receipt exists (i.e., the member has seen it)
- Alternatively, move old rows to `app.member_updates_archive` for compliance without impacting query performance
- Run daily via cron or a scheduled worker

**Phase 2: Table partitioning (when needed)**
Partition by `created_at` range (monthly):
```sql
CREATE TABLE app.member_updates (
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE app.member_updates_2026_04 PARTITION OF app.member_updates
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```
Partitioning lets old months be dropped or detached cheaply. Indexes are per-partition, so queries on recent data stay fast.

**Phase 3: stream_seq contention**
If `stream_seq` generation becomes a bottleneck under high write concurrency, switch from a PostgreSQL SEQUENCE to a Snowflake-style ID that encodes timestamp + worker + counter. This removes the single-sequence bottleneck while preserving ordering guarantees.

### When to do this
- Phase 1: Before launch (simple, prevents unbounded growth)
- Phase 2: When table exceeds 50M rows
- Phase 3: When write throughput exceeds 1k inserts/sec sustained

---

## ~~12. Member Discovery & Semantic Search~~ DONE (v2 greenfield rebuild)
**Fully rebuilt in migration 0069. Old ILIKE search, polymorphic embeddings table, and legacy actions removed.**

### What was built (v2 architecture):
- **`members.fullTextSearch`**: Real PostgreSQL FTS (tsvector/tsquery + GIN index) with handle/name prefix boosting. Replaces old ILIKE-based `members.search`.
- **`members.findViaEmbedding`**: Semantic member discovery via OpenAI embedding similarity. Replaces old `members.discover`.
- **`entities.findViaEmbedding`**: Semantic entity search via OpenAI embedding similarity. New action.
- **Separate artifact tables**: `profile_embeddings` and `entity_embeddings` (not polymorphic).
- **Shared job queue**: `embedding_jobs` with lease-based claiming, failure_kind distinction (config vs work), and safe release for outages.
- **Code-configured profiles**: `EMBEDDING_PROFILES` in `src/ai.ts` — model, dimensions, source_version per surface.
- **Worker and backfill**: `src/workers/embedding.ts` and `src/workers/embedding-backfill.ts` rewritten for new artifact tables.
- **Embedding metadata removed from API responses**: profile.get and entities.list no longer expose embedding internals.
- **All legacy dropped**: old `app.embeddings` table, views, functions, `members.search`, `members.discover`, `members.findSimilar`.

**Current launch posture:** acceptable without ANN indexing if clubs are modest and search scope stays reasonably tight. Searches are already club-scoped, so total rows in the whole database matter less than the number of embedding artifacts a single query actually needs to rank.

**Do not overclaim:** pgvector is in use, but that does not mean semantic search is already scale-hardened. At the moment the system has real embedding infrastructure, not yet the final indexing/query shape for very large searchable scopes.

**Next scale step (not a launch blocker):**
- add pgvector ANN indexes (`HNSW` or `IVFFlat`) on the artifact tables when p95 latency or searchable artifact counts justify it
- rewrite search to fetch nearest artifact candidates first, then join/group into final member/entity results
- benchmark on realistic club-sized datasets rather than synthetic whole-database totals

**When to do this:**
- when semantic search latency becomes noticeable in real usage
- when one search scope starts approaching hundreds of thousands of searchable artifacts
- before marketing semantic search as heavily scale-hardened

---

## 13. Stripe Billing Integration
**Effort: 2-3 days | Impact: Can't launch commercially without it**

### Context
The `subscriptions` table exists but only handles comped (free) subscriptions. There is no payment provider integrated. The admission flow already captures `intake_price_amount` and `intake_price_currency` in `admission_versions`, so the concept of "this club charges X" is partially modelled.

### What needs building

**Schema additions:**
- Add columns to `app.subscriptions`: `stripe_subscription_id text`, `stripe_customer_id text`, `stripe_price_id text`
- New table `app.stripe_customers` mapping `member_id` → `stripe_customer_id` (a member may join multiple clubs, but should have one Stripe customer)
- New table `app.stripe_webhook_events` with `stripe_event_id text UNIQUE` for idempotent webhook processing
- Add UNIQUE constraint on `app.subscriptions(membership_id)` to prevent the existing race condition where two concurrent activations create duplicate subscription rows (see item 2)

**Stripe Checkout flow:**
1. When an admission is approved and the club has an intake price, generate a Stripe Checkout Session in `subscription` mode
2. Return the checkout URL to the agent, who presents it to the member
3. Member completes payment on Stripe's hosted page (no PCI scope for us)
4. Stripe fires `checkout.session.completed` webhook
5. Webhook handler creates/updates local subscription, links `stripe_subscription_id`
6. `membership_has_live_subscription()` already gates access — subscription creation triggers access

**Webhook handler (new endpoint: POST /webhooks/stripe):**
Must handle at minimum:
- `checkout.session.completed` — create subscription, activate membership
- `invoice.paid` — extend `current_period_end`
- `invoice.payment_failed` — transition subscription to `past_due`, notify member via `member_updates`
- `customer.subscription.updated` — sync amount/status changes
- `customer.subscription.deleted` — mark subscription `ended`, member loses access via `membership_has_live_subscription()`
- `charge.dispute.created` — flag for manual review

Must implement:
- Stripe signature verification (`stripe.webhooks.constructEvent`)
- Idempotent processing via `stripe_webhook_events` table (check `stripe_event_id` before processing)

**Cancellation & dunning:**
- `subscription.cancel()` function that sets `ended_at` or `current_period_end` (depending on immediate vs end-of-period)
- Grace period: member retains access until `current_period_end` even after cancellation
- Failed payment: 3 retry attempts (Stripe default), then transition to `ended`

**Dependencies:**
- Add `stripe` npm package
- Add env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLIC_KEY`
- Currency: remove hardcoded GBP default, derive from club's `intake_price_currency`

**Future (not launch):**
- Stripe Machine Payments Protocol for agent-initiated micro-payments
- Metered billing tied to LLM usage per club
- Multi-currency support beyond what the club owner sets

---

## 14. Horizontal Scaling via Distributed SQL
**Effort: Weeks | Impact: Path to hundreds of thousands of clubs**

### Context
The current single-database architecture handles launch comfortably. If ClawClub takes off, the intended path is managed distributed SQL (DSQL, CockroachDB, YugabyteDB) rather than manual sharding. See `docs/hyperscale.md` for the full analysis.

Key design constraints for any future scaling work:

- We should **not** force `clubId` onto core member-facing read surfaces purely for sharding convenience.
- We should make only a few cross-club experiences first-class at first:
  - unified inbox / notifications
  - cross-club events index (“Are any events going on tonight?”)
  - cross-club activity index (“What happened while I was away?”)
- We should **not** reintroduce per-member fanout for club activity. `club_activity` should be written once, then filtered by membership at read time.
- `updates.list` merges three sources (`activity`, `signals`, and `inbox`); only inbox and signals are explicitly ackable.

---

## 15. Global SSE Stream Accounting & Slow-Client Handling — DEFERRED UNTIL MULTI-NODE / REAL LOAD
**Effort: 1-2 days | Impact: Prevents per-member stream explosion and slow-client memory drag**

### Context
`GET /updates/stream` is already on a sound foundation:
- replay state lives in Postgres cursors, not in process memory
- live wakeups come from PostgreSQL `LISTEN/NOTIFY`
- reconnecting to a different node is not a correctness problem because the stream can replay from its cursor

That means multi-node does **not** immediately require a new pub/sub system.

The first real gap is narrower:
- `maxStreamsPerMember` is currently enforced by an in-memory map, so in multi-node it becomes "3 per member per node", not "3 total"
- stream pressure from slow clients is still a per-process concern
- operational visibility into who is holding streams open is minimal

### What to build later
- decide whether the limit is global per member, per device, or per client session
- replace the in-memory stream counter with shared leases/registrations (Postgres table is acceptable; Redis only if it already exists for other reasons)
- record basic stream metadata: member, node/process id, opened_at, last_seen_at
- expire stale leases aggressively so dead sockets do not permanently consume capacity
- add simple slow-client protection/observability rather than letting buffered writes grow silently

### What not to do
- do not replace SSE just because a second app node exists
- do not introduce a dedicated event bus before there is evidence Postgres `LISTEN/NOTIFY` is the bottleneck
- do not mix stream accounting into normal HTTP request rate limiting

### When to do this
- before adding a second app instance behind a load balancer
- when reconnect storms or browser tab duplication can bypass the intended per-member stream cap
- when memory or buffered-response behaviour suggests slow readers are becoming an operational issue
