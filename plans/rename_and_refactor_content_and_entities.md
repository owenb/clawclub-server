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
- the wire ID fields are still `entityId`, `entityVersionId`, and their ref-positional cousins

That is not a clean system. It works, but it does not read cleanly, teach cleanly, or invite contribution cleanly.

This plan fixes that from first principles.

### Surfaces added since this plan was first drafted

The following redesigns have shipped and are live in production. Their surfaces are absorbed (or excluded) from this rename's scope:

**System notifications rewrite (migration 007) and mentions (migration 006)**

- `signal_deliveries` has already been renamed to `member_notifications`. This plan does **not** touch the table name again — it only renames the `entity_id` column and its foreign key (`member_notifications_entity_fkey` → `member_notifications_content_fkey`).
- New table `entity_version_mentions` is pulled in and renames to `content_version_mentions`. Its own `entity_version_id` column follows the general `entity_version_id → content_version_id` rule.
- New read surfaces `activity.*` and `notifications.*` ship with response types (`ActivityEvent`, `NotificationItem`, `NotificationReceipt`) that carry `entityId` / `entityVersionId` wire fields. Those fields are pulled into the rename map below.
- The `updates.*` namespace, the `PendingUpdate` type, the `memberUpdates` polling response, and `sharedContext.pendingUpdates` have all been deleted by the system-notifications rewrite. They are no longer rename targets — they do not exist. The envelope now carries `sharedContext.notifications: NotificationItem[]`, and the rename cascades through the `NotificationItem` definition in `src/schemas/responses.ts`.
- New code files `src/mentions.ts`, `src/schemas/activity.ts`, and `src/schemas/notifications.ts` are in scope for internal column and type references. `src/notifications-core.ts` exists but carries no entity-named fields and needs no edits.

**Unified club join (migration 008, plans/unified-club-join-redesign.md)**

The admissions-era surfaces have been deleted entirely and replaced by application-state on `club_memberships`. This redesign is **orthogonal to the entity → content rename**: a grep of `src/clubs/unified.ts`, `src/schemas/clubs.ts`, `src/schemas/invitations.ts`, `src/identity/memberships.ts`, and `src/quality-gate.ts` finds zero new entity references. Nothing new is pulled into scope. The relevant consequences for this plan are:

- `admissions.*` namespace, `admissions`/`admission_versions`/`admission_challenges`/`admission_attempts` tables, `current_admissions` view, and the `source_admission_id` columns are all gone. They are not rename targets.
- `clubadmin.admissions.get` has been renamed to `clubadmin.memberships.get`. Any earlier draft of this plan that referenced `clubadmin.admissions.get` is stale — it does not exist.
- `NotificationItem.ref.admissionId` has been replaced by `NotificationItem.ref.membershipId`. The `ref.entityId` field is still present and still renames to `ref.contentId`.
- The derived pending-application notification now reads from `club_memberships` + `club_membership_state_versions` instead of `current_admissions`. No entity naming in this path. No rename-plan impact.
- New tables `invitations` and `application_pow_challenges` have no entity references. Not in scope.
- New actions (`clubs.join`, `clubs.applications.submit`, `clubs.applications.get`, `clubs.applications.list`, `invitations.issue`, `invitations.revoke`, `invitations.list`, `clubadmin.memberships.get`) are content-clean from day one.

**Migration 009 (global content quota default)** is a quota-policy adjustment with no entity-naming impact. Not in scope.

**Migration 010 (rename `admission_generated` → `application_generated`)** is a profile-generation-source value rewrite with no entity-naming impact. Not in scope.

**Migration 011 (delete handles)** removed the `handle` column from `members` and restructured mention storage. Wire shapes (`memberRef`, `includedMember`, `mentionSpan`, `contentAuthorRef`, `membershipSummary`, etc.) no longer carry `handle` / `handleHistory`. This plan's target `Content.author` shape is updated to drop `handle`. No entity-naming impact.

**Migration 012 (kill the untyped public JSON surface) — this eliminates two of the original plan's biggest items.**

- `entity_versions.content` (the generic JSONB payload column) has been **dropped**. It was not renamed to `payload`; the entire untyped JSON surface was removed by design. `ContentEntity.version` no longer has a `content` / `payload` field. Neither `content.create` nor `content.update` accepts a `content` / `payload` input field. The plan's "Rename the generic payload field to `payload`" direction is therefore obsolete — there is no generic payload field to rename on either input or output, and no collision to eliminate.
- `entities.parent_entity_id`, its FK, and its index have been **dropped**. The plan's original `parent_entity_id` removal step is already complete.
- `member_club_profile_versions.profile` (another untyped JSON column) is also gone; not in scope either way.
- Consequence for this plan: the rename surface is purely structural now — table/column/enum/type/wire-field renames only. No value rewrites, no column drops, no input/output payload-field renames.

**Migration 013 (auto-comp owners, remove clubadmin access bypass)** retargeted the `accessible_club_memberships` view; no entity-naming impact.

**Migration 014 (content gate redesign)** renamed `ai_llm_usage_log.gate_name` → `artifact_kind`, rewrote the gate status enum, and added a `feedback` column. No entity-naming impact.

**Admin / member read surfaces split (commit `353a652`, no migration)** introduced `publicMemberSummary`, `adminMemberSummary`, `adminApplicationSummary` wire shapes; rewrote `clubadmin.memberships.*` into `clubadmin.members.*` + `clubadmin.applications.*`; added `members.get`; added a `vouch.received` notification topic. A grep of `src/schemas/clubadmin.ts`, `src/schemas/clubowner.ts`, `src/schemas/superadmin.ts`, `src/clubs/welcome.ts`, and the new member/application summary shapes in `responses.ts` finds zero new entity references. Nothing new is pulled into rename scope.

**New `included: IncludedBundle` response sidecar** ships on every content-related action output (`content.create`, `content.update`, `content.remove`, `content.closeLoop`, `content.reopenLoop`, `content.getThread`, `content.list`, `content.searchBySemanticSimilarity`, `events.list`, `events.rsvp`, `events.cancelRsvp`). Shape is `{membersById: Record<string, includedMember>}` — carries resolved member references so that mention spans (which now encode `memberId` instead of handle) can be rendered without round-trips. This sidecar is NOT entity-named and needs no rename, but every action's target output in this plan's "Action contract adjustments" section now also carries it.

**New `version.mentions` field on `ContentEntity`:** `{title: MentionSpan[], summary: MentionSpan[], body: MentionSpan[]}`. Populated by the mentions work. Not entity-named; stays unchanged by the rename.

**Updated CLAUDE.md migration-testing rules**

CLAUDE.md now requires migrations with `UPDATE`/`INSERT`/rewrite logic to be tested against representative pre-migration synthetic data, not empty databases. It also documents three recurring migration pitfalls: pending constraint trigger events blocking `ALTER TABLE`, `FOR EACH ROW` triggers not firing on empty tables, and `CHECK` constraint ordering in enum value rewrites. The rename migration for this plan is a pure schema rename — no value rewrites inside `entity_kind`/`entity_state`, no data backfill, no row-level rewrite — so an empty-DB test is sufficient to exercise every code path it contains, and none of the three pitfalls apply:

- No DEFERRABLE INITIALLY DEFERRED triggers exist on `entities`, `entity_versions`, `entity_embeddings`, or `entity_version_mentions`. The one deferred trigger in the schema (`club_memberships_require_profile_version_trigger`) is on `club_memberships` and is not touched by this migration.
- No `FOR EACH ROW` triggers that the rename migration's path depends on for correctness.
- The enum renames (`entity_kind → content_kind`, `entity_state → content_state`) are type renames, not value rewrites, so the CHECK-constraint-ordering rule does not apply. Existing values inside the enum (`post`, `ask`, `gift`, `service`, `opportunity`, `event`, `complaint`, `draft`, `published`, `removed`) are preserved verbatim.

The implementer must still follow the `reset-dev.sh` → `scripts/migrate.sh` → manual-verify → update-init.sql path per CLAUDE.md, and `db/init.sql` is now maintained as `pg_dump` output (≈3500 lines) — regenerated from the migrated database, not hand-edited.

## Problem Statement

The runtime model is now `content`, not `entity`. The product language, action namespace, and mental model are all content-centric:

- members create content
- content lives in threads
- content can be an event, ask, gift, opportunity, service, or post
- content appears in thread feeds and event lists

But `entity` still names the storage tables, the type (`ContentEntity`), the ID fields (`entityId`, `entityVersionId`), the thread-summary fields (`firstEntity`, `entityCount`), the thread body array field (`entities`), the enums (`entity_kind`, `entity_state`), and the module paths (`src/schemas/entities.ts`, `src/clubs/entities.ts`). It is a historical storage term that leaked forward and now sits alongside the `content.*` action namespace and the `content_threads` table, creating a split vocabulary that is tedious to teach and easy to trip over.

(The original draft of this plan also listed `version.content`, `parent_entity_id`, and a top-level `content` input field as collision points. Migration 012 has since eliminated all three by deleting the untyped JSON surface — those items are no longer rename targets.)

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

## Durable Design Calls

These decisions are part of the plan and should not be casually reopened during implementation.

1. The active public-content model uses `content`, not `entity`.
2. There will be no compatibility aliases such as dual `entityId`/`id` fields, compatibility SQL views, or duplicate repository methods.
3. The rename is comprehensive across API, code, schema, tests, and docs.
4. Historical migration files are not rewritten except when required to preserve current deployability; the rename lands as a new follow-up migration.
5. The threaded behavior already shipped remains the product baseline; this plan is about naming clarity and schema cleanup, not rethinking threads.

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
- public thread body array: `contents`
- public count field: `contentCount`

### Why the table is `contents`

The API noun is `content`.

SQL tables still need a concrete table name for many rows of that resource. `contents` is the least bad answer that keeps the same noun family:

- it stays aligned with the public API
- it avoids introducing `item` / `entry` / `record`
- it reads naturally alongside `content_threads` and `content_versions`

The awkwardness of pluralizing a mass noun is smaller than the awkwardness of giving the same concept two different names.

### ID parameter convention

Spell this out explicitly so the implementer does not mix the two styles mid-refactor:

- **Single-ID content actions take `id`.** `content.update({id})`, `content.remove({id})`, `content.closeLoop({id})`, `content.reopenLoop({id})`. The action namespace makes the type obvious; the parameter is just "the ID of the thing this action operates on."
- **Disambiguation and cross-reference actions take typed IDs.** `content.getThread({threadId?, contentId?})` needs both because either can resolve a thread. `events.rsvp({eventId})` uses `eventId` because the action name is `events.*` and the domain noun at the wire boundary is `event`. Any action that takes a reference to a content from outside the `content.*` namespace uses `contentId`.
- **Response primary IDs use `id`.** `Content.id`, `ContentThread.id`, `ContentThreadSummary.id`. Response reference IDs use typed forms: `Content.threadId`, `Content.clubId`, `activityEvent.contentId`, `notificationItem.ref.contentId`.

## Explicit Rename Map

### Core schema

| Old | New |
|---|---|
| `entities` | `contents` |
| `entity_versions` | `content_versions` |
| `entity_embeddings` | `content_embeddings` |
| `entity_version_mentions` | `content_version_mentions` |
| `current_entity_versions` | `current_content_versions` |
| `published_entity_versions` | `published_content_versions` |
| `live_entities` | `live_content` |
| `entity_kind` | `content_kind` |
| `entity_state` | `content_state` |

(`parent_entity_id` no longer appears in the rename map — migration 012 already dropped the column.)

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

These column renames apply everywhere the old names appear. Known dependent tables that must be updated in the migration:

- `content_versions` (was `entity_versions`) — `entity_id` → `content_id`
- `content_embeddings` (was `entity_embeddings`) — `entity_id`, `entity_version_id`
- `content_version_mentions` (was `entity_version_mentions`) — `entity_version_id` → `content_version_id`
- `event_version_details` — `entity_version_id` → `content_version_id`
- `event_rsvps` — `event_entity_id` → `event_content_id`
- `club_edges` — `from_entity_id`, `from_entity_version_id`, `to_entity_id`, `to_entity_version_id`
- `club_activity` — `entity_id`, `entity_version_id`
- `member_notifications` — `entity_id` → `content_id` with FK `member_notifications_entity_fkey` → `member_notifications_content_fkey`
- `signal_background_matches` and `signal_recompute_queue` — any `entity_*` columns that still exist

The implementer must grep `db/init.sql` for `entity_id` / `entity_version_id` before writing the migration; the list above is a checklist, not an exhaustive contract.

### Core TypeScript / contract types

| Old | New |
|---|---|
| `ContentEntity` | `Content` |
| `ContentEntitySearchResult` | `ContentSearchResult` |
| `ContentThreadSummary` | `ContentThread` (merged, see flat-shape decision) |
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
| `entities` | `contents` |
| `eventEntityId` | `eventId` |
| `activityEvent.entityId` | `activityEvent.contentId` |
| `activityEvent.entityVersionId` | `activityEvent.contentVersionId` |
| `notificationItem.ref.entityId` | `notificationItem.ref.contentId` |
| `notificationReceipt.entityId` | `notificationReceipt.contentId` |

(The top-level `content` input field and `version.content` output field were removed by migration 012 and are no longer rename targets.)

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
    mentions: {
      title: MentionSpan[];
      summary: MentionSpan[];
      body: MentionSpan[];
    };
  };
  event: EventFields | null;
  rsvps: EventRsvpSummary | null;
  createdAt: string;
};
```

(No `handle` on `author` — migration 011 removed handles. No `payload` / `content` on `version` — migration 012 removed the untyped JSON surface. `mentions` carries inline `[Name|memberId]` spans per the mentions work.)

### `ContentThread`

One flat thread-metadata type used by both `content.list` and `content.getThread`. There is no separate `ContentThreadSummary` — the two types collapse into this one under the flat shape decision below.

```ts
type ContentThread = {
  id: string;
  clubId: string;
  firstContent: Content;
  contentCount: number;
  lastActivityAt: string;
};
```

Pagination and the thread body live at the top level of the `content.getThread` response, next to `thread`, not inside it. See "Action contract adjustments" below.

Existing visibility behavior remains:

- removed first content is still surfaced as redacted
- expired first content may still appear in `firstContent` while being absent from the top-level `contents` array

Clients must not assume `thread.firstContent === contents[0]`.

### Action contract adjustments

The goal is to make the wire format read naturally. Every content-related action output also carries an `included: IncludedBundle` sidecar (shipped via the handles-deletion work); the rename does not touch that sidecar shape.

- `content.create` returns `{ content: Content, included: IncludedBundle }`
- `content.update` returns `{ content: Content, included: IncludedBundle }`
- `content.remove` returns `{ content: Content, included: IncludedBundle }`
- `content.closeLoop` returns `{ content: Content, included: IncludedBundle }`
- `content.reopenLoop` returns `{ content: Content, included: IncludedBundle }`
- `content.getThread` returns `{ thread: ContentThread, contents: Content[], hasMore: boolean, nextCursor: string | null, included: IncludedBundle }` — flat shape, pagination and the body array at the top level alongside `thread`. The `thread` object is thread identity only, not a paginated container.
- `content.list` returns `results: ContentThread[]` + pagination + `included: IncludedBundle` — each result is a flat thread-identity summary.
- `content.searchBySemanticSimilarity` returns `results: ContentSearchResult[]` + `included: IncludedBundle`
- `events.list` returns `results: Content[]` + `included: IncludedBundle`
- `events.rsvp` returns `{ event: Content, included: IncludedBundle }`
- `events.cancelRsvp` returns `{ event: Content, included: IncludedBundle }`

Input cleanup:

- `content.update` takes `id`, not `entityId`
- `content.remove` takes `id`, not `entityId`
- `content.getThread` takes either `threadId` or `contentId`
- `events.rsvp` and `events.cancelRsvp` take `eventId`

(No input `content` / `payload` field rename — migration 012 removed the field on both actions entirely.)

**Thread response shape: locked to flat.** Pagination (`hasMore`, `nextCursor`) and the body array (`contents`) sit at the top level of the `content.getThread` response, next to `thread`, not inside it. Reasons: the `firstContent` / `contents[0]` distinction (expired-first-content stays in `firstContent` while being absent from `contents`) telegraphs more clearly when those fields live at different depths; `response.thread` becomes "thread identity" cleanly, cacheable independently of the current page; and it matches the pagination convention used by every other paginated action in the API. There is no separate `ContentThreadSummary` type — `ContentThread` is used everywhere a thread's metadata is returned.

**Structured metadata input / output: locked to absent.** `content.create` and `content.update` do not accept a generic structured metadata field on input (no `content`, no `payload`). `ContentEntity.version` does not expose a generic structured metadata field on output. Kind-specific structured data lives on a typed field (`event: EventFields` today; future kinds that need structure get their own typed fields). Rationale: the quality gate has to know what content to send to the legality filter, and a JSON escape hatch is structured-but-unvalidated input that bypasses the gate by construction. Typed fields per kind is the correct pattern.

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

1. Rename all active public-content tables, views, enums, and columns to `content*`.
2. Rename dependent foreign keys and indexes.
3. Preserve data exactly.
4. Keep the migration transactional and safe under `scripts/migrate.sh`.

### Migration outline

1. Drop or replace dependent views in dependency order.
2. Rename enums:
   - `entity_kind` → `content_kind`
   - `entity_state` → `content_state`
3. Rename core tables:
   - `entities` → `contents`
   - `entity_versions` → `content_versions`
   - `entity_embeddings` → `content_embeddings`
   - `entity_version_mentions` → `content_version_mentions`
4. Rename columns across all dependent tables (including `member_notifications`, `club_activity`, `club_edges`, `event_rsvps`, `event_version_details`, `signal_background_matches`):
   - `entity_id` → `content_id`
   - `entity_version_id` → `content_version_id`
   - `content_thread_id` → `thread_id`
   - other dependent foreign-key columns listed above
5. Rename views:
   - `current_entity_versions` → `current_content_versions`
   - `published_entity_versions` → `published_content_versions`
   - `live_entities` → `live_content`
   - any `current_event_versions` / `live_events` views rebuilt on the renamed base
6. Recreate indexes and constraints with matching names.
7. Update any SQL functions, triggers, or queue subject-kind values that still use `entity_version`.
8. Verify seeds and helper SQL no longer mention `entity` for active public content.

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
- `src/schemas/activity.ts` — update `ActivityEvent` to use `contentId` / `contentVersionId`
- `src/schemas/notifications.ts` — update `NotificationItem.ref` and `NotificationReceipt` to use `contentId`
- `src/schemas/clubadmin.ts`
- `src/schemas/superadmin.ts`

Specific work:

- rename `ContentEntity` → `Content`
- rename all `entityId` wire fields to `id` or `contentId` depending on context
- rename `contentThreadId` → `threadId`
- rename `firstEntity` → `firstContent`
- rename `entityCount` → `contentCount`
- rename the thread body field `entities` → `contents`
- rename `eventEntityId` input field (`events.rsvp` / `events.cancelRsvp`) → `eventId`
- leave `included: IncludedBundle` sidecar shape unchanged — it is not entity-named

### Domain modules

Rename and refactor:

- `src/clubs/entities.ts` → `src/clubs/content.ts`
- repository interfaces from `createEntity`, `updateEntity`, `removeEntity`, `readContentEntity` to `createContent`, `updateContent`, `removeContent`, `readContent`
- `src/mentions.ts` — update SQL against the renamed `content_version_mentions` table and rename internal `entity_version_id` references to `content_version_id`

Keep behavior the same unless the new wire shape naturally collapses duplicate mapping code.

### Workers and background jobs

Update:

- embeddings worker
- similarity worker
- synchronicity worker — also inserts into `member_notifications` with an `entity_id` reference that must become `content_id`
- any queue subject-kind strings

The rename should remove `entity` from the active public-content path, but it should not accidentally broaden or narrow matching/search behavior.

### SQL and mapping boundary

There will be a large mapping pass in `src/postgres.ts` and domain repository code.

This is the right place to make the new contract decisive:

- return `Content`, not `ContentEntity`
- emit `id`, not `entityId`
- emit `threadId`, not `contentThreadId`

## Documentation Plan

Update active docs only. Historical plans can keep old terms if clearly archived.

Must update:

- `SKILL.md`
- `docs/design-decisions.md`
- `docs/self-hosting.md`
- any active implementation notes that still describe `entity` as the live public-content noun

Docs should explicitly say:

- public threaded content uses `content` across API, code, and schema
- `events.*` survives only for event-specific read/interaction surfaces

## Test Plan

This refactor touches almost every contract surface. The rename is incomplete until the tests and schema snapshot read cleanly.

Must update:

- `test/snapshots/api-schema.json`
- integration tests for all `content.*`, `events.*`, `activity.*`, and `notifications.*` actions
- unit tests that mock repository methods
- SQL-facing tests that assert column names or response shapes

Add explicit regression tests for:

- `content.getThread` response is flat: `thread.id`, `thread.firstContent`, `thread.contentCount`, `thread.lastActivityAt` on the thread object; `contents`, `hasMore`, `nextCursor`, `included` at the top level
- `content.list` results are flat `ContentThread[]` (no separate `ContentThreadSummary` wrapper)
- `content.create`, `content.update`, `content.remove`, `content.closeLoop`, `content.reopenLoop` return `{ content: Content, included: IncludedBundle }`
- `events.rsvp` and `events.cancelRsvp` return `{ event: Content, included: IncludedBundle }`
- semantic search returns `ContentSearchResult[]` alongside `included: IncludedBundle`
- `activity.list` response items expose `contentId` and `contentVersionId`, not `entityId` / `entityVersionId`
- `notifications.list` items use `ref.contentId` when present
- `notifications.acknowledge` receipts use `contentId`
- no active API surface exposes `entityId`, `entityVersionId`, `contentThreadId`, `firstEntity`, `entityCount`, or `entities` (as a field name) — including `ActivityEvent`, `NotificationItem`, `NotificationReceipt`, and the admin read surfaces

## Pre-execution sanity checks

Run these before writing a single line of the rename migration. They exist to catch new `entity_*` surfaces that have landed between when this plan was last updated and when execution begins — the codebase is actively changing under concurrent feature work.

1. `git log --oneline main -- db/migrations src/schemas src/clubs src/identity src/workers src/mentions.ts src/notifications-core.ts | head -20` — confirm no migration after the one named at the end of the "Surfaces added since this plan was first drafted" section has touched entity-shaped schema. If anything new has landed, reconcile the rename map against it before continuing.
2. Grep the repo for `entity_id`, `entity_version_id`, `entityId`, `entityVersionId`, `ContentEntity`, `entity_kind`, `entity_state`, `entity_version_mentions`, `parent_entity_id`, `firstEntity`, `entityCount`, `contentThreadId`, `eventEntityId`. Every match should be covered by a row in the rename map below. If any match is uncovered, add it before starting.
3. Establish the baseline: `npx tsc --noEmit`, `npm run test:unit`, `npm run test:integration:non-llm` must all pass on the branch tip before the rename starts. If they don't, fix first.
4. Regenerate `test/snapshots/api-schema.json` from the current `main` and commit that regeneration separately if it has drifted — the rename should produce a clean diff from a clean base, not a rename diff tangled with other drift.

## Implementation Order

The rename lands as migration **015** (the next unused number after `014_content_gate_redesign.sql`). Bump `package.json` patch version (e.g. `0.2.70` → `0.2.71`) at commit time per CLAUDE.md.

1. Write the rename migration first (`db/migrations/015_rename_entities_to_contents.sql`).
2. Test the migration against the current deployed schema using `reset-dev.sh` and `scripts/migrate.sh`.
3. Verify the migrated database manually — inspect table names, enum names, view definitions, and spot-check column renames on every table listed in the "Known dependent tables" checklist.
4. Only then update `db/init.sql` to the target schema. Because `init.sql` is now `pg_dump` output, regenerate it from the migrated scratch DB rather than hand-editing: `pg_dump --schema-only --no-owner --no-privileges <scratch_db> > db/init.sql`, then diff against the previous `init.sql` to sanity-check that only the renamed surface changed.
5. Update `db/seeds/dev.sql`.
6. Refactor contract/types/schemas in `src/contract.ts`, `src/schemas/*.ts`.
7. Refactor domain code and workers (`src/clubs/entities.ts` → `content.ts`, `src/postgres.ts`, `src/workers/*`, `src/mentions.ts`).
8. Update tests and regenerate `test/snapshots/api-schema.json`.
9. Update `SKILL.md` and `docs/design-decisions.md`.
10. Run the full test suite (`npm run check`, `npm run test:unit`, `npm run test:integration:non-llm`, and at least one pass of `npm run test:integration:with-llm`).

## Post-execution verification

Do these before opening the PR. They are the last chance to catch a partial landing.

1. **Grep for leftover entity names.** After the rename lands locally, search the repo for `entity_id`, `entity_version_id`, `entityId`, `entityVersionId`, `ContentEntity`, `EntityKind`, `EntityState`, `entity_kind`, `entity_state`, `parent_entity_id`, `firstEntity`, `entityCount`, `contentThreadId`, `eventEntityId`, `createEntity`, `updateEntity`, `removeEntity`, `ListEntitiesInput`, `CreateEntityInput`, `UpdateEntityInput`, `RemoveEntityInput`, `entity_version_mentions`, `current_entity_versions`, `published_entity_versions`, `live_entities`. Every remaining hit must be either in `db/migrations/00*-01*.sql` (historical, frozen), in `plans/` archived planning docs, or on an explicit allowlist. No survivors in active code, active tests, active docs, or current migrations.
2. **Schema snapshot diff review.** Read `test/snapshots/api-schema.json`'s diff line-by-line. That diff IS the public contract change. Confirm that every removal corresponds to a planned rename and every addition corresponds to its paired new name. No stray additions, no unexpected removals.
3. **Integration test green.** `npm run test:integration:non-llm` and `npm run test:integration:with-llm` both pass. The with-llm pass is load-bearing because content.create / content.update routes through the legality gate — a rename that silently breaks the gate surface will only show up here.
4. **Manual smoke test.** Start the dev server, call `content.create`, `content.getThread`, `content.update`, `content.remove`, `events.list`, `events.rsvp`, `activity.list`, `notifications.list` against the new schema. Confirm the wire field names are all new.
5. **Version bump present.** `package.json` patch version must be incremented.

## Adjacent improvements worth bundling

These are not strictly part of the rename, but the rename PR is the cheapest moment to land them because they touch the same action schemas and the same types. Treat each as a "land if easy, defer cleanly if not" item — do not block the rename on them.

1. **Add `content.get({id}) → { content: Content, included: IncludedBundle }`.** The current API has no singular-read for a content item. If an agent receives a `contentId` from a notification or a search result and wants the current state of just that one item, the only path today is `content.getThread`, which fetches the whole thread. A `content.get` action closes that gap. It is ~15 lines: accept `id`, call the existing repository helper, return `{ content, included }`.

## Risks

### 1. Rename churn across a wide surface

This is a broad change. That is intentional. The answer is not to make it smaller; the answer is to execute it in one disciplined pass.

### 2. Partial rename temptation

The biggest implementation risk is stopping halfway:

- renaming the API but not the DB
- renaming tables but not docs
- renaming types but missing some wire field (e.g. activityEvent.entityId, notificationItem.ref.entityId)
- renaming module files but leaving repository methods on old names

That would leave the codebase more confusing than it is today.

### 3. Historical docs and archived plans

Some archived plans will still say `entity`. That is acceptable if they are clearly historical. Active docs should not.

## Recommendation

From first principles, the clean end state is:

- threaded public content remains the product model
- `entity` disappears from the active public-content stack
- `content` becomes the single noun across API, code, docs, and schema

The two original heavy-lift items (`parent_entity_id` removal and `version.content` elimination) have already shipped in migration 012 via the untyped-JSON-surface cleanup. What remains is a pure structural rename: tables, enums, columns, types, wire fields, modules, and repository methods. If we are going to make a large pre-open-source cleanup, this is the one worth doing.
