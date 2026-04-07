# Member Signals and Synchronicity Engine

Implementation plan for proactive, system-generated notifications delivered through the existing update feed. This document covers the full primitive stack: from a general-purpose signal delivery channel through to the synchronicity matching engine that uses it.

Last updated: 2026-04-06

## Motivation

ClawClub today is entirely reactive. Nothing happens unless a human initiates it. An ask sits in the feed waiting for someone to scroll past it. Two members with overlapping interests never learn about each other unless one explicitly searches. An event with one spot left and three perfect-fit members goes unfilled because nobody thought to check.

The platform already has the raw intelligence to connect these dots:
- Member profiles are embedded as vectors (pgvector, `text-embedding-3-small`, 1536 dims)
- Entities (asks, opportunities, services, posts) are embedded the same way
- Both embedding sets are maintained asynchronously by the existing embedding worker
- The update feed already merges multiple notification sources into a single poll/SSE stream

What's missing is the ability for the *system* to generate targeted notifications based on what it knows. Not DMs from a bot. Not broadcast announcements. Quiet, structured signals delivered to one specific member's agent, carrying enough context for the agent to decide whether and how to surface them.

## Design philosophy

### Primitives over features

This plan is deliberately structured as a stack of general-purpose primitives, not as a set of feature implementations. The use cases for system-generated member notifications extend far beyond synchronicity:

- Billing: "Your subscription expires in 7 days"
- Moderation: "Your post was removed by a club admin"
- Admissions: "A new applicant you sponsored has been accepted"
- Support: "You've received a reply from the club owner"
- Capacity: "A spot opened up at Thursday's dinner"
- Milestones: "You've been a member for one year"

All of these are the same primitive: a targeted, structured, system-generated notification delivered through the update feed. Building the signal channel as a general-purpose primitive means every future notification use case is already solved at the transport layer. The synchronicity engine is just the first (and most complex) producer.

This philosophy extends to every layer of the stack. The worker runner is not a "synchronicity runner" -- it is a general-purpose worker lifecycle harness. The match table is not a "synchronicity matches table" -- it is a general-purpose background match lifecycle tracker. The similarity queries are not "synchronicity queries" -- they are general-purpose vector similarity helpers. Every component should be named, documented, and tested as the general tool it is, not as a feature-specific implementation detail.

### Quality of signal over quantity

The system must earn the member's trust by being useful, not noisy. A single high-quality signal that leads to a real connection is worth more than fifty marginal suggestions. Every design decision should bias toward precision over recall:

- Conservative similarity thresholds (miss a match rather than send a bad one)
- Strict per-member daily caps (start with 2-3 signals/day, never more)
- Rich payloads that give the agent enough context to make a good judgment call
- Durable acknowledgement state so we can measure and improve signal quality

If a member's agent starts suppressing signals, that is a product failure, not a tuning problem.

### LLM cost discipline

Clubs can grow large. A club with 500 members and 50 daily entity publications would generate 25,000 candidate similarity comparisons per day. The system must not call the LLM for every candidate.

The core matching primitive is pgvector cosine similarity -- pure SQL, no LLM call. The only places the LLM is involved are:
1. **Embedding generation** (already exists, already async, already batched)
2. **Match context generation** (optional, deferred to Phase 5, and only for matches that pass the threshold and will actually be delivered)

The plan never calls the LLM speculatively. Embedding vectors are pre-computed and maintained by the existing embedding worker. Similarity queries are SQL joins over those vectors. The LLM is only invoked *after* a match has been confirmed as worth delivering, and only if we decide match context generation adds enough value to justify the cost.

### Sharding awareness

If ClawClub scales to the point where horizontal scaling is needed (see `docs/hyperscale.md`), every primitive in this plan must work in that world:

- **Member signals** are already club-scoped. One shard = one club's signals.
- **Worker state** lives in the database alongside the data it tracks. Each shard maintains its own high-water marks. A worker process can be assigned to one or many shards.
- **Similarity queries** load a source vector and query the target table. This pattern works whether the database is one instance or many -- the vector is loaded from the shard, then queried against the target table.
- **The worker runner** is shard-agnostic. It manages pools and lifecycle. The worker implementation receives pools and operates on them.

## Architecture overview

The stack decomposes into four tiers. Each tier is independently useful, and each is designed to outlast any specific feature built on top of it.

```
┌─────────────────────────────────────────────────────────────┐
│  Feature workers                                            │
│  synchronicity today; digests, billing nudges, recommendation │
│  workers later. Each is a process using the tiers below.    │
├─────────────────────────────────────────────────────────────┤
│  Recommendation primitives                                  │
│  similarity helpers, background_matches table               │
├─────────────────────────────────────────────────────────────┤
│  Worker primitives                                          │
│  runner.ts (lifecycle, pools, health), worker_state table   │
├─────────────────────────────────────────────────────────────┤
│  Transport primitives                                       │
│  signals table, compound cursor, notifier/SSE               │
└─────────────────────────────────────────────────────────────┘
```

- **Transport primitives** are the general-purpose notification channel. Any system that needs to tell a specific member something -- billing, moderation, support, capacity alerts -- inserts a row into `signals` and the existing update feed delivers it. This tier has no knowledge of matching, similarity, or recommendations.
- **Worker primitives** are the general-purpose background process infrastructure. Any long-running process that polls for work, needs DB pools, health checks, and graceful shutdown uses the shared runner. Any worker that needs to persist cursor state uses `worker_state`. This tier has no knowledge of what the workers do.
- **Recommendation primitives** are reusable within the narrower domain of "the system computed that member X should know about thing Y." Similarity queries and the `background_matches` lifecycle table. Any worker that needs to find similar members/entities and track match state uses these. This tier has no knowledge of specific match types.
- **Feature workers** are the specific business logic: synchronicity matching today, digests, billing nudges, and other recommendation workers later. Each worker is a thin layer of domain logic that uses the tiers below. Adding a new feature worker should never require changes to the transport, worker, or recommendation tiers.

## Prerequisites: Phase 0

### Canonical embedding schema

The migrations and the application code have drifted on embedding artifact column names:

**Migrations** (`db/migrations/0001_init.sql`):
- Profile artifacts: `member_profile_version_id`, `embedding_vector`
- Entity artifacts: `entity_version_id`, `embedding_vector`

**Application code** (`src/identity/profiles.ts`, `src/clubs/index.ts`, `src/workers/embedding.ts`):
- Identity: `member_id`, `profile_version_id`, `embedding`
- Clubs: `entity_id`, `entity_version_id`, `embedding`

The code-style schema is the right one to standardize on, for two reasons:
1. The code includes denormalized `member_id` / `entity_id` columns that avoid a join through the version table on every similarity query. At scale (large clubs), eliminating that join per row matters.
2. All existing application code already uses this schema. Changing the migrations to match is one task; changing all the code to match the migrations is many.

**Action**: Update the migrations to match the code-style schema. Add `member_id` and `entity_id` columns, rename `embedding_vector` to `embedding`, rename `member_profile_version_id` to `profile_version_id`. Maintain the upsert-on-conflict key as `(member_id, model, dimensions, source_version, chunk_index)` for profiles and `(entity_id, model, dimensions, source_version, chunk_index)` for entities.

Additionally, add an `updated_at` column (default `now()`) to both artifact tables, and update it on upsert conflict. The current `insertProfileArtifact` in `src/workers/embedding.ts` uses `ON CONFLICT DO UPDATE` but does not touch any timestamp, which makes it impossible to detect re-embedded profiles. The `updated_at` column is needed for the synchronicity worker's profile-change trigger (see Primitive 5).

### Worker infrastructure

All workers move to `src/workers/` with shared infrastructure. This is detailed in the "Worker management" section below. Files affected:
- `src/workers/embedding.ts` (embedding worker)
- `src/workers/embedding-backfill.ts` (backfill script)
- `package.json` (`worker:*` npm scripts)

---

## Primitive 1: Member Signals

### What it is

A new notification source in the update feed. Today `listMemberUpdates` in `src/postgres.ts` merges two sources:

| Source | Table | Scope | Targeting |
|--------|-------|-------|-----------|
| Activity | `app.activity` | Club-wide broadcast | Audience filter (members/clubadmins/owners) |
| Inbox | `app.inbox_entries` | Per-recipient | Specific member |

Member signals add a third:

| Source | Table | Scope | Targeting |
|--------|-------|-------|-----------|
| Signal | `app.signals` | Per-recipient, club-scoped | Specific member |

### Why not DMs

DMs are conversations between people. They create threads, have senders, expect replies. System-generated notifications are none of these things:
- **Not conversations** -- there is no back-and-forth. The system states a fact; the agent decides what to do.
- **Not from anyone** -- no sender identity. No anthropomorphized agent persona. `createdByMemberId` is null.
- **Structured data** -- the payload is a JSON object designed for machine consumption by the member's agent, not human-readable prose.
- **Ephemeral** -- acknowledged and done. No thread history to maintain.

Using DMs would pollute the messaging system with non-conversational noise and force the agent to distinguish "real messages from people" from "system notifications pretending to be messages." A separate source type keeps the semantics clean.

### Why not extend activity

`activity` is broadcast -- every member in the club sees the same activity entries (filtered by audience tier). Signals are targeted to one specific member. "This ask matches *your* profile" is meaningless to anyone else. Adding per-recipient targeting to `activity` would complicate its simple broadcast model and break the assumption that all members (within their audience tier) see the same activity log.

### Migration

New table:

```sql
CREATE TABLE app.signals (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text NOT NULL,
    recipient_member_id     text NOT NULL,
    seq                     bigint GENERATED ALWAYS AS IDENTITY,
    topic                   text NOT NULL,
    payload                 jsonb NOT NULL DEFAULT '{}',
    entity_id               text,
    match_id                text,
    acknowledged_state      text,
    acknowledged_at         timestamptz,
    suppression_reason      text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT signals_pkey PRIMARY KEY (id),
    CONSTRAINT signals_seq_unique UNIQUE (seq),
    CONSTRAINT signals_topic_check CHECK (length(btrim(topic)) > 0),
    CONSTRAINT signals_entity_fkey
        FOREIGN KEY (entity_id) REFERENCES app.entities(id),
    CONSTRAINT signals_ack_state_check CHECK (
        acknowledged_state IS NULL
        OR acknowledged_state IN ('processed', 'suppressed')
    ),
    CONSTRAINT signals_suppression_check CHECK (
        (acknowledged_state = 'suppressed' AND suppression_reason IS NOT NULL)
        OR (acknowledged_state IS DISTINCT FROM 'suppressed')
    )
);

CREATE INDEX signals_recipient_poll_idx
    ON app.signals (recipient_member_id, club_id, seq)
    WHERE acknowledged_state IS NULL;

CREATE INDEX signals_match_idx
    ON app.signals (match_id)
    WHERE match_id IS NOT NULL;
```

**Why `acknowledged_state` instead of `acknowledged boolean`**: The current inbox acknowledgement path in `src/postgres.ts` only flips a boolean and synthesizes receipt objects in memory -- it does not persist `processed` vs `suppressed` state. For signals, we want durable analytics: did the agent act on this signal, or suppress it? This data is essential for tuning match quality and similarity thresholds. If 80% of `signal.introduction` signals are suppressed, the threshold is too loose. If 95% of `signal.ask_match` signals are processed, the threshold might be too tight. A bare boolean discards this information.

### NOTIFY trigger

The trigger reuses the existing `updates` NOTIFY channel:

```sql
CREATE FUNCTION app.notify_member_signal() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('updates', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER signals_notify
    AFTER INSERT ON app.signals
    FOR EACH ROW EXECUTE FUNCTION app.notify_member_signal();
```

**Known tradeoff**: The `MemberUpdateNotifier` (`src/member-updates-notifier.ts`) filters `updates` notifications by `clubId` only, not by `recipientMemberId`. One signal to one member wakes every SSE waiter in that club. Woken waiters re-poll and find nothing new, which is wasted work. This is acceptable at launch (single-node, small clubs). If it becomes a performance concern at scale, extend the notifier to optionally filter by `recipientMemberId` when the notification payload includes it.

### Signal topic conventions

Topics use a dot-separated namespace. All system-generated signals use the `signal.` prefix:

- `signal.ask_match` -- an ask entity matches this member's profile
- `signal.offer_match` -- a service/opportunity matches an ask this member posted
- `signal.introduction` -- this member and another member have high profile affinity
- `signal.event_suggestion` -- an upcoming event aligns with this member's interests
- `signal.subscription_expiring` -- billing lifecycle
- `signal.content_removed` -- moderation action
- `signal.admission_update` -- a sponsored applicant changed status
- `signal.waitlist_promoted` -- a spot opened up at an event

New signal topics can be added by any producer without schema changes. The agent interprets the topic and payload; the transport doesn't care about semantics. This is the extensibility point: future features add new topics, not new tables.

### Payload design

Payloads are structured JSON designed for the member's agent, not for direct human display. They must contain:
- **What happened** -- the fact that triggered this signal
- **Why this member** -- the reason this specific member was targeted
- **Enough context to act** -- entity IDs, member IDs, display names, so the agent can take action (send a DM, RSVP, fetch more detail) without additional lookups
- **Match metadata** -- scores, when applicable

The agent on the other end decides how and whether to present each signal to the human. The platform provides the signal; the agent decides the moment. This separation is fundamental: ClawClub generates the intelligence, the agent applies the judgment.

Example payloads are shown in the "Signal payloads" section.

---

## Primitive 2: Compound Update Cursor

### Why this is necessary

The current update cursor encodes two values: `activity.seq` (for activity) and a timestamp (for inbox). Adding a third source with its own independent sequence (`signals.seq`) breaks this model. The signal seq and activity seq are independent identity-generated columns on different tables -- their values have no relationship.

### Design

The cursor format changes from `{ s: activitySeq, t: inboxTimestamp }` to:

```typescript
type UpdateCursor = {
  a: number;        // activity.seq high-water mark
  s: number;        // signals.seq high-water mark
  t: string;        // inbox timestamp high-water mark
};
```

Each source tracks its own position independently. On each poll:
- Activity entries are fetched where `seq > cursor.a`
- Signal entries are fetched where `seq > cursor.s`
- Inbox entries are fetched where `created_at > cursor.t`

The cursor is base64url-encoded JSON, same as today. The existing `encodeCursor` / `decodeCursorSeq` / `decodeCursorTimestamp` helpers are replaced with a single `encodeCursor` / `decodeCursor` pair.

**Backward compatibility**: If a client sends an old-format cursor (only `s` and `t`), treat `s` as the activity position and default the signal position to 0 (returns all unacknowledged signals on first poll -- correct upgrade behavior).

**`streamSeq` semantics**: The existing `PendingUpdate.streamSeq` field is already source-relative (activity items use their seq, inbox items use a timestamp-derived value). With three independent sources, `streamSeq` is explicitly *not* a global total order. Clients must treat `updateId` + cursor as the replay primitive, not `streamSeq`. The cursor is authoritative.

### `getLatestCursor` update

The server uses `repository.getLatestCursor` in two places:
- `GET /updates?after=latest` (`src/server.ts:389-390`)
- `GET /updates/stream` bootstrap (`src/server.ts:482-486`)

This method must return a compound cursor seeded from `max(seq)` of both `activity` and `signals`, plus `now()` for the inbox timestamp.

### Feed ordering and limiting

The current merged feed is already only loosely ordered: `listMemberUpdates` fetches `limit` rows from each source and concatenates them unsorted. Adding signals the same way means `limit` is per source, not global.

This is acceptable because:
- The feed is append-only and clients dedupe by `updateId`
- Clients process all returned items regardless of order
- The at-least-once replay contract tolerates duplicates

If strict ordering is needed later, the composition layer can merge-sort all result sets by `createdAt` and apply a single global limit. But that is a separate improvement.

---

## Primitive 3: Similarity Queries

### What it is

Worker-side helper functions that find members or entities similar to a given member or entity, using embedding vectors that already exist in `profile_embeddings` and `entity_embeddings`.

### Where these live

New file: `src/workers/similarity.ts`. These are worker-side helpers, not repository methods. They have no API surface and are not wired into the action registry. They are designed to be reusable by any worker that needs similarity queries, not just the synchronicity worker.

### Scope constraint: no cross-club matching

All similarity queries are scoped to a single club. ClawClub never leaks membership across clubs. A member's ask in DogClub must not be matched against a profile visible only through CatClub, even if the target member is in both. Each club is a closed context.

All member-scoped queries join through `accessible_memberships` (not bare `memberships`). This matches the current product model where member visibility is gated by active membership + valid subscription (`db/init.sql`).

### Methods

**`findMembersMatchingEntity`**: Given an entity (ask, opportunity, service), find members whose profiles are semantically similar.

Step 1 -- load entity vector:
```sql
select ee.embedding
from app.entity_embeddings ee
join app.current_entity_versions cev
  on cev.entity_id = ee.entity_id and cev.state = 'published'
where ee.entity_id = $1
order by ee.created_at desc
limit 1
```

Step 2 -- query for similar profiles, scoped to accessible club members:
```sql
select pe.member_id, min(pe.embedding <=> $1::vector) as distance
from app.profile_embeddings pe
join app.accessible_memberships am
  on am.member_id = pe.member_id
  and am.club_id = $2
where pe.member_id <> $3
group by pe.member_id
order by distance asc
limit $4
```

**`findSimilarMembers`**: Given a member, find other members in the same club with similar profiles.

Step 1 -- load member's profile vector:
```sql
select pe.embedding
from app.profile_embeddings pe
where pe.member_id = $1
order by pe.updated_at desc
limit 1
```

Step 2 -- query for similar profiles in the same club (same query shape as above, different source vector).

**`findAskMatchingOffer`**: Given a new service/opportunity entity, find existing *ask* entities in the same club that it could fulfil. This is entity-to-entity matching.

Step 1 -- load offer entity vector (same as `findMembersMatchingEntity` step 1).

Step 2 -- query for similar ask entities:
```sql
select ee.entity_id,
       cev.author_member_id,
       min(ee.embedding <=> $1::vector) as distance
from app.entity_embeddings ee
join app.current_entity_versions cev
  on cev.entity_id = ee.entity_id and cev.state = 'published'
join app.entities e on e.id = ee.entity_id
where e.club_id = $2
  and e.kind = 'ask'
  and e.id <> $3
group by ee.entity_id, cev.author_member_id
order by distance asc
limit $4
```

The result includes `author_member_id` -- the worker signals the ask's author, not the offer's author.

**Why `findAskMatchingOffer` instead of `findEntitiesMatchingMember`**: The product intent of offer matching is "this new offer satisfies an existing ask." That's entity-to-entity similarity, not profile-to-entity. Using profile similarity would find entities that match the member's *identity*, not their *request*. A member who is a biotech expert and posts an ask for a plumber should not receive a match to their own ask when someone posts a biotech service.

### Interaction filtering for introductions

To avoid introducing members who already know each other, the worker batch-loads existing DM thread pairs. Threads store canonical member ordering (`member_a_id < member_b_id`, `src/messages/index.ts:109-110`). The worker batch-checks using `unnest`:

```sql
select member_a_id, member_b_id
from app.threads
where archived_at is null
  and (member_a_id, member_b_id) in (
    select * from unnest($1::text[], $2::text[])
  )
```

Where `$1` and `$2` are parallel arrays of canonically-ordered member ID pairs. This is a single query per batch, compatible with `node-postgres` bind semantics.

Future enhancement: also consider shared event attendance (both RSVP'd `yes` to the same event) as a signal of existing connection.

---

## Primitive 4: Match Lifecycle Table

### What it is

A reusable table for tracking background member-targeted match computations. It serves two purposes:
1. **Deduplication** -- prevents suggesting the same match twice
2. **Lifecycle tracking** -- records whether a match was delivered and enables analytics

The scope is deliberately specific: every match targets a member. This is not a universal matching substrate for arbitrary object pairs -- it is a primitive for "the system computed that member X should know about thing Y." That scope covers all current and foreseeable recommendation use cases (synchronicity, digest highlights, billing nudges, moderation notifications) without pretending to solve a more general problem. If a future system needs non-member-targeted matching, it should have its own table rather than forcing `background_matches` into a shape it wasn't designed for.

### Why this is separate from signals

`signals` is the delivery channel -- it carries the notification. The match table is the computation state -- it tracks whether a match was computed, whether it was worth delivering, and links to the signal that delivered it.

Without this separation:
- Restarting a worker would re-compute and re-deliver all matches
- There would be no way to track match quality (what percentage of matches are suppressed?)
- There would be no way to distinguish "never matched" from "matched but dismissed"

### Migration

```sql
CREATE TABLE app.background_matches (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text NOT NULL,
    match_kind              text NOT NULL,
    source_id               text NOT NULL,
    target_member_id        text NOT NULL,
    score                   double precision NOT NULL,
    state                   text NOT NULL DEFAULT 'pending',
    payload                 jsonb NOT NULL DEFAULT '{}',
    signal_id               text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    delivered_at            timestamptz,
    expires_at              timestamptz,

    CONSTRAINT background_matches_pkey PRIMARY KEY (id),
    CONSTRAINT background_matches_state_check CHECK (
        state IN ('pending', 'delivered', 'expired')
    ),
    CONSTRAINT background_matches_unique
        UNIQUE (match_kind, source_id, target_member_id),
    CONSTRAINT background_matches_signal_fkey
        FOREIGN KEY (signal_id) REFERENCES app.signals(id)
);

CREATE INDEX background_matches_pending_idx
    ON app.background_matches (state, created_at)
    WHERE state = 'pending';

CREATE INDEX background_matches_expires_idx
    ON app.background_matches (expires_at)
    WHERE expires_at IS NOT NULL AND state = 'pending';
```

Note: no CHECK constraint on `match_kind` values. New match kinds can be added by any worker without a migration. The `match_kind` is a free-text identifier chosen by the producing worker. Current kinds:
- `ask_to_member` -- an ask matched a member's profile
- `offer_to_ask` -- a service/opportunity matched an existing ask
- `member_to_member` -- two members have high profile affinity
- `event_to_member` -- an event aligns with a member's interests

### State machine

```
pending ──> delivered    (signal written to signals)
pending ──> expired      (TTL passed, source removed, or superseded)
```

The `(match_kind, source_id, target_member_id)` unique constraint prevents duplicates. If a member updates their profile and a new match is computed for the same source entity, the constraint prevents a second row. The original match stands until it expires or is delivered.

---

## Primitive 5: Match Workers

### What it is

Background processes that detect triggers, compute matches, and deliver signals. The first worker is the synchronicity worker, but the infrastructure is designed for any number of workers.

### Architecture: shared runner + specific workers

```
src/workers/
  runner.ts              shared worker lifecycle
  similarity.ts          vector similarity helpers
  embedding.ts           embedding worker
  embedding-backfill.ts  backfill script
  synchronicity.ts         synchronicity matching worker (new)
```

Each worker implements a single function: `process(pool) -> number` (returns count of items processed). The runner handles everything else.

### Synchronicity worker: trigger detection

The worker uses two trigger sources, because entity publications and profile updates emit through different mechanisms.

**Source A: Club activity** (entity-triggered matching)

Polls `activity` for new entity publications:
```sql
select seq, club_id, entity_id, topic, payload, created_by_member_id
from app.activity
where seq > $1 and topic = 'entity.version.published'
order by seq asc limit $2
```

High-water mark: `activity.seq`, persisted in `worker_state` (see below).

**Source B: Profile embedding completion** (introduction-triggered matching)

Polls for newly completed or updated profile embeddings:
```sql
select member_id, updated_at
from app.profile_embeddings
where (updated_at, member_id) > ($1, $2)
order by updated_at asc, member_id asc
limit $3
```

High-water mark: `(updated_at, member_id)` pair, persisted in `worker_state`. A timestamp alone is not a safe cursor (rows can share timestamps). The query uses row-value comparison `(updated_at, member_id) > ($1, $2)` so the tie-breaker is honored in the filter, not just in storage.

This depends on the `updated_at` column added to artifact tables in Phase 0. The `insertProfileArtifact` in `src/workers/embedding.ts` upserts in place without advancing any timestamp, so without `updated_at`, later profile changes would be invisible to the synchronicity worker.

**Shard coordination**: Profile data is global (not sharded), so the profile artifact change stream is global too. If we run one synchronicity worker per shard, every shard-local worker independently scans the same global profile change stream. This is an explicit design choice: each worker filters the global profile changes to members who have memberships in its shard's clubs. The profile-side scan is read-only and cheap (a small indexed query), so N workers scanning the same stream is acceptable. The alternative -- a single coordinator that fans out profile changes to per-shard queues -- adds a coordination point that is not justified at current scale.

### Synchronicity worker: matching logic

**Ask published** (Source A, entity kind = `ask`):
1. Run `findMembersMatchingEntity` -- find members whose profiles are similar to the ask
2. For each result above the similarity threshold, insert `(match_kind='ask_to_member', source_id=askEntityId, target_member_id=memberId)` into `background_matches`
3. Skip on unique constraint violation (already matched)

**Service/opportunity published** (Source A, entity kind = `service` or `opportunity`):
1. Run `findAskMatchingOffer` -- find ask entities similar to the new offer
2. For each matching ask above threshold, insert `(match_kind='offer_to_ask', source_id=offerEntityId, target_member_id=askAuthorMemberId)`
3. Skip on unique constraint violation

**Introduction matching** (trigger → recompute queue → match):

Introductions use a different model from entity-triggered matching. Triggers never send signals directly. They mark a `(member_id, club_id)` pair as dirty for recomputation. A separate recompute step processes the dirty set and produces matches.

**Triggers** (any of these marks a pair dirty):
- Primary: profile embedding completion/update (Source B — `updated_at` on profile artifacts)
- Secondary: member becomes newly accessible in a club via `accessible_memberships` (new membership, subscription activated)
- Backstop: periodic sweep for repair/reconciliation only, not primary discovery

**Recompute queue** (`recompute_queue` table or dirty-set, added in Phase 4):
- Key: `(member_id, club_id)` — one pending recompute per pair, deduplicated
- Newly accessible members get a warm-up delay before recompute (e.g., 24 hours) to let them fill out their profile before matching
- Small profile edits should not fan out repeated work — the dirty-set deduplicates naturally
- New members joining only enqueue recomputation for the new member, never a broadcast to the whole club

**Recompute step** (processes dirty set):
1. Claim dirty `(member_id, club_id)` pairs
2. Run `findSimilarMembers` for each
3. Batch-check existing DM threads
4. Filter out pairs with existing threads
5. Filter out pairs with existing `member_to_member` matches (delivered or pending)
6. Insert new match rows for qualifying pairs above threshold

**Introduction identity and dedup**:
- `match_kind = 'member_to_member'`
- `source_id = other_member_id` (the person being introduced)
- `target_member_id = recipient_member_id`
- The unique constraint `(match_kind, source_id, target_member_id)` means a member never receives the same introduction twice
- Pending matches should be expired/invalidated if a DM thread now exists or either member is no longer accessible in that club

**Introduction-specific delivery rules**:
- Stricter caps than general signals: 1/day or 2/week per member (configurable)
- Best-first delivery only (lowest cosine distance first)
- Introduction caps are separate from general signal caps

**Event suggestion** (periodic, e.g., every 6 hours):
1. Query events with `starts_at` within 48 hours and remaining capacity
2. For each event, run `findMembersMatchingEntity`
3. Filter out members with existing RSVPs (any state)
4. Filter out members with existing `event_to_member` matches for this event
5. Insert match rows

### Synchronicity worker: delivery

After computing matches, the worker delivers pending ones:

```sql
select id, club_id, match_kind, source_id, target_member_id, score, payload
from app.background_matches
where state = 'pending'
  and (expires_at is null or expires_at > now())
order by score asc, created_at asc
limit $1
for update skip locked
```

Note: results ordered by `score asc` (lower distance = better match). Best matches are delivered first within the throttle budget.

For each pending match:
1. **Throttle check**: Count signals delivered to this member, scoped by match kind and time window. Different match kinds can have different caps (e.g., introductions: 1/day or 2/week; ask matches: 3/day). Skip if over the cap. The match stays `pending` for the next cycle.
2. **Validity check**: Verify the match is still valid (source entity still published, both members still accessible in the club, no DM thread created since match was computed). Expire invalid matches.
3. **Enrich payload**: Look up member names and entity details. Build the signal payload.
4. **Write signal**: Insert into `signals` with the appropriate topic and payload.
5. **Transition match**: Set `state = 'delivered'`, `delivered_at = now()`, `signal_id = <new signal ID>`.

### Cost analysis at scale

**Current state: no ANN indexes.** The existing embedding migrations (`db/migrations/0001_init.sql`) create only B-tree indexes on version/ID columns. There are no pgvector ANN indexes (IVFFlat, HNSW) on the embedding columns. All `<=>` similarity queries currently do exact brute-force scans.

**Performance at current scale (brute-force):**

For a club with 500 members and 20 new entities/day:

- **Ask/offer matching** (20 entities * 1 similarity query each): Each query scans ~500 profile embeddings (1536 dims). Exact scan of 500 vectors at 1536 dims takes ~1-5ms per query on modern hardware. 20 queries total: <100ms. Fine without an index.
- **Introduction recompute** (triggered by dirty-set, not exhaustive sweep): only processes members whose profiles changed or who are newly accessible. Typical daily volume is ~5-20 dirty members, not 500. Each recompute runs one similarity query (~500 vectors). Total: <100ms. The periodic backstop sweep is infrequent (weekly) and only for repair.
- **Event suggestions** (every 6 hours, ~5 events): Negligible.
- **LLM calls**: Zero. All matching is pgvector SQL.
- **Embedding calls**: Zero additional. The existing embedding worker maintains all vectors.

**When ANN indexes become necessary:**

At ~2,000-5,000 members per club, brute-force scans start taking noticeable time (introduction sweep of 5,000 members * 5,000-vector scan each = ~25M distance computations). At this scale, add HNSW indexes:

```sql
-- Phase 0 or when a club approaches 2,000 members
CREATE INDEX profile_embeddings_hnsw_idx
    ON app.profile_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX entity_embeddings_hnsw_idx
    ON app.entity_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

HNSW is preferred over IVFFlat because it does not require periodic re-training and handles incremental inserts well, which matches the append-driven embedding pipeline.

**Decision**: Do not add ANN indexes in Phase 0. The current club sizes do not need them, and adding them prematurely increases write overhead (HNSW indexes are maintained on every insert/update). Add them reactively when a club crosses the ~2,000 member threshold, or proactively in a later phase if growth trends warrant it. The similarity queries in Primitive 3 work identically with or without ANN indexes -- the index is transparent to the SQL.

The introduction sweep is the operation most sensitive to scale. For very large clubs (5,000+), even with HNSW the sweep generates substantial work. Mitigations:
- Run introduction sweeps less frequently (weekly instead of daily)
- Sample members rather than exhaustive sweep (e.g., 500 random members per cycle)
- Only re-evaluate members whose profile embeddings changed since the last sweep
- Log sweep duration per club and alert if it exceeds a threshold

### Worker state persistence

```sql
CREATE TABLE app.worker_state (
    worker_id       text NOT NULL,
    state_key       text NOT NULL,
    state_value     text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT worker_state_pkey PRIMARY KEY (worker_id, state_key)
);
```

This is generic -- any worker stores key-value state here. The synchronicity worker stores:
- `('synchronicity', 'activity_seq')` -- last processed `activity.seq`
- `('synchronicity', 'profile_artifact_at')` -- last processed profile artifact `updated_at`
- `('synchronicity', 'profile_artifact_member_id')` -- tie-breaker for timestamp cursor
- `('synchronicity', 'introduction_sweep_at')` -- last introduction sweep timestamp
- `('synchronicity', 'event_sweep_at')` -- last event suggestion sweep timestamp

### Configuration

Environment variables:
- `DATABASE_URL`
- `SYNCHRONICITY_POLL_INTERVAL_MS` (default: 30000)
- `SYNCHRONICITY_SIMILARITY_THRESHOLD` (default: TBD, needs tuning)
- `SYNCHRONICITY_MAX_SIGNALS_PER_DAY` (default: 3)
- `SYNCHRONICITY_INTRODUCTION_INTERVAL_MS` (default: 86400000)
- `SYNCHRONICITY_EVENT_WINDOW_HOURS` (default: 48)

---

## Worker management

### Problem

Worker scripts are currently scattered in `src/` with no shared infrastructure for lifecycle, health, or graceful shutdown. Each worker reimplements pool setup, signal handling, and the poll-sleep loop. This doesn't scale as more workers are added.

### Design: `src/workers/` with shared runner

```
src/workers/
  runner.ts              shared worker lifecycle
  similarity.ts          vector similarity helpers
  embedding.ts           embedding worker
  embedding-backfill.ts  backfill script
  synchronicity.ts         synchronicity worker (new)
```

### Shared runner (`runner.ts`)

Provides:

1. **Pool management**: Creates and tears down the DB pool from `DATABASE_URL`.

2. **Graceful shutdown**: Listens for `SIGTERM`/`SIGINT`, sets a flag, waits for the current cycle to complete, closes pools, exits cleanly.

3. **Health endpoint**: Minimal HTTP server on `WORKER_HEALTH_PORT`. Returns 200 if the loop is running. Railway and systemd use this for liveness checks and auto-restart.

4. **Loop harness**: Standard poll-sleep loop:

```typescript
export async function runWorkerLoop(
  name: string,
  pool: Pool,
  processFn: (pool: Pool) => Promise<number>,
  opts: { pollIntervalMs: number; healthPort?: number },
): Promise<void>;

export async function runWorkerOnce(
  name: string,
  pool: Pool,
  processFn: (pool: Pool) => Promise<number>,
): Promise<void>;
```

5. **One-shot mode**: `--once` flag runs a single pass and exits. Used for testing, manual runs, and cron-triggered work.

### Adding a new worker

Adding a future worker (e.g., billing notifications, digest generation) is:
1. Create `src/workers/my-worker.ts`
2. Import `runWorkerLoop` from `runner.ts`
3. Implement `async function process(pool: Pool): Promise<number>`
4. Call `runWorkerLoop('my-worker', pool, process, { pollIntervalMs: N })`

The runner handles pool setup, shutdown, health checks, and error recovery. The worker only implements its processing logic.

### npm scripts

```json
{
  "worker:embedding": "node --experimental-strip-types src/workers/embedding.ts",
  "worker:synchronicity": "node --experimental-strip-types src/workers/synchronicity.ts"
}
```

### Deployment

Each worker runs as a separate Railway service with its own health check endpoint. Railway's restart policy handles crash recovery. For local development, workers are started manually as needed.

---

## Signal payloads

Structured JSON designed for machine interpretation, not human display. The agent decides how and whether to present each signal.

### `signal.ask_match`

Sent to a member whose profile suggests they can help with someone's ask.

```json
{
  "kind": "ask_match",
  "askEntityId": "ent_abc123",
  "askTitle": "Looking for someone in biotech",
  "askSummary": "I need an intro to someone working in biologics manufacturing...",
  "askAuthor": {
    "memberId": "mem_xyz789",
    "publicName": "Sarah Chen",
    "handle": "sarah"
  },
  "matchScore": 0.82
}
```

### `signal.offer_match`

Sent to a member who posted an ask, when a new service/opportunity matches it.

```json
{
  "kind": "offer_match",
  "offerEntityId": "ent_def456",
  "offerKind": "service",
  "offerTitle": "Spare desk in Shoreditch 3 days/week",
  "offerAuthor": {
    "memberId": "mem_uvw321",
    "publicName": "James Hall",
    "handle": "james"
  },
  "yourAskEntityId": "ent_ghi789",
  "yourAskTitle": "Looking for coworking space in East London",
  "matchScore": 0.79
}
```

### `signal.introduction`

Sent to a member when the system identifies another member with high profile affinity and no prior interaction.

```json
{
  "kind": "introduction",
  "otherMember": {
    "memberId": "mem_abc456",
    "publicName": "James Park",
    "handle": "james-park"
  },
  "matchScore": 0.88
}
```

### `signal.event_suggestion`

Sent to a member when an upcoming event has aligned attendees and remaining capacity.

```json
{
  "kind": "event_suggestion",
  "eventEntityId": "ent_evt123",
  "eventTitle": "Thursday dinner at Rochelle Canteen",
  "startsAt": "2026-04-09T19:00:00Z",
  "spotsRemaining": 1,
  "alignedAttendees": [
    {
      "memberId": "mem_att1",
      "publicName": "Sarah Chen"
    }
  ],
  "matchScore": 0.85
}
```

Note: `matchContext` is absent from v1 payloads. The receiving agent has enough information (entity IDs, member IDs) to fetch full details and form its own judgment about why the match matters. LLM-generated context explanations are deferred to a future phase, after we have data on whether agents need them.

---

## How features compose from primitives

| Feature | Primitives used | Trigger |
|---------|----------------|---------|
| Ask matching | 1 + 2 + 3 + 4 + 5 | New ask published (activity) |
| Offer matching | 1 + 2 + 3 + 4 + 5 | New service/opportunity published (activity) |
| Introductions | 1 + 2 + 3 + 4 + 5 | Profile embedding update (identity) + periodic sweep |
| Event suggestions | 1 + 2 + 3 + 4 + 5 | Periodic (approaching events) |
| Subscription expiring | 1 + 2 only | Billing code inserts a signal row |
| Content removed | 1 + 2 only | Moderation code inserts a signal row |
| Admission status change | 1 + 2 only | Admission transition inserts a signal row |
| Waitlist promotion | 1 + 2 only | RSVP logic inserts a signal row |

The first four features require all five primitives. Every other notification needs only Primitives 1+2 (signal table + compound cursor). This is the leverage: the transport is done once and every future producer is just an insert.

---

## Implementation order

### Phase 0: Prerequisites

1. Canonicalize embedding artifact schema: update migrations to match code-style columns (`member_id`, `entity_id`, `profile_version_id`, `embedding`). Add `updated_at` column to both artifact tables, set on upsert.
2. Create `src/workers/` directory and `runner.ts` with shared lifecycle (pools, shutdown, health, loop harness).
3. Verify all existing tests pass.

### Phase 1: Member Signals + Compound Cursor (Primitives 1 + 2)

1. Write migration: `signals` table, NOTIFY trigger, `worker_state` table.
2. Add `'signal'` to `PendingUpdate.source` type in `src/contract.ts`.
3. Update `pendingUpdate` Zod schema in `src/schemas/responses.ts`.
4. Refactor cursor encode/decode to compound format (backward-compatible).
5. Add signals query to `listMemberUpdates` in `src/postgres.ts`.
6. Update `getLatestCursor` to seed compound cursor from both `activity` and `signals`.
7. Extend `acknowledgeUpdates` to handle `signal:` prefixed IDs with durable state.
8. Integration tests: signal in `updates.list`, acknowledgement (processed + suppressed), cursor independence, SSE wake-up, backward-compatible cursor parsing.

### Phase 2: Similarity Queries (Primitive 3)

1. Create `src/workers/similarity.ts` with `findMembersMatchingEntity`, `findSimilarMembers`, `findAskMatchingOffer`.
2. Integration tests: seed known embeddings, verify ranking, verify club scoping, verify `accessible_memberships` filtering.

### Phase 3: Match Lifecycle Table (Primitive 4)

1. Write migration: `background_matches` table.
2. Add repository helpers for creating matches (with upsert/skip on conflict), transitioning state, expiring old matches.
3. Tests: deduplication, state transitions, expiration.

### Phase 4: Synchronicity Worker (Primitive 5)

1. Create `src/workers/synchronicity.ts` using the shared runner.
2. Implement dual trigger detection (activity + profile embeddings with `updated_at`).
3. Implement ask matching and offer matching (entity-triggered).
4. Implement introduction matching (profile-triggered + periodic sweep) with batch DM thread filtering.
5. Implement event suggestion matching (periodic).
6. Implement delivery step with throttling.
7. Integration tests against a real database.
8. Add npm scripts and deployment config.

### Phase 5 (future): Match Context Generation

After the system has been running and we have data on signal processed/suppressed rates:
1. Evaluate whether agents need richer context than entity IDs + match scores.
2. If yes, add optional LLM-generated context to the delivery step. Call `gpt-5.4-nano` with both source texts and ask for a one-sentence explanation.
3. Only generate context for matches that pass the threshold and will be delivered (never speculatively).
4. Log cost per context generation in `llm_usage_log`.

---

## Testing strategy

Every primitive must have its own integration tests that run against real Postgres databases, following the existing test harness pattern (`test/integration/harness.ts`).

### Primitive 1 tests
- Insert a signal via direct SQL, verify it appears in `updates.list` with `source: 'signal'`
- Acknowledge with `processed`, verify durable state
- Acknowledge with `suppressed` + reason, verify durable state
- Verify acknowledged signals don't reappear
- Verify NOTIFY wakes SSE

### Primitive 2 tests
- Parse old-format cursor, verify backward compatibility
- Round-trip compound cursor, verify all three positions preserved
- Verify activity and signal cursors advance independently
- Verify `getLatestCursor` returns compound format

### Primitive 3 tests
- Seed known profile and entity embeddings
- Verify `findMembersMatchingEntity` returns correct ranking
- Verify club scoping (member in wrong club not returned)
- Verify `accessible_memberships` filtering (inactive subscription excluded)
- Verify `findAskMatchingOffer` returns asks, not other entity kinds
- Verify self-exclusion (author not matched to own entity)

### Primitive 4 tests
- Insert match, verify state = `pending`
- Insert duplicate, verify unique constraint skip
- Transition to `delivered`, verify `delivered_at` set
- Transition to `expired`, verify state
- Verify pending index is used (explain analyze)

### Primitive 5 tests
- Publish an ask, run one worker cycle, verify match created and signal delivered
- Publish a service, verify offer-to-ask match finds the right ask
- Update a profile, verify introduction candidates computed
- Verify throttling: exceed daily cap, verify match stays pending
- Verify expiration: old pending match transitions to expired

---

## Open questions

### Similarity threshold

What cosine distance qualifies as "close enough"? This needs empirical tuning. Start conservative (only very strong matches) and relax based on signal acknowledgement data. The `acknowledged_state` field on signals gives us the data: if `processed` rate is >80%, the threshold might be too tight. If `suppressed` rate is >40%, it's too loose.

### Match context generation

Deferred to Phase 5. Start without it. The agent has entity IDs and member IDs in the payload -- it can fetch full details and form its own context. If agents consistently struggle to explain matches to humans, add LLM-generated one-liners. But only after we have evidence it's needed, and only for delivered matches (never speculatively).

### Profile location field

Several features benefit from knowing where members are. No location field exists on profiles today. Not blocking for v1 -- location text in profiles ("London-based") has some embedding signal. A dedicated field can be added later if location-aware matching proves valuable.
