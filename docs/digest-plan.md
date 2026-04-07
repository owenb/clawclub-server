# Digest System: "Read the Room"

Server-side relevance filtering and summarization for agent-first consumption. The server decides **what matters** for a given member; the member's agent decides **how to say it**.

## Context and motivation

ClawClub is agent-first. Agents are the primary API consumers. When a member asks their agent "what's been happening?" or "catch me up", the agent needs structured, relevance-ranked data — not a raw firehose of every message or post.

This matters at two scales:

- **Single club**: A member returns after a few days. The club has had 200 new posts, 15 events, and 40 comments. Surface the 5 things that matter to them.
- **Cross-club**: A member belongs to 20 clubs. Across all of them there are thousands of new items. Surface the 10-15 things worth knowing about right now, normalised so quiet clubs aren't drowned by noisy ones.

The system must work when there are hundreds of thousands of clubs, millions of members, and tens of millions of content items.

## Design principles

1. **No per-member fanout.** Club-level work is done once and shared across all members. Personalisation happens at read time, not write time. This follows the `club_activity` precedent.

2. **Structured output, not prose.** The server returns structured JSON with entity/member references, relevance signals, and topic metadata. Agents synthesise prose in their own voice. An optional `pulse` field carries a short club-level summary for vibe, but highlights are structured.

3. **Shard-compatible from day one.** Club-level summaries live on the club shard. Cross-club merge happens on the query/control plane. References resolve against current state at read time, so redacted/archived content silently drops.

4. **Embeddings are the primary relevance signal.** Member profile embeddings and entity embeddings already exist in the same vector space. Nearest-neighbor queries handle "what's relevant to this person" without per-request LLM calls.

5. **LLM calls are amortised background work.** The only LLM usage is the background worker producing topic labels and vibe summaries for rollups. Per-member digest requests involve zero LLM calls — just database queries and scoring math.

6. **Deterministic extraction first, LLM only for semantics.** Entity references, stats, active members, upcoming events, and open loops are all computed from SQL over the activity window. The LLM is only used for topic labeling (semantic clustering of what the window was "about") and the optional one-line vibe summary. This makes rollups cheaper, reproducible, and trustworthy.

7. **Rollups preserve all candidates, personalisation prunes.** Rollups store every entity ref in the window (up to a bounded cap), not an LLM-curated "notable" subset. Editorial choices about what matters to a specific member happen at read time in the ranking layer, not at write time in the rollup. This prevents candidate starvation — the per-member ranker always has a full pool to work with.

---

## Architecture overview

```
                    ┌─────────────────────────────────────┐
                    │         club_activity (existing)     │
                    │   append-only log, one row per event │
                    └──────────────┬──────────────────────┘
                                   │
                         NOTIFY wakes worker
                                   │
                    ┌──────────────▼──────────────────────┐
                    │        digest-worker (new)           │
                    │  claims seq ranges, produces rollups │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │   club_activity_rollups (new table)  │
                    │  per-club structured summaries       │
                    │  keyed by (club_id, from_seq, to_seq)│
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────────┐
              │                    │                        │
    ┌─────────▼──────────┐  ┌─────▼──────────┐  ┌─────────▼──────────┐
    │  club.digest (API) │  │cross-club merge │  │  rollup compaction │
    │  single-club view  │  │  + re-rank      │  │  (background)      │
    └────────────────────┘  └────────────────┘  └────────────────────┘
```

---

## Layer 1: Club-level rollups

### What it is

A background worker processes `club_activity` in windows and produces structured summaries stored in `club_activity_rollups`. One rollup per window per club. No per-member work.

### Schema

```sql
CREATE TABLE app.club_activity_rollups (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    club_id         app.short_id NOT NULL REFERENCES app.clubs(id),
    from_seq        bigint NOT NULL,
    to_seq          bigint NOT NULL,
    event_count     integer NOT NULL,
    -- Structured extraction (the primary output)
    rollup_json     jsonb NOT NULL,
    -- Human-readable one-liner for "pulse" display
    summary_text    text,
    -- Model/version tracking for cache invalidation
    model           text NOT NULL,
    source_version  text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT club_activity_rollups_pkey PRIMARY KEY (id),
    CONSTRAINT club_activity_rollups_range_unique UNIQUE (club_id, from_seq, to_seq),
    CONSTRAINT club_activity_rollups_seq_order CHECK (to_seq >= from_seq)
);

CREATE INDEX club_activity_rollups_club_seq_idx
    ON app.club_activity_rollups (club_id, to_seq DESC);
```

### `rollup_json` structure

The rollup has two distinct sections: **deterministic fields** computed from SQL, and **LLM fields** that require semantic understanding.

```jsonc
{
  "version": 1,
  "period": {
    "from_seq": 48201,
    "to_seq": 48250,
    "from_time": "2026-04-01T10:00:00Z",
    "to_time": "2026-04-01T18:30:00Z"
  },

  // ── DETERMINISTIC (computed from SQL, no LLM) ──────────

  // ALL entities in the window, up to a cap of 100.
  // Not filtered by "importance" — the full candidate pool
  // for downstream per-member ranking.
  "entities": [
    {
      "entity_id": "abc123",
      "entity_version_id": "def456",
      "kind": "ask",
      "topic": "entity.version.published",
      "author_member_id": "mem789",
      "title": "Looking for a ceramics studio in East London"
    }
  ],
  // Members who were active in this window
  "active_member_ids": ["mem789", "mem012"],
  // New members who joined (membership.activated events, when we emit them)
  "new_member_ids": [],
  // Aggregate signals
  "stats": {
    "entity_count": 8,
    "event_count": 2,
    "comment_count": 14,
    "unique_authors": 6
  },
  // Events with approaching deadlines (from entity.kind = 'event' in window)
  "upcoming_events": [
    {
      "entity_id": "evt001",
      "title": "Sunday roast",
      "starts_at": "2026-04-06T12:00:00Z"
    }
  ],
  // Open loops: asks without responses in the window
  "open_loops": [
    {
      "entity_id": "ask002",
      "kind": "ask",
      "title": "Need a venue for 40-person dinner",
      "signal": "unanswered_ask"
    }
  ],

  // ── LLM-DERIVED (semantic extraction) ──────────────────

  // Topic/theme labels — the LLM's only real job
  "topics": ["ceramics", "weekend plans", "east london"]
}
```

Key design decisions:
- **Entity IDs, not content.** Rollups store references. If an entity is later redacted or archived, the read path resolves the reference and silently drops it. No stale prose leakage.
- **All entities, not curated entities.** Rollups store every entity ref in the window up to a hard cap of 100. The LLM does not decide which entities are "notable" — that's the per-member ranker's job at read time. This prevents candidate starvation.
- **Deterministic first.** Stats, active members, upcoming events, and open loops come from SQL aggregation over the activity window. The LLM only handles topic labeling and the optional `summary_text`. If the LLM call fails, the deterministic fields are still written — the rollup is useful without topics.
- **`summary_text` is optional.** A one-liner for the pulse ("Active week — lots of event planning and a few asks"). Prose about specific entities or members should never appear here — only aggregate vibes. Generated by the LLM alongside topic extraction.
- **`model` and `source_version`** allow re-processing rollups when the prompt or model improves, without dropping data.

### Windowing strategy

Hybrid: **up to N events OR M estimated tokens, whichever comes first**, plus a time ceiling so quiet clubs still get summarised. The token budget is the hard constraint — event count is just a soft hint.

- **Token budget (hard cap)**: 12,000 estimated tokens of source content per window. The worker estimates tokens from `club_activity.payload` sizes *before* loading full content, using a deliberately conservative estimator (1 token per 3 characters of JSON payload). If the estimate exceeds the budget, the window is shortened. This prevents blowouts from long entity bodies.
- **Event cap (soft cap)**: 50 events per window. Reached before the token budget in most cases. But a window of 10 long-form posts can hit the token budget at 10 events.
- **Time ceiling**: 24 hours — if a club has had any activity in the last 24h that hasn't been rolled up, process it regardless of event count
- **Minimum gap**: Don't roll up fewer than 3 events unless the time ceiling forces it (avoids micro-rollups for near-silent clubs)

The worker tracks progress via a simple table:

```sql
CREATE TABLE app.digest_worker_progress (
    club_id         app.short_id NOT NULL REFERENCES app.clubs(id),
    last_rolled_seq bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digest_worker_progress_pkey PRIMARY KEY (club_id)
);
```

This is analogous to `club_activity_cursors` but for the worker, not for members. Completely separate concern.

### Worker design

Follows the pattern established by `src/workers/embedding.ts`: a standalone process with a poll loop, `LISTEN/NOTIFY` wakeup, and lease-based claiming.

```
digest-worker.ts
  ├── LISTEN club_activity (existing NOTIFY channel)
  ├── On wake or poll interval:
  │   ├── Find clubs where max(club_activity.seq) > digest_worker_progress.last_rolled_seq
  │   ├── Claim one club at a time (advisory lock on club_id)
  │   ├── Estimate window size from payload sizes (respect token budget)
  │   ├── Load activity window (from last_rolled_seq, bounded by caps)
  │   ├── PASS 1 (SQL): Compute deterministic fields
  │   │     entity refs, stats, active_member_ids, upcoming_events, open_loops
  │   ├── INSERT rollup with deterministic fields (usable immediately)
  │   ├── PASS 2 (LLM): Send titles/summaries to gpt-5.4-nano
  │   │     for topic labels + summary_text
  │   ├── UPDATE rollup with LLM fields (or leave null on failure)
  │   ├── UPDATE digest_worker_progress
  │   └── Log LLM usage via app.log_llm_usage()
  └── Poll interval: 30s (NOTIFY usually wakes it sooner)
```

The two-pass design means rollups are immediately useful even if the LLM is slow, down, or rate-limited. Rollups missing LLM fields are backfilled on the next worker pass (query for rollups where `topics IS NULL`).

Advisory locking (`pg_advisory_xact_lock(hashtext(club_id))`) prevents multiple worker instances from processing the same club simultaneously. Multiple workers can process different clubs in parallel.

### LLM prompt design

The LLM's job is narrow: **topic labeling and vibe summary only.** All structural extraction (entity refs, stats, active members, events, open loops) is done in SQL before the LLM is called. The LLM receives the deterministic fields plus entity titles/summaries as context, and returns only the semantic fields.

```
System: You are labeling the themes of a batch of activity from a private
members club. You will receive a list of entity titles and summaries from the
batch. Your job:

1. Extract 3-5 short topic labels that capture what the club was talking about
   in this batch. Use lowercase phrases, 1-3 words each.

2. Write a single sentence summarizing the overall activity level and theme.
   Do not name specific members or entities. Just the vibe.
   Example: "Active week — mostly event planning and a few asks about venues."

Output JSON: { "topics": [...], "summary_text": "..." }
```

This prompt is cheap (~500-1000 input tokens of titles/summaries, not full bodies) and its output is small. If the LLM call fails, the deterministic rollup fields are still written — the rollup is useful without topic labels. The LLM fields are backfilled on the next worker pass.

Structured output (JSON mode / function calling) ensures parseable results. Failed parses trigger a retry with the same window.

### Cost model

One LLM call per window per club, but the input is now just titles and summaries (not full payloads). Typical input: ~500-1000 tokens of entity titles/summaries + ~100 tokens of prompt. Output: ~100 tokens of topic labels and summary.

At gpt-5.4-nano pricing, this is negligible per-club. Even with 100K active clubs each producing one rollup per day, total daily cost is bounded. And because the deterministic fields don't need the LLM at all, the LLM call can be deferred, batched, or skipped entirely under load without losing rollup utility.

---

## Layer 2: Rollup compaction

Over time, a club accumulates many fine-grained rollups. For "catch me up on the last month" queries, we don't want to load 30+ rollups and merge them client-side.

### Compaction strategy

A background job (same worker, different mode, or a scheduled job) merges adjacent rollups into coarser ones:

- **Daily**: Merge all rollups from a calendar day into one daily rollup
- **Weekly**: Merge 7 daily rollups into one weekly rollup (after 2 weeks)
- **Monthly**: Merge weekly rollups into monthly rollups (after 3 months)

Compacted rollups have the same schema. `from_seq` and `to_seq` span the full range. `rollup_json` is a merged structure — entity lists are deduplicated, topic lists are re-ranked by frequency, stats are summed.

Compaction can be done **without an LLM call** for the structured fields (it's just JSON merging). Only `summary_text` benefits from an LLM re-summarisation at the daily level, and even that is optional.

Fine-grained rollups are retained for 30 days (configurable), then deleted once covered by a compacted rollup. This keeps `club_activity_rollups` bounded.

### Compaction markers

```sql
ALTER TABLE app.club_activity_rollups
    ADD COLUMN granularity text NOT NULL DEFAULT 'window'
        CHECK (granularity IN ('window', 'daily', 'weekly', 'monthly')),
    ADD COLUMN compacted_from_ids app.short_id[] DEFAULT '{}';
```

---

## Relevance ranking (the recommender)

This is the core of personalisation. When a member requests a digest, the server must rank items by relevance to that specific member. No LLM calls — just math.

### Signals

| Signal | Source | Weight | Notes |
|--------|--------|--------|-------|
| **Embedding similarity** | member profile embedding vs entity embedding | High | Already in same vector space. Cosine similarity via pgvector. |
| **Social proximity** | DM history, comment replies, shared RSVP attendance | High | Computed on-demand from existing tables. Lightweight joins. |
| **Recency** | `club_activity.created_at` | Medium | Exponential decay. Recent items score higher. |
| **Engagement volume** | Comment count, RSVP count | Medium | Derivable from rollup stats + on-demand query for top items. |
| **Novelty** | New members, first-time posters, new entity kinds | Low-Medium | Boost items that represent something the member hasn't seen before. |
| **Time urgency** | Events approaching, asks aging without response | Medium | Events within 72h get a deadline boost. Unanswered asks get a freshness bump. |

### Scoring formula (v1, intentionally simple)

```
score = (w_embed * embedding_similarity)
      + (w_social * social_proximity_score)
      + (w_recency * recency_decay(age_hours))
      + (w_engagement * log(1 + engagement_count))
      + (w_urgency * urgency_boost(entity))
```

Weights are code-configured constants, not ML-trained. Tuned by hand from real usage data. Start with embedding similarity as the dominant signal and adjust.

`social_proximity_score` for a given (member, author) pair:
- 1.0 if they've had a DM conversation
- 0.7 if they've replied to each other's entities
- 0.4 if they've attended the same event
- 0.0 otherwise

This is a sparse, on-demand lookup — not a pre-computed graph. At digest time, we know the candidate entity authors (from rollups), so we query the member's interactions with those specific authors. Small, bounded query.

### Embedding similarity at scale

For a single-club digest with thousands of entities, we don't need to scan them all. Rollups store all entity refs from each window (up to 100 per rollup). For a "catch me up on the last week" query covering 5 rollups, the candidate pool is at most 500 entity IDs. We compute embedding similarity only against those candidates — a targeted pgvector query with an `entity_version_id IN (...)` filter, not a full table scan.

For cross-club digests, we run this per-club in parallel, then merge. 20 clubs × ~100 candidates each = ~2000 total candidates, which is still well within pgvector's comfort zone for exact (non-ANN) queries.

If we later need to answer "find me anything in this club's entire history that matches my interests" (the discovery case), that's a pgvector ANN query against `entity_embeddings` — which is what `entities.findViaEmbedding` already does. The digest system doesn't replace it; it complements it for the temporal catch-up case.

---

## Cross-club digest

### The merge problem

A member belongs to 20 clubs. Each club produces ranked highlights. A raw score of 0.82 in a 30-person club means something different from 0.82 in a 5,000-person club.

### Normalisation

**Percentile-based normalisation** (v1):

1. For each club, compute the club's activity baseline: rolling average events/day over the last 30 days (derivable from `digest_worker_progress` and `club_activity_rollups`).
2. Rank items within each club by relevance score.
3. Convert raw ranks to percentiles within each club.
4. Apply cross-club boosts:
   - **Quiet club boost**: Items from clubs with below-median activity get a percentile bump. If a quiet club surfaces something, it's more likely to be genuinely notable.
   - **New membership boost**: Clubs the member joined in the last 14 days get a temporary percentile bump (they're orienting).
   - **Deadline boost**: Events within 72h transcend normalisation — they always surface if the member is a plausible attendee.
   - **Social boost**: Items authored by members the requesting member has DM'd in any club get a cross-club social bump.

5. **Small pool guard**: If a club has fewer than 5 candidate items in the period, skip percentile normalisation entirely — percentile math on 1-2 items is noise. Instead, pass raw scores through with the quiet-club boost applied directly. This prevents a club with one mediocre item from filling a top percentile slot just because it was the only item.

6. Re-rank all items by boosted percentile (or raw boosted score for small pools), take top N.

This ensures every club gets a fair shot at the digest without requiring per-club tuning.

### Fallback for cold-start

When a member just joined a club and has no interaction history there, embedding similarity carries all the weight. Their profile embedding vs entity embeddings in the new club. Social proximity is zero, recency still applies, and the new-membership boost ensures the club isn't invisible.

---

## API design

### Single endpoint

```
POST /api

Action: digest.read
```

### Input

```jsonc
{
  "action": "digest.read",
  // Optional: single-club digest. Omit for cross-club.
  "clubId": "club123",
  // Optional: only items since this cursor. Omit for "everything recent."
  "since": "base64-encoded-digest-cursor",
  // Optional: max items to return. Default 10, max 30.
  "limit": 10,
  // Optional: include the club pulse summary. Default true.
  "includePulse": true
}
```

### Output (single-club)

```jsonc
{
  "action": "digest.read",
  "data": {
    "clubId": "club123",
    "clubName": "London Tech Club",
    "coverage": {
      "fromSeq": 48201,
      "toSeq": 49875,
      "fromTime": "2026-04-01T00:00:00Z",
      "toTime": "2026-04-05T14:30:00Z"
    },

    // Relevance-ranked highlights. Each is a resolved entity.
    "highlights": [
      {
        "entityId": "ask123",
        "entityVersionId": "ver456",
        "kind": "ask",
        "title": "Looking for a ceramics studio in East London",
        "summary": "...",
        "author": {
          "memberId": "mem789",
          "publicName": "Elena K",
          "handle": "elena-k"
        },
        "relevanceScore": 0.87,
        "relevanceSignals": ["embedding_match", "social_proximity"],
        "commentCount": 3,
        "ageHours": 14,
        "createdAt": "2026-04-04T22:30:00Z"
      }
    ],

    // Upcoming events, sorted by start time
    "upcomingEvents": [
      {
        "entityId": "evt001",
        "title": "Sunday roast",
        "startsAt": "2026-04-06T12:00:00Z",
        "location": "The Bleeding Heart, Farringdon",
        "spotsRemaining": 6,
        "capacity": 12,
        // Members the requesting member has interacted with
        "knownAttendees": [
          { "memberId": "mem111", "publicName": "Marcus H", "handle": "marcus-h" }
        ],
        "totalAttendees": 8
      }
    ],

    // People signals
    "notableMembers": [
      {
        "memberId": "mem222",
        "publicName": "New Person",
        "handle": "new-person",
        "reason": "just_joined",
        "joinedAt": "2026-04-04T09:00:00Z",
        // Shared interests derived from embedding similarity
        "sharedInterests": ["ai", "music production"]
      }
    ],

    // Club-level vibe (from rollup summary_text)
    "pulse": {
      "activityLevel": "lively",   // quiet | moderate | lively | very_active
      "itemsSinceLast": 47,
      "uniqueAuthors": 12,
      "summaryText": "Active week. Lots of event planning and a few asks around London venues. Two new members joined.",
      "trendingTopics": ["weekend plans", "london venues", "new members"]
    },

    // Cursor for next request
    "nextCursor": "base64-encoded-digest-cursor"
  }
}
```

### Output (cross-club)

Same shape, but `highlights`, `upcomingEvents`, and `notableMembers` are merged across clubs. Each item includes `clubId` and `clubName`. `pulse` becomes `clubPulses` — an array of one-liner per club.

```jsonc
{
  "data": {
    "coverage": { ... },

    "highlights": [
      {
        "clubId": "club123",
        "clubName": "London Tech Club",
        "entityId": "ask123",
        // ... same fields as single-club
      }
    ],

    "upcomingEvents": [ ... ],

    "notableMembers": [ ... ],

    "clubPulses": [
      {
        "clubId": "club123",
        "clubName": "London Tech Club",
        "activityLevel": "lively",
        "summaryText": "Active week. Event planning and venue asks.",
        "itemsSinceLast": 47
      },
      {
        "clubId": "club456",
        "clubName": "SF Founders",
        "activityLevel": "quiet",
        "summaryText": "Quiet few days. One new member.",
        "itemsSinceLast": 3
      }
    ],

    "nextCursor": "..."
  }
}
```

### Digest cursor

Separate from the `updates.list` transport cursor. The per-club coverage map is stored server-side, not encoded into the API cursor:

```sql
CREATE TABLE app.digest_cursors (
    member_id       app.short_id NOT NULL REFERENCES app.members(id),
    club_id         app.short_id NOT NULL REFERENCES app.clubs(id),
    last_digest_seq bigint NOT NULL DEFAULT 0,
    last_digest_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digest_cursors_pkey PRIMARY KEY (member_id, club_id)
);
```

Updated on each `digest.read` call, per club. This means "I've seen up to here in this club" for digest purposes, completely independent of the transport cursor in `club_activity_cursors`.

**Cross-club cursor handling**: For a cross-club digest, the server reads all `digest_cursors` rows for the member and uses per-club seqs to determine coverage per club. The API `nextCursor` in the response is a lightweight opaque token (e.g., a timestamp or digest-read ID) — it does NOT encode per-club seqs. The server is authoritative on per-club coverage. This keeps the API cursor small and avoids noisy clubs and quiet clubs interfering with each other's progress tracking.

---

## New `club_activity` topics needed

The current `club_activity` only captures entity publish/archive/redact. The digest system benefits from richer signals. These should be added incrementally — the digest works without them, but gets better with them:

### v1 (ship with digest)

No new topics needed. The digest works entirely on existing `entity.version.published`, `entity.version.archived`, `entity.redacted` topics.

### v2 (quick follow-ups)

| Topic | Emitted by | Value for digest |
|-------|-----------|-----------------|
| `event.rsvp.changed` | `rsvpEvent()` in events.ts | "3 people you know are going" |
| `membership.activated` | membership state transitions | "Someone new joined" |
| `membership.departed` | membership state transitions | Absence/churn signals |

### v3 (richer signals)

| Topic | Emitted by | Value for digest |
|-------|-----------|-----------------|
| `entity.comment.published` | comment creation | Engagement volume, "this ask got 5 responses" |
| `event.capacity.low` | derived (RSVP count approaching capacity) | Urgency signal for events |

Each new topic makes rollups richer without changing the rollup schema or worker architecture — they're just more events in the window.

---

## Scaling analysis

### At 100K clubs, 1M members

**Rollup storage**: 100K clubs × ~1 rollup/day × 365 days = ~36.5M rows/year before compaction. After compaction (daily → weekly → monthly), ~5M rows/year. Each row is ~2-5KB of JSONB. Total: ~10-25GB/year. Manageable on a single Postgres.

**Rollup compute**: With the deterministic-first design, the LLM call is cheap — it only receives entity titles and summaries (~500-1000 input tokens per rollup), not full payloads. 100K clubs × 1 LLM call/day at ~1K tokens each = ~100M input tokens/day. But most clubs are inactive on any given day. Realistic daily active clubs: 10-20% of total = 10-20K LLM calls/day, well within budget. Inactive clubs skip the worker entirely — no wasted compute.

**Digest reads**: Member calls `digest.read`. The query:
1. Load rollups covering the period (1-5 rows per club, indexed lookup)
2. Extract candidate entity IDs from rollups (~20-50 per club)
3. Compute embedding similarity for candidates (~1 pgvector query)
4. Compute social proximity for candidate authors (~1 join query)
5. Score + rank (~in-memory, microseconds)
6. Resolve top-N entities to current state (~1 batch query)
7. Load RSVP data for upcoming events (~1 query)

Total: ~5-7 queries, all index-backed, no sequential scans. Sub-100ms for single-club, sub-500ms for 20-club cross-club (parallelised).

**No LLM call on the read path.** This is critical. The cost of a digest read is pure database work.

### At 500K clubs, 10M members (shard split)

Rollup tables live on club shards alongside `club_activity`. The digest worker runs per-shard (or claims clubs across shards).

Cross-club digest reads:
1. Query/control plane resolves member's clubs → shard routing
2. Fan out rollup reads to relevant shards (parallel)
3. Merge + re-rank on the query/control plane
4. Resolve top-N entities by routing back to owning shards

This is exactly the pattern described in the horizontal scaling plan (Tier 5/6). The digest system fits it naturally because rollups are club-scoped and the merge is a lightweight read-time operation.

### Projection to central query plane (optimisation, not required for v1)

For very high-traffic cross-club digests, rollup summaries could be projected to the central query plane (same pattern as the cross-club activity index in the scaling plan). This avoids the shard fan-out on every digest read. The projector writes a denormalised rollup summary row centrally when a new rollup is created on a shard.

---

## Implementation phases

### Phase 1: Foundation (ship first, deliberately minimal)

- `club_activity_rollups` table + migration
- `digest_worker_progress` table + migration
- `digest_cursors` table + migration
- `digest-worker.ts` — rollup producer, following `src/workers/embedding.ts` patterns
  - Deterministic fields only in pass 1 (entity refs, stats, events, open loops from SQL)
  - LLM pass 2 for topic labels + summary_text (gracefully degraded if LLM unavailable)
- `digest.read` action — **single-club only**, no cross-club
- Relevance ranking: **embedding similarity + recency only** (no social graph, no engagement scoring)
- No rollup compaction (fine-grained rollups accumulate; compaction is Phase 3)
- Integration tests in `test/integration/digest.test.ts`

Phase 1 is deliberately narrow so that weak results can be attributed clearly: is it the rollup coverage? The ranking weights? The LLM topic extraction? Each variable is isolated.

**What the agent can do after Phase 1**: "Catch me up on this club" → structured highlights ranked by topic match and recency, upcoming events, club pulse.

### Phase 2: Social + cross-club

- Social proximity scoring (DM history, comment interactions, shared RSVPs)
- Cross-club digest (omit `clubId` in `digest.read`)
- Cross-club normalisation (percentile-based)
- New activity topics: `event.rsvp.changed`, `membership.activated`

**What the agent can do after Phase 2**: "How are things across my clubs?" → merged cross-club digest with social signals. "Three people you know are going."

### Phase 3: Compaction + enrichment

- Rollup compaction (daily/weekly/monthly)
- Retention policy for fine-grained rollups
- Notable members: new joins, unusual quiet, first-time posters
- `entity.comment.published` activity topic
- Refined scoring weights based on real usage data

**What the agent can do after Phase 3**: "Sarah's been quiet — not like her." "Someone new joined who builds AI tools for musicians."

### Phase 4: Scale hardening

- pgvector ANN indexes on embedding artifact tables (if not already added)
- Rollup projection to central query plane (if shard split has happened)
- Digest read caching (short TTL, per-member, invalidated by new rollups)
- Budget enforcement integration (digest LLM calls count against club budget)
- Audit logging for digest reads

---

## Known risks and mitigations

### Profile embedding quality is the silent bottleneck

Embedding similarity is the primary ranking signal, and member profile embeddings are built from whatever the member has written in their bio fields (`tagline`, `summary`, `what_i_do`, `known_for`, `services_summary`). If a member has a sparse profile — or a generic one like "I work in tech" — the embedding is too vague to produce meaningful relevance scores. The digest degrades silently to "basically just recency," which is a glorified reverse-chronological feed.

This is not a reason to delay the feature, but it has consequences:

- **Digest quality will be silently coupled to profile completeness.** Two members in the same club will get very different digest quality based purely on how much they've filled out their profile. This is hard to debug from the outside — the digest looks like it's working, it's just not very good.
- **The admission flow and onboarding should nudge richer profiles.** This is a product concern, not a technical one, but the digest feature creates a strong incentive to get it right. A profile that says "I'm a ceramicist, music producer, and AI researcher based in East London" produces dramatically better embedding matches than "I like making stuff."
- **Social proximity (Phase 2) may end up being the more reliable signal.** For members with thin profiles, "posts by people you've actually talked to" is a stronger signal than "posts about topics that match your vague bio." This is another reason to get Phase 2 shipped quickly after Phase 1.
- **Monitor this explicitly.** When Phase 1 ships, track the distribution of embedding similarity scores in digest results. If a large fraction of members are getting flat, undifferentiated scores, that's the profile quality problem manifesting. Consider a fallback: if a member's profile embedding has low variance against the candidate pool, weight recency and engagement more heavily and weight embedding similarity down.

### Rollup coverage gaps during deploys

When the digest worker restarts (deploy, crash), there's a window where activity accumulates without being rolled up. This is fine — `digest_worker_progress` ensures the worker picks up exactly where it left off. But if the worker is down for hours, the first rollup after recovery may be unusually large. The token budget hard cap handles this: the worker produces multiple sequential rollups to clear the backlog rather than one enormous one.

### Redaction in compacted rollups

Fine-grained rollups store entity IDs and titles. When an entity is redacted, the read path resolves the reference and drops it — clean. But compacted rollups (Phase 3) merge entity lists from multiple windows. A compacted rollup's `stats` (entity_count, comment_count) will include counts from now-redacted entities. This is acceptable: aggregate stats don't leak content, and the alternative (recomputing compacted rollups on every redaction) is expensive for little benefit. The rule is: **no prose about specific entities or members in `summary_text`**, which is already enforced by the LLM prompt. Stats can be stale.

---

## Open questions (to resolve before implementation)

1. **Should `digest.read` be rate-limited differently from other actions?** It's read-only but involves multiple queries. Suggest: 10 requests/hour per member, with cached results for rapid re-requests.

2. **DM signals in the digest?** The current design deliberately excludes DM content from club digests (DMs are private). But DM *existence* between the requesting member and other members is a useful social proximity signal. Plan: use DM thread existence as a signal, never surface DM content. Confirm this is acceptable from a privacy standpoint.

3. **Member absence detection** ("Sarah's been quiet"). This requires baseline activity tracking per member per club — average posts/week, last active timestamp. It's derivable from `club_activity` but needs a materialised view or periodic computation. Phase 3. Open question: is this creepy? It's useful, but some members might find it uncomfortable that the system tracks their silence. May need to be opt-in or limited to close connections.

4. **Should the digest include entity bodies or just titles/summaries?** Leaning toward: titles and summaries in the highlights, with `entityId` for the agent to fetch the full entity if it wants to quote from it. Keeps the digest response compact and avoids transmitting content that might be long.

5. **Pre-computation vs on-demand for cross-club digests?** On-demand for Phase 2. If latency becomes an issue, pre-compute daily digests for active members as a background job and serve cached results with a freshness tail of raw recent activity. Decision depends on real latency numbers from Phase 1.

6. **Should the agent be told why something was ranked highly?** The current design includes `relevanceSignals` (e.g., `["embedding_match", "social_proximity"]`). This helps the agent craft natural explanations ("Elena posted something I think you'd love" vs "Marcus is hosting — three people you know are going"). But it also exposes ranking internals. Probably fine for an agent-first API, but worth confirming.

---

## Remaining criticisms / concerns

1. **`digest.read` advancing the cursor on every read is risky.** The current plan says `digest_cursors` are updated on each `digest.read` call. That couples "fetched by some agent process" with "actually seen by the member." Retries, background refreshes, or speculative reads could silently move the boundary forward. It may be safer to make cursor advancement explicit (`digest.acknowledge`, or an `advanceCursor: true` flag) rather than automatic.

2. **The plan still says "entity IDs, not content," but `rollup_json` stores titles.** That weakens the redaction story. If a post is later redacted, the read path can drop the entity reference, but the rollup row still contains a persisted title at rest. If the design goal is "no stale content leakage," the safest version is IDs only, plus deterministic metadata that is not user-authored text. If titles stay, the doc should say clearly that rollups are privileged server-side cache data, not content-free references.

3. **Compaction coverage semantics need to be specified more precisely.** Once you have `window`, `daily`, `weekly`, and `monthly` rows, the read path needs an exact algorithm for choosing a non-overlapping covering set for a requested range. Otherwise it's easy to double-count or miss gaps. Related: if compaction rows coexist with fine-grained rows, the schema/indexing should reflect that access pattern explicitly rather than treating all ranges as equivalent blobs.

4. **Candidate starvation is still a real risk unless rollups retain enough entities.** The ranking layer only works if the rollup layer preserves a broad candidate set. If rollups end up storing only model-selected or aggressively pruned entities, personalization can never recover items that were omitted upstream. The doc should make this an explicit rule: Phase 1 rollups retain all entity references in the window up to a deterministic cap, or prune only by deterministic objective rules, not by LLM judgment.

5. **Some "window facts" are underspecified because the activity stream does not yet contain all the needed events.** Fields like `has_responses`, `response_count`, `comment_count`, and some `open_loops` logic imply comment/reply events that do not exist in `club_activity` yet. If those are derived from current-state joins instead, the same rollup can mean different things depending on when it is read. The plan should be explicit about which fields are true window-local facts versus current-state enrichments.

6. **Current-state resolution can distort historical digests.** Resolving references against current entity state is the right move for redaction safety, but it means a digest for "what happened last week" may show a newer title/summary if the entity was edited after the rollup window. That may be acceptable, but it should be called out as a deliberate tradeoff: safety and freshness over perfect historical fidelity.

7. **Cross-club social boosting based on DM existence in any club may create boundary weirdness.** It's useful, but it also means a private relationship signal from one club can influence ranking in another club where the member may not expect that connection to matter. Even if no DM content is exposed, this is still a product/privacy decision and not just a ranking detail.

8. **The worker scheduling query may need a more explicit queue once volume rises.** "Find clubs where `max(seq) > last_rolled_seq`" is fine for an initial version, but at larger scale it can become an expensive repeated scan. That is not a blocker for Phase 1, but the doc should acknowledge that a ready-clubs queue or wakeup table may be needed before true high-scale operation.
