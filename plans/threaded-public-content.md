# Plan: Unified Content Model and Threaded Public Content

## Context for the reviewing agent

This plan is intentionally opinionated.

- Breaking the public API is allowed and expected.
- Backward compatibility is not required.
- Database migration is allowed and expected.
- This plan ships two tightly coupled changes as one body of work: content model unification, then threading on top of it.

This plan deliberately does **not** try to preserve old response shapes. The old `events.*` namespace collapses into `content.*`. The old flat entity list becomes a thread list. There are no bridges, compatibility aliases, or dual shapes.

**This is a firm design decision.** The reviewing agent should not reopen the question of whether events should remain a separate namespace, whether a `reply` kind should exist, or whether `parent_entity_id` should be used instead of a threads table. Those questions have been debated and resolved.

## What we're doing

Two things, in order:

### 1. Unify the content model

Events stop being a parallel API surface and become regular content entities. `events.create` and `events.remove` are absorbed into `content.create` and `content.remove`. `events.list` and `events.rsvp` survive as event-specific read/interaction surfaces. `events.cancelRsvp` is added as a new action.

This makes the entity system genuinely extensible. Future kinds (polls, etc.) add validation rules and extension tables without adding new API namespaces.

### 2. Add threading

Every public content entity lives inside a thread. A `content_threads` table (analogous to `dm_threads`) is the grouping container. All entities in a thread are structural peers. Any kind can appear at any position.

These two changes ship together because threading on a split model means threading twice.

## The design in one sentence

Collapse all public content into one `content.create` action with kind-discriminated validation, add a `content_threads` table to group entities into flat threads, and make `content.list` return thread summaries with `content.getThread` as the canonical read path.

## Why this design

### One write path for all content

The current split — `content.create` for non-events, `events.create` for events — is an implementation artifact. Both insert into `entities`. Both create versions in `entity_versions`. Both emit the same activity topics. Both go through the same quota and gate machinery.

An agent posting content to a club should not need to know two different actions for the same conceptual operation. One `content.create`, with kind-specific fields validated by kind.

This pays off immediately: threading needs one write path, not two. And it pays off again for every future kind. Polls, resources, announcements — they add validation rules and extension tables, not new API namespaces.

### Extension tables for kind-specific data

`event_version_details` already demonstrates the right pattern: a 1:1 extension table keyed on `entity_version_id` that stores fields specific to one kind.

This plan makes that pattern explicit and first-class:

- the core `entity_versions` table stores universal fields (title, summary, body, content, expires_at)
- kind-specific extension tables store kind-specific fields
- `content.create` accepts kind-specific input, validates it, and writes the extension table
- the read path joins extension tables based on kind

Future kinds follow the same pattern. Polls would get a `poll_version_details` table. Resources might get a `resource_version_details` table. The core entity machinery doesn't change.

### A threads table, not parent_entity_id overloading

The original draft proposed reusing `parent_entity_id` to model threading. That creates a structurally special "root" entity. But:

- someone should be able to reply to an event with a post ("I went — it was great")
- someone should be able to reply to a post with an event ("let's do this — here's when")
- the subject remains the same regardless of response kind

These requirements mean every entity in a thread is a peer. A thin `content_threads` table gives us:

- no "root is special" logic
- thread metadata (last activity, entity count) on the thread row
- feed ordering is just `content_threads.last_activity_at DESC`
- mirrors the proven `dm_threads` pattern already in the codebase

It does **not** duplicate entity infrastructure. Entities still own versioning, moderation, removal, auth, idempotency, and embeddings.

### Every entity gets an embedding

Entities are full content regardless of thread position. A "sounds great, I went last week" post is still searchable. Search returns matching entities with their `contentThreadId` so the agent can pull the full thread for context.

### DMs stay separate

DMs are participant-scoped conversations with inbox delivery. Public threads are club-scoped content with club activity semantics. They do not share a table model.

## Durable design calls

These are the decisions this plan makes. The implementer should not re-open them casually.

1. **`content.create` is the single write path for all public content kinds.** Events, posts, opportunities, services, asks, gifts — all created through one action.
2. **Kind-specific fields use a namespaced input object.** Event fields live under `event: { ... }` in the `content.create` input. Future kinds follow the same pattern.
3. **Kind-specific data lives in extension tables.** `event_version_details` is the template. The core entity/version tables are kind-agnostic.
4. **The `events.*` write namespace collapses.** `events.create` and `events.remove` are absorbed into `content.*`. `events.list` survives as an event-specific read surface (flat, ordered by `starts_at`). `events.rsvp` survives. `events.cancelRsvp` is added as a new action.
5. **The `comment` kind is removed.** Responding to a thread is just `content.create` with a `threadId`.
6. **A `content_threads` table exists.** It is a thin container, analogous to `dm_threads`.
7. **Every public content entity lives inside a thread.** There are no threadless entities.
8. **All entities in a thread are structural peers.** The first entity establishes the subject, but it is not a different type than the others.
9. **Any public content kind can appear at any position in a thread.**
10. **The feed is thread-based.** `content.list` returns thread summaries, not flat entities.
11. **`content.getThread` is the canonical read path.**
12. **`content.getThread` accepts any entity ID or thread ID.** The server resolves the thread automatically.
13. **Every entity gets an embedding.** Search returns matching entities with `contentThreadId`.
14. **Removing an entity shows `[redacted]` in thread reads.** The thread survives.
15. **New entity in a thread bumps thread order.** Editing an existing entity does not.
16. **The first entity is always surfaced in thread summaries when visible.** If removed, it appears as `[redacted]`. If expired, it still appears with metadata. But if the first entity is *closed* (a closed ask/gift/service/opportunity), the thread follows existing `includeClosed` semantics: hidden from non-authors when `includeClosed=false`, visible when `includeClosed=true`. Removal is structural (always show the slot); closure is a content-level visibility filter.
17. **Thread-position-1 entities participate in matching. Subsequent entities do not.** The synchronicity worker only processes the first entity in a thread for match generation.

## Open problem: thread summary shape in the feed

`content.list` returns thread summaries, but what a "summary" contains beyond the first entity is an open problem.

Only agents know what they want to see. This plan does **not** prescribe a specific shape beyond:

- the summary always includes the thread's first entity (the subject), even if redacted
- the summary always includes `entityCount` and `lastActivityAt`
- the summary shape is a dedicated type

The implementation should start with the simplest viable option and evolve based on agent feedback.

## Part 1: Unified content model

### What collapses

| Old action | New home | Notes |
|---|---|---|
| `events.create` | `content.create(kind='event')` | Event fields under `event: { ... }` |
| `events.list` | `events.list` | **Survives** — event-specific read surface, flat, ordered by `starts_at` |
| `events.remove` | `content.remove` | Already worked on entities |
| `events.rsvp` | `events.rsvp` | **Survives** — RSVP is not content CRUD |
| `events.cancelRsvp` | `events.cancelRsvp` | **New action** — does not exist today, added in this plan |
| `content.create` | `content.create` | Gains `kind='event'` support |
| `content.update` | `content.update` | Gains event field support |
| `content.list` | `content.list` | Gains event results (thread-based) |
| `content.remove` | `content.remove` | Already handles all entity kinds |

### `content.create` input shape

```ts
{
  // Common fields (all kinds)
  clubId?: string;          // required for new threads, derived for thread responses
  threadId?: string;        // omit to start a new thread
  kind: ContentEntityKind;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;
  clientKey?: string | null;

  // Event-specific fields (required when kind='event')
  event?: {
    location: string;
    startsAt: string;
    endsAt?: string | null;
    timezone?: string | null;
    recurrenceRule?: string | null;
    capacity?: number | null;
  };
}
```

Validation rules:

- `kind='event'` requires `event` object and `title`
- `kind='event'` validates `endsAt >= startsAt` if both present
- `kind='event'` validates `capacity > 0` if present
- `kind` in `('ask', 'gift', 'service', 'opportunity')` gets `open_loop` set automatically
- `kind='post'` has no required fields beyond at least one of `title`, `summary`, `body`, or `content`
- future kinds follow the same pattern: `poll: { ... }`, etc.

### `ContentEntity` response shape

One shape for all kinds. Kind-specific fields are included when present, null otherwise.

```ts
type ContentEntity = {
  entityId: string;
  contentThreadId: string;
  clubId: string;
  kind: ContentEntityKind;
  openLoop: boolean | null;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
    displayName: string;
  };
  version: {
    versionNo: number;
    state: 'published' | 'removed';
    title: string | null;
    summary: string | null;
    body: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    createdAt: string;
    content: Record<string, unknown>;
  };
  // Kind-specific extensions (null when kind doesn't match)
  event: {
    location: string | null;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string | null;
    recurrenceRule: string | null;
    capacity: number | null;
  } | null;
  // RSVP data (null when kind != 'event' or when not fetched)
  rsvps: {
    viewerResponse: EventRsvpState | null;
    counts: Record<EventRsvpState, number>;
    attendees: EventRsvpAttendee[];
  } | null;
  createdAt: string;
};
```

For removed entities in thread reads: `state` is `'removed'`, text fields become `'[redacted]'`, kind-specific extensions become null.

### `content.update` gains event fields

```ts
{
  entityId: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;

  // Event-specific (only when updating an event entity)
  event?: {
    location?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    timezone?: string | null;
    recurrenceRule?: string | null;
    capacity?: number | null;
  };
}
```

The `event` object is rejected with `400 invalid_input` if the target entity is not `kind='event'`. Same pattern for future kind-specific update fields.

### `content.list` gains events (thread-based)

Events appear in `content.list` alongside all other kinds. The `kinds` filter controls which kinds appear. After threading, this is thread-based listing with kind filtering on the first entity.

`content.list(kinds=['event'])` returns threads whose first entity is an event. This is **not** a drop-in replacement for `events.list`. An event posted as a response inside a post-thread is invisible to this filter, and thread ordering by `lastActivityAt` can outrank an upcoming event with an old event that has recent replies.

### `events.list` survives as an event-specific read surface

`events.list` is not content CRUD — it is an event-specific read concern. "What events are happening this week?" is a fundamental query that does not map to thread ordering.

`events.list` queries entities with `kind='event'` directly (flat, not thread-grouped), ordered by `starts_at`. It returns `ContentEntity[]` with event fields populated. It ignores threading entirely.

This is the same argument as `events.rsvp`: it survives because it serves a genuinely different product need. The pattern generalizes — future kinds can have their own read surfaces (`polls.results`, etc.) without needing their own write paths.

### Event-specific read enrichment

When reading entities with `kind='event'`, the response mapper joins `event_version_details` and optionally `current_event_rsvps` to populate the `event` and `rsvps` fields.

This join happens in the read path, not in the list path. `content.list` thread summaries include the first entity with event fields populated. `content.getThread` includes event fields for all event entities in the thread.

### Event-specific actions survive

`events.list` survives as a read-only action. It queries event entities directly (flat, ordered by `starts_at`), not through threads. This is the "upcoming events" surface that agents need. `content.list(kinds=['event'])` is not a substitute — it filters threads by first-entity kind and orders by thread activity, which is materially different.

`events.rsvp` stays. It takes an `eventEntityId` and operates on the entity directly. Threading does not change RSVP semantics — you RSVP to a specific event entity, not to a thread.

Both actions change their output shape from `{ event: EventSummary }` to `{ entity: ContentEntity }` (for RSVP) and `ContentEntity[]` (for list). The unified `ContentEntity` shape includes `event` and `rsvps` fields when `kind='event'`.

The only validation change: `events.rsvp` should explicitly check `kind='event'` on the target entity (it implicitly does today via the query).

### Quota collapse

Current:

- `content.create`: 30/day (counts post, opportunity, service, ask, gift)
- `events.create`: 20/day (counts event)

After:

- `content.create`: counts all content kinds including events

The per-kind rate limits could be:

- option A: one combined budget (e.g. 50/day for all kinds)
- option B: per-kind sub-limits within `content.create`

Option A is simpler and the right starting point. If event spam becomes a problem, add per-kind sub-limits later.

Recommended: `content.create`: 50/day global default.

Quota migration merge rule (must execute in this order):

1. Materialize the old state into a temp table: snapshot all `quota_policies` rows for both `content.create` and `events.create`, including their actual `max_per_day` values. Read the actual global defaults from the snapshot — do not hardcode `30` and `20`. **Assert that both global rows exist** (`scope = 'global'` for `content.create` and `events.create`). If either is missing, abort the migration with a clear error rather than producing a bad merge.
2. For any club that has per-club overrides for **both** `content.create` and `events.create`: update the `content.create` row to the sum of both values.
3. For any club that has a per-club override for `events.create` only: insert a `content.create` row at `snapshot_global_content + club_event_override`.
4. For any club that has a per-club override for `content.create` only: update it to `existing_value + snapshot_global_event`.
5. Update the global `content.create` row to `snapshot_global_content + snapshot_global_event`.
6. Delete all `events.create` rows.

Steps 2-5 read from the snapshot, so deletion in step 6 is safe. All arithmetic derives from whatever global rows actually exist, not from assumed bootstrap values.

### Quality gate collapse

Current:

- `content.create` → gated
- `events.create` → gated

After:

- `content.create` → gated (covers all kinds)

The gate prompt does not need kind-specific variants. It checks legality, not kind-specific quality.

### Database changes for content unification

These are changes needed for unification that are separate from the threading changes:

1. **Remove `comment` from enum** — requires enum recreation (see migration section)
2. **Update `quota_policies`** — migrate `events.create` rows to `content.create`
3. **Update gate prompts** — remove `events-create` as a separate gate

No schema changes to `event_version_details` or `event_rsvps` — those tables stay as-is.

## Part 2: Threaded public content

### `content_threads` table

```sql
CREATE TABLE content_threads (
    id                   short_id DEFAULT new_id() NOT NULL,
    club_id              short_id NOT NULL,
    created_by_member_id short_id NOT NULL,
    last_activity_at     timestamptz DEFAULT now() NOT NULL,
    created_at           timestamptz DEFAULT now() NOT NULL,
    archived_at          timestamptz,

    CONSTRAINT content_threads_pkey PRIMARY KEY (id),
    CONSTRAINT content_threads_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT content_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX content_threads_club_activity_idx
    ON content_threads (club_id, last_activity_at DESC, id DESC)
    WHERE archived_at IS NULL;
```

### `content_thread_id` on entities

```sql
ALTER TABLE entities ADD COLUMN content_thread_id short_id;

-- Same-club enforcement
CREATE UNIQUE INDEX content_threads_id_club_idx ON content_threads (id, club_id);

ALTER TABLE entities ADD CONSTRAINT entities_content_thread_same_club_fkey
    FOREIGN KEY (content_thread_id, club_id)
    REFERENCES content_threads (id, club_id);

-- Thread read index
CREATE INDEX entities_thread_created_idx
    ON entities (content_thread_id, created_at ASC, id ASC)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
```

### Thread semantics

A thread is:

- one `content_threads` row
- one or more entities belonging to that thread
- ordered by `entities.created_at ASC, id ASC`

Thread ordering in the feed:

- `content_threads.last_activity_at DESC, id DESC`

`last_activity_at` is updated when a new entity is added. Not on edit, not on removal.

### Entity removal within a thread

When an entity is removed:

- the entity gets a `removed` version (existing pattern)
- the thread survives
- thread reads show the entity in position with `state: 'removed'` and redacted fields
- removed entities still occupy their slot in the thread

The first entity is always surfaced when the thread is visible. If removed, it shows as `[redacted]`. If the first entity is closed, the thread follows `includeClosed` semantics (hidden from non-authors by default).

### Drop old parent constraints

```sql
ALTER TABLE entities DROP CONSTRAINT entities_comment_parent_check;
```

`parent_entity_id` remains on the table but is no longer used for public content threading. It can be dropped in a later cleanup migration.

## API after both changes

### Types

```ts
type ContentEntityKind =
  | 'post'
  | 'opportunity'
  | 'service'
  | 'ask'
  | 'gift'
  | 'event';
```

No `reply` kind. No `comment` kind. No root-vs-reply distinction.

### `ContentThreadSummary`

```ts
type ContentThreadSummary = {
  threadId: string;
  clubId: string;
  firstEntity: ContentEntity;
  thread: {
    entityCount: number;
    lastActivityAt: string;
  };
};
```

### `ContentThread`

```ts
type ContentThread = {
  threadId: string;
  clubId: string;
  entities: ContentEntity[];
  entityCount: number;
  lastActivityAt: string;
  hasMore: boolean;
  nextCursor: string | null;
};
```

### Actions

#### `content.create`

Creates a new entity. If `threadId` is omitted, creates a new thread. If `threadId` is provided, adds the entity to that thread.

Input:

```ts
{
  clubId?: string;          // required for new threads, derived for thread responses
  threadId?: string;        // omit to start a new thread
  kind: ContentEntityKind;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;
  clientKey?: string | null;

  // Kind-specific extensions
  event?: {
    location: string;
    startsAt: string;
    endsAt?: string | null;
    timezone?: string | null;
    recurrenceRule?: string | null;
    capacity?: number | null;
  };
}
```

Output:

```ts
{ entity: ContentEntity }
```

#### `content.getThread`

Input:

```ts
{
  entityId?: string;   // any entity ID in the thread
  threadId?: string;   // or the thread ID directly
  limit?: number;
  cursor?: string | null;
}
```

Output:

```ts
{
  thread: ContentThreadSummary;
  entities: ContentEntity[];
  hasMore: boolean;
  nextCursor: string | null;
}
```

Rules:

- accept either an entity ID or a thread ID
- entity pagination: newest page first, entities returned in chronological order within the page
- removed entities appear with `state: 'removed'` and redacted fields
- expired entities are excluded from the `entities` array
- event entities include `event` and `rsvps` fields
- **important**: `thread.firstEntity` may not equal `entities[0]`. The first entity is always present in the summary (even if expired), but expired entities are filtered from the `entities` array. Clients must not assume `thread.firstEntity` is the first element of `entities`.

#### `content.list`

Input:

```ts
{
  clubId?: string;
  kinds?: ContentEntityKind[];
  query?: string | null;
  includeClosed?: boolean;
  limit?: number;
  cursor?: string | null;
}
```

Output:

```ts
{
  query: string | null;
  kinds: ContentEntityKind[];
  includeClosed: boolean;
  limit: number;
  clubScope: MembershipSummary[];
  results: ContentThreadSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}
```

Rules:

- `kinds` filter applies to the first entity's kind
- lexical search applies to the first entity's title/summary/body
- ordering: `lastActivityAt DESC, threadId DESC`
- a thread appears if it has at least one visible entity
- the first entity is always surfaced when the thread is visible (redacted if removed, present if expired)
- threads whose first entity is closed follow `includeClosed` semantics (hidden from non-authors by default)

#### `content.searchBySemanticSimilarity`

Searches all entities regardless of thread position.

Output:

```ts
{
  query: string;
  kinds: ContentEntityKind[];
  results: (ContentEntity & { score: number })[];
  hasMore: boolean;
  nextCursor: string | null;
}
```

Each result includes `contentThreadId` so agents can pull the full thread.

#### `content.update`

Input:

```ts
{
  entityId: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  expiresAt?: string | null;
  content?: Record<string, unknown>;
  event?: {
    location?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    timezone?: string | null;
    recurrenceRule?: string | null;
    capacity?: number | null;
  };
}
```

Rules:

- `event` object rejected if target entity is not `kind='event'`
- editing does not bump `content_threads.last_activity_at`
- kind-specific validation still applies (endsAt >= startsAt, etc.)

Output:

```ts
{ entity: ContentEntity }
```

#### `content.remove`

Input:

```ts
{
  entityId: string;
  reason?: string | null;
}
```

Output:

```ts
{ entity: ContentEntity }
```

Behavior:

- appends a `removed` version
- thread survives
- thread reads show `[redacted]`
- does not bump `content_threads.last_activity_at`

#### `content.closeLoop` / `content.reopenLoop`

No change. Work on any entity with `open_loop` regardless of thread position.

#### `clubadmin.content.remove`

Works on any entity in any thread in the club.

#### `events.list`

**Survives** as an event-specific read surface. This is not `content.list(kinds=['event'])` — it queries event entities directly (flat, not thread-grouped), ordered by `starts_at`.

Input:

```ts
{
  clubId?: string;
  query?: string | null;
  limit?: number;
  cursor?: string | null;
}
```

Output:

```ts
{
  query: string | null;
  limit: number;
  clubScope: MembershipSummary[];
  results: ContentEntity[];
  hasMore: boolean;
  nextCursor: string | null;
}
```

Rules:

- queries entities with `kind='event'` across the actor's club scope
- visibility: published, non-removed, non-archived, non-deleted, non-expired only (same lifecycle filters as the current `live_events` view)
- ordered by `event.startsAt ASC, entityId ASC` (upcoming first)
- keyset cursor on `(startsAt, entityId)`
- returns `ContentEntity` (the unified shape), not the old `EventSummary`
- includes `contentThreadId` on each entity so agents can pull the thread
- includes `event` and `rsvps` fields

#### `events.rsvp`

**Survives.** Input unchanged. Takes `eventEntityId`, validates `kind='event'`, operates on the entity directly.

Output changes from `{ event: EventSummary }` to `{ entity: ContentEntity }`. The unified `ContentEntity` shape includes `event` and `rsvps` fields when `kind='event'`, so no information is lost.

#### `events.cancelRsvp`

**New action.** Does not exist in the current codebase — this plan adds it.

Input:

```ts
{
  eventEntityId: string;
}
```

Output:

```ts
{ entity: ContentEntity }
```

Semantics:

Cancellation is not a decline. "No" means "I'm not going." Cancellation means "I haven't decided" — the viewer goes back to having no response.

The storage model is a new RSVP version with a `'cancelled'` state. This requires adding `'cancelled'` to the `rsvp_state` enum. The read path treats `'cancelled'` as "no RSVP":

- `viewerResponse` = `null` (not `'cancelled'`)
- `counts` does not include a `'cancelled'` bucket
- `attendees` array excludes cancelled RSVPs

This preserves the append-only RSVP versioning model (no row deletion) while giving the API clean "no response" semantics.

Rules:

- validates target entity has `kind='event'`
- appends a new RSVP version with `response = 'cancelled'`
- returns the updated event entity with RSVP data reflecting the cancellation
- idempotent: cancelling when no active RSVP exists (including already-cancelled) is a no-op, returns the event as-is

Database change:

```sql
ALTER TYPE rsvp_state ADD VALUE 'cancelled';
```

The `current_event_rsvps` view already returns the latest RSVP version per member per event, so cancellation is automatic: the latest version is `'cancelled'`, which the read path maps to null.

## Read-path semantics

### Visibility

Thread visibility is driven by club scope.

Individual entity visibility within a thread:

- removed: visible with `state: 'removed'`, redacted fields
- expired: not visible in thread reads
- closed + non-author: not visible to non-author

Thread-level visibility in the feed:

- a thread appears if it has at least one visible entity
- the first entity is always surfaced when the thread is visible: redacted if removed, present if expired
- threads whose first entity is closed follow `includeClosed` semantics: hidden from non-authors when `includeClosed=false` (default), visible when `includeClosed=true`
- closure is a content-level filter, not a structural concern — a closed first entity means the thread subject is done

### Thread resolution

`content.getThread(entityId)` works:

1. load entity, read `content_thread_id`
2. load thread
3. load entities for that thread, paginated

`content.getThread(threadId)` skips to step 2.

### Entity ordering

`entities.created_at ASC, id ASC` within the returned page.

### Pagination direction

Newest page first, reversed before return. `hasMore` means there are older entities. The cursor encodes `(created_at, id)` for the oldest entity in the current page.

This is the opposite direction from the current `listEntities` cursor. The implementation must not accidentally reuse the list cursor decoder.

### Event enrichment in reads

When a `ContentEntity` has `kind='event'`, the read path joins `event_version_details` to populate `event` fields and optionally joins `current_event_rsvps` to populate `rsvps`.

For `content.list` thread summaries: if the first entity is an event, include event fields + RSVP summary.

For `content.getThread`: all event entities in the thread include event fields + RSVP data.

For `content.searchBySemanticSimilarity`: matching event entities include event fields. RSVP data may be omitted for performance (the agent can fetch via `content.getThread`).

## Write-path semantics

### New thread creation

When `content.create` is called without `threadId`:

1. validate kind-specific input
2. create `content_threads` row
3. create entity with `content_thread_id`
4. create version 1
5. if `kind='event'`: insert `event_version_details`
6. emit `entity.version.published` activity
7. enqueue embedding job

### Thread response creation

When `content.create` is called with `threadId`:

1. load thread, verify club access
2. validate kind-specific input
3. create entity with `content_thread_id = threadId`, `club_id = thread.club_id`
4. create version 1
5. if `kind='event'`: insert `event_version_details`
6. update `content_threads.last_activity_at = now()`
7. emit `entity.version.published` activity
8. enqueue embedding job

### Entity update

Same as today. If `kind='event'` and `event` fields are provided, also insert a new `event_version_details` row for the new version. No thread-level side effects.

### Entity removal

Same as today. No thread-level side effects. The thread survives.

### Idempotency

For new-thread creates (no `threadId`): idempotency is keyed on `(author_member_id, client_key)` only. The generated `content_thread_id` is output, not input, so it's not compared. Replay returns the existing entity and its thread.

For thread responses (with `threadId`): idempotency key is still `(author_member_id, client_key)`. The comparison must verify the stored entity's `content_thread_id` matches the resolved thread. If the caller supplied an entity ID that resolves to the same thread, that's the same operation.

## Activity and updates

### Entity topics

Unchanged:

- `entity.version.published`
- `entity.removed`

All entities regardless of thread position emit their own activity. No thread-specific topics. Every entity is a full citizen.

### `listClubActivity` filtering

No changes needed. Activity is per-entity. The existing removed-entity filter works as-is.

### `updates.list`

No schema changes. The `content_thread_id` on the entity gives agents thread context.

## Search, embeddings, and matching

### Lexical search

`content.list(query=...)` searches the first entity in each thread (the subject).

### Semantic search

All entities get embeddings. `content.searchBySemanticSimilarity` returns matching entities with `contentThreadId`.

### Embedding jobs

Every `content.create` and `content.update` enqueues an embedding job, regardless of thread position.

### Synchronicity worker

**Thread-position-aware.** The worker processes only position-1 entities (thread subjects) for match generation. Subsequent entities in a thread do not generate matches.

Implementation: the worker already filters by `entity.version.published`. Add a check that the entity's `created_at` equals the earliest `created_at` in its thread (or is the first entity by ID). Alternatively, add a `thread_position` column or a boolean `is_thread_subject` — but a query-time check is simpler and avoids schema additions.

## Quotas and gating

### Quotas

One action: `content.create`. One budget.

Recommended: 50/day global default. Per-kind sub-limits can be added later if needed.

Migration: existing `events.create` rows in `quota_policies` are migrated to `content.create` or removed.

### Quality gate

One action: `content.create`. Already gated.

The `events-create` gate reference is removed. All content goes through the same legality gate.

## Migration strategy

This ships as one migration-backed deploy. The migration has two logical phases within one file.

### Phase 1: Content unification

1. **Assert safety invariants:**
   - no non-comment entities have `parent_entity_id` set
   - no cross-club parent links exist
   - no comment chains are cyclic

2. **Convert comment entities to posts:**
   - flatten any nested comment chains (walk to non-comment ancestor)
   - update `kind` from `comment` to `post` for all comment entities
   - assert no rows with `kind = 'comment'` remain

3. **Recreate enum without `comment`:**
   - create `entity_kind_new` without `comment`
   - drop and recreate views that reference `entity_kind` (`live_entities`, `current_entity_versions`, `published_entity_versions`, `current_event_versions`, `live_events`)
   - alter `entities.kind` to use new enum
   - drop old enum, rename new enum

4. **Migrate quotas** (see quota merge rule in Part 1):
   - merge `events.create` budgets into `content.create` rows (sum for per-club overrides)
   - delete all `events.create` rows
   - update `quota_policies_action_check` constraint to remove `events.create`

### Phase 2: Threading

5. **Create `content_threads` table** with indexes.

6. **Backfill threads for existing entities:**
   - create one `content_threads` row per existing entity that has `parent_entity_id IS NULL`
   - assign `content_thread_id` on those entities
   - for entities with `parent_entity_id` (former comments): assign the parent's `content_thread_id`
   - for orphans: create individual threads

7. **Add `NOT NULL` constraint** on `content_thread_id` after backfill.

8. **Add same-club FK and thread read index.**

9. **Drop old parent constraint:**
   - `ALTER TABLE entities DROP CONSTRAINT entities_comment_parent_check`

### `db/init.sql`

Must reflect the final state:

- `entity_kind` enum without `comment`
- `content_threads` table
- `content_thread_id` column on entities (NOT NULL)
- same-club FK constraint
- thread read index
- thread feed index
- updated views that include `content_thread_id`

### `db/seeds/dev.sql`

- remove `comment` kind rows
- every entity gets a thread
- add multi-entity threads (post + event response, event + post response)
- add threads with removed entities
- RSVP seeds remain, pointing at event entities

## Repository and implementation plan

### `src/schemas/fields.ts`

- content kind enum: `post|opportunity|service|ask|gift|event`
- remove any reply/comment kind references
- add event-specific field schemas (for `content.create` input validation)

### `src/schemas/responses.ts`

Replace flat entity and event response shapes with:

- `contentEntity` (unified shape with kind-specific extensions)
- `contentThreadSummary`
- `contentThread`

Remove `eventSummary` as a separate shape. Its fields are absorbed into `contentEntity`.

### `src/schemas/entities.ts`

Major changes:

- `content.create`: add `threadId`, `event` input fields, accept all content kinds
- `content.getThread`: new action
- `content.list`: returns thread summaries, accepts all content kinds in `kinds` filter
- `content.update`: add `event` input fields
- `content.searchBySemanticSimilarity`: returns entities with `contentThreadId`

### `src/schemas/events.ts`

Collapse write actions:

- remove `events.create`, `events.remove`
- keep `events.list` (update output to `ContentEntity[]`)
- keep `events.rsvp` (update output to `{ entity: ContentEntity }`)
- add `events.cancelRsvp` (new action, output `{ entity: ContentEntity }`)

### `src/contract.ts`

- unify `EntitySummary` and `EventSummary` into `ContentEntity`
- remove separate event repo methods (`createEvent`, `removeEvent`)
- existing `createEntity`, `removeEntity` gain event support
- `listEvents` stays but uses unified `ContentEntity` shape
- add `readContentThread`, `listContentThreads` repo methods
- keep `rsvpEvent` repo method

### `src/clubs/entities.ts`

**Write path:**

- `createEntity`: accept `threadId`, handle thread creation, handle `event_version_details` insert for events, update `last_activity_at` for thread responses
- `updateEntity`: handle `event_version_details` insert for event updates
- idempotency: include `content_thread_id` in comparison

**Read path:**

- `readEntitySummary` → `readContentEntity`: join `event_version_details` and `current_event_rsvps` for events
- new `listContentThreads`: query `content_threads`, join first entity per thread, support kind filter and lexical search on first entity
- new `readContentThread`: load thread metadata + paginated entities with event enrichment
- the `[redacted]` mapping for removed entities in the response mapper

### `src/clubs/events.ts`

Collapse most of this into `src/clubs/entities.ts`:

- `createEvent` → absorbed into `createEntity`
- `removeEvent` → absorbed into `removeEntity`
- `readEventSummary` → absorbed into `readContentEntity`
- `listEvents` → stays but returns `ContentEntity[]` using the unified read path
- `rsvpEvent` → stays (event-specific)

### `src/clubs/index.ts`

- merge event quota into content quota
- `QUOTA_ENTITY_KINDS`: `'content.create': ['post', 'opportunity', 'service', 'ask', 'gift', 'event']`
- remove `events.create` mapping

### `src/postgres.ts`

- route `content.create` with event support
- route `content.getThread`
- route `content.list` to thread list
- remove `events.create`, `events.remove` routes
- keep `events.list` route (update to return `ContentEntity[]`)
- keep `events.rsvp` route (update to return `{ entity: ContentEntity }`)
- update response mapping for unified `ContentEntity` shape

### `src/quality-gate.ts`

- remove `events.create` from `GATED_ACTIONS` (it no longer exists)
- `content.create` remains gated (covers all kinds)

### `src/workers/embedding.ts`

No changes. All entities get embeddings. The worker processes `entity.version.published` regardless of kind or thread position.

### `src/workers/synchronicity.ts`

Add thread-position awareness: only process entities that are the first in their thread. Skip subsequent entities.

### `src/schemas/clubadmin.ts`

- `clubadmin.content.remove` works on any entity in any thread
- update descriptions

### `src/schemas/superadmin.ts`

- keep `superadmin.content.list` flat at the entity level
- add `contentThreadId` to admin summaries
- include all content kinds

## Tests

### Integration tests

#### `test/integration/non-llm/threaded-content.test.ts` (new)

Thread-specific cases:

1. create content → auto-creates thread, list returns one thread
2. create content with `threadId` → adds to existing thread
3. `content.getThread` returns entities chronologically
4. `content.getThread` by entity ID resolves thread
5. `content.getThread` by thread ID works directly
6. respond to thread with different kind (post thread, event response)
7. respond to thread in wrong club → rejected
8. respond to archived/invisible thread → 404
9. `content.list` returns thread summaries ordered by `lastActivityAt`
10. thread ordering bumps on new entity, not on edit
11. entity removal shows `[redacted]` in thread read
12. entity removal does not kill the thread
13. first entity always appears in summary even when removed
14. thread with closed first entity hidden from non-authors when `includeClosed=false`
15. thread with closed first entity visible when `includeClosed=true`
16. `content.list` hides threads where all entities are removed/expired
17. `content.list(kinds=...)` filters by first entity kind
18. lexical search searches first entity text only
19. semantic search returns entities with `contentThreadId`
20. idempotent `clientKey` retry — new thread
21. idempotent `clientKey` retry — thread response
22. `content.getThread` summary `firstEntity` present even when first entity is expired, but absent from `entities` array

#### `test/integration/non-llm/unified-content.test.ts` (new)

Content unification cases:

1. `content.create(kind='event')` with event fields → success
2. `content.create(kind='event')` without event fields → 400
3. `content.create(kind='post')` with event fields → 400
4. `content.update` on event entity with event fields → success
5. `content.update` on non-event entity with event fields → 400
6. `content.list(kinds=['event'])` returns events
7. `content.list(kinds=['post', 'event'])` returns both
8. `content.remove` on event entity → success
9. `events.rsvp` still works, returns `{ entity: ContentEntity }` with event + RSVP fields
10. `events.cancelRsvp` returns entity with `rsvps.viewerResponse === null` (not `'cancelled'`)
11. `events.cancelRsvp` result has no `'cancelled'` bucket in `rsvps.counts`
12. `events.cancelRsvp` result excludes cancelled member from `rsvps.attendees`
13. `events.cancelRsvp` on entity with no active RSVP is idempotent no-op
12. `events.list` returns events ordered by `startsAt`, flat (not thread-grouped)
13. `events.list` returns events regardless of thread position (event response to a post thread is discoverable)
14. `events.list` excludes removed, expired, and unpublished events
15. `events.create` → 404 or removed (action no longer exists)
16. quota enforcement counts all kinds under `content.create`
17. quality gate applies to event creation via `content.create`
18. event entity in thread read includes event fields + RSVP data
19. clubadmin can remove event entities

#### Update existing test files

- `test/integration/non-llm/events.test.ts`: migrate to use `content.create(kind='event')`
- `test/integration/non-llm/profiles.test.ts`: update if entity response shapes changed
- `test/integration/with-llm/llm-gated.test.ts`: update event gate tests

### Unit tests

- response schemas
- cursor encoding/decoding for thread reads
- thread resolution from entity ID
- `[redacted]` field mapping
- kind-specific validation dispatch
- event field validation

### Schema snapshot

Regenerate `test/snapshots/api-schema.json` in one shot after all changes land.

## Docs to update

### `SKILL.md`

Full rewrite of the content and events sections. After this change:

- `content.create` is the single write path for all public content kinds (post, opportunity, service, ask, gift, event)
- `content.create` accepts optional `threadId` to respond to an existing thread
- `content.create(kind='event')` requires an `event: { ... }` object with event-specific fields
- `content.update` supports event-specific fields via `event: { ... }`
- `content.list` returns thread summaries (`ContentThreadSummary[]`), not flat entities
- `content.list` `kinds` filter applies to the first entity's kind
- `content.getThread` is the canonical thread read path (accepts entity ID or thread ID)
- `content.searchBySemanticSimilarity` returns entities with `contentThreadId`
- `content.remove` removes an entity within a thread; thread survives; removed entities show as `[redacted]`
- `events.create` and `events.remove` no longer exist
- `events.list` survives as an event-specific read surface (flat, ordered by `startsAt`)
- `events.rsvp` survives, returns `{ entity: ContentEntity }`
- the `comment` kind no longer exists
- all response shapes use the unified `ContentEntity` type with kind-specific extensions

The SKILL.md agent guidance section must be updated to reflect the thread-based content model. Agents should:
- use `content.create` for all content, not separate actions per kind
- pass `threadId` when responding to existing content
- use `content.getThread` to read full threads
- use `events.list` for "upcoming events" queries, not `content.list(kinds=['event'])`
- expect `ContentEntity` shapes with nullable `event` and `rsvps` extensions

### `docs/design-decisions.md`

Add a new section documenting the unified content model and threading decisions:

- **Why one write path**: events are entities; the split was an implementation artifact; one action is simpler for agents and extensible for future kinds
- **Why a threads table**: entities in a thread are structural peers; any kind can appear at any position; `parent_entity_id` overloading creates a false root/reply hierarchy
- **Why `events.list` survives**: thread-based listing and event-specific listing serve different product needs; "upcoming events" requires `starts_at` ordering, not thread activity ordering
- **Why every entity gets an embedding**: entities are full content regardless of thread position; search returns entities with thread context
- **Why `[redacted]` not deletion**: threads survive entity removal; removed entities show in position to preserve conversational flow; matches the DM pattern
- **Why closed threads follow `includeClosed`**: closure is a content-level filter, not structural; a closed first entity means the thread subject is done
- **Extension table pattern**: `event_version_details` is the template; future kinds (polls, etc.) add extension tables without new API namespaces

### `README.md`

Update the API overview to reflect the collapsed action set.

### `docs/digest-plan.md`

Update activity topic references. No thread-specific topics exist — all entities emit `entity.version.published` regardless of thread position.

## Rollout summary

1. add migration (enum cleanup, content_threads, backfill)
2. update schema/init/seeds
3. update contract/types/responses (unify entity + event shapes)
4. collapse event write/read paths into content paths
5. add thread write/read paths
6. update quota and gate wiring
7. update workers (synchronicity thread-position check)
8. update tests
9. update docs

No bridges. No dual read shapes. No compatibility aliases.

## Final recommendation

Do exactly two conceptual things, in order:

1. make all public content go through one `content.create` action with kind-discriminated validation
2. put every content entity inside a thread container

Do **not** also try to:

- add nested replies
- add a special "reply" entity kind
- keep event write actions as a separate API namespace
- restrict which kinds can appear where in a thread
- add per-thread inbox notifications

The existing entity/version model handles all the hard parts. Extension tables handle kind-specific data. The `content_threads` table is just the grouping container. Keep it thin.

---

## Implementation warnings

Reviewed against the codebase as of 2026-04-10.

### Enum recreation is the trickiest migration step

Postgres cannot `ALTER TYPE ... DROP VALUE`. The standard approach:

1. `CREATE TYPE entity_kind_new AS ENUM (... without 'comment' ...)`
2. Drop all views referencing the old enum (`live_entities`, `current_entity_versions`, `published_entity_versions`, `current_event_versions`, `live_events`)
3. `ALTER TABLE entities ALTER COLUMN kind TYPE entity_kind_new USING kind::text::entity_kind_new`
4. `DROP TYPE entity_kind`
5. `ALTER TYPE entity_kind_new RENAME TO entity_kind`
6. Recreate all dropped views

This is safe in a transaction but verbose. Every view that references `entity_kind` must be dropped and recreated.

### `live_entities` view needs `content_thread_id`

The `live_entities` view (init.sql:1434) is used by the list query. After the change:

- add `e.content_thread_id` to the view's SELECT list
- the list query joins through to `content_threads` for feed ordering

### Event read path is the most complex merge

`readEventSummary` (events.ts:94-154) is a substantial query with CTE-based RSVP aggregation. Merging this into `readContentEntity` means the content read path must conditionally join event extension tables and RSVP data.

The cleanest approach: always attempt the LEFT JOIN on `event_version_details` (it's null for non-events, free when the row doesn't exist) and conditionally aggregate RSVPs only when `kind='event'`.

Alternatively, read the base entity first, then enrich with a second query if `kind='event'`. The second approach is simpler but adds a round trip.

### `listContentThreads` is a new query, not a modification

The current `listEntities` (entities.ts:402) sorts by `effective_at` with a keyset cursor. The new thread list sorts by `content_threads.last_activity_at` with a different cursor.

Keep `listEntities` for non-thread consumers (superadmin, etc.) and add a dedicated `listContentThreads`.

### New-thread idempotency must not compare `content_thread_id`

For new-thread creates (no `threadId` in input), the generated `content_thread_id` is output, not input. The idempotency check keys on `(author_member_id, client_key)` only. If the clientKey matches and the payload matches, return the existing entity and its thread — do not 409 because the thread IDs differ.

### `content.getThread` pagination is reverse-direction

Newest page first, reversed before return. The cursor decoder must use ascending-keyset semantics for "next page = older." Do not reuse the `listEntities` cursor decoder.

### Repository interface changes will break unit fixtures

This plan changes response shapes and adds repo methods. That will break:

- `test/unit/fixtures.ts`
- inline repository doubles in `test/unit/app.test.ts`

Update these deliberately once the new contract is in place.

### `events.rsvp` validation needs explicit kind check

Today `events.rsvp` implicitly validates `kind='event'` via the query that joins `event_version_details`. After unification, if the query changes to use the generic entity read path, add an explicit check that the target entity has `kind='event'` before attempting the RSVP.

### Migration guard assertions

Before constraint changes, assert:

- no non-comment entities have `parent_entity_id` set
- no cross-club parent links exist
- no comment chains are cyclic
- all entities have `content_thread_id` after backfill (before adding NOT NULL)

### Implementation ordering

1. **Migration + init.sql** — enum cleanup, content_threads, backfill
2. **Schema types** — unified ContentEntity, thread shapes, event fields in content schemas
3. **Contract** — merge event + content interfaces
4. **Content unification** — collapse event write/read into content paths
5. **Threading read path** — listContentThreads, readContentThread
6. **Threading write path** — threadId in content.create, last_activity_at updates
7. **Worker updates** — synchronicity thread-position check
8. **Tests**
9. **Snapshot + docs**

Get the migration right first. Content unification before threading. Threading builds on the unified model.
