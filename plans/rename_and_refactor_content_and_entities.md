# Plan: Rename And Refactor Content And Entities

## Context

This plan is intentionally aggressive.

- The codebase is still private.
- Breaking API changes are allowed.
- Database migration is allowed.
- Backward compatibility is not a goal.

The current threaded public-content work shipped a good product model, but it left the codebase with a mixed vocabulary:

- the public namespace is `content.*`
- thread containers are `content_threads`
- the authored rows are still `entities`
- versions are still `entity_versions`
- the public wire type is still `ContentEntity`
- the generic structured version field is still `version.content`

That is not a clean system. It works, but it does not read cleanly, teach cleanly, or invite contribution cleanly.

This plan fixes that from first principles.

## Problem Statement

There are two separate issues:

### 1. The runtime model is now `content`, not `entity`

The product language, action namespace, and mental model are all content-centric:

- members create content
- content lives in threads
- content can be an event, ask, gift, opportunity, service, or post
- content appears in thread feeds and event lists

`entity` is now a historical storage term that leaked forward.

### 2. The word `content` is overloaded in one genuinely confusing place

Today, one response can contain all of these at once:

- `content.create`
- `ContentEntity`
- `version.content`

That is the real naming collision. If we want `content` to be the primary noun, `version.content` cannot survive.

## Goals

1. Use one coherent noun family across API, code, docs, and schema.
2. Remove vestigial schema from the pre-threaded model.
3. Make public content shapes read naturally to new contributors.
4. Keep the existing threaded behavior unless a rename naturally improves the wire shape.
5. Avoid introducing a third noun like `entry`, `item`, or `record`.
6. Land in a state that feels final enough for open source.

## Non-Goals

This is **not** a redesign of the public-content product model.

The following remain as-is:

- public content stays threaded
- `content.create` remains the primary write path
- `events.list` remains a flat upcoming-events read surface
- `events.rsvp` and `events.cancelRsvp` remain event-specific actions
- removed content remains redacted in thread reads
- matching still only uses thread-position-1 content
- DMs remain a separate system

This plan is a vocabulary and schema cleanup on top of the existing threaded design.

## Design Decision

### Adopt `content` as the single public-content noun everywhere

This plan removes `entity` from the active public-content stack.

That means:

- public API uses `content`
- TypeScript domain types use `Content`
- schema tables/views use `content`
- repository methods use `content`
- docs use `content`

The one exception is historical migration context inside old migration files and archived planning docs.

### Rename the generic version field to `payload`

If `content` becomes the canonical noun, `version.content` must become `version.payload`.

This is a required part of the rename, not an optional polish pass.

Without this change we end up with a broken shape:

- `content.create` returns `Content`
- `Content.version.content`

That is exactly the collision we should eliminate now.

## Durable Design Calls

These decisions are part of the plan and should not be casually reopened during implementation.

1. The active public-content model uses `content`, not `entity`.
2. The generic structured version field is renamed from `content` to `payload`.
3. `parent_entity_id` is removed entirely in a new migration.
4. There will be no compatibility aliases such as dual `entityId`/`id` fields, compatibility SQL views, or duplicate repository methods.
5. The rename is comprehensive across API, code, schema, tests, and docs.
6. Historical migration files are not rewritten except when required to preserve current deployability; the rename lands as a new follow-up migration.
7. The threaded behavior already shipped remains the product baseline; this plan is about naming clarity and schema cleanup, not rethinking threads.

## Target Vocabulary

### Public API

- namespace: `content.*`
- resource type: `Content`
- thread type: `ContentThread`
- thread summary type: `ContentThreadSummary`
- search result type: `ContentSearchResult`
- kind enum: `ContentKind`
- state enum: `ContentState`

### Persistence

- thread container table: `content_threads`
- authored unit table: `contents`
- version table: `content_versions`
- embedding table: `content_embeddings`
- current-version view: `current_content_versions`
- published-version view: `published_content_versions`
- live-content view: `live_content`

### Generic field names

- primary id in public wire format: `id`
- public thread reference: `threadId`
- public thread subject field: `firstContent`
- public count field: `contentCount`
- generic version payload: `payload`

### Why the table is `contents`

The API noun is `content`.

SQL tables still need a concrete table name for many rows of that resource. `contents` is the least bad answer that keeps the same noun family:

- it stays aligned with the public API
- it avoids introducing `item` / `entry` / `record`
- it reads naturally alongside `content_threads` and `content_versions`

The awkwardness of pluralizing a mass noun is smaller than the awkwardness of giving the same concept two different names.

## Explicit Rename Map

### Core schema

| Old | New |
|---|---|
| `entities` | `contents` |
| `entity_versions` | `content_versions` |
| `entity_embeddings` | `content_embeddings` |
| `current_entity_versions` | `current_content_versions` |
| `published_entity_versions` | `published_content_versions` |
| `live_entities` | `live_content` |
| `entity_kind` | `content_kind` |
| `entity_state` | `content_state` |
| `parent_entity_id` | removed |

### Core columns

| Old | New |
|---|---|
| `entity_id` | `content_id` |
| `entity_version_id` | `content_version_id` |
| `content_thread_id` | `thread_id` |
| `subject_entity_id` | `subject_content_id` |
| `event_entity_id` | `event_content_id` |
| `from_entity_id` | `from_content_id` |
| `from_entity_version_id` | `from_content_version_id` |
| `to_entity_id` | `to_content_id` |
| `to_entity_version_id` | `to_content_version_id` |

### Core TypeScript / contract types

| Old | New |
|---|---|
| `ContentEntity` | `Content` |
| `ContentEntitySearchResult` | `ContentSearchResult` |
| `EntitySummary` | removed |
| `EventSummary` | removed |
| `EntityKind` | `ContentKind` |
| `EntityState` | `ContentState` |
| `CreateEntityInput` | `CreateContentInput` |
| `UpdateEntityInput` | `UpdateContentInput` |
| `RemoveEntityInput` | `RemoveContentInput` |
| `ListEntitiesInput` | `ListContentInput` |

### Public wire fields

| Old | New |
|---|---|
| `entityId` | `id` |
| `contentThreadId` | `threadId` |
| `firstEntity` | `firstContent` |
| `entityCount` | `contentCount` |
| `entities` | `content` |
| `version.content` | `version.payload` |
| `eventEntityId` | `eventId` |

### Module and file names

| Old | New |
|---|---|
| `src/schemas/entities.ts` | `src/schemas/content.ts` |
| `src/clubs/entities.ts` | `src/clubs/content.ts` |
| `contentEntity` schema | `content` schema |
| `entityKind` schema | `contentKind` schema |
| `entityState` schema | `contentState` schema |

## Target API Shape

The rename is a chance to clean up the thread wire shapes, not just substitute nouns.

### `Content`

```ts
type Content = {
  id: string;
  threadId: string;
  clubId: string;
  kind: ContentKind;
  openLoop: boolean | null;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
    displayName: string;
  };
  version: {
    versionNo: number;
    state: ContentState;
    title: string | null;
    summary: string | null;
    body: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    createdAt: string;
    payload: Record<string, unknown>;
  };
  event: EventFields | null;
  rsvps: EventRsvpSummary | null;
  createdAt: string;
};
```

### `ContentThreadSummary`

```ts
type ContentThreadSummary = {
  id: string;
  clubId: string;
  firstContent: Content;
  contentCount: number;
  lastActivityAt: string;
};
```

### `ContentThread`

```ts
type ContentThread = {
  id: string;
  clubId: string;
  firstContent: Content;
  content: Content[];
  contentCount: number;
  lastActivityAt: string;
  hasMore: boolean;
  nextCursor: string | null;
};
```

Existing visibility behavior remains:

- removed first content is still surfaced as redacted
- expired first content may still appear in `firstContent` while being absent from `content`

Clients must not assume `firstContent === content[0]`.

### Action contract adjustments

The goal is to make the wire format read naturally.

- `content.create` returns `{ content: Content }`
- `content.update` returns `{ content: Content }`
- `content.remove` returns `{ content: Content }`
- `content.closeLoop` returns `{ content: Content }`
- `content.reopenLoop` returns `{ content: Content }`
- `content.getThread` returns `{ thread: ContentThread }`
- `content.searchBySemanticSimilarity` returns `results: ContentSearchResult[]`
- `events.list` returns `results: Content[]`
- `events.rsvp` returns `{ event: Content }`
- `events.cancelRsvp` returns `{ event: Content }`

Input cleanup:

- `content.update` takes `id`, not `entityId`
- `content.remove` takes `id`, not `entityId`
- `content.getThread` takes either `threadId` or `contentId`
- `events.rsvp` and `events.cancelRsvp` take `eventId`

## Why `content` Everywhere Instead Of Keeping `entity` Internally

The usual argument for keeping `entity` internally is boundary separation: persistence can use one vocabulary and the public contract another.

That is reasonable in a closed internal system.

It is less compelling here because:

- the repository layer is thin and exposed to contributors
- the API is agent-first and therefore the contract is the product
- this codebase will soon be open source
- the current threaded model is already content-shaped, not generic-entity-shaped

Open source contributors read the schema, the repo layer, the action schemas, the tests, and the docs. Giving those layers different nouns for the same thing creates friction without buying a meaningful abstraction benefit.

The cleanest end state is one noun.

## Why Not `content_item`, `entry`, or Another Third Noun

Those names solve countability but create a worse problem:

- the API says `content`
- the code says `entry` or `item`
- the contributor must keep translating

That is exactly the split we are trying to eliminate.

If we are willing to make a large pre-open-source rename, we should use that opportunity to remove vocabulary drift, not replace one drift with another.

## Schema Plan

Create a new migration after the threaded-content migration. Do **not** edit the historical threaded migration just to make the names prettier.

### Migration goals

1. Remove `parent_entity_id` and its index/foreign key.
2. Rename all active public-content tables, views, enums, and columns to `content*`.
3. Rename dependent foreign keys and indexes.
4. Rename generic version payload columns/fields from `content` to `payload`.
5. Preserve data exactly.
6. Keep the migration transactional and safe under `scripts/migrate.sh`.

### Migration outline

1. Drop or replace dependent views in dependency order.
2. Drop the dead `parent_entity_id` foreign key and index.
3. Drop the `parent_entity_id` column.
4. Rename enums:
   - `entity_kind` → `content_kind`
   - `entity_state` → `content_state`
5. Rename core tables:
   - `entities` → `contents`
   - `entity_versions` → `content_versions`
   - `entity_embeddings` → `content_embeddings`
6. Rename columns across all dependent tables:
   - `entity_id` → `content_id`
   - `entity_version_id` → `content_version_id`
   - `content_thread_id` → `thread_id`
   - other dependent foreign-key columns listed above
7. Rename views:
   - `current_entity_versions` → `current_content_versions`
   - `published_entity_versions` → `published_content_versions`
   - `live_entities` → `live_content`
8. Recreate indexes and constraints with matching names.
9. Update any SQL functions, triggers, or queue subject-kind values that still use `entity_version`.
10. Verify seeds and helper SQL no longer mention `entity` for active public content.

### Migration guardrails

- Do not keep compatibility views such as `entities AS SELECT * FROM contents`.
- Do not keep duplicate columns such as both `entity_id` and `content_id`.
- Do not do a partial rename that leaves live tables on old nouns and only changes TypeScript.

If we are going to do this, do it cleanly.

## Code Refactor Plan

### Contract and response schemas

Update:

- `src/contract.ts`
- `src/schemas/responses.ts`
- `src/schemas/fields.ts`
- `src/schemas/content.ts` (renamed from `entities.ts`)
- `src/schemas/events.ts`
- `src/schemas/clubadmin.ts`
- `src/schemas/superadmin.ts`

Specific work:

- rename `ContentEntity` → `Content`
- rename `version.content` → `version.payload`
- rename all `entityId` wire fields to `id` or `contentId` depending on context
- rename `contentThreadId` → `threadId`
- rename `firstEntity` → `firstContent`
- rename `entityCount` → `contentCount`
- simplify `content.getThread` output to `{ thread: ContentThread }`

### Domain modules

Rename and refactor:

- `src/clubs/entities.ts` → `src/clubs/content.ts`
- repository interfaces from `createEntity`, `updateEntity`, `removeEntity`, `readContentEntity` to `createContent`, `updateContent`, `removeContent`, `readContent`

Keep behavior the same unless the new wire shape naturally collapses duplicate mapping code.

### Workers and background jobs

Update:

- embeddings worker
- similarity worker
- synchronicity worker
- any queue subject-kind strings

The rename should remove `entity` from the active public-content path, but it should not accidentally broaden or narrow matching/search behavior.

### SQL and mapping boundary

There will be a large mapping pass in `src/postgres.ts` and domain repository code.

This is the right place to make the new contract decisive:

- return `Content`
- not `ContentEntity`
- emit `payload`, not `content`
- emit `id`, not `entityId`

## Documentation Plan

Update active docs only. Historical plans can keep old terms if clearly archived.

Must update:

- `SKILL.md`
- `docs/design-decisions.md`
- `docs/self-hosting.md`
- any active implementation notes that still describe `entity` as the live public-content noun

Docs should explicitly say:

- public threaded content uses `content` across API, code, and schema
- `payload` is the generic structured version field
- `events.*` survives only for event-specific read/interaction surfaces

## Test Plan

This refactor touches almost every contract surface. The rename is incomplete until the tests and schema snapshot read cleanly.

Must update:

- `test/snapshots/api-schema.json`
- integration tests for all `content.*` and `events.*` actions
- unit tests that mock repository methods
- SQL-facing tests that assert column names or response shapes

Add explicit regression tests for:

- `content.getThread` response uses `thread.id`, `thread.firstContent`, `thread.contentCount`, and `thread.content`
- `events.rsvp` and `events.cancelRsvp` return `{ event: Content }`
- semantic search returns `ContentSearchResult[]`
- no active API response exposes `entityId`, `contentThreadId`, `firstEntity`, `entityCount`, or `version.content`

## Implementation Order

1. Write the rename migration first.
2. Test the migration against the current deployed schema using `reset-dev.sh` and `scripts/migrate.sh`.
3. Verify the migrated database manually.
4. Only then update `db/init.sql` to the target schema.
5. Update `db/seeds/dev.sql`.
6. Refactor contract/types/schemas.
7. Refactor domain code and workers.
8. Update tests and schema snapshot.
9. Update `SKILL.md` and `docs/design-decisions.md`.
10. Run the full test suite.

## Risks

### 1. Rename churn across a wide surface

This is a broad change. That is intentional. The answer is not to make it smaller; the answer is to execute it in one disciplined pass.

### 2. Partial rename temptation

The biggest implementation risk is stopping halfway:

- renaming the API but not the DB
- renaming tables but not docs
- renaming types but keeping `version.content`

That would leave the codebase more confusing than it is today.

### 3. Historical docs and archived plans

Some archived plans will still say `entity`. That is acceptable if they are clearly historical. Active docs should not.

## Recommendation

From first principles, the clean end state is:

- threaded public content remains the product model
- `entity` disappears from the active public-content stack
- `content` becomes the single noun across API, code, docs, and schema
- `version.payload` replaces `version.content`
- `parent_entity_id` is removed completely

If we are going to make a large pre-open-source cleanup, this is the one worth doing.
