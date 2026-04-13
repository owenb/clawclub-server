# Plan: Updates Transport Rewrite Around First Principles

## Status

These decisions are **locked**. Prior revisions of this plan went through multiple compromise shapes trying to minimize churn at the expense of clarity. We are no longer optimizing for churn. We are optimizing for the long-term shape the system should have had from the start.

The only constraint is data-migration safety. Code churn, schema churn, action renames, test rewrites, and doc rewrites are all free. Any reviewer re-reading this plan should pressure-test it for implementation traps, not re-open the direction.

This revision integrates the second-round review findings around per-request caching, column nullability, DM stream primitive, audience computation, cursor semantics, migration SQL extras, and cross-plan dependency. Everything that used to be "implementer's call" is now pinned.

## Recommendation

Delete the merged-tape abstraction entirely. Split it into the surfaces that match the four distinct things a member actually cares about: club activity, personal notifications, DMs, and calendar events. Rename `signal_deliveries` to `member_notifications` to reflect what it has always actually been. Repurpose the existing (but unused) envelope piggyback field so notifications ride along on every authenticated response, gated by a strict per-request caching rule so the piggyback never pays more than one notification read per request.

## The single load-bearing insight

`signal_deliveries` has always been `member_notifications` in disguise. Look at the columns today in `db/init.sql` around line 1124 (the table block — rg it, it has drifted across revisions): `id`, `recipient_member_id`, `club_id`, `seq`, `topic`, `payload`, `entity_id`, `match_id`, `acknowledged_state`, `acknowledged_at`, `suppression_reason`, `created_at`. That is the per-recipient materialized notification table. The vocabulary got frozen around synchronicity — the first use case — when it should have been generalized. Every prior revision of this plan sketched a future `member_notifications` table that would need to be built in "Phase 2". It doesn't need to be built. It needs to be renamed.

Once you accept that rename, the entire "merged updates tape" abstraction collapses. There is no tape. There is club activity, personal notifications, DM inbox, and calendar events — four honest concepts, each with its own cursor model, its own ack semantics, and its own typed item shape.

## Locked decisions

1. **Four canonical read surfaces.** `activity.*`, `notifications.*`, `messages.*`, `events.*`. Nothing else.
2. **Delete the `updates.*` namespace entirely.** `updates.list`, `updates.acknowledge`, `/updates/stream`, `PendingUpdate`, `memberUpdates`, the compound cursor, `Repository.listMemberUpdates`, `Repository.getLatestCursor`, `Repository.acknowledgeUpdates`. All gone.
3. **Rename `signal_deliveries` to `member_notifications`** via data migration. Keep all columns, keep all data, update stored `topic` values to the new vocabulary, drop `NOT NULL` on `club_id` for future account-scoped notifications, rename the IDENTITY backing sequence, rename indexes and triggers.
4. **Repurpose `sharedContext.pendingUpdates` as `sharedContext.notifications`**, typed `NotificationItem[]`, populated on every authenticated response by the dispatch layer. Strict per-request caching: one notification read per request, never more. This is the primary agent read path — `notifications.list` is a fallback for agents that want a forced refresh.
5. **Rename `/updates/stream` to `/stream`.** One SSE endpoint with typed frames for each concept.
6. **Rename the `updates` NOTIFY channel to `stream`.** One-line change in each trigger and in the listen statement.
7. **Synchronicity matching keeps its internal vocabulary for lifecycle state.** `signal_background_matches` and `signal_recompute_queue` stay named as-is. Only the user-visible delivery table (`signal_deliveries` → `member_notifications`) is renamed, and only its stored `topic` values get rewritten to the `synchronicity.*` vocabulary.
8. **Phase 0 ships `clubadmin.admissions.get` standalone.** Unchanged from prior plan revisions.
9. **Derived admissions notifications still live in `notifications.list`.** They are composed alongside materialized notifications from the table. FIFO cap, stable ordering, `truncated` flag, all preserved.
10. **Typed wakeup cause plumbing.** NOTIFY triggers tag with `kind`, `waitForUpdate()` returns `{ outcome, cause? }`, a `NOTIFICATION_WAKEUP_KINDS` allowlist gates `notifications_dirty` emission.
11. **Existing `admission.submitted` activity append stays.** It is historical club activity, not a personal notification. The two are distinct and both valid.
12. **`member_notifications.club_id` becomes nullable in the migration.** Phase 2 account-scoped notifications must work without another schema migration.
13. **The DM stream read path is a first-class Repository primitive.** Extract from the merged-tape query into `Repository.listInboxSince`.
14. **Phase 1 updates and absorbs the stream scope-refresh plan.** Both plans touch the same stream loop and must not ship serially.

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

Reads from `club_activity` using the existing audience filter logic from `src/clubs/index.ts` (the `listClubActivity` function at lines 404-465 — rg to confirm). No merging with other sources. No compound cursor — just the single activity seq.

No `activity.acknowledge` — activity items cursor-advance without explicit ack, same as today.

`after = 'latest'` is preserved for backlog-skipping. It resolves via `Repository.getLatestActivityCursor(actorMemberId, clubIds)`, which returns the current max seq for the actor's accessible clubs. This replaces the deleted `Repository.getLatestCursor`. The method is renamed for honesty — it was always activity-specific, just bundled into the compound cursor.

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

Phase-1 `kind` values (the external vocabulary, used in both the API response and the stored `topic` column after migration):

- `admission.submitted` — derived from `current_admissions` where `status = 'submitted'` and the actor is a clubadmin of the admission's club
- `synchronicity.ask_to_member` — materialized, migrated from existing signal rows (was `signal.ask_to_member` — rg `src/workers/synchronicity.ts` to confirm the actual current stored value)
- `synchronicity.offer_to_ask` — materialized, was `signal.offer_match`
- `synchronicity.member_to_member` — materialized, was `signal.member_to_member`

Reads are a union:

1. **Materialized:** read unacknowledged rows from `member_notifications` where `recipient_member_id = actor` and `club_id` is in the actor's accessible clubs OR `club_id IS NULL` (for account-scoped notifications). Read-time filtering preserves the two guards from the current `listMemberUpdates` SQL — both the generic published-entity check and the topic-specific offer-match `yourAskEntityId` check. Both guards move with the query into `listNotifications`, updated to reference the new stored topic value (`synchronicity.offer_to_ask` instead of `signal.offer_match`).
2. **Derived admissions:** read from `current_admissions` where `status = 'submitted'` and `club_id` is in the actor's clubadmin clubs, ordered `ORDER BY version_created_at ASC, id ASC`, capped at a server-internal `MAX_NOTIFICATIONS`.

Merge the two sets. Return `truncated` if either the materialized set or the derived set was capped.

### `notifications.acknowledge` — ack for materialized items only

- action: `notifications.acknowledge`
- auth: `member`
- input: `{ notificationIds: string[], state: 'processed' | 'suppressed', suppressionReason?: string | null }`
- output: `{ receipts: NotificationReceipt[] }`

Only updates materialized rows in `member_notifications`. Derived notifications are rejected explicitly with `422 invalid_input` — a client-facing error message that says "derived notifications resolve automatically and cannot be acknowledged". Derived notification IDs are detectable by their `kind_family` prefix (e.g., `admission.submitted:*`).

**All-or-nothing semantics:** if any ID in the batch is a derived notification ID, the whole call fails with 422. No partial acknowledgement. This matches the existing `updates.acknowledge` all-or-nothing pattern and avoids ambiguous partial-success responses.

### `messages.*` — DM surface

The agent-facing actions (`messages.getInbox`, `messages.send`, `messages.getThread`, `messages.remove`) are unchanged. Internally, a new Repository primitive is added for the stream loop to produce incremental `message` frames — see the "DM stream read path" section below.

### `events.*` — calendar surface

Unchanged. `events.list`, `events.rsvp`, `events.cancelRsvp` already exist and already mean "calendar gatherings". Do not touch.

## The piggyback envelope

Every authenticated response carries `sharedContext` today. The field `sharedContext.pendingUpdates` at `src/schemas/transport.ts:21-23` is currently dead weight — declared in the envelope, initialized to `[]` in `src/identity/auth.ts:135, 168`, filtered in `src/dispatch.ts:217`, but nothing ever populates it.

Repurpose it:

- Rename the field from `sharedContext.pendingUpdates` to `sharedContext.notifications`
- Change the type from `PendingUpdate[]` (deleted) to `NotificationItem[]`
- Populate it on every authenticated response by calling `listNotifications({ actorMemberId })` during envelope assembly in `src/dispatch.ts`
- Keep the existing filter-on-acknowledge logic at `src/dispatch.ts:217` so `notifications.acknowledge` removes items from the piggyback set for the same response

The effect: agents reading the envelope of any response they were already making get their current notification set for free. Polling `notifications.list` explicitly becomes a fallback for agents that want to force a refresh, not the primary read path.

The existing `ActionResult.acknowledgedUpdateIds` field at `src/schemas/registry.ts` (around line 124 — rg the comment referencing `sharedContext.pendingUpdates`) is renamed to `acknowledgedNotificationIds`. The filter at `src/dispatch.ts:214-218` updates its target field, its comment, and its type.

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
5. **Unauthenticated actions** (cold admission flows) never call `listNotifications` because they use `unauthenticatedSuccessEnvelope` which has no `sharedContext`. Confirm at `src/schemas/transport.ts:54-59`.

Result: `notifications.list` pays one read (down from two), every other authenticated action pays one read, unauthenticated actions pay zero. `session.getContext` on connect gives the agent a full notification set as part of the standard envelope.

If performance profiling later shows the per-request read is too expensive on hot paths, the mitigation is to add an `ActionDefinition.skipSharedNotifications?: boolean` flag for high-frequency read endpoints. That is a Phase 2 concern, not a Phase 1 concern.

## Stream cursor and Last-Event-ID semantics

The old `/updates/stream` attached a compound cursor (`{ a: activitySeq, s: signalSeq, t: inboxTimestamp }`) as the SSE frame `id:` on the last event in each batch. Clients reconnecting with `Last-Event-ID` resumed from that compound cursor. That is being deleted along with the merged tape.

Under the new `/stream`, cursor semantics are per-frame-type:

- **`activity` frames** attach the `ActivityEvent.seq` as the SSE `id:` field. On reconnect with `Last-Event-ID: <seq>`, the stream resumes activity delivery from that seq. If the `Last-Event-ID` value is not a parseable seq (e.g., from an old client), it is treated as `'latest'` and the stream seeds from current activity tip.
- **`message` frames** do not attach an `id:`. Message resumption is handled by the per-connection inbox cursor maintained in the stream loop — see "DM stream read path" below. Clients that miss `message` frames across a reconnect re-seed by reading their inbox via `messages.getInbox({ unreadOnly: true })` and/or by reading `sharedContext.notifications` from any subsequent authenticated action (since unread DM counts are NOT in notifications, this is message-specific).
- **`notifications_dirty` frames** do not attach an `id:`. They are pure invalidation signals with no state. Reconnecting after a dirty frame does nothing special — the next authenticated request's `sharedContext.notifications` carries current state.
- **`ready` frames** attach the current activity tip as the `id:` field, so that a reconnect without an explicit cursor naturally resumes from the ready-frame position.

The `after = 'latest'` convention is preserved for `activity.list`. It resolves via `Repository.getLatestActivityCursor(actorMemberId, clubIds)`. This is a renamed and narrowed version of the deleted `Repository.getLatestCursor` — same logic (select max seq from club_activity filtered by accessible clubs), new name that matches the new surface.

## The single stream

`GET /stream` replaces `GET /updates/stream`. The old URL returns 404.

Frame types:

- `ready` — initial handshake. Payload: `{ member, requestScope, notifications: NotificationItem[], activityCursor: string | null }`. Seeds both the notification set and the activity cursor in one frame. SSE `id:` is set to `activityCursor`.
- `activity` — a new activity event. Payload: `ActivityEvent`. SSE `id:` is the activity seq.
- `message` — a new DM inbox entry. Payload: the existing DM summary shape used by `messages.getInbox`. No SSE `id:`.
- `notifications_dirty` — invalidation-only. No payload body. No SSE `id:`. Clients react by reading `sharedContext.notifications` on their next authenticated request, or by explicitly calling `notifications.list`.
- `: keepalive` comment — unchanged.

Clients that only care about notifications can connect `/stream` and ignore everything except `notifications_dirty`. Clients that care about activity or DMs can process those frames directly. The frame type is the discriminator — no client-side branching on `source` or `kind` within a shared envelope.

## DM stream read path

The current merged-tape query at `src/postgres.ts:1102-1206` contains a dedicated inbox read that queries `dm_inbox_entries` filtered by recipient and ordered by `created_at ASC`. This logic needs to be extracted into a new Repository primitive so the stream loop can emit `message` frames cleanly.

**New:** `Repository.listInboxSince({ recipientMemberId, after: string | null, limit: number })` — returns new DM inbox entries since a timestamp cursor, ordered `created_at ASC`, with sender details joined in for the `message` frame payload. Same logic as the current inbox section of `listMemberUpdates`, extracted.

Stream loop usage:

1. On connect, `ready` frame records the current inbox head timestamp as the stream's internal `inboxCursor` state
2. On wakeup with `cause.kind === 'message'`, call `listInboxSince({ recipientMemberId, after: inboxCursor, limit: ... })`, emit each result as a `message` frame, advance `inboxCursor` to the last delivered timestamp
3. On reconnect, the client issues `messages.getInbox({ unreadOnly: true })` to reconcile anything missed during the disconnect window

This decouples the DM stream primitive from the tape merge, makes it explicit, and preserves the existing query behavior.

`messages.getInbox` itself (the user-facing paginated inbox read) is unchanged. It remains the canonical historical inbox read.

## Activity audience computation

The current merged-tape query computes `adminClubIds` and `ownerClubIds` from the actor's memberships at `src/postgres.ts:1008-1010`, then passes them into `listClubActivity` for the audience filter at `src/clubs/index.ts:436-438`. Under the new surface, this computation must happen in the `activity.list` action handler.

**Pinned:** the `activity.list` handler computes the audience arrays from `ctx.actor.memberships`:

```ts
const adminClubIds = ctx.actor.memberships.filter(m => m.role === 'clubadmin').map(m => m.clubId);
const ownerClubIds = ctx.actor.memberships.filter(m => m.isOwner).map(m => m.clubId);
```

These are passed into `Repository.listClubActivity` as explicit arguments. The repository method does not re-read the actor.

The stream loop in `src/server.ts` does the same computation at the top of the loop (using the captured `auth.actor`) and passes them into `Repository.listClubActivity` for activity frame production.

`Repository.listClubActivity` is promoted from an internal `ClubsRepository` method to a top-level `Repository` method. Current declaration at `src/clubs/index.ts:565` stays; the top-level `Repository` interface in `src/contract.ts` gains a matching signature; `src/postgres.ts` wires through by calling the existing `clubs.listClubActivity`. Add `'listClubActivity'` to the capability list in `src/schemas/registry.ts`.

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

The stream-loop variable currently named `outcome` at `src/server.ts:513-521` is renamed to `result` to match the new struct shape. The current `if (outcome === 'timed_out')` check becomes `if (result.outcome === 'timed_out')`.

## Data migration

One migration, reversible, in `db/migrations/NNN_rename_signals_to_notifications.sql`. Everything below is metadata-only — no data scan, no row rewrites beyond the topic UPDATE which runs once during migration.

```sql
-- Rename the delivery table
ALTER TABLE signal_deliveries RENAME TO member_notifications;

-- Drop NOT NULL on club_id for future account-scoped notifications.
-- Existing rows all have non-null club_id; no data scan needed.
ALTER TABLE member_notifications ALTER COLUMN club_id DROP NOT NULL;

-- Rename the IDENTITY backing sequence. ALTER TABLE RENAME does not touch
-- the backing sequence name; if we skip this the sequence keeps the old name
-- forever and pg_dump / init.sql regeneration drifts.
ALTER SEQUENCE signal_deliveries_seq_seq RENAME TO member_notifications_seq_seq;

-- Rename indexes
ALTER INDEX signal_deliveries_recipient_poll_idx RENAME TO member_notifications_recipient_poll_idx;
-- (plus any other indexes currently on the table — rg db/init.sql for `signal_deliveries_` and rename each)

-- Rename unique constraints if any have the old table name embedded
-- (rg db/init.sql for `signal_deliveries_` constraint names)

-- Rewrite stored topic values to the new vocabulary.
-- Confirm the actual current stored values by rg-ing src/workers/synchronicity.ts
-- before running this migration.
UPDATE member_notifications SET topic = CASE topic
  WHEN 'signal.ask_to_member' THEN 'synchronicity.ask_to_member'
  WHEN 'signal.offer_match'   THEN 'synchronicity.offer_to_ask'
  WHEN 'signal.member_to_member' THEN 'synchronicity.member_to_member'
  ELSE topic
END;

-- Drop old triggers and functions
DROP TRIGGER IF EXISTS signal_deliveries_notify ON member_notifications;
DROP TRIGGER IF EXISTS club_activity_notify ON club_activity;
DROP TRIGGER IF EXISTS dm_inbox_entries_notify ON dm_inbox_entries;
DROP FUNCTION IF EXISTS notify_signal_delivery();
DROP FUNCTION IF EXISTS notify_club_activity();
DROP FUNCTION IF EXISTS notify_dm_inbox();

-- Create new trigger functions landing on the `stream` channel with typed kinds

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

Verification steps after the migration runs:

- `signal_background_matches` FK to `signal_deliveries(id)` now points at `member_notifications(id)` automatically. Confirm with `\d signal_background_matches` or equivalent introspection.
- Every index on `member_notifications` has a name matching the new table.
- No index or constraint still references the old table name in its name.
- The IDENTITY sequence is named `member_notifications_seq_seq`.
- Existing rows have their `topic` values rewritten (spot-check a few).
- The `stream` NOTIFY channel fires on insert into each of the four source tables.

Test the migration via `scripts/migrate.sh` per `CLAUDE.md`, then mirror the final target state into `db/init.sql`.

## Repository shape

Delete from `src/contract.ts`:

- `listMemberUpdates?`
- `getLatestCursor?`
- `acknowledgeUpdates?`

Add to `src/contract.ts`:

- `listClubActivity({ actorMemberId, clubIds, adminClubIds, ownerClubIds, limit, afterSeq })` — promoted from the internal `ClubsRepository` definition at `src/clubs/index.ts:565`. Top-level exposure required because the action handler must call it directly.
- `getLatestActivityCursor({ actorMemberId, clubIds })` — returns the current max `club_activity.seq` for the actor's accessible clubs. Replaces `getLatestCursor` with a name that matches its one remaining purpose.
- `listNotifications({ actorMemberId, accessibleClubIds, adminClubIds })` — union of materialized reads from `member_notifications` and derived reads from `current_admissions`.
- `acknowledgeNotifications({ actorMemberId, notificationIds, state, suppressionReason })` — updates materialized rows only; rejects derived IDs.
- `listInboxSince({ recipientMemberId, after, limit })` — incremental DM read for the stream loop, extracted from the current merged-tape query.
- `getAdmission?({ actorMemberId, admissionId, accessibleClubIds })` — Phase 0.

Add to `src/schemas/registry.ts` capability list:

- `'listClubActivity'`
- `'getLatestActivityCursor'`
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

1. Every `INSERT INTO signal_deliveries` → `INSERT INTO member_notifications`
2. Every hardcoded topic string (`'signal.ask_to_member'` etc. — rg around line 751 to find them all) → the corresponding `'synchronicity.*'` value
3. Any internal branching on topic strings (grep for the old values) → updated to the new values

The existing match lifecycle transaction (FOR UPDATE + delivery row insert + state transition, per `docs/design-decisions.md` synchronicity section) stays exactly the same. Only the table name and the topic strings change.

**Stored `topic` values match `NotificationItem.kind` values after the migration.** No read-time vocabulary translation. The storage layer and the API layer use the same vocabulary. The migration UPDATE brings existing rows into alignment with the new worker code; the new worker code inserts the new vocabulary going forward.

## Deployment and operational notes

The rename migration and the synchronicity worker code update must land atomically. They cannot ship in separate deploys because:

- If the migration runs first, the old worker code attempts `INSERT INTO signal_deliveries` which no longer exists → every synchronicity match insert fails until the new code deploys
- If the worker code ships first, it attempts `INSERT INTO member_notifications` which doesn't yet exist → same failure

**Pinned deploy sequence:**

1. Migration, server code, and worker code all ship in one deploy
2. During the deploy window (typically seconds to a minute), synchronicity match inserts may fail with "relation does not exist" errors. These are retried by the worker's existing error handling and self-resolve as the new code activates.
3. The deploy runbook should say: "expect 0-10 synchronicity worker errors during the deploy window; they self-resolve as the new code takes effect. Alert only if errors continue for more than 5 minutes."

This is acceptable because (a) the worker is asynchronous and already has retry logic, (b) no agent-facing endpoint is affected by the error window, (c) the migration itself is metadata-only and fast.

## Cross-plan dependency on scope-refresh

The related plan at `plans/updates-stream-scope-refresh.md` fixes a separate bug where a long-lived `/updates/stream` connection does not pick up membership changes until reconnect. That plan refreshes the captured `clubIds` on a 60-second cadence inside the stream loop.

Both plans touch the same stream loop in `src/server.ts`. They cannot ship serially without one of them rewriting significant portions of the other's changes. **Phase 1 of this plan absorbs and updates the scope-refresh plan**, not as an afterthought but as a first-class part of the stream rewrite:

- The scope refresh runs against `/stream` (not `/updates/stream`) — URL reference updated
- The refresh updates `clubIds`, `adminClubIds`, and `ownerClubIds` all together — activity visibility and notification relevance both depend on the actor's membership state, and a promoted clubadmin must start seeing `notifications_dirty` for their new club without reconnecting
- The refresh cadence and configuration knob (`streamScopeRefreshMs`) stay as designed in the scope-refresh plan
- The `validateBearerTokenPassive` helper from the scope-refresh plan ships as part of Phase 1 of this plan, not as a separate PR

After Phase 1 of this plan lands, the scope-refresh plan is complete and can be archived or marked as superseded.

## Phase 0: `clubadmin.admissions.get`

Unchanged from prior plan revisions. Ship as a standalone PR ahead of everything else.

- action: `clubadmin.admissions.get`
- auth: `clubadmin` (superadmin bypass via `ctx.requireClubAdmin(clubId)` early return at `src/dispatch.ts:77-85`)
- input: `{ clubId, admissionId }`
- output: `{ admission: AdmissionSummary }`

The existing `readAdmission` helper at `src/clubs/admissions.ts:146-152` returns a raw `AdmissionRow`, not the full `AdmissionSummary`. Phase 0 needs either:

- an extended helper that joins applicant / sponsor display names, or
- a dedicated single-row query that mirrors the `listAdmissions` projection at `src/postgres.ts:460-482`

`getAdmission?` lands on Repository with matching optional pattern. `'getAdmission'` lands in the capability list.

Tests in `test/integration/non-llm/admissions.test.ts`: happy path fetch in scope, regular member 403, superadmin bypass, response shape matches `AdmissionSummary`.

## Phase 1: The full rewrite

Everything else in this plan. One PR (or a small number of tightly-coupled PRs). The rewrite cannot land in pieces — the migration, the action surfaces, the stream, the worker update, and the scope refresh are interdependent.

Implementation order inside the PR:

1. **Migration first.** Write `db/migrations/NNN_rename_signals_to_notifications.sql`. Test via `scripts/migrate.sh`. Mirror into `db/init.sql`.
2. **Schemas and types.** Delete `PendingUpdate`, `memberUpdates`, `pendingUpdate` Zod schema, `sseUpdateEvent` references. Add `activityEvent`, `notificationItem`, `notificationReceipt`, `notificationsResponse`, `activityResponse`. Update `sharedContext` field name from `pendingUpdates` to `notifications`. Rename `ActionResult.acknowledgedUpdateIds` → `acknowledgedNotificationIds` in `src/schemas/registry.ts`.
3. **Contract interface.** Update `src/contract.ts` with the new Repository shape: delete the three old methods, add the six new ones.
4. **Repository implementation.** Delete `listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates` from `src/postgres.ts`. Add `listClubActivity` wiring, `getLatestActivityCursor`, `listNotifications`, `acknowledgeNotifications`, `listInboxSince`, `getAdmission`.
5. **Handler context.** Extend `HandlerContext` in `src/schemas/registry.ts` with the memoized `getNotifications()` accessor. Wire the per-request cache.
6. **Action handlers.** Create `src/schemas/activity.ts` and `src/schemas/notifications.ts`. Delete `src/schemas/updates.ts`. Pin that `activity.list` handler computes `adminClubIds` and `ownerClubIds` from `ctx.actor.memberships`.
7. **Dispatch layer.** Update envelope assembly in `src/dispatch.ts` to populate `sharedContext.notifications` via `ctx.getNotifications()`. Update the ack-filter logic at line 217 to operate on `sharedContext.notifications` and `acknowledgedNotificationIds`. Update the field-rename comment at `src/schemas/registry.ts:124`.
8. **Auth init.** Update `src/identity/auth.ts:135, 168` to initialize `sharedContext: { notifications: [] }`. Add the `validateBearerTokenPassive` helper from the scope-refresh plan.
9. **Stream handler.** Rewrite `/updates/stream` → `/stream` in `src/server.ts`. Add the typed frame emission logic. Wire in the extended `WaitResult` from the notifier. Rename the `outcome` variable to `result` at line 513-521. Add the periodic scope refresh from the scope-refresh plan.
10. **Notifier.** Update `src/member-updates-notifier.ts` to listen on `stream` instead of `updates`, parse the `kind` field from payloads, return the typed `WaitResult`.
11. **Synchronicity worker.** Update `src/workers/synchronicity.ts` to write to `member_notifications` with the new topic vocabulary.
12. **Tests.** Delete `test/integration/non-llm/signals.test.ts` test references to `updates.list`; rewrite against `notifications.list`. Rewrite DM polling tests against the new stream frames. Add `test/integration/non-llm/activity.test.ts` and `test/integration/non-llm/notifications.test.ts`. Update `test/integration/non-llm/stream-scope-refresh.test.ts` to use `/stream` and the new frame types.
13. **Unit tests and fixtures.** Rename `test/unit/fixtures.ts:78-94` `makePendingUpdate` → `makeNotificationItem` and `makeActivityEvent`. Update the five `sharedContext.pendingUpdates` references in `test/unit/app.test.ts` at lines 79, 672, 673, 2273, 3223.
14. **Docs.** Rewrite `docs/design-decisions.md` "Update transport" and "Member signals" sections. Rewrite `SKILL.md` "Checking for new messages" (lines 26-32) and "`updates.list` / `updates.acknowledge`" (lines 264-266) sections.
15. **Schema snapshot.** Regenerate `test/snapshots/api-schema.json`.
16. **Patch bump.** `package.json` version.

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

- `src/schemas/updates.ts`

### New

- `src/schemas/activity.ts`
- `src/schemas/notifications.ts`
- `db/migrations/NNN_rename_signals_to_notifications.sql`
- `test/integration/non-llm/activity.test.ts`
- `test/integration/non-llm/notifications.test.ts`

### Significantly modified

- `src/contract.ts` — Repository interface, type imports
- `src/postgres.ts` — remove `listMemberUpdates` and friends, add new methods including `listInboxSince` and `getLatestActivityCursor`
- `src/server.ts` — `/stream` handler, typed frame emission, periodic scope refresh, `validateBearerTokenPassive` integration
- `src/member-updates-notifier.ts` — channel rename, typed WaitResult, kind parsing
- `src/schemas/transport.ts` — `sharedContext.notifications`, SSE frame schemas (add `notificationsDirtyEvent`, update `sseReadyEvent`)
- `src/schemas/responses.ts` — delete `pendingUpdate`, add `activityEvent`, `notificationItem`, `notificationReceipt`
- `src/schemas/registry.ts` — capability list update, `HandlerContext.getNotifications` memo, `ActionResult.acknowledgedNotificationIds` rename, comment at line 124 updated
- `src/schemas/clubadmin.ts` — Phase 0 `clubadmin.admissions.get`
- `src/dispatch.ts` — `sharedContext.notifications` population via `ctx.getNotifications()`, ack filter field rename at line 217
- `src/identity/auth.ts` — `sharedContext` init field rename, `validateBearerTokenPassive` helper
- `src/clubs/admissions.ts` — Phase 0 helper extension
- `src/clubs/index.ts` — confirm `listClubActivity` top-level exposure (signature promotion in `src/contract.ts`, no body change)
- `src/workers/synchronicity.ts` — writes to `member_notifications` with new topic vocabulary
- `db/init.sql` — mirror migration after test
- `docs/design-decisions.md` — rewrite Update Transport + Member Signals sections
- `SKILL.md` — rewrite polling/streaming sections
- `test/integration/non-llm/admissions.test.ts` — Phase 0 tests
- `test/integration/non-llm/signals.test.ts` — rewrite or fold into `notifications.test.ts`
- `test/integration/non-llm/messages.test.ts` — update DM stream frame expectations
- `test/integration/non-llm/stream-scope-refresh.test.ts` — update for new stream URL, frame types, and integrated scope refresh
- `test/integration/non-llm/smoke.test.ts` — update any tape-references
- `test/unit/fixtures.ts` — delete `makePendingUpdate`, add `makeActivityEvent`, `makeNotificationItem`
- `test/unit/app.test.ts` — update five `sharedContext.pendingUpdates` references
- `test/snapshots/api-schema.json` — regenerate
- `package.json` — patch bump

### Archived / superseded after this lands

- `plans/updates-stream-scope-refresh.md` — absorbed into Phase 1 of this plan

## Tests to cover

### Phase 0

- `clubadmin.admissions.get` returns a single admission in scope
- Regular member cannot call it
- Superadmin bypass works
- Response shape matches `AdmissionSummary`

### Phase 1 — activity

- `activity.list` returns club-scoped activity events
- Cursor advances correctly across repeated polls
- Audience filter respects `members` / `clubadmins` / `owners`
- `clubId` filter narrows to one club when provided
- `after='latest'` resolves via `getLatestActivityCursor` and skips backlog

### Phase 1 — notifications

- `notifications.list` returns materialized rows from `member_notifications` (migrated signal data)
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
- Account-scoped notification (club_id = null) round-trips correctly (stubbed test — uses a fixture with null club_id)

### Phase 1 — envelope piggyback

- Every authenticated response carries `sharedContext.notifications` populated
- `notifications.list` handler and envelope assembly share the per-request cache (query counter assertion — one `listNotifications` call per request)
- `notifications.acknowledge` on a materialized row removes the row from the same response's `sharedContext.notifications`
- Non-admin calling an unrelated action sees an empty `sharedContext.notifications`
- Piggyback respects the same FIFO cap and `MAX_NOTIFICATIONS`
- Unauthenticated actions (cold admission) do not trigger notification reads at all

### Phase 1 — stream

- `GET /stream` replaces `GET /updates/stream`; old URL returns 404
- `ready` frame includes initial notifications set and activity cursor
- `activity` frames carry `ActivityEvent` payloads with seq as SSE `id:`
- `message` frames carry DM inbox entries (no SSE `id:`)
- `notifications_dirty` fires on `member_notifications` insert
- `notifications_dirty` fires on `admission_versions` insert
- `notifications_dirty` does not fire on unrelated wakeups (activity, message)
- Untagged / malformed NOTIFY payloads don't emit `notifications_dirty`
- Reconnect with `Last-Event-ID: <activity_seq>` resumes activity from that seq
- Reconnect with a garbage `Last-Event-ID` resumes from latest
- Periodic scope refresh picks up new clubadmin memberships mid-stream and starts delivering `notifications_dirty` for the new club's `admission_versions` inserts without reconnect

### Phase 1 — migration

- Existing `signal_deliveries` data survives the rename intact — row count, specific row contents by id
- `signal_background_matches` FK still resolves to the renamed delivery table
- The IDENTITY backing sequence is renamed and continues to allocate correctly
- `club_id` nullability drop succeeds and does not invalidate existing rows
- Stored `topic` values are rewritten to the `synchronicity.*` vocabulary
- New triggers fire on inserts into all four source tables and deliver NOTIFY on the new `stream` channel
- The `notify_admission_version` trigger resolves `club_id` correctly via the join pattern (verify with an admission_version insert that should wake a clubadmin stream)
- Read-time entity-still-published filter still suppresses synchronicity matches whose referenced entity is no longer published
- Read-time topic-specific filter still suppresses offer-match notifications whose matched ask has been unpublished (verify with the new topic value `synchronicity.offer_to_ask`)

### Phase 1 — synchronicity worker

- Worker inserts into `member_notifications` with new topic vocabulary
- `signal_background_matches` lifecycle (pending → delivered) still works across the table rename
- Per-recipient advisory lock for throttle enforcement still works
- Read-time entity-published filter still suppresses unpublished-entity matches
- Offer-match ask drift still expires matches
- Worker error window during migration is bounded (<5 min, errors self-resolve)

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
- **Do not** argue for shipping the scope-refresh plan separately. It is absorbed into Phase 1.
- **Do not** argue for leaving `member_notifications.club_id` as NOT NULL. Phase 2 account-scoped notifications depend on the nullability being in place now.
- **Do not** argue for populating `sharedContext.notifications` without per-request caching. The caching rule is the reason the piggyback is affordable.

What the reviewer SHOULD pressure-test:

- Any remaining file / line drift since the plan was written (rg to confirm)
- Implementation traps in the migration SQL (index names, constraint names, FK renames, trigger drops, grants, sequence rename)
- Edge cases in the per-request notification cache (concurrent handlers, error paths, request retries)
- Edge cases in the stream frame emission (ordering within a burst, cursor attachment, Last-Event-ID parse failures, reconnect mid-burst)
- Test-coverage gaps beyond the enumerated list above
- Whether the synchronicity worker's existing invariants (TTL, throttling, freshness guards, advisory locks, offer-match drift detection) survive the rename and topic rewrite without behavioral change
- Whether the read-time entity-published and topic-specific guards preserve their full semantics after the topic vocabulary rewrite
- Any unexpected consumer of `signal_deliveries` that was missed by grep (rg for all references to the old name before the migration runs)
- Any operational dashboards, alerts, or runbooks that reference the old table name, channel name, or URL

If you find something that belongs in that second list, speak up. If you find something that belongs in the "do not re-open" list, ignore it.
