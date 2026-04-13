# Plan: Updates Transport Rewrite Around First Principles

## Status

These decisions are **locked**. Prior revisions of this plan went through multiple compromise shapes trying to minimize churn at the expense of clarity. We are no longer optimizing for churn. We are optimizing for the long-term shape the system should have had from the start.

The only constraint is data-migration safety. Code churn, schema churn, action renames, test rewrites, and doc rewrites are all free. Any reviewer re-reading this plan should pressure-test it for implementation traps, not re-open the direction.

This revision integrates the multi-round review findings around migration topic mapping, schema-endpoint wiring, dispatch-layer side-effect imports, `listInboxSince` preservation requirements, rename inventory, piggyback edge semantics, and the stream frame rules.

### Line numbers are hints, not targets

Every file + line citation in this plan is a **pointer**, not a contract. The codebase is actively changing under unrelated feature work, and prior revisions of this plan have had citations drift by 5–50 lines. Before editing any file, `rg` the nearest stable symbol (function name, variable name, distinctive string) and resolve the current line yourself. Do not grep by line number — grep by symbol.

## Recommendation

Delete the merged-tape abstraction entirely. Split it into the surfaces that match the four distinct things a member actually cares about: club activity, personal notifications, DMs, and calendar events. Rename `signal_deliveries` to `member_notifications` to reflect what it has always actually been. Repurpose the existing (but unused) envelope piggyback field so notifications ride along on every authenticated response, gated by a strict per-request caching rule so the piggyback never pays more than one notification read per request.

## The single load-bearing insight

`signal_deliveries` has always been `member_notifications` in disguise. The columns today in `db/init.sql` (rg `CREATE TABLE signal_deliveries`): `id`, `recipient_member_id`, `club_id`, `seq`, `topic`, `payload`, `entity_id`, `match_id`, `acknowledged_state`, `acknowledged_at`, `suppression_reason`, `created_at`. That is the per-recipient materialized notification table. The vocabulary got frozen around synchronicity — the first use case — when it should have been generalized. Every prior revision of this plan sketched a future `member_notifications` table that would need to be built in "Phase 2". It doesn't need to be built. It needs to be renamed.

Once you accept that rename, the entire "merged updates tape" abstraction collapses. There is no tape. There is club activity, personal notifications, DM inbox, and calendar events — four honest concepts, each with its own cursor model, its own ack semantics, and its own typed item shape.

## Locked decisions

1. **Four canonical read surfaces.** `activity.*`, `notifications.*`, `messages.*`, `events.*`. Nothing else.
2. **Delete the `updates.*` namespace entirely.** `updates.list`, `updates.acknowledge`, `/updates/stream`, `PendingUpdate`, `memberUpdates`, `pollingResponse`, the compound cursor, `Repository.listMemberUpdates`, `Repository.getLatestCursor`, `Repository.acknowledgeUpdates`. All gone.
3. **Rename `signal_deliveries` to `member_notifications`** via data migration. Keep all columns, keep all data, update stored `topic` values to the new vocabulary, drop `NOT NULL` on `club_id` for future account-scoped notifications, rename the IDENTITY backing sequence, rename indexes and constraints (all of them, enumerated in the migration SQL below — not "figure it out from grep").
4. **Repurpose `sharedContext.pendingUpdates` as `sharedContext.notifications`**, typed `NotificationItem[]`, populated on every authenticated response by the dispatch layer. Strict per-request caching: one notification read per request, never more. This is the primary agent read path — `notifications.list` is a fallback for agents that want a forced refresh.
5. **Rename `/updates/stream` to `/stream`.** One SSE endpoint with typed frames for each concept.
6. **Rename the `updates` NOTIFY channel to `stream`.** One-line change in each trigger and in the listen statement.
7. **Synchronicity matching keeps its internal vocabulary for lifecycle state.** `signal_background_matches`, `signal_recompute_queue`, and the `signal_background_matches.signal_id` column stay named as-is. Only the user-visible delivery table (`signal_deliveries` → `member_notifications`) is renamed, and only its stored `topic` values get rewritten to the `synchronicity.*` vocabulary.
8. **Phase 0 ships `clubadmin.admissions.get` standalone.** Unchanged from prior plan revisions.
9. **Derived admissions notifications still live in `notifications.list`.** They are composed alongside materialized notifications from the table. FIFO cap, stable ordering, `truncated` flag, all preserved.
10. **Typed wakeup cause plumbing.** NOTIFY triggers tag with `kind`, `waitForUpdate()` returns `{ outcome, cause? }`, a `NOTIFICATION_WAKEUP_KINDS` allowlist gates `notifications_dirty` emission.
11. **Existing `admission.submitted` activity append stays.** It is historical club activity, not a personal notification. The two are distinct and both valid.
12. **`member_notifications.club_id` becomes nullable in the migration.** Phase 2 account-scoped notifications must work without another schema migration.
13. **The DM stream read path is a first-class Repository primitive.** Extract from the merged-tape query into `Repository.listInboxSince`, preserving every behavior of the current inbox section (removed-message filter, sender display joins, sharedClubs resolution).
14. **Phase 1 extends the already-shipped stream scope refresh.** The old scope-refresh plan describes base behavior that is now in the codebase; this rewrite updates that existing machinery rather than introducing it from scratch.
15. **`getLatestActivityCursor` does NOT exist.** The existing seed-on-first-call behavior inside `listClubActivity` already handles `after='latest'` — the action handler resolves `'latest'` by passing `afterSeq: null` to `listClubActivity` and returning the resulting `nextAfterSeq` to the client.

## The four surfaces in full

### `activity.list` — club activity log

Cursor-forward log of things that happened broadcast-to-club.

- action: `activity.list`
- auth: `member`
- input: `{ clubId?: string, limit?: number, after?: string | null }`
- output: `{ items: ActivityEvent[], nextAfter: string | null, polledAt: string }`

`ActivityEvent` shape:

```ts
type ActivityEvent = {
  activityId: string;            // stable id derived from club_activity row
  seq: number;                   // global monotonic seq for cursor advancement
  clubId: string;
  topic: string;                 // e.g. 'admission.submitted', 'entity.published'
  payload: Record<string, unknown>;
  entityId: string | null;
  entityVersionId: string | null;
  audience: 'members' | 'clubadmins' | 'owners';
  createdAt: string;
  createdByMemberId: string | null;
};
```

Reads from `club_activity` using the existing audience filter logic from `src/clubs/index.ts` (rg `export async function listClubActivity`). No merging with other sources. No compound cursor — just the single activity seq.

The existing `listClubActivity` also has a second filter that hides activity items whose referenced entity has been removed (except for the `entity.removed` event itself). `activity.list` preserves this filter automatically by reusing `listClubActivity`.

No `activity.acknowledge` — activity items cursor-advance without explicit ack, same as today.

**`after = 'latest'` is preserved** and is resolved by passing `afterSeq: null` to `listClubActivity`, which already contains a seed-on-first-call branch that returns zero items plus a `nextAfterSeq` set to the current tip (rg `Seed cursor if needed` in `src/clubs/index.ts`). The action handler returns that seeded cursor to the client. No new repository method is needed.

### `notifications.list` — personal sticky queue

Sticky queue of everything personally targeted at the member.

- action: `notifications.list`
- auth: `member`
- input: `{}` (lax — unknown keys ignored, matching the rest of the action surface)
- output: `{ items: NotificationItem[], truncated: boolean, polledAt: string }`

`NotificationItem` shape:

```ts
type NotificationItem = {
  notificationId: string;        // <kind_family>:<primary_ref>
  kind: string;                  // open enum, phase-1 values below
  clubId: string | null;         // nullable for future account-scoped notifications
  ref: {
    admissionId?: string;
    matchId?: string;
    entityId?: string;
    // extended as new kinds are added
  };
  payload: Record<string, unknown>;  // refs-first, no denormalized display blobs
  createdAt: string;
  acknowledgeable: boolean;      // false for derived, true for materialized
  acknowledgedState: 'processed' | 'suppressed' | null;
};
```

**Phase-1 `kind` values** (the external vocabulary, used in both the API response and the stored `topic` column after migration):

- `admission.submitted` — derived from `current_admissions` where `status = 'submitted'` and the actor is a clubadmin of the admission's club
- `synchronicity.ask_to_member` — materialized; was stored as `signal.ask_match`
- `synchronicity.offer_to_ask` — materialized; was stored as `signal.offer_match`
- `synchronicity.member_to_member` — materialized; was stored as `signal.introduction`
- `synchronicity.event_to_member` — materialized; was stored as `signal.event_suggestion`

These four `synchronicity.*` kinds map one-to-one with the four `match_kind` values in the synchronicity worker (rg `function topicForMatchKind` in `src/workers/synchronicity.ts`). The migration UPDATE rewrites stored rows to this vocabulary atomically.

Reads are a union:

1. **Materialized:** read unacknowledged rows from `member_notifications` where `recipient_member_id = actor` and `club_id` is in the actor's accessible clubs OR `club_id IS NULL` (for account-scoped notifications). Read-time filtering preserves the two guards from the current `listMemberUpdates` SQL (rg the `signal.offer_match` branch in `src/postgres.ts`) — both the generic published-entity check and the topic-specific offer-match `yourAskEntityId` check. Both guards move with the query into `listNotifications`, updated to reference the new stored topic value (`synchronicity.offer_to_ask` instead of `signal.offer_match`).
2. **Derived admissions:** read from `current_admissions` where `status = 'submitted'` and `club_id` is in the actor's clubadmin clubs, ordered `ORDER BY version_created_at ASC, id ASC`, capped at a server-internal `MAX_NOTIFICATIONS`.

Merge the two sets. Return `truncated` if either the materialized set or the derived set was capped.

### `notifications.acknowledge` — ack for materialized items only

- action: `notifications.acknowledge`
- auth: `member`
- input: `{ notificationIds: string[], state: 'processed' | 'suppressed', suppressionReason?: string | null }`
- output: `{ receipts: NotificationReceipt[] }`

Only updates materialized rows in `member_notifications`. Derived notifications are rejected explicitly with `422 invalid_input` — a client-facing error message that says "derived notifications resolve automatically and cannot be acknowledged". Derived notification IDs are detectable by their `kind_family` prefix (e.g., `admission.submitted:*`).

**All-or-nothing semantics:** if any ID in the batch is a derived notification ID, the whole call fails with 422. No partial acknowledgement.

**Receipt set:** `result.acknowledgedNotificationIds` (the dispatch-layer filter input) contains only IDs that actually transitioned state — rows that matched and were updated. Idempotent re-acks of already-acknowledged rows do not appear in the returned receipts and do not filter from the piggyback set.

### `messages.*` — DM surface

The DM read / write surface mostly stays intact:

- `messages.getInbox`
- `messages.send`
- `messages.getThread`
- `messages.remove`

**New in Phase 1:** `messages.acknowledge`.

This is required because deleting `updates.acknowledge` otherwise removes the only live path that flips `dm_inbox_entries.acknowledged = true`. The helper already exists inside `src/messages/index.ts` (rg `acknowledgeInbox`) but is currently dead code — it is never called from an action handler. Phase 1 must make DM acknowledgement explicit instead of silently relying on the deleted `updates.acknowledge` inbox branch.

Pinned shape:

- action: `messages.acknowledge`
- auth: `member`
- input: `{ threadId }`
- output: `{ threadId, acknowledgedCount }`

Semantics:

- Marks all unread inbox entries for that thread and recipient as acknowledged
- Idempotent: a second call returns `acknowledgedCount = 0`
- Does not touch notifications or activity

Internally, add a top-level Repository method that delegates to the existing messaging helper (extend it to return a count if needed). Keep the stream-only `listInboxSince` primitive for incremental `message` frames — see the "DM stream read path" section below.

**Delete dead receipt cruft in the same rewrite.** The `DirectMessageUpdateReceipt` / `updateReceipts` shape hanging off DM thread entries is always empty today and is tied to the deleted `PendingUpdate.updateId` vocabulary. Do not preserve it. Delete the Zod schema, the contract type, the `updateReceipts` field on `DirectMessageEntry`, and the dead unit-test fixtures that populate it.

### `events.*` — calendar surface

Unchanged. `events.list`, `events.rsvp`, `events.cancelRsvp` already exist and already mean "calendar gatherings". Do not touch.

## The piggyback envelope

Every authenticated response carries `sharedContext` today. The field `sharedContext.pendingUpdates` in `src/schemas/transport.ts` (rg `pendingUpdates`) is currently dead weight — declared in the envelope, initialized to `[]` in `src/identity/auth.ts`, filtered in `src/dispatch.ts`, but nothing ever populates it.

Repurpose it:

- Rename the field from `sharedContext.pendingUpdates` to `sharedContext.notifications`
- Change the type from `PendingUpdate[]` (deleted) to `NotificationItem[]`
- Populate it on every authenticated response by calling `listNotifications({ actorMemberId })` during envelope assembly in `src/dispatch.ts`
- Keep the existing filter-on-acknowledge logic (rg the `pendingUpdates: sharedContext.pendingUpdates.filter` site) so `notifications.acknowledge` removes items from the piggyback set for the same response

The effect: agents reading the envelope of any response they were already making get their current notification set for free. Polling `notifications.list` explicitly becomes a fallback for agents that want to force a refresh, not the primary read path.

The existing `ActionResult.acknowledgedUpdateIds` field in `src/schemas/registry.ts` is renamed to `acknowledgedNotificationIds`. The filter in `src/dispatch.ts` updates its target field, its comment, and its type.

### Failure and retry semantics (pinned)

**Fail-open on piggyback errors.** If `getNotifications()` throws during envelope assembly (DB timeout, transient error, unexpected data), the dispatch layer catches the error, logs it, and returns `sharedContext.notifications: []` on the successful response. The piggyback is an enrichment, not a core response field — a piggyback read failure must not turn a successful handler call into a 5xx. The action result is preserved.

**Retries are not byte-identical.** `sharedContext.notifications` reads current state at envelope assembly time. Clients that retry mutating actions with a `clientKey` (the idempotency pattern per `docs/design-decisions.md`) may see different notification sets across retries as new notifications arrive or get acknowledged elsewhere. The `notifications` field is explicitly **not** part of the idempotency boundary. Document this in `SKILL.md` so agents don't assume byte-level identity.

## Per-request notification caching

**This is the single biggest implementation risk if handled wrong.** The piggyback design means every authenticated request triggers a potential `listNotifications` call. Without caching, the worst cases are:

- `notifications.list` handler reads notifications to populate `data`; envelope assembly reads them again to populate `sharedContext.notifications`. Two DB roundtrips per call to the one action specifically designed to read notifications.
- A session that makes 30 unrelated actions pays 30 extra `listNotifications` calls, each taking a partial set of locks on `member_notifications` and `current_admissions`.
- A polling client hitting a high-frequency read endpoint pays one extra notification read per poll.

**Pinned rule: one notification read per request, maximum.**

Implementation:

1. Extend `HandlerContext` (defined in `src/schemas/registry.ts`) with a lazy memo field such as `getNotifications(): Promise<NotificationsResult>`. The first call hits the repository; subsequent calls return the cached result.
2. The `notifications.list` handler calls `ctx.getNotifications()` to produce its `data` field.
3. The envelope assembly in `src/dispatch.ts` calls `ctx.getNotifications()` to populate `sharedContext.notifications`. Same call, same result, one DB hit.
4. Handlers that don't need notifications don't call `ctx.getNotifications()`. The envelope assembly still calls it after the handler returns — this is the one unavoidable read per authenticated request. The `acknowledgedNotificationIds` filter runs on that cached set.
5. **Unauthenticated actions** (cold admission flows) never call `listNotifications` because they use `unauthenticatedSuccessEnvelope` which has no `sharedContext`. Confirm in `src/schemas/transport.ts`.
6. **The stream handler is NOT a standard handler** and does not use the `HandlerContext` memo. It calls `Repository.listNotifications` directly once at connect to produce the `ready` frame seed. This is the single exception to the per-request rule and is acceptable because stream connections have their own lifecycle.

Result: `notifications.list` pays one read (down from two), every other authenticated action pays one read, unauthenticated actions pay zero, stream connections pay one read at connect and zero thereafter (they rely on `notifications_dirty` invalidation + the next authenticated action's piggyback).

If performance profiling later shows the per-request read is too expensive on hot paths, the mitigation is to add an `ActionDefinition.skipSharedNotifications?: boolean` flag for high-frequency read endpoints. That is a Phase 2 concern, not a Phase 1 concern.

## Stream cursor and Last-Event-ID semantics

The old `/updates/stream` attached a compound cursor (`{ a: activitySeq, s: signalSeq, t: inboxTimestamp }`) as the SSE frame `id:` on the last event in each batch. Clients reconnecting with `Last-Event-ID` resumed from that compound cursor. That is being deleted along with the merged tape.

Under the new `/stream`, cursor semantics are per-frame-type:

- **`activity` frames** attach the `ActivityEvent.seq` as the SSE `id:` field. On reconnect with `Last-Event-ID: <seq>`, the stream resumes activity delivery from that seq. If the `Last-Event-ID` value is not a parseable seq (e.g., from an old client with a compound cursor), it is treated as `'latest'` and the stream seeds activity from current tip.
- **`message` frames** do NOT attach an SSE `id:`. They do not advance any cursor. Message resumption is handled by the per-connection inbox cursor maintained inside the stream loop — see "DM stream read path" below.
- **`notifications_dirty` frames** do NOT attach an SSE `id:`. They do not advance any cursor. They are pure invalidation signals.
- **`ready` frames** attach the activity tip at connect time (after Last-Event-ID resolution if provided) as the `id:` field, so a reconnect without an explicit Last-Event-ID naturally resumes from the ready-frame position.

The only frame type that advances an SSE cursor is `activity`. Everything else is stateless on reconnect.

**`after = 'latest'` for `activity.list`** is resolved inline by the action handler passing `afterSeq: null` to `listClubActivity`, which returns zero items plus a seeded `nextAfterSeq` at current tip. No new Repository method. See the "`activity.list`" surface section.

## The single stream

`GET /stream` replaces `GET /updates/stream`. The old URL returns 404.

Frame types:

- `ready` — initial handshake. Payload: `{ member, requestScope, notifications: NotificationItem[], activityCursor: string | null }`. Seeds both the notification set and the activity cursor in one frame. SSE `id:` is set to the activity tip.
- `activity` — a new activity event. Payload: `ActivityEvent`. SSE `id:` is the activity seq.
- `message` — a new DM inbox entry. Payload: the existing DM summary shape used by `messages.getInbox` (sender display, message text, shared clubs, etc.). No SSE `id:`.
- `notifications_dirty` — invalidation-only. No payload body. No SSE `id:`. Clients react by reading `sharedContext.notifications` on their next authenticated request, or by explicitly calling `notifications.list`.
- `: keepalive` comment — unchanged.

**Rule: after the initial `ready` frame, the stream does NOT emit standalone notification payloads.** The `ready` frame carries notifications inline as a connect-time seed. After that, notification state changes are signalled via `notifications_dirty` only. The client re-reads via `sharedContext.notifications` on the next authenticated request or via an explicit `notifications.list` call.

Clients that only care about notifications can connect `/stream` and ignore everything except `notifications_dirty`. Clients that care about activity or DMs process those frames directly. The frame type is the discriminator — no client-side branching on `source` or `kind` within a shared envelope.

## DM stream read path

The current merged-tape query (rg `dm_inbox_entries ie` in `src/postgres.ts`) contains a dedicated inbox read. This logic needs to be extracted into a new Repository primitive so the stream loop can emit `message` frames cleanly. **The extraction must preserve every behavior of the existing inbox section.** That is the whole value of extracting rather than rewriting.

**New:** `Repository.listInboxSince({ recipientMemberId, after: string | null, limit: number })` — returns new DM inbox entries since a timestamp cursor, ordered `created_at ASC`, with all of the following behaviors preserved:

1. **Filter out removed messages** via `and not exists (select 1 from dm_message_removals rmv where rmv.message_id = ie.message_id)`. Without this filter, removed DMs leak into `message` frames — this is a real regression on the existing test in `test/integration/non-llm/removal.test.ts`. The extraction must keep this clause.
2. **Join DM details.** A second query (or a single joined query) against `dm_messages` and `members` populates `sender_member_id`, `message_text`, `thread_id`, `sender_public_name`, and `sender_handle` into the return shape. The `message` frame payload depends on these fields.
3. **Resolve shared clubs per sender.** The existing code calls `batchResolveSharedClubs(pool, actorMemberId, dmSenderIds)` (rg the function name) to populate a `sharedClubs` field on each returned entry. This is an agent-facing field used by the DM rendering path. `listInboxSince` must preserve this behavior — either call the helper directly or restructure the query to include the shared-clubs join.

If the implementer writes `listInboxSince` from the plan's one-line spec without preserving these three behaviors, the `message` frame regresses in three ways: stale removed messages leak through, sender display fields disappear, and shared clubs are empty. The integration tests in `removal.test.ts` and `messages.test.ts` should catch #1 and #2 respectively but may not cover #3 explicitly.

Stream loop usage:

1. On connect, the stream captures the current inbox head timestamp as its internal `inboxCursor` state, seeded from a one-shot read (e.g., `SELECT max(created_at) FROM dm_inbox_entries WHERE recipient_member_id = $1`).
2. On wakeup with `cause.kind === 'message'`, call `listInboxSince({ recipientMemberId, after: inboxCursor, limit: ... })`, emit each result as a `message` frame, advance `inboxCursor` to the last delivered timestamp.
3. On reconnect, the client issues `messages.getInbox({ unreadOnly: true })` to reconcile anything missed during the disconnect window.

`messages.getInbox` itself (the user-facing paginated inbox read) is unchanged. It remains the canonical historical inbox read.

## Activity audience computation

The current merged-tape query (rg `adminClubIds = actor\?.memberships` in `src/postgres.ts`) computes `adminClubIds` and `ownerClubIds` from the actor's memberships, then passes them into `listClubActivity` for the audience filter (rg `audience = 'clubadmins'` in `src/clubs/index.ts`). Under the new surface, this computation must happen in the `activity.list` action handler.

**Pinned:** the `activity.list` handler computes the audience arrays from `ctx.actor.memberships`:

```ts
const adminClubIds = ctx.actor.memberships.filter(m => m.role === 'clubadmin').map(m => m.clubId);
const ownerClubIds = ctx.actor.memberships.filter(m => m.isOwner).map(m => m.clubId);
```

These are passed into `Repository.listClubActivity` as explicit arguments. The repository method does not re-read the actor.

The stream loop in `src/server.ts` does the same computation at the top of the loop (using the captured `auth.actor`) and passes them into `Repository.listClubActivity` for activity frame production.

`Repository.listClubActivity` is promoted from an internal `ClubsRepository` method (rg `listClubActivity(input:` in `src/clubs/index.ts`) to a top-level `Repository` method in `src/contract.ts`. Current `Repository` interface (rg `listMemberUpdates?`) does not expose it — adding it is a real edit, not a trivial rename. Wire the method through `src/postgres.ts` by calling the existing `clubs.listClubActivity`. Add `'listClubActivity'` to the capability list in `src/schemas/registry.ts`.

## Wakeup plumbing

Single NOTIFY channel renamed from `updates` to `stream`.

Triggers, all landing on the `stream` channel with a typed payload carrying `kind`:

- `notify_club_activity` on `club_activity` insert — payload `{ clubId, kind: 'activity' }`
- `notify_member_notification` on `member_notifications` insert — payload `{ clubId, recipientMemberId, kind: 'notification' }`
- `notify_dm_inbox` on `dm_inbox_entries` insert — payload `{ recipientMemberId, kind: 'message' }`
- `notify_admission_version` on `admission_versions` insert — payload `{ clubId, kind: 'admission_version' }` (new in this plan — see migration SQL for the join pattern)

`MemberUpdateNotifier.waitForUpdate()` returns:

```ts
type WaitResult =
  | { outcome: 'notified'; cause: { kind: string; clubId?: string | null; recipientMemberId?: string | null } }
  | { outcome: 'timed_out' };
```

The stream loop uses `cause.kind` to decide which frame to emit on the next iteration:

- `'activity'` → next `listClubActivity` call; emit any new `activity` frames
- `'notification'` → emit `notifications_dirty`
- `'message'` → next `listInboxSince` call; emit any new `message` frames
- `'admission_version'` → emit `notifications_dirty` (derived admissions set may have changed)
- unknown → event-tape default behavior (check activity for new events), no `notifications_dirty`

A `NOTIFICATION_WAKEUP_KINDS = new Set(['notification', 'admission_version'])` allowlist gates `notifications_dirty` emission. Untagged or malformed payloads never emit `notifications_dirty`. Untagged wakeups still advance the activity and message paths defensively.

The stream-loop variable currently named `outcome` (rg `const outcome = await updatesNotifier.waitForUpdate` in `src/server.ts`) is renamed to `result` to match the new struct shape. The current `if (outcome === 'timed_out')` check becomes `if (result.outcome === 'timed_out')`.

## Data migration

One migration, reversible, in `db/migrations/NNN_rename_signals_to_notifications.sql`. Everything below is metadata-only plus a single UPDATE that rewrites stored topic values — no data scan beyond that UPDATE.

```sql
-- ── Table rename ────────────────────────────────────────
ALTER TABLE signal_deliveries RENAME TO member_notifications;

-- ── Column nullability ──────────────────────────────────
-- Drop NOT NULL on club_id for future account-scoped notifications.
-- Existing rows all have non-null club_id; no data scan needed.
ALTER TABLE member_notifications ALTER COLUMN club_id DROP NOT NULL;

-- ── IDENTITY backing sequence ──────────────────────────
-- ALTER TABLE RENAME does not touch the backing sequence name.
-- If we skip this, the sequence keeps the old name forever and
-- pg_dump / init.sql regeneration drifts.
ALTER SEQUENCE signal_deliveries_seq_seq RENAME TO member_notifications_seq_seq;

-- ── Indexes ─────────────────────────────────────────────
-- The unique partial index on match_id is the deduplication guard
-- that synchronicity.ts relies on for crash-retry idempotency
-- (rg `on conflict ((match_id))` in src/workers/synchronicity.ts).
-- Do not drop it. Rename it explicitly.
ALTER INDEX signal_deliveries_recipient_poll_idx RENAME TO member_notifications_recipient_poll_idx;
ALTER INDEX signal_deliveries_match_unique_idx   RENAME TO member_notifications_match_unique_idx;

-- ── Constraints ─────────────────────────────────────────
-- Check constraints, primary key, unique, and FK constraint names
-- all embed the old table name. These are cosmetic but leaving them
-- stale causes schema-drift between db/init.sql and the live database.
-- Rename all of them.
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_pkey                TO member_notifications_pkey;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_seq_unique          TO member_notifications_seq_unique;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_topic_check         TO member_notifications_topic_check;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_ack_state_check     TO member_notifications_ack_state_check;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_suppression_check   TO member_notifications_suppression_check;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_club_fkey           TO member_notifications_club_fkey;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_recipient_fkey      TO member_notifications_recipient_fkey;
ALTER TABLE member_notifications RENAME CONSTRAINT signal_deliveries_entity_fkey         TO member_notifications_entity_fkey;

-- Verify there are no other `signal_deliveries_*` constraint or index names in
-- db/init.sql before running this migration. rg `signal_deliveries_` once
-- and confirm this list is exhaustive.

-- ── Topic vocabulary rewrite ────────────────────────────
-- Rewrite stored topic values from the signal.* vocabulary to the
-- synchronicity.* vocabulary. The actual stored values come from
-- src/workers/synchronicity.ts topicForMatchKind().
-- Do NOT invent mappings — these four strings are the only values
-- produced by the worker as of this plan. Verify with rg before running.
UPDATE member_notifications SET topic = CASE topic
  WHEN 'signal.ask_match'        THEN 'synchronicity.ask_to_member'
  WHEN 'signal.offer_match'      THEN 'synchronicity.offer_to_ask'
  WHEN 'signal.introduction'     THEN 'synchronicity.member_to_member'
  WHEN 'signal.event_suggestion' THEN 'synchronicity.event_to_member'
  ELSE topic
END;

-- ── Trigger drops ──────────────────────────────────────
-- Drop in dependency order (triggers before functions) so nothing
-- has a dangling dependency mid-migration.
DROP TRIGGER IF EXISTS signal_deliveries_notify ON member_notifications;
DROP TRIGGER IF EXISTS club_activity_notify ON club_activity;
DROP TRIGGER IF EXISTS dm_inbox_entries_notify ON dm_inbox_entries;
DROP FUNCTION IF EXISTS notify_signal_delivery();
DROP FUNCTION IF EXISTS notify_club_activity();
DROP FUNCTION IF EXISTS notify_dm_inbox();

-- ── Trigger creates: all on the `stream` channel, all typed by kind ──

CREATE FUNCTION notify_club_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'kind', 'activity'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_activity_notify
    AFTER INSERT ON club_activity
    FOR EACH ROW EXECUTE FUNCTION notify_club_activity();

CREATE FUNCTION notify_member_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'notification'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_notifications_notify
    AFTER INSERT ON member_notifications
    FOR EACH ROW EXECUTE FUNCTION notify_member_notification();

CREATE FUNCTION notify_dm_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'message'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER dm_inbox_entries_notify
    AFTER INSERT ON dm_inbox_entries
    FOR EACH ROW EXECUTE FUNCTION notify_dm_inbox();

-- admission_versions does NOT have a club_id column. It has admission_id.
-- The trigger must join through admissions to find the club_id.

CREATE FUNCTION notify_admission_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_club_id short_id;
BEGIN
    SELECT club_id INTO v_club_id
      FROM admissions
      WHERE id = NEW.admission_id;
    PERFORM pg_notify('stream', json_build_object(
        'clubId', v_club_id,
        'kind', 'admission_version'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER admission_versions_notify
    AFTER INSERT ON admission_versions
    FOR EACH ROW EXECUTE FUNCTION notify_admission_version();
```

**Verification steps after the migration runs:**

- `signal_background_matches` FK to `signal_deliveries(id)` automatically points at `member_notifications(id)` via PostgreSQL's implicit FK target tracking. The constraint name `signal_background_matches_signal_fkey` and the column name `signal_id` both stay unchanged (synchronicity-internal vocabulary).
- Every index and constraint on `member_notifications` has a name matching the new table. No `signal_deliveries_*` names remain. Run `\d+ member_notifications` to confirm.
- The IDENTITY sequence is named `member_notifications_seq_seq`.
- `SELECT DISTINCT topic FROM member_notifications` returns only `synchronicity.*` values (no stale `signal.*` rows). Spot-check with a few known match IDs.
- The `stream` NOTIFY channel fires on insert into each of the four source tables. `LISTEN stream` in psql and verify each trigger.
- The existing crash-retry dedup still works: insert two rows with the same `match_id` and confirm only one succeeds.

Test the migration via `scripts/migrate.sh` per `CLAUDE.md`, then mirror the final target state into `db/init.sql`. The mirror is a multi-section edit (table block, indexes, constraints, all four NOTIFY functions, all four triggers, FK target comment in `signal_background_matches`) — regenerate from a dev database rather than editing by hand to avoid missing a line.

## Repository shape

Delete from `src/contract.ts`:

- `listMemberUpdates?`
- `getLatestCursor?`
- `acknowledgeUpdates?`

Add to `src/contract.ts`:

- `listClubActivity({ actorMemberId, clubIds, adminClubIds, ownerClubIds, limit, afterSeq })` — promoted from the internal `ClubsRepository` definition. The top-level `Repository` interface does not currently expose this. Adding it is a real edit, not a re-export.
- `listNotifications({ actorMemberId, accessibleClubIds, adminClubIds })` — union of materialized reads from `member_notifications` and derived reads from `current_admissions`.
- `acknowledgeNotifications({ actorMemberId, notificationIds, state, suppressionReason })` — updates materialized rows only; rejects derived IDs.
- `listInboxSince({ recipientMemberId, after, limit })` — incremental DM read for the stream loop, extracted from the current merged-tape query with all three preserved behaviors (removed-message filter, sender display joins, sharedClubs resolution).
- `getAdmission?({ actorMemberId, admissionId, accessibleClubIds })` — Phase 0.

**NOT added:** `getLatestActivityCursor`. The existing `listClubActivity` seed-on-first-call behavior handles `after='latest'` — the action handler resolves it inline.

Add to `src/schemas/registry.ts` capability list:

- `'listClubActivity'`
- `'listNotifications'`
- `'acknowledgeNotifications'`
- `'listInboxSince'`
- `'getAdmission'`

Delete from the capability list:

- `'listMemberUpdates'`
- `'getLatestCursor'`
- `'acknowledgeUpdates'`

## Synchronicity worker update

`src/workers/synchronicity.ts` currently writes rows to `signal_deliveries`. The worker's logic doesn't change — it still computes matches, still enforces TTLs and freshness guards, still tracks lifecycle in `signal_background_matches`, still uses the recompute queue. Only the target table name and the stored `topic` values change.

Specific edits in the worker:

1. Every `insert into signal_deliveries` → `insert into member_notifications` (rg `insert into signal_deliveries`).
2. Every `select id from signal_deliveries` → `select id from member_notifications` (there's at least one in the retry path).
3. The `topicForMatchKind` function (rg `function topicForMatchKind`) returns hardcoded `signal.*` strings — rewrite every branch to return the corresponding `synchronicity.*` value:
   - `'signal.ask_match'` → `'synchronicity.ask_to_member'`
   - `'signal.offer_match'` → `'synchronicity.offer_to_ask'`
   - `'signal.introduction'` → `'synchronicity.member_to_member'`
   - `'signal.event_suggestion'` → `'synchronicity.event_to_member'`
   - The `default` catchall `` `signal.${kind}` `` should either become `` `synchronicity.${kind}` `` or (better) be removed in favor of an exhaustive switch that throws on unknown kinds.
4. Any internal branching on topic strings (rg `signal\.` across the worker file) updates to the new vocabulary.

The existing match lifecycle transaction (FOR UPDATE + delivery row insert + state transition, per `docs/design-decisions.md` synchronicity section) stays exactly the same. Only the table name and the topic strings change.

**Stored `topic` values match `NotificationItem.kind` values after the migration.** No read-time vocabulary translation. The storage layer and the API layer use the same vocabulary. The migration UPDATE brings existing rows into alignment with the new worker code; the new worker code inserts the new vocabulary going forward.

## Deployment and operational notes

The rename migration and the synchronicity worker code update must land atomically. They cannot ship in separate deploys because:

- If the migration runs first, the old worker code attempts `INSERT INTO signal_deliveries` which no longer exists → every synchronicity match insert fails until the new code deploys
- If the worker code ships first, it attempts `INSERT INTO member_notifications` which doesn't yet exist → same failure

**Pinned deploy sequence:**

1. Migration, server code, and worker code all ship in one deploy
2. During the deploy window (typically seconds to a minute), synchronicity match inserts may fail with "relation does not exist" errors. These are retried by the worker's existing error handling and self-resolve as the new code activates.
3. The deploy runbook should say: "expect 0–10 synchronicity worker errors during the deploy window; they self-resolve as the new code takes effect. Alert only if errors continue for more than 5 minutes."
4. The deploy runbook should also say: "expect a burst of `409 stale_client` responses immediately after deploy as agents present a pre-rewrite `ClawClub-Schema-Seen` hash and refresh their cached `/api/schema`. This is expected contract-handshake behavior, not a rollback signal."
5. Before production deploy, run a smoke-level performance check on the piggyback path under realistic concurrent authenticated load. The goal is not a formal benchmark suite; it is an operational confidence check that the per-request `listNotifications` read stays comfortably below the team's latency budget when many requests are paying the piggyback cost.

This is acceptable because (a) the worker is asynchronous and already has retry logic, (b) no agent-facing endpoint is affected by the error window, (c) the migration itself is metadata-only and fast.

## Cross-plan dependency on scope-refresh

The related plan at `plans/updates-stream-scope-refresh.md` describes a separate bug where a long-lived `/updates/stream` connection does not pick up membership changes until reconnect. **That basic work has already shipped.**

What exists in the current checkout already:

- `validateBearerTokenPassive` already exists on Repository and is already wired
- `src/server.ts` already refreshes captured stream scope on a 60-second cadence via `streamScopeRefreshMs`
- Token-revoked handling on passive refresh already exists

Phase 1 of this plan does **not** introduce scope refresh from scratch. It **extends the existing shipped refresh** while rewriting the stream surface:

- `/updates/stream` becomes `/stream`
- the refresh recomputes `clubIds`, `adminClubIds`, and `ownerClubIds` together, not just the full accessible club set
- the rewritten stream loop uses those refreshed subsets for activity visibility and notification relevance

`plans/updates-stream-scope-refresh.md` is therefore stale documentation of already-shipped base behavior. After Phase 1 lands, archive or delete that plan rather than describing it as future work to be absorbed.

## Phase 0: `clubadmin.admissions.get`

Unchanged from prior plan revisions. Ship as a standalone PR ahead of everything else.

- action: `clubadmin.admissions.get`
- auth: `clubadmin` (superadmin bypass via `ctx.requireClubAdmin(clubId)` — `createRequireClubAdmin()` already returns early for superadmins; rg `globalRoles.includes('superadmin')` in `src/dispatch.ts`)
- input: `{ clubId, admissionId }`
- output: `{ admission: AdmissionSummary }`

The existing `readAdmission` helper in `src/clubs/admissions.ts` (rg `export async function readAdmission`) returns a raw `AdmissionRow`, not the full `AdmissionSummary` projection. Phase 0 needs either:

- an extended helper that joins applicant / sponsor display names, or
- a dedicated single-row query that mirrors the `listAdmissions` projection (rg `listAdmissions` in `src/postgres.ts` for the joins it uses)

`getAdmission?` lands on Repository with matching optional pattern. `'getAdmission'` lands in the capability list.

Tests in `test/integration/non-llm/admissions.test.ts`: happy path fetch in scope, regular member 403, superadmin bypass, response shape matches `AdmissionSummary`.

## Phase 1: The full rewrite

Everything else in this plan. One PR (or a small number of tightly-coupled PRs). The rewrite cannot land in pieces — the migration, the action surfaces, the stream, the worker update, and the scope refresh are interdependent.

Implementation order inside the PR:

1. **Migration first.** Write `db/migrations/NNN_rename_signals_to_notifications.sql` exactly as pinned in the Data Migration section. Test via `scripts/migrate.sh`. Mirror into `db/init.sql` by regenerating from a dev database (not hand-editing).
2. **Schemas and types.** Delete `PendingUpdate`, `memberUpdates`, `pollingResponse`, `pendingUpdate` Zod schema, `sseUpdateEvent` comment references, and the "Polling response (`updates.list` via POST /api)" section header in `src/schemas/transport.ts`. Add `activityEvent`, `notificationItem`, `notificationReceipt`, `notificationsResponse`, `activityResponse`, `sseNotificationsDirtyEvent` (empty body). Rename `sharedContext.pendingUpdates` → `sharedContext.notifications`. Update `sseReadyEvent` to carry `notifications: NotificationItem[]` and `activityCursor: string | null` instead of `nextAfter` / `latestCursor`. Rename `ActionResult.acknowledgedUpdateIds` → `acknowledgedNotificationIds` in `src/schemas/registry.ts` and update the comment that references `sharedContext.pendingUpdates`.
3. **Contract interface.** Update `src/contract.ts` with the new Repository shape: delete `listMemberUpdates?`, `getLatestCursor?`, `acknowledgeUpdates?`; add `listClubActivity`, `listNotifications`, `acknowledgeNotifications`, `listInboxSince`, `acknowledgeDirectMessageInbox`, `getAdmission?`. Delete the `PendingUpdate` type definition (rg `export type PendingUpdate` in `src/contract.ts`) and the `pendingUpdates: PendingUpdate[]` field in `SharedResponseContext`; replace with `notifications: NotificationItem[]`. Delete `DirectMessageUpdateReceipt` and remove `updateReceipts` from `DirectMessageEntry`.
4. **Repository implementation.** In `src/postgres.ts`: delete `listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates`. Remove the `import { PendingUpdate }` at the top of the file. Wire `listClubActivity` by calling the existing `clubs.listClubActivity`. Add `listNotifications`, `acknowledgeNotifications`, `listInboxSince` (preserving the three behaviors from the DM stream read path section), `acknowledgeDirectMessageInbox`, `getAdmission`.
5. **Handler context.** Extend `HandlerContext` in `src/schemas/registry.ts` with the memoized `getNotifications()` accessor. Wire the per-request cache.
6. **Action handlers.** Create `src/schemas/activity.ts` and `src/schemas/notifications.ts`. Delete `src/schemas/updates.ts`. Extend `src/schemas/messages.ts` with `messages.acknowledge` wired to the new top-level DM-ack repository method. Pin that `activity.list` handler computes `adminClubIds` and `ownerClubIds` from `ctx.actor.memberships` and resolves `after='latest'` by passing `afterSeq: null` to `listClubActivity`.
7. **Dispatch layer.** Delete the `import './schemas/updates.ts';` side-effect line in `src/dispatch.ts` (rg `schemas/updates`). Add `import './schemas/activity.ts';` and `import './schemas/notifications.ts';` next to the other action imports. Update envelope assembly to populate `sharedContext.notifications` via `ctx.getNotifications()`. Wrap the call in a try/catch that logs and falls back to `[]` on error (fail-open rule). Update the ack-filter logic (rg `result.acknowledgedUpdateIds`) to operate on `sharedContext.notifications` and `acknowledgedNotificationIds`. Update the `sharedContext = auth.sharedContext ?? { pendingUpdates: [] }` fallback to use `notifications` instead.
8. **Auth init.** Update `src/identity/auth.ts` (rg `pendingUpdates: \[\]` to find both sites) to initialize `sharedContext: { notifications: [] }`. Do **not** add `validateBearerTokenPassive` here — it already exists. This step is only the envelope-field rename.
9. **Stream handler.** Rewrite `/updates/stream` → `/stream` in `src/server.ts`. Update the unsupported-path error message (rg `Only GET /, GET /skill`) to list `/stream` instead of `/updates/stream`. Add the typed frame emission logic. Wire in the extended `WaitResult` from the notifier. Rename the `outcome` variable to `result` (rg `const outcome = await updatesNotifier`). Extend the **existing** periodic scope refresh (already present, 60s cadence via `streamScopeRefreshMs`) so it recomputes `clubIds`, `adminClubIds`, and `ownerClubIds` together in the rewritten loop. The stream handler calls `Repository.listNotifications` directly once at connect for the `ready` frame seed — it does NOT use the `HandlerContext.getNotifications` memo because the stream is not a standard handler.
10. **Schema endpoint.** In `src/schema-endpoint.ts` (rg `/updates/stream` and `updates.acknowledge` in this file): update the `stream` endpoint entry to `path: '/stream'` and rewrite the acknowledgment description text to describe `notifications.acknowledge` and the piggyback envelope pattern. `/api/schema` is the canonical contract agents fetch at boot — this file is agent-visible and must match the new surface exactly.
11. **Notifier.** Update `src/member-updates-notifier.ts` to listen on `stream` instead of `updates`, parse the `kind` field from payloads, return the typed `WaitResult`.
12. **Synchronicity worker.** Update `src/workers/synchronicity.ts` per the "Synchronicity worker update" section above: change the INSERT target, rewrite `topicForMatchKind` to return `synchronicity.*` values, update any internal topic branches.
13. **Tests.** See "Files affected" and "Tests to cover" sections below. Update or replace coverage across `admissions.test.ts`, `signals.test.ts`, `messages.test.ts`, `stream-scope-refresh.test.ts`, `smoke.test.ts`, `matches.test.ts`, `synchronicity.test.ts`, `removal.test.ts`, and `test/unit/server.test.ts`. Add new `activity.test.ts` and `notifications.test.ts` files.
14. **Unit tests and fixtures.** In `test/unit/fixtures.ts`: delete `makePendingUpdate`, delete the `PendingUpdate` import, add `makeActivityEvent` and `makeNotificationItem`, update the `sharedContext: { pendingUpdates: [] }` initializer to `{ notifications: [] }`. In `test/unit/app.test.ts`: update every `sharedContext.pendingUpdates` reference (there are more than the plan's earlier version enumerated — rg `pendingUpdates` in the file and fix every hit), delete or update the local `makePendingUpdate` definition that shadows the fixture one (rg `function makePendingUpdate` in `test/unit/app.test.ts`), delete the `PendingUpdate` type import, and delete the dead `updateReceipts` mock setups that were only exercising the always-empty `DirectMessageUpdateReceipt` shape. In `test/unit/server.test.ts`: update the `makePendingUpdate` import and its single call site.
15. **Docs.** Rewrite `docs/design-decisions.md` "Update transport" and "Member signals" sections. Rewrite `SKILL.md` "Checking for new messages" section and the `updates.list` / `updates.acknowledge` section (rg both section headers). Delete the stale reference to nonexistent `docs/member-signals-plan.md` from `docs/design-decisions.md`. In the same docs pass, update the synchronicity matching prose to say "notifications" instead of "signals" where it is describing the live system.
16. **Schema snapshot.** Regenerate `test/snapshots/api-schema.json`.
17. **Patch bump.** `package.json` version.

## Phase 2: What happens next

Phase 2 is now purely additive — the schema migration happened in Phase 1 (table rename, column nullability, sequence rename, topic vocabulary). New notification kinds land as new rows in `member_notifications` (materialized) or as new derived queries composed into `notifications.list`.

Concrete next notification types, when their use cases arrive:

- `billing.past_due` — derived from subscription state plus grace window, probably account-scoped with `club_id = null`
- `billing.charge_failed` — materialized, written when a Stripe webhook fires
- `billing.invoice_ready` — materialized, account-scoped
- `email.delivered` — materialized, written by the email worker
- `moderation.content_flagged` — materialized, written by a moderator action

None of these require schema migrations. They require new `kind` enum values, new insert sites, and possibly new derived query branches inside `notifications.list`. The plan for each is a small PR, not a structural change.

## Files affected

### Deleted

- `src/schemas/updates.ts` (also removed from the side-effect import in `src/dispatch.ts`)

### New

- `src/schemas/activity.ts`
- `src/schemas/notifications.ts`
- `db/migrations/NNN_rename_signals_to_notifications.sql`
- `test/integration/non-llm/activity.test.ts`
- `test/integration/non-llm/notifications.test.ts`

### Significantly modified

- `src/contract.ts` — delete `PendingUpdate` type, Repository interface changes, `SharedResponseContext` field rename
- `src/postgres.ts` — remove `listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates`; add new methods including `listInboxSince` and the `listClubActivity` wire-through; remove `PendingUpdate` import
- `src/messages/index.ts` — expose the existing `acknowledgeInbox` helper through the top-level Repository surface; extend it to return an acknowledged count if needed
- `src/server.ts` — `/stream` handler, typed frame emission, periodic scope refresh, `validateBearerTokenPassive` integration, unsupported-path error message
- `src/member-updates-notifier.ts` — channel rename, typed WaitResult, kind parsing
- `src/schemas/transport.ts` — `sharedContext.notifications`, `sseReadyEvent` update, add `sseNotificationsDirtyEvent`, delete `pollingResponse` and the `memberUpdates` import
- `src/schemas/responses.ts` — delete `pendingUpdate`, `memberUpdates`, `updateReceipt`, and `directMessageUpdateReceipt`; remove `updateReceipts` from direct-message entries; add `activityEvent`, `notificationItem`, `notificationReceipt`, response shapes for the new actions. Keep the shared `updateReceiptState` enum in `src/schemas/fields.ts`.
- `src/schemas/registry.ts` — capability list update, `HandlerContext.getNotifications` memo, `ActionResult.acknowledgedNotificationIds` rename, rewrite the comment that references `sharedContext.pendingUpdates`
- `src/schemas/clubadmin.ts` — Phase 0 `clubadmin.admissions.get`
- `src/schemas/messages.ts` — add `messages.acknowledge`; update the action header comment to include it
- `src/dispatch.ts` — side-effect import line changes, `sharedContext.notifications` population via `ctx.getNotifications()` with fail-open try/catch, ack filter field rename, `auth.sharedContext` fallback update
- `src/identity/auth.ts` — `sharedContext` init field rename, `validateBearerTokenPassive` helper
- `src/schema-endpoint.ts` — **hand-authored agent-facing metadata**; update the `stream` endpoint path and the acknowledgment description text
- `src/clubs/admissions.ts` — Phase 0 helper extension
- `src/clubs/index.ts` — (no body changes; `listClubActivity` already exists, only the top-level Repository exposure is new in `src/contract.ts`)
- `src/workers/synchronicity.ts` — writes to `member_notifications`, `topicForMatchKind` rewrite, any other topic-string branches
- `db/init.sql` — mirror migration after test (regenerate, don't hand-edit)
- `docs/design-decisions.md` — rewrite Update Transport + Member Signals sections
- `SKILL.md` — rewrite polling/streaming sections
- `test/integration/non-llm/admissions.test.ts` — Phase 0 tests
- `test/integration/non-llm/signals.test.ts` — rewrite or fold into `notifications.test.ts`
- `test/integration/non-llm/messages.test.ts` — update DM stream frame expectations
- `test/integration/non-llm/matches.test.ts` — update synchronicity match lifecycle assertions that touch `signal_deliveries` or signal topic strings
- `test/integration/non-llm/synchronicity.test.ts` — update synchronicity worker assertions; this is expected to be the single largest test-file rewrite in the PR (roughly 1200 lines, 20+ affected sites, pattern rewrite not just string replacement)
- `test/integration/non-llm/removal.test.ts` — update DM removal interaction with the new `listInboxSince` stream primitive
- `test/integration/non-llm/stream-scope-refresh.test.ts` — update for new stream URL, frame types, and the extended already-shipped scope refresh
- `test/integration/non-llm/smoke.test.ts` — update any tape-references
- `test/unit/fixtures.ts` — delete `makePendingUpdate`, add `makeActivityEvent`, `makeNotificationItem`
- `test/unit/app.test.ts` — update every `sharedContext.pendingUpdates` reference (rg the file; there are more than five) and the local `makePendingUpdate` shadow function
- `test/unit/server.test.ts` — update `makePendingUpdate` import and call site
- `test/snapshots/api-schema.json` — regenerate
- `package.json` — patch bump

### Archived / superseded after this lands

- `plans/updates-stream-scope-refresh.md` — stale documentation of already-shipped base scope-refresh behavior; archive or delete after the rewritten stream lands

## Tests to cover

### Phase 0

- `clubadmin.admissions.get` returns a single admission in scope
- Regular member cannot call it
- Superadmin can call it through the existing `ctx.requireClubAdmin` bypass
- Response shape matches `AdmissionSummary`

### Phase 1 — activity

- `activity.list` returns club-scoped activity events
- Cursor advances correctly across repeated polls
- Audience filter respects `members` / `clubadmins` / `owners` (specifically: regular member sees `members` only, clubadmin sees `members`+`clubadmins` in their admin clubs, owner sees all three in their owned clubs, cross-club admin sees per-club audience)
- `clubId` filter narrows to one club when provided
- `after='latest'` resolves via the `listClubActivity` seed path and skips backlog (the action handler passes `afterSeq: null`, the repository returns `{ items: [], nextAfterSeq: <current tip> }`)

### Phase 1 — notifications

- `notifications.list` returns materialized rows from `member_notifications` (migrated synchronicity data)
- `notifications.list` returns derived admission notifications for clubadmins
- Materialized and derived items merge in the response
- `truncated` flag fires when the derived admissions set exceeds `MAX_NOTIFICATIONS`
- Stable truncation: repeated polls return the same truncated subset until earlier admissions resolve
- FIFO ordering across multiple admin clubs
- Non-admin member gets an empty derived set
- `notifications.list` → `clubadmin.admissions.get` round trip succeeds using returned `clubId` + `ref.admissionId`
- Derived notification disappears when admission transitions away from `submitted`
- Newly-promoted admin sees current pending admissions on next poll
- `notifications.acknowledge` updates materialized rows and returns receipts
- `notifications.acknowledge` rejects any batch containing derived notification IDs with `422 invalid_input`
- `notifications.acknowledge` receipts contain only IDs that actually transitioned state (idempotent re-acks do not appear)
- Account-scoped notification (`club_id = null`) round-trips correctly
- After migration, every row in `member_notifications` has a `synchronicity.*` topic (no stale `signal.*` values remain) — verify with `SELECT DISTINCT topic`

### Phase 1 — envelope piggyback

- Every authenticated response carries `sharedContext.notifications` populated
- `notifications.list` handler and envelope assembly share the per-request cache (query-counter assertion: one `listNotifications` call per request, not two)
- `notifications.acknowledge` on a materialized row removes the row from the same response's `sharedContext.notifications`
- Non-admin calling an unrelated action sees an empty `sharedContext.notifications`
- Piggyback respects the same FIFO cap and `MAX_NOTIFICATIONS`
- Unauthenticated actions (cold admission) do not trigger notification reads at all
- **Fail-open on piggyback error:** mock `listNotifications` to throw, call any authenticated action, assert the response is successful with `sharedContext.notifications: []` and an error is logged — NOT a 500 response
- **Retry non-byte-identity:** make a mutating call with `clientKey`, have another notification land, retry the same `clientKey`, assert the second response has a different `sharedContext.notifications` set even though the action result is idempotent

### Phase 1 — stream

- `GET /stream` replaces `GET /updates/stream`; old URL returns 404
- Unsupported-path error message lists `/stream`
- `ready` frame includes initial notifications set and activity cursor, with SSE `id:` set to the activity tip
- `activity` frames carry `ActivityEvent` payloads with seq as SSE `id:`
- `message` frames carry DM inbox entries with no SSE `id:` (do not advance any cursor)
- `notifications_dirty` fires on `member_notifications` insert
- `notifications_dirty` fires on `admission_versions` insert
- `notifications_dirty` does not fire on unrelated wakeups (activity, message)
- Untagged / malformed NOTIFY payloads don't emit `notifications_dirty`
- Reconnect with `Last-Event-ID: <activity_seq>` resumes activity from that seq
- Reconnect with a garbage `Last-Event-ID` (e.g., old compound cursor string) resumes from latest
- Reconnect with an activity seq beyond the current max returns zero items and enters the waiter (graceful degradation)
- Periodic scope refresh picks up new clubadmin memberships mid-stream and starts delivering `notifications_dirty` for the new club's `admission_versions` inserts without reconnect (use a short `streamScopeRefreshMs` in the harness for this test)
- After the initial `ready` frame, no standalone notification payload frames are emitted — only `activity`, `message`, `notifications_dirty`, and keepalive

### Phase 1 — migration

- Existing `signal_deliveries` data survives the rename intact (insert N rows pre-migration with known values, run migration, select by id post-migration, assert all fields match including the rewritten `topic`)
- `signal_background_matches` FK still resolves to the renamed delivery table (`\d+ signal_background_matches` shows `member_notifications(id)` as the FK target)
- `signal_background_matches_signal_fkey` constraint name and `signal_background_matches.signal_id` column name are unchanged (synchronicity internal vocabulary)
- The IDENTITY backing sequence is renamed to `member_notifications_seq_seq` and continues to allocate correctly (insert a row post-migration, verify seq advances)
- `club_id` nullability drop succeeds and does not invalidate existing rows
- Every constraint and index has been renamed; no `signal_deliveries_*` names remain in the schema
- `signal_deliveries_match_unique_idx` is renamed, not dropped; the crash-retry dedup still works (attempt to insert two rows with the same `match_id`, assert one succeeds and one is blocked by the conflict)
- Stored `topic` values are rewritten to the `synchronicity.*` vocabulary for all four kinds
- New triggers fire on inserts into all four source tables and deliver NOTIFY on the new `stream` channel
- The `notify_admission_version` trigger resolves `club_id` correctly via the join (verify with an admission_version insert that should wake a clubadmin stream)
- Read-time entity-still-published filter still suppresses synchronicity matches whose referenced entity is no longer published
- Read-time topic-specific filter still suppresses offer-match notifications whose matched ask has been unpublished (verify with the new topic value `synchronicity.offer_to_ask`)

### Phase 1 — synchronicity worker

- Worker inserts into `member_notifications` with new topic vocabulary
- `signal_background_matches` lifecycle (pending → delivered) still works across the table rename
- Per-recipient advisory lock for throttle enforcement still works
- Read-time entity-published filter still suppresses unpublished-entity matches
- Offer-match ask drift still expires matches
- Worker error window during migration is bounded (<5 min, errors self-resolve)

### Phase 1 — DM stream (listInboxSince preservation)

- `listInboxSince` filters out removed DMs via the `dm_message_removals` join (remove a message mid-stream, confirm the next `message` frame does not include it)
- `listInboxSince` populates sender display fields (`sender_public_name`, `sender_handle`) in the `message` frame payload
- `listInboxSince` populates `sharedClubs` in the `message` frame payload (two members in the same club → the frame includes that club)

### Phase 1 — DM acknowledgement

- `messages.acknowledge({ threadId })` marks unread inbox entries for that thread as acknowledged
- After `messages.acknowledge`, `messages.getInbox({ unreadOnly: true })` no longer returns that thread if no unread entries remain
- `directMessageInboxSummary.unread.unreadMessageCount` decrements correctly after `messages.acknowledge`
- A second `messages.acknowledge({ threadId })` call is a no-op (`acknowledgedCount = 0`)
- `messages.acknowledge` does not affect notifications or activity

## What not to re-open

The reviewer of this plan should not re-open any of the following. These decisions are locked based on multiple rounds of design-cycle pressure testing and are the load-bearing foundation of everything else.

- **Do not** argue for keeping the merged tape. The merge was a mistake. Four surfaces, not one.
- **Do not** argue for keeping the `updates.*` namespace. It was always ambiguous between "tape" and "notifications".
- **Do not** argue for keeping `PendingUpdate` as the item type. It was a lowest-common-denominator envelope.
- **Do not** argue for keeping the compound cursor. It exists only to serve the merge.
- **Do not** argue for building a new `member_notifications` table. `signal_deliveries` already is it.
- **Do not** argue for keeping `signal_deliveries` as the table name. The name is wrong; it constrains thinking.
- **Do not** argue for keeping `signal.*` as the stored topic vocabulary. The migration rewrites it.
- **Do not** argue that renaming is too much churn. Churn is explicitly not the constraint.
- **Do not** re-open the `events.*` collision question. `events.*` is calendar. `activity.*` is the tape. They are distinct.
- **Do not** argue for adding `notifications.acknowledge` as a future concern. It ships in Phase 1 alongside the migration.
- **Do not** argue for preserving `sharedContext.pendingUpdates` as dead weight. It is being repurposed.
- **Do not** argue for splitting Phase 1 into smaller phases. The migration, worker update, and action rewrite are atomic.
- **Do not** argue for keeping `/updates/stream` at the old URL. The new URL is `/stream`.
- **Do not** argue for keeping the `updates` NOTIFY channel name. The new channel is `stream`.
- **Do not** argue for keeping `Repository.listMemberUpdates`. It is deleted.
- **Do not** argue for shipping the old scope-refresh plan separately. The base behavior is already shipped; this rewrite extends that existing machinery in place.
- **Do not** argue for leaving `member_notifications.club_id` as NOT NULL. Phase 2 account-scoped notifications depend on the nullability being in place now.
- **Do not** argue for populating `sharedContext.notifications` without per-request caching. The caching rule is the reason the piggyback is affordable.
- **Do not** argue for adding a `getLatestActivityCursor` Repository method. The existing `listClubActivity` seed-on-first-call behavior already handles `after='latest'`.
- **Do not** argue for keeping `pollingResponse` in `src/schemas/transport.ts`. It is dead code referencing the deleted `memberUpdates` shape.
- **Do not** argue for preserving `DirectMessageUpdateReceipt` / `updateReceipts`. They are dead code, always empty today, and tied to the deleted `PendingUpdate.updateId` vocabulary.
- **Do not** argue for skipping the `src/schema-endpoint.ts` edits. The file is agent-visible via `/api/schema` and must match the new surface.
- **Do not** argue for skipping the `src/dispatch.ts:57` side-effect import replacement. Without deleting the old import and adding the two new ones, the new actions never register.

What the reviewer SHOULD pressure-test:

- Any remaining line / symbol drift since the plan was written — every citation in this plan should be re-resolved with `rg` by symbol before editing
- Implementation traps in the migration SQL beyond the enumerated renames (grants, permissions, triggers on tables the plan didn't inventory)
- Edge cases in the per-request notification cache (concurrent handlers, error paths, request retries with `clientKey`)
- Edge cases in the stream frame emission (ordering within a burst, cursor attachment on activity-only bursts, Last-Event-ID parse failures, reconnect mid-burst)
- Test-coverage gaps beyond the enumerated list above
- Whether the synchronicity worker's existing invariants (TTL, throttling, freshness guards, advisory locks, offer-match drift detection) survive the rename and topic rewrite without behavioral change
- Whether the read-time entity-published and topic-specific guards preserve their full semantics after the topic vocabulary rewrite
- Any unexpected consumer of `signal_deliveries` that was missed by grep — `rg signal_deliveries` across the entire repo, including docs, tests, runbooks, and operational dashboards
- Any operational dashboards, alerts, or runbooks that reference the old table name, channel name, or URL

If you find something that belongs in that second list, speak up. If you find something that belongs in the "do not re-open" list, ignore it.
