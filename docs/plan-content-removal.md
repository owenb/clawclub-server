# Content Removal System: Implementation Plan

## Prerequisite check

Before starting this work, verify the permissions overhaul landed correctly. The following should all be true:

1. `src/schemas/admin.ts` does not exist — all actions are in `clubadmin.ts` or `superadmin.ts`
2. `ActionAuth` type is `'none' | 'member' | 'clubadmin' | 'superadmin'` in `src/schemas/registry.ts`
3. `MembershipSummary` has `role: 'clubadmin' | 'member'` and `isOwner: boolean` in `src/contract.ts`
4. `requireClubAdmin()` and `requireClubOwner()` exist in `src/dispatch.ts` — `requireClubAdmin` accepts both clubadmin role and superadmin
5. All `clubadmin.*` actions require explicit `clubId` — no scope inference
6. Superadmins can call all `clubadmin.*` write operations (repository queries use `actor_is_club_admin()` not `accessible_club_memberships` JOIN)
7. All unit tests pass (`npm run test:unit`)
8. All non-LLM integration tests pass (run each file individually)
9. `db/migrations/0078_clubadmin_role_enum.sql` and `0079_clubadmin_role.sql` exist

Run `npx tsc --noEmit` and `npm run test:unit` to confirm. If anything fails, fix it before proceeding.

## Background

ClawClub currently has two overlapping mechanisms for hiding content:

1. **Entity archiving** — appends a new `entity_version` with `state: 'archived'`. Author-only via `entities.archive`. The `live_entities` view filters to `state = 'published'`, so archived entities vanish from listings. There's also `superadmin.content.archive` for superadmin override.

2. **Redactions table** — a cross-cutting `app.redactions` table that can flag both entities and DM messages. `entities.redact` (author or club owner) and `messages.redact` (sender or club owner) insert rows. Listing queries filter redacted items via `NOT EXISTS` subqueries (entities) or `LEFT JOIN` with text blanking (messages).

Both mechanisms hide content from normal reads and preserve the original data. Neither deletes anything. But having two systems creates confusion for agents (which one to call?) and cross-cutting query complexity (every entity listing, embedding function, and the pending_member_updates view must check the redactions table).

## Design decisions (already made)

- **One verb: `remove`.** Agents call `remove` to hide content. No choosing between "archive" and "redact."
- **Explicit authority separation.** Self-service removal and club admin moderation are separate actions — no magic commands that change behavior depending on who calls them.
- **Entity removal uses versioning.** Append a new `entity_version` with `state = 'removed'`. This is the natural extension of the existing versioning model. The `current_published_entity_versions` view already filters to `state = 'published'`, so removed entities automatically vanish from `live_entities`, all listing queries, and all embedding operations.
- **Message removal uses a dedicated append-only table.** Messages have no versioning. A `dm_message_removals` table records removals without mutating `dm_messages` rows.
- **Delete `app.redactions`.** The generic cross-cutting table goes away. Entity visibility is determined by version state. Message visibility is determined by the removal table.
- **Events get their own `remove` actions.** Events are entities with `kind = 'event'` but have their own type system (`EventSummary`, not `EntitySummary`) and their own action family (`events.create`, `events.list`, `events.rsvp`). The `entityKind` enum (`post | opportunity | service | ask`) excludes events. So events get `events.remove` (self-service) and `clubadmin.events.remove` (moderation) — same verb, same semantics, correct return types. The underlying storage mechanism is identical (append a version with `state = 'removed'`), just the action surface is separate.

## New action surface

**Self-service (auth: 'member'):**
- `content.remove` — author removes their own entity. Replaces both `entities.archive` and `entities.redact` for the author case. `reason` is optional.
- `events.remove` — author removes their own event. Same semantics as `content.remove` but returns `EventSummary`. `reason` is optional.
- `messages.remove` — sender removes their own message. Replaces `messages.redact` for the sender case. `reason` is optional.

**Club admin moderation (auth: 'clubadmin'):**
- `clubadmin.content.remove` — club admin removes any entity in their club. Replaces `entities.redact` for the owner case. `reason` is **required** — moderators must justify removal.
- `clubadmin.events.remove` — club admin removes any event in their club. `reason` is **required**.
- `clubadmin.messages.remove` — club admin removes any message in their club. Replaces `messages.redact` for the owner case. `reason` is **required**.

**Superadmin:** No separate superadmin removal actions. Superadmins call `clubadmin.content.remove` and `clubadmin.messages.remove` directly — the permissions system already grants superadmins access to all `clubadmin.*` actions. They pass a `clubId` and a `reason` like any other club admin.

**Actions to delete:**
- `entities.archive` (member)
- `entities.redact` (member)
- `messages.redact` (member)
- `superadmin.content.archive` (superadmin)
- `superadmin.content.redact` (superadmin)
- `superadmin.messages.redact` (superadmin)

## Important: read these files first

Before making any changes, read and understand these files thoroughly.

**Current removal mechanisms:**
- `src/schemas/entities.ts` — `entities.archive` (~line 164) and `entities.redact` (~line 214) action definitions
- `src/schemas/messages.ts` — `messages.redact` (~line 254) action definition
- `src/schemas/superadmin.ts` — `superadmin.content.archive`, `superadmin.content.redact`, `superadmin.messages.redact`
- `src/postgres/redactions.ts` — full `redactEntity()` and `redactMessage()` implementations
- `src/postgres/entities.ts` — `archiveEntity()` implementation (~line 347), `listEntities()` with redaction NOT EXISTS (~line 514)
- `src/postgres/embeddings.ts` — `findViaEmbedding` with redaction NOT EXISTS (~line 283)

**Database views and functions that reference redactions:**
- `db/migrations/0062_rename_transcripts_to_dm_and_add_redactions.sql` — `app.redactions` table, `pending_member_updates` view (LEFT JOINs for both dm_message and entity redactions), `current_dm_inbox_threads` view (exposes raw message_text without redaction filtering — this is a known bug)
- `db/migrations/0070_embeddings_v2_fixes.sql` — 3 embedding locations that check redactions: RLS policy on `embeddings_entity_artifacts` (line 28), `embeddings_list_entities_needing_artifacts` (line 51), `embeddings_load_entity_version` (line 85). All three ALSO check `cev.state = 'published'`, making the redaction checks redundant once removal is version-based.
- `db/migrations/0064_add_location_to_entity_versions.sql` — `live_entities` view (joins through `current_published_entity_versions`)

**Message queries with redaction LEFT JOINs:**
- `src/postgres/messages.ts` — three locations (~lines 178, 279, 318) that LEFT JOIN `app.redactions` and blank message text

**Contract and types:**
- `src/contract.ts` — `ArchiveEntityInput`, `archiveEntity()`, `adminArchiveEntity()`, `redactEntity()`, `redactMessage()`, `RedactionResult`
- `src/schemas/fields.ts` — `entityState` enum (`draft | published | archived`)
- `src/schemas/registry.ts` — `RepositoryCapability` (includes `archiveEntity`, `adminArchiveEntity`, `redactEntity`, `redactMessage`)
- `src/schemas/responses.ts` — `redactionResult` response schema

**Tests:**
- `test/app.test.ts` — unit tests for `entities.archive` 
- `test/integration/content.test.ts` — "author archives the post and it disappears from list"
- `test/integration/redaction.test.ts` — full redaction test suite (messages and entities)
- `test/integration/admin.test.ts` — `superadmin.content.archive`, `superadmin.content.redact`, `superadmin.messages.redact` tests

**Documentation:**
- `SKILL.md` — documents `entities.archive`, `entities.redact`, `messages.redact`, update topics
- `CLAUDE.md` — build/test commands

## Storage model

### Entities: version-based removal

Add `'removed'` to the `app.entity_state` Postgres enum (separate migration, must commit before using).

Add a nullable `reason` column to `app.entity_versions` (only populated on removal versions).

When `content.remove` or `clubadmin.content.remove` is called:
1. Look up the entity and its current version
2. Auth check: actor is author (for `content.remove`) or club admin (for `clubadmin.content.remove`)
3. If the current version is already `removed`, return it unchanged (idempotent)
4. Insert a new `entity_version` with `state = 'removed'`, `reason`, `created_by_member_id = actorMemberId`, `supersedes_version_id = current version id`
5. Emit `entity.removed` club activity update (unless `skipNotification`)
6. Return the entity summary with the removal version

The `current_published_entity_versions` view only shows `state = 'published'`. So the removed entity automatically vanishes from `live_entities`, all listing queries, embedding discovery, and embedding search.

**Important: entity reload helper.** The existing `readEntitySummary` helper in `src/postgres/entities.ts` (~line 127) hard-filters to `state = 'published'` and joins `app.redactions`. This helper is used to reload entity data after mutations. After implementing removal:
- The helper must be updated to work for removed entities too (the `content.remove` handler needs to return the entity with its removal version)
- Remove the `app.redactions` JOIN from the helper
- For the removal return path: use `current_entity_versions` (which shows any state) instead of `current_published_entity_versions` (which only shows published)
- Listing queries continue using `live_entities` / `current_published_entity_versions` to exclude removed entities

**Events and RSVP.** Events are entities with `kind = 'event'`. Removing an event must also prevent new RSVPs. The `rsvpEvent()` implementation in `src/postgres/events.ts` (~line 461) currently checks the root entity row but does NOT check whether the current version is still published. After this change, `rsvpEvent()` must additionally verify the event is currently published (via `entity_is_currently_published()` or joining `current_published_entity_versions`). Without this fix, users could RSVP to a removed event.

### Messages: dm_message_removals table

```sql
CREATE TABLE app.dm_message_removals (
  message_id app.short_id PRIMARY KEY REFERENCES app.dm_messages(id),
  club_id app.short_id NOT NULL REFERENCES app.clubs(id),
  removed_by_member_id app.short_id NOT NULL REFERENCES app.members(id),
  reason text,
  removed_at timestamptz NOT NULL DEFAULT now()
);
```

When `messages.remove` or `clubadmin.messages.remove` is called:
1. Look up the message and its club
2. Auth check: actor is sender (for `messages.remove`) or club admin (for `clubadmin.messages.remove`)
3. Insert into `dm_message_removals` with `ON CONFLICT (message_id) DO NOTHING` (idempotent)
4. If already removed, return existing state
5. Emit `dm.message.removed` member update (unless `skipNotification`)
6. Return the removal result

Message queries keep showing the message row in the thread but blank the text: `CASE WHEN dmr.message_id IS NOT NULL THEN '[Message removed]' ELSE tm.message_text END`.

## Database migration

Write TWO migration files (Postgres requires ADD VALUE to commit before the value can be used):

### Migration A: `0080_entity_removed_state.sql`
```sql
ALTER TYPE app.entity_state ADD VALUE IF NOT EXISTS 'removed';
```

### Migration B: `0081_content_removal.sql`

In order:

**1. Add `reason` column to `entity_versions`:**
```sql
ALTER TABLE app.entity_versions ADD COLUMN IF NOT EXISTS reason text;
```

**2. Create `dm_message_removals` table** with RLS, policies, and grants. Follow the same patterns as `app.redactions` in migration 0062:
- FORCE ROW LEVEL SECURITY
- Insert policy: `removed_by_member_id = current_actor_member_id()` or `current_actor_is_superadmin()` or `actor_is_club_admin(club_id)` (note: the column is `removed_by_member_id`, not `created_by_member_id`)
- Select policy: `actor_has_club_access(club_id)` or `current_actor_is_superadmin()`
- Grant SELECT and INSERT to `clawclub_app`

**3. Update `entity_versions` insert RLS policy** to allow club admins (not just authors) to insert removal versions. Add a new policy:
```sql
CREATE POLICY entity_versions_insert_club_admin_removal ON app.entity_versions
  FOR INSERT WITH CHECK (
    state = 'removed'
    AND (created_by_member_id)::text = (app.current_actor_member_id())::text
    AND EXISTS (
      SELECT 1 FROM app.entities e
      WHERE (e.id)::text = (entity_versions.entity_id)::text
        AND e.deleted_at IS NULL
        AND app.actor_is_club_admin(e.club_id)
    )
  );
```
This only allows club admin inserts for `state = 'removed'` versions — they can't create or update content.

**4. Migrate existing entity redactions → removal versions:**
```sql
INSERT INTO app.entity_versions (entity_id, version_no, state, reason, effective_at, content, supersedes_version_id, created_by_member_id)
SELECT
  e.id,
  cev.version_no + 1,
  'removed',
  r.reason,
  r.created_at,
  cev.content,
  cev.id,
  r.created_by_member_id
FROM app.redactions r
JOIN app.entities e ON e.id = r.target_id AND r.target_kind = 'entity'
JOIN app.current_entity_versions cev ON cev.entity_id = e.id
WHERE cev.state = 'published';
```
Only migrates entities whose current version is still published. If a redacted entity was later updated (new published version after redaction), the redaction was effectively overridden — skip it.

**5. Migrate existing `'archived'` versions to `'removed'`:**
```sql
UPDATE app.entity_versions SET state = 'removed' WHERE state = 'archived';
```

**6. Migrate existing message redactions → `dm_message_removals`:**
```sql
INSERT INTO app.dm_message_removals (message_id, club_id, removed_by_member_id, reason, removed_at)
SELECT r.target_id, r.club_id, r.created_by_member_id, r.reason, r.created_at
FROM app.redactions r
WHERE r.target_kind = 'dm_message'
ON CONFLICT (message_id) DO NOTHING;
```

**7. Update `pending_member_updates` view:**
Replace both redaction LEFT JOINs:
- Entity: replace `LEFT JOIN app.redactions r_entity ON r_entity.target_kind = 'entity' AND r_entity.target_id = mu.entity_id` + `WHERE r_entity.id IS NULL` with:
  ```sql
  WHERE (mu.entity_id IS NULL OR EXISTS (
    SELECT 1 FROM app.current_published_entity_versions cev WHERE cev.entity_id = mu.entity_id
  ))
  ```
  Use `current_published_entity_versions`, NOT `live_entities` — expiry should not suppress old update entries.
- Message: replace `LEFT JOIN app.redactions r_msg ON r_msg.target_kind = 'dm_message' AND r_msg.target_id = mu.dm_message_id` + `WHERE r_msg.id IS NULL` with:
  ```sql
  LEFT JOIN app.dm_message_removals dmr ON dmr.message_id = mu.dm_message_id
  WHERE dmr.message_id IS NULL
  ```

**8. Update `current_dm_inbox_threads` view** to honor `dm_message_removals` for the latest_message_text preview. This view currently exposes raw `message_text` without any redaction/removal filtering — this is a bug in the current system too. LEFT JOIN `dm_message_removals` and apply `CASE WHEN` blanking.

**9. Update embedding functions and RLS:**
- `embeddings_ea_select_actor_scope` policy: remove the `NOT EXISTS (SELECT 1 FROM app.redactions ...)` check. The existing `entity_is_currently_published()` call checks `state = 'published'` which excludes removed entities.
- `embeddings_list_entities_needing_artifacts` function: remove the `NOT EXISTS` redaction check. The existing `cev.state = 'published'` filter is sufficient.
- `embeddings_load_entity_version` function: remove the `NOT EXISTS` redaction check from the `is_current_published` calculation. The existing `ev.state = 'published'` check handles it.

**10. Drop `app.redactions`** table, its RLS policies, indexes, and grants. Do this LAST.

## Application code changes

### New action definitions

**`content.remove` in `src/schemas/entities.ts`:**
- `action: 'content.remove'`, `domain: 'content'`, `auth: 'member'`, `safety: 'mutating'`
- `authorizationNote: 'Only the original author may remove their own entity.'`
- Wire input: `{ entityId: string, reason?: string }` — reason is optional for self-service
- Wire output: `{ entity: entitySummary }`
- Handler: call `ctx.repository.removeEntity()` with `actorMemberId`, `accessibleClubIds`, `entityId`, `reason`. The repository enforces author-only.

**`messages.remove` in `src/schemas/messages.ts`:**
- `action: 'messages.remove'`, `domain: 'messages'`, `auth: 'member'`, `safety: 'mutating'`
- `authorizationNote: 'Only the sender may remove their own message.'`
- Wire input: `{ messageId: string, reason?: string }` — reason is optional for self-service
- Wire output: `{ removal: messageRemovalResult }` — new response type
- Handler: call `ctx.repository.removeMessage()` with `actorMemberId`, `accessibleClubIds`, `messageId`, `reason`. The repository enforces sender-only.

**`events.remove` in `src/schemas/events.ts`:**
- `action: 'events.remove'`, `domain: 'content'`, `auth: 'member'`, `safety: 'mutating'`
- `authorizationNote: 'Only the original author may remove their own event.'`
- Wire input: `{ entityId: string, reason?: string }` — reason is optional
- Wire output: `{ event: eventSummary }`
- Handler: call `ctx.repository.removeEvent()` with `actorMemberId`, `accessibleClubIds`, `entityId`, `reason`. The repository enforces author-only. Uses the same underlying version-based removal as `content.remove`.

**`clubadmin.content.remove` in `src/schemas/clubadmin.ts`:**
- `action: 'clubadmin.content.remove'`, `domain: 'clubadmin'`, `auth: 'clubadmin'`, `safety: 'mutating'`
- `authorizationNote: 'Club admin may remove any entity in their club. Reason is required for moderation audit trail.'`
- Wire input: `{ clubId: string, entityId: string, reason: string }` — reason is **required**, not optional
- Wire output: `{ entity: entitySummary }`
- Handler: `ctx.requireClubAdmin(clubId)`, then call `ctx.repository.removeEntity()` with `skipAuthCheck: true`, the `clubId`, and the required `reason`.

**`clubadmin.events.remove` in `src/schemas/clubadmin.ts`:**
- `action: 'clubadmin.events.remove'`, `domain: 'clubadmin'`, `auth: 'clubadmin'`, `safety: 'mutating'`
- `authorizationNote: 'Club admin may remove any event in their club. Reason is required.'`
- Wire input: `{ clubId: string, entityId: string, reason: string }` — reason is **required**
- Wire output: `{ event: eventSummary }`
- Handler: `ctx.requireClubAdmin(clubId)`, then call `ctx.repository.removeEvent()` with `skipAuthCheck: true`, `accessibleClubIds: [clubId]`, and the required `reason`.

**`clubadmin.messages.remove` in `src/schemas/clubadmin.ts`:**
- `action: 'clubadmin.messages.remove'`, `domain: 'clubadmin'`, `auth: 'clubadmin'`, `safety: 'mutating'`
- `authorizationNote: 'Club admin may remove any message in their club. Reason is required for moderation audit trail.'`
- Wire input: `{ clubId: string, messageId: string, reason: string }` — reason is **required**
- Wire output: `{ removal: messageRemovalResult }`
- Handler: `ctx.requireClubAdmin(clubId)`, then call `ctx.repository.removeMessage()` with `skipAuthCheck: true`, the `clubId`, and the required `reason`.

**No superadmin removal actions.** Superadmins call `clubadmin.content.remove` and `clubadmin.messages.remove` directly — they pass through `requireClubAdmin()` which accepts superadmins. They must provide a `clubId` and a `reason` like any other moderator.

### Delete these actions
- `entities.archive` from `src/schemas/entities.ts`
- `entities.redact` from `src/schemas/entities.ts`
- `messages.redact` from `src/schemas/messages.ts`
- `superadmin.content.archive` from `src/schemas/superadmin.ts`
- `superadmin.content.redact` from `src/schemas/superadmin.ts`
- `superadmin.messages.redact` from `src/schemas/superadmin.ts`

### Repository contract (`src/contract.ts`)

**Remove:**
- `ArchiveEntityInput` type
- `archiveEntity()` method
- `adminArchiveEntity()` method
- `redactEntity()` method
- `redactMessage()` method
- `RedactionResult` type

**Add:**
```typescript
type RemoveEntityInput = {
  actorMemberId: string;
  accessibleClubIds: string[];  // scopes the entity lookup — [clubId] for clubadmin, all clubs for self-service
  entityId: string;
  reason?: string | null;
  skipAuthCheck?: boolean;      // true for clubadmin path (auth already checked by handler)
  skipNotification?: boolean;
};

type RemoveMessageInput = {
  actorMemberId: string;
  accessibleClubIds: string[];  // scopes the message lookup
  messageId: string;
  reason?: string | null;
  skipAuthCheck?: boolean;
  skipNotification?: boolean;
};

type MessageRemovalResult = {
  messageId: string;
  clubId: string;
  removedByMemberId: string;
  reason: string | null;
  removedAt: string;
};
```

The `accessibleClubIds` field provides club scoping. Self-service handlers pass all the actor's club IDs. Clubadmin handlers pass `[clubId]` — the single club they're moderating. This matches the existing pattern used by `clubadmin.memberships.setStatus` (passes `accessibleClubIds: [clubId]`) and other clubadmin handlers. The repository query then filters `e.club_id = any($N::app.short_id[])` to ensure the entity/message belongs to an authorized club.

Add to Repository:
```typescript
removeEntity?(input: RemoveEntityInput): Promise<EntitySummary | null>;
removeEvent?(input: RemoveEntityInput): Promise<EventSummary | null>;  // same input, different return type
removeMessage?(input: RemoveMessageInput): Promise<MessageRemovalResult | null>;
```

### Repository capabilities (`src/schemas/registry.ts`)

**Remove:** `'archiveEntity'`, `'adminArchiveEntity'`, `'redactEntity'`, `'redactMessage'`
**Add:** `'removeEntity'`, `'removeEvent'`, `'removeMessage'`

### Postgres implementation

**New file `src/postgres/removals.ts`** (or repurpose `src/postgres/redactions.ts`):

`removeEntity()`:
- Apply actor context with `accessibleClubIds`
- Look up entity and current version via `current_entity_versions`, scoped by `e.club_id = any($N::app.short_id[])` using `accessibleClubIds`
- If `skipAuthCheck` is false: verify actor is the author. Throw 403 otherwise.
- If current version is already `'removed'`: return the entity summary (idempotent)
- INSERT new entity_version with `state = 'removed'`, `reason`, `created_by_member_id`
- Emit `entity.removed` club activity (unless `skipNotification`)
- Return entity summary (using updated reload helper that works for removed versions)

`removeEvent()`:
- Same logic as `removeEntity()` but scoped to `kind = 'event'` and returns `EventSummary`
- The underlying storage operation is identical (append a `state = 'removed'` version)
- **Event reload path:** The existing `readEventSummary()` helper scopes via `accessible_club_memberships where member_id = $1`, which requires a real club membership. Superadmins calling `clubadmin.events.remove` may not have a membership row. The `removeEvent()` implementation must NOT use `readEventSummary()` for its reload. Instead, it should use a direct query scoped by `e.club_id = any($N::app.short_id[])` using `accessibleClubIds` (same pattern as the entity reload helper `readEntitySummary()`, which has no membership scoping). This reload query also needs to join `current_entity_versions` (not `current_published_entity_versions`) to return the removed version.

`removeMessage()`:
- Apply actor context
- Look up message and its club
- If `skipAuthCheck` is false: verify actor is the sender. Throw 403 otherwise.
- INSERT into `dm_message_removals` with ON CONFLICT DO NOTHING
- If already removed (conflict hit), reload and return existing removal
- Emit `dm.message.removed` member update (unless `skipNotification`)
- Return removal result

**Update `src/postgres/entities.ts`:**
- Remove `archiveEntity()` implementation entirely
- In `listEntities()`: remove the `NOT EXISTS (SELECT 1 FROM app.redactions ...)` filter. The `live_entities` view (which joins through `current_published_entity_versions`) already excludes removed entities.

**Update `src/postgres/messages.ts`:**
- Replace all 3 `LEFT JOIN app.redactions r ON r.target_kind = 'dm_message' AND r.target_id = tm.id` with `LEFT JOIN app.dm_message_removals dmr ON dmr.message_id = tm.id`
- Update `CASE WHEN` expressions: `CASE WHEN dmr.message_id IS NOT NULL THEN '[Message removed]' ELSE tm.message_text END`
- Also update payload blanking: `CASE WHEN dmr.message_id IS NOT NULL THEN null ELSE tm.payload END`

**Update `src/postgres/events.ts`:**
- Add `removeEvent()` implementation (delegates to the same version-insertion logic as `removeEntity` but scoped to `kind = 'event'` and returning `EventSummary`)
- Update `rsvpEvent()` (~line 461): add a check that the event is currently published. Either join `current_published_entity_versions` or call `entity_is_currently_published()`. Without this, users can RSVP to removed events.

**Update `src/postgres/embeddings.ts`:**
- In `findViaEmbedding` query (~line 283): remove the `NOT EXISTS (SELECT 1 FROM app.redactions ...)` filter. The existing `cev.state = 'published'` filter handles it.

**Delete `src/postgres/redactions.ts`.**

**Update `src/postgres.ts`:**
- Replace `import { buildRedactionsRepository } from './postgres/redactions.ts'` with `import { buildRemovalsRepository } from './postgres/removals.ts'`
- Update the repository composition

### TypeScript types

**`src/schemas/fields.ts`:** Update `entityState` to `z.enum(['draft', 'published', 'removed'])` — drop `'archived'` from the TypeScript type (the DB enum still has it).

**`src/schemas/responses.ts`:**
- Remove `redactionResult` schema
- Add `messageRemovalResult` schema
- Widen event `state` from `z.literal('published')` to `entityState` in `eventSummary` — events can now be `'removed'` when returned from `events.remove` / `clubadmin.events.remove`

**`src/contract.ts`:** Widen `EventSummary.version.state` from the hard-coded literal `'published'` to `EntityState` (i.e. `'draft' | 'published' | 'removed'`). This parallels `EntitySummary.version.state` which already uses `EntityState`.

**`src/postgres/events.ts`:** Widen the `EventRow.state` type from `'published'` to `EntityState`. The `mapEventRow()` function already just passes `row.state` through, so it needs no logic changes — only the type annotation.

**Update type casts:** Search for `'published' | 'archived'` in `src/postgres/entities.ts` and change to `'published' | 'removed'`.

### Update topics

- Replace `entity.version.archived` with `entity.removed`
- Replace `entity.redacted` with `entity.removed`
- Replace `dm.message.redacted` with `dm.message.removed`

### Stale embedding artifacts

When an entity is removed, its old embedding artifact remains in the DB. This is safe — `content.searchBySemanticSimilarity` joins through `current_entity_versions` and filters `cev.state = 'published'`, so removed entities never appear in search results. The artifacts are dead weight, not a correctness issue. Artifact pruning is a separate concern — do not attempt to fix it in this PR.

## Update SKILL.md

- Remove `entities.archive` from action list
- Replace `entities.redact` with `content.remove` — "remove an entity (author only)"
- Add `events.remove` — "remove an event (author only)"
- Replace `messages.redact` with `messages.remove` — "remove a message (sender only)"
- Add `clubadmin.content.remove`, `clubadmin.events.remove`, and `clubadmin.messages.remove` to the clubadmin section
- Remove `superadmin.content.archive`, `superadmin.content.redact`, `superadmin.messages.redact` from the superadmin section (superadmins use `clubadmin.content.remove`, `clubadmin.events.remove`, and `clubadmin.messages.remove` instead)
- Update the update topics table: replace `entity.version.archived` and `entity.redacted` with `entity.removed`; replace `dm.message.redacted` with `dm.message.removed`
- Update agent behavior guidance: replace "archive" and "redact" with "remove"

## Test plan

**Rewrite `test/integration/redaction.test.ts` → `test/integration/removal.test.ts`:**
- Author removes own entity (no reason) → disappears from `content.list`
- Author removes own entity (with optional reason) → reason stored on version
- Club admin removes member's entity via `clubadmin.content.remove` with required reason → disappears, `created_by_member_id` on removal version is the admin, reason is stored
- `clubadmin.content.remove` without reason → 400 invalid_input (reason is required for moderation)
- Non-author non-admin cannot remove → 403
- Superadmin calls `clubadmin.content.remove` successfully (with clubId and reason)
- Double remove is idempotent (returns current state, no error)
- Sender removes own message (no reason) → thread shows `[Message removed]`
- Club admin removes member message via `clubadmin.messages.remove` with required reason
- `clubadmin.messages.remove` without reason → 400 invalid_input
- Non-sender non-admin cannot remove → 403
- Superadmin calls `clubadmin.messages.remove` successfully
- Double message remove is idempotent
- Removed message disappears from inbox-targeted updates (`pending_member_updates`)
- `entity.removed` event appears in club activity feed (historical `entity.version.published` entries are NOT suppressed — the activity feed shows history, and the removal is its own event)
- Author removes own event via `events.remove` → event disappears from `events.list`
- Club admin removes event via `clubadmin.events.remove` with required reason
- RSVP on a removed event returns 404

**Update `test/integration/content.test.ts`:**
- Replace archive test with removal test

**Update `test/integration/admin.test.ts`:**
- Remove `superadmin.content.archive`, `superadmin.content.redact`, `superadmin.messages.redact` tests
- Verify superadmin can call `clubadmin.content.remove`, `clubadmin.events.remove`, and `clubadmin.messages.remove` (already tested via existing clubadmin superadmin bypass tests)

**Update unit tests (`test/app.test.ts`):**
- Remove `entities.archive` test
- Add `content.remove` and `messages.remove` tests

**Update `test/integration/llm-gated.test.ts`:**
- Replace `superadmin.content.archive` test with `clubadmin.content.remove` test (this test exercises the LLM-gated entity creation, then archives it — change to removal)

**Update `test/integration/smoke.test.ts`:**
- Action count changes
- Verify no `entities.archive`, `entities.redact`, `messages.redact` in schema

**Run all tests:**
```bash
npm run check
npm run test:unit
npm run test:integration:non-llm
npm run test:integration:with-llm
```
All must pass.

## What NOT to change

- **Club archiving** (`superadmin.clubs.archive`) — different concept, stays.
- **`entities.archived_at`** column on the entities root table — never written to, dead column, leave it.
- **`expires_at`** auto-expiry logic — continues to work unchanged.
- **`'draft'` and `'archived'` values in the Postgres `entity_state` enum** — leave them unused. Removing enum values from Postgres is painful.
- **`superadmin.content.list`** — this is a read action for listing content, not a removal action. Keep it.
- **`superadmin.messages.listThreads`** and **`superadmin.messages.getThread`** — read actions, keep them. `adminReadThread()` in `src/postgres/admin.ts` should continue showing raw message text (not blanked) for removed messages. Superadmins need to see what was removed. Do NOT join `dm_message_removals` in the admin read path.

## Phased execution

If you want to minimize risk, implement in this order:

1. **Migrations first** — add enum value, create table, update views/functions. Do NOT drop `app.redactions` yet.
2. **Add new actions** — `content.remove`, `events.remove`, `messages.remove`, `clubadmin.content.remove`, `clubadmin.events.remove`, `clubadmin.messages.remove`.
3. **Delete old actions** — `entities.archive`, `entities.redact`, `messages.redact`, `superadmin.content.archive`, `superadmin.content.redact`, `superadmin.messages.redact`.
4. **Remove redaction query hooks** — entity listing, embeddings, message queries.
5. **Migrate data** — existing redactions → new mechanisms.
6. **Drop `app.redactions`** — last step.
7. **Update tests, docs, snapshot.**

But if you're confident (and all tests pass at each step), you can do it in one migration + one code PR.
