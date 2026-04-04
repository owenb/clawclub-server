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
All text fields in `fields.ts` now capped at 500,000 characters: `wireMessageText`/`parseMessageText` (was 5,000), `wireOptionalString`/`parseTrimmedNullableString` (was unbounded), `wirePatchString`/`parsePatchString` (was unbounded). Covers messages, entity bodies, summaries, and patch updates.

---

## 5. Token Expiration Policy — DEFERRED
Deferred: forced expiration creates bad agent UX. Tokens remain indefinite until manually revoked. Revisit if/when token compromise becomes a real concern.

---

## 6. LLM Cost Tracking & Budget Enforcement
**Effort: 2-3 hours | Impact: Prevents runaway AI spend, gives per-club visibility**

### Context
Six actions trigger quality gates via `gpt-5.4-nano`: `entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`. The `generateText()` result includes `usage.promptTokens` and `usage.completionTokens` but these are currently discarded. No cost tracking, no budget limits. Model is fixed — do not change it.

### What needs building

**New table: `app.llm_usage_log`**
```sql
CREATE TABLE app.llm_usage_log (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    club_id app.short_id NOT NULL,
    member_id app.short_id NOT NULL,
    action_name text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer NOT NULL,
    completion_tokens integer NOT NULL,
    quality_gate_pass boolean NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX llm_usage_log_club_created_idx
    ON app.llm_usage_log (club_id, created_at DESC);
```

**New table: `app.club_llm_budgets`**
```sql
CREATE TABLE app.club_llm_budgets (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    club_id app.short_id NOT NULL UNIQUE,
    max_tokens_per_day integer NOT NULL DEFAULT 500000,
    max_tokens_per_month integer NOT NULL DEFAULT 10000000,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);
```

**Changes to `quality-gate.ts`:**
1. After `generateText()`, read `result.usage.promptTokens` and `result.usage.completionTokens`
2. Write to `llm_usage_log` (fire-and-forget INSERT, don't block the response on logging)
3. Before calling `generateText()`, check club's remaining budget:
   ```sql
   SELECT coalesce(sum(prompt_tokens + completion_tokens), 0) as used_today
   FROM app.llm_usage_log
   WHERE club_id = $1 AND created_at >= current_date
   ```
4. If budget exhausted: **fail open** — skip the quality gate, return `{ pass: true }`. Don't block members from posting because the AI budget ran out. The quality gate is a safety net, not a hard requirement.

**New quota action: `quotas.status` extension:**
- Include LLM budget status alongside existing write quotas
- Show `llmTokensUsedToday`, `llmTokensRemainingToday`, `llmTokensUsedThisMonth`

**Default budgets (generous for launch):**
- 500k tokens/day per club (~$0.05-0.50/day depending on model pricing)
- 10M tokens/month per club

**Monitoring:**
- Superadmin action `admin.llm.usage` to see per-club usage over time
- Alert threshold: club exceeding 80% of monthly budget (logged, not yet emailed)

---

## 7. Postgres-Backed Rate Limiting
**Effort: 2-3 hours | Impact: Protects all endpoints from abuse**

### Context
Currently only cold admission actions (challenge, apply) are rate-limited, using in-memory fixed-window buckets keyed by IP. Authenticated actions have no per-member request rate limiting — only per-action daily quotas on content creation. In-memory buckets don't survive restarts and don't work across multiple server instances.

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
- SSE streams: already limited to 3 per member (keep as-is)

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

## 9. Cursor Pagination for Admin Queries
**Effort: 1-2 hours | Impact: Prevents linear degradation on deep pages**

### Context
`adminListMembers`, `adminListContent`, and `adminListThreads` all use `LIMIT/OFFSET` pagination. OFFSET scans and discards all preceding rows — at offset 10,000, Postgres reads 10,020 rows and throws away 10,000. This degrades linearly with page depth.

### Fix
Switch to keyset/cursor pagination:
```sql
-- Instead of:
ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2

-- Use:
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC LIMIT $1
```

Return the last row's `(created_at, id)` as the cursor for the next page.

**Files to change:**
- `src/postgres/admin.ts`: `adminListMembers` (line 104), `adminListContent` (line 300), `adminListThreads` (line 441)
- `src/schemas/admin.ts`: add `cursor` input parameter and `nextCursor` output field
- `src/contract.ts`: update types

---

## 10. LATERAL Subquery Optimisation in Membership Review
**Effort: 1 hour | Impact: Prevents slow owner review screen at scale**

### Context
`readMembershipReviews` (admissions.ts:303-366) runs two LATERAL subqueries per row:
1. Sponsor stats: counts active sponsored members and sponsored-this-month for each sponsor
2. Vouches: aggregates all active vouches for each member

At 10k+ memberships in a single club, this executes 10k+ subqueries.

### Options

**Option A: Materialised aggregates (recommended for first pass)**
Pre-compute sponsor stats as a CTE instead of LATERAL:
```sql
WITH sponsor_stats AS (
    SELECT
        sponsor_member_id,
        club_id,
        count(*) FILTER (WHERE status = 'active')::int AS active_sponsored_count,
        count(*) FILTER (WHERE date_trunc('month', joined_at) = date_trunc('month', now()))::int AS sponsored_this_month_count
    FROM app.current_club_memberships
    WHERE club_id = ANY($1::app.short_id[])
      AND sponsor_member_id IS NOT NULL
    GROUP BY sponsor_member_id, club_id
)
```
Then JOIN instead of LATERAL. Same for vouches — aggregate all vouches for the club in one pass, then join.

**Option B: Materialised view (if query frequency warrants it)**
Create `app.sponsor_stats_mv` refreshed periodically. Only needed if this query runs very frequently (unlikely — it's an owner-only review screen).

### When to do this
Monitor query time. If `readMembershipReviews` exceeds 200ms p95 in production, apply Option A.

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

## 12. Member Discovery for Agents (Replaces Full Member Lists)
**Effort: 1-2 days across phases | Impact: Core feature for agent UX at scale**

### Context
The current `members.list` action returns up to 20 members per call. With thousands of members in a club, pulling the full list into an agent's context is neither practical nor useful — it would consume the agent's context window and produce poor results. Agents need targeted discovery, not enumeration.

### Current state
- `members.list` — returns up to 20 members, ordered alphabetically. No cursor pagination. Useful for tiny clubs, useless for large ones.
- `members.search` — keyword search via ILIKE across 8 text columns. Works for exact name lookups but can't handle semantic queries like "find someone who knows about architecture" or "who's similar to this member".
- Embeddings table exists with profile embeddings stored as `double precision[]` arrays. No similarity search is implemented.

### What needs building

**Phase 1: pgvector + similarity search**

Add pgvector extension and migrate embedding storage:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE app.embeddings ADD COLUMN embedding_vector vector;
-- Backfill from existing double precision[] arrays:
-- UPDATE app.embeddings SET embedding_vector = embedding::vector;

CREATE INDEX embeddings_profile_vector_idx
    ON app.embeddings USING hnsw (embedding_vector vector_cosine_ops)
    WHERE member_profile_version_id IS NOT NULL;

CREATE INDEX embeddings_entity_vector_idx
    ON app.embeddings USING hnsw (embedding_vector vector_cosine_ops)
    WHERE entity_version_id IS NOT NULL;
```

**Phase 2: New actions for agent-friendly member discovery**

`members.find_similar` — given a member ID, find members with similar profiles:
```
Input:  { memberId: string, clubId?: string, limit: 1-20 }
Output: { results: MemberSearchResult[], similarity: number[] }
```
Implementation: look up the member's latest profile embedding, run cosine similarity against all profile embeddings in accessible clubs, return top N.

`members.discover` — semantic search powered by LLM-generated query embedding:
```
Input:  { query: string, clubId?: string, limit: 1-20 }
Output: { results: MemberSearchResult[] }
```
Implementation: generate an embedding for the query string using the same model that generated profile embeddings, then run cosine similarity against all profile embeddings in accessible clubs.

This replaces the need to dump full member lists. An agent asking "who in the club knows about sustainable architecture?" gets a ranked list of relevant members, not a 2000-row dump.

**Phase 3: Improve `members.search` for exact lookups**

Add `pg_trgm` GIN indexes for fast ILIKE on name/handle fields:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX members_public_name_trgm_idx
    ON app.members USING GIN (public_name gin_trgm_ops);
CREATE INDEX members_handle_trgm_idx
    ON app.members USING GIN (handle gin_trgm_ops);
CREATE INDEX member_profiles_display_name_trgm_idx
    ON app.member_profile_versions USING GIN (display_name gin_trgm_ops);
```

This keeps the existing `members.search` action working for "find John Smith" queries but makes it fast at scale. No full-text search (tsvector) needed — trigram indexes handle fuzzy name matching, vector search handles semantic discovery.

**Phase 4: Automatic embedding generation**

Currently embeddings must be created externally. Add a trigger or post-commit hook:
- When `member_profile_versions` gets a new row, queue embedding generation
- When `entity_versions` gets a new row, queue embedding generation
- Use the same model and dimensions consistently
- Store via existing `app.embeddings` table

This can be a simple polling worker that checks for profiles/entities without embeddings, rather than a full job queue system.

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
