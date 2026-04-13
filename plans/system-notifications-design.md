# Plan: Updates Transport Rewrite Around First Principles

## Status

These decisions are **locked**. Prior revisions of this plan went through multiple compromise shapes trying to minimize churn at the expense of clarity. We are no longer optimizing for churn. We are optimizing for the long-term shape the system should have had from the start.

The only constraint is data-migration safety. Code churn, schema churn, action renames, test rewrites, and doc rewrites are all free. Any reviewer re-reading this plan should pressure-test it for implementation traps, not re-open the direction.

## Recommendation

Delete the merged-tape abstraction entirely. Split it into the surfaces that match the four distinct things a member actually cares about: club activity, personal notifications, DMs, and calendar events. Rename `signal_deliveries` to `member_notifications` to reflect what it has always actually been. Repurpose the existing (but unused) envelope piggyback field so notifications ride along on every authenticated response.

## The single load-bearing insight

`signal_deliveries` has always been `member_notifications` in disguise. Look at the columns today at `db/init.sql:1082-1115`: `id`, `recipient_member_id`, `club_id`, `topic`, `payload`, `acknowledged_state`, `suppression_reason`, `created_at`. That is the per-recipient materialized notification table. The vocabulary got frozen around synchronicity — the first use case — when it should have been generalized. Every prior revision of this plan sketched a future `member_notifications` table that would need to be built in "Phase 2". It doesn't need to be built. It needs to be renamed.

Once you accept that rename, the entire "merged updates tape" abstraction collapses. There is no tape. There is club activity, personal notifications, DM inbox, and calendar events — four honest concepts, each with its own cursor model, its own ack semantics, and its own typed item shape.

## Locked decisions

1. **Four canonical read surfaces.** `activity.*`, `notifications.*`, `messages.*`, `events.*`. Nothing else.
2. **Delete the `updates.*` namespace entirely.** `updates.list`, `updates.acknowledge`, `/updates/stream`, `PendingUpdate`, `memberUpdates`, the compound cursor, `Repository.listMemberUpdates`, `Repository.getLatestCursor`, `Repository.acknowledgeUpdates`. All gone.
3. **Rename `signal_deliveries` to `member_notifications`** via data migration. Keep all columns, keep all data. Update every reference in code, triggers, indexes, and tests.
4. **Repurpose `sharedContext.pendingUpdates` as `sharedContext.notifications`**, typed `NotificationItem[]`, populated on every authenticated response by the dispatch layer. This is the primary read path for agents — polling `notifications.list` is a fallback.
5. **Rename `/updates/stream` to `/stream`.** One SSE endpoint with typed frames for each concept.
6. **Rename the `updates` NOTIFY channel to `stream`.** One-line change in each trigger and in the listen statement.
7. **Synchronicity matching keeps its internal vocabulary.** `signal_background_matches`, `signal_recompute_queue`, and the synchronicity worker stay named as-is — they are synchronicity-specific internal state. Only the user-visible delivery table (`signal_deliveries` → `member_notifications`) is renamed.
8. **Phase 0 ships `clubadmin.admissions.get` standalone.** Unchanged from prior plan revisions.
9. **Derived admissions notifications still live in `notifications.list`.** They are composed alongside materialized notifications from the table. FIFO cap, stable ordering, `truncated` flag, all preserved.
10. **Typed wakeup cause plumbing.** `admission_versions` NOTIFY trigger tags with `kind: 'admission_version'`, `waitForUpdate()` returns `{ outcome, cause? }`, a `NOTIFICATION_WAKEUP_KINDS` allowlist gates `notifications_dirty` emission.
11. **Existing `admission.submitted` activity append stays.** It is historical club activity, not a personal notification. The two are distinct and both valid.

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
  activityId: string;            // stable, derived from club_activity row id or seq
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

Reads from `club_activity` with the existing audience filter logic at `src/clubs/index.ts:432-449`. No merging with other sources. No compound cursor — just the single activity seq.

No `activity.acknowledge` — activity items cursor-advance without explicit ack, same as today.

### `notifications.list` — personal sticky queue

Sticky queue of everything personally targeted at the member.

- action: `notifications.list`
- auth: `member`
- input: `{}`
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
  acknowledgedState: 'processed' | 'suppressed' | null;  // always null for derived
};
```

Phase-1 `kind` values:

- `admission.submitted` — derived from `current_admissions` where `status = 'submitted'` and the actor is a clubadmin of the admission's club
- `synchronicity.ask_to_member` — materialized, migrated from existing signal rows
- `synchronicity.offer_to_ask` — materialized, migrated from existing signal rows
- `synchronicity.member_to_member` — materialized, migrated from existing signal rows

Reads are a union:

1. **Materialized:** read unacknowledged rows from `member_notifications` where `recipient_member_id = actor` and `club_id` is in the actor's accessible clubs. Read-time filtering preserves the existing entity-still-published guard from `src/postgres.ts:1060-1073`.
2. **Derived admissions:** read from `current_admissions` where `status = 'submitted'` and `club_id` is in the actor's clubadmin clubs, ordered `ORDER BY version_created_at ASC, id ASC`, capped at a server-internal `MAX_NOTIFICATIONS`.

Merge the two sets, return `truncated` if the derived set hit the cap.

### `notifications.acknowledge` — ack for materialized items only

- action: `notifications.acknowledge`
- auth: `member`
- input: `{ notificationIds: string[], state: 'processed' | 'suppressed', suppressionReason?: string | null }`
- output: `{ receipts: NotificationReceipt[] }`

Only updates materialized rows in `member_notifications`. Derived notifications are rejected explicitly with `422 invalid_input` — a client-facing error message that says "derived notifications resolve automatically and cannot be acknowledged". Derived notification IDs are detectable by their `kind_family` prefix (e.g., `admission.submitted:*`).

### `messages.*` — DM surface

Unchanged. `messages.getInbox`, `messages.send`, `messages.getThread`, `messages.remove` already exist and are already the canonical DM read path.

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

This is the agent-first design we always should have had. The merged-tape abstraction was a polling-first design because nobody noticed the envelope already had the shape.

## The single stream

`GET /stream` replaces `GET /updates/stream`.

Frame types:

- `ready` — initial handshake. Payload: `{ member, requestScope, notifications: NotificationItem[], activityCursor: string | null }`. Seeds both the notification set and the activity cursor in one frame.
- `activity` — a new activity event. Payload: `ActivityEvent`. Attaches the activity seq as the SSE frame id for `Last-Event-ID` resumption.
- `message` — a new DM inbox entry. Payload: the existing DM summary shape.
- `notifications_dirty` — invalidation-only. No payload body. Clients react to the frame type alone by re-reading `sharedContext.notifications` on their next action, or by explicitly calling `notifications.list`.
- `: keepalive` comment — unchanged.

Clients that only care about notifications can connect `/stream` and ignore everything except `notifications_dirty`. Clients that care about activity or DMs can process those frames directly. There is no client-side branch on "is this a notification or an activity or a message" — the frame type is the discriminator.

## Wakeup plumbing

Single NOTIFY channel renamed from `updates` to `stream`.

Triggers, all landing on the `stream` channel:

- `notify_club_activity` on `club_activity` insert — payload `{ clubId, kind: 'activity' }`
- `notify_member_notification` on `member_notifications` insert — payload `{ clubId, recipientMemberId, kind: 'notification' }`
- `notify_dm_inbox` on `dm_inbox_entries` insert — payload `{ recipientMemberId, kind: 'message' }`
- `notify_admission_version` on `admission_versions` insert — payload `{ clubId, kind: 'admission_version' }` (new in this plan)

`MemberUpdateNotifier.waitForUpdate()` returns:

```ts
type WaitResult =
  | { outcome: 'notified'; cause: { kind: string; clubId?: string | null; recipientMemberId?: string | null } }
  | { outcome: 'timed_out' };
```

The stream loop uses `cause.kind` to decide which frame to emit on the next iteration:

- `'activity'` → next `listClubActivity` call; emit any new `activity` frames
- `'notification'` → emit `notifications_dirty`
- `'message'` → next DM inbox read; emit any new `message` frames
- `'admission_version'` → emit `notifications_dirty` (derived admissions set may have changed)
- unknown → event-tape default behavior (read activity), no `notifications_dirty`

A `NOTIFICATION_WAKEUP_KINDS = new Set(['notification', 'admission_version'])` allowlist gates `notifications_dirty` emission. Untagged or malformed payloads never emit `notifications_dirty`.

## Data migration

One migration, reversible, in `db/migrations/NNN_rename_signals_to_notifications.sql`:

```sql
-- Rename the delivery table
ALTER TABLE signal_deliveries RENAME TO member_notifications;

-- Rename indexes
ALTER INDEX signal_deliveries_recipient_poll_idx RENAME TO member_notifications_recipient_poll_idx;
ALTER INDEX signal_deliveries_seq_unique RENAME TO member_notifications_seq_unique;
-- (plus any other indexes currently on the table)

-- Rename trigger function and trigger
DROP TRIGGER signal_deliveries_notify ON member_notifications;
DROP FUNCTION notify_signal_delivery();

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

-- Rename the other notify functions to land on the new channel name
-- (similar DROP/CREATE for notify_club_activity and notify_dm_inbox to update the channel name)

-- Add the admission_versions notify trigger
CREATE FUNCTION notify_admission_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,  -- need to join through admissions to get this
        'kind', 'admission_version'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER admission_versions_notify
    AFTER INSERT ON admission_versions
    FOR EACH ROW EXECUTE FUNCTION notify_admission_version();
```

No data is moved. No columns are dropped. No column types change. Pure rename plus a new trigger. Test via `scripts/migrate.sh` per `CLAUDE.md`, then mirror into `db/init.sql`.

`signal_background_matches` stays named as-is. Its foreign key to `signal_deliveries(id)` needs to update to `member_notifications(id)` — PostgreSQL handles FK target renames automatically when the target table is renamed, so no additional SQL needed, but verify.

## Repository shape

Delete from `src/contract.ts`:

- `listMemberUpdates?`
- `getLatestCursor?`
- `acknowledgeUpdates?`

Add to `src/contract.ts`:

- `listClubActivity({ actorMemberId, clubIds, limit, after })` — already exists internally at `src/clubs/index.ts:404`, promote to the top-level Repository interface
- `listNotifications({ actorMemberId, adminClubIds, accessibleClubIds })` — union of materialized member_notifications reads and derived admissions reads
- `acknowledgeNotifications({ actorMemberId, notificationIds, state, suppressionReason })`
- `getAdmission?({ actorMemberId, admissionId, accessibleClubIds })` — Phase 0

Add to `src/schemas/registry.ts` capability list:

- `'listClubActivity'`
- `'listNotifications'`
- `'acknowledgeNotifications'`
- `'getAdmission'`

Delete from the capability list:

- `'listMemberUpdates'`
- `'getLatestCursor'`
- `'acknowledgeUpdates'`

## Synchronicity worker update

`src/workers/synchronicity.ts` currently writes rows to `signal_deliveries`. The worker's logic doesn't change — it still computes matches, still enforces TTLs and freshness guards, still tracks lifecycle in `signal_background_matches`, still uses the recompute queue. It just writes to a table named `member_notifications` instead.

The match topic values (`signal.ask_to_member` etc.) become `synchronicity.ask_to_member` etc. when projected into `NotificationItem.kind`. The stored `topic` column value in `member_notifications` can keep the short form or use the full form — implementer's call, but be consistent.

The existing match lifecycle transaction (FOR UPDATE + delivery row insert + state transition, per `docs/design-decisions.md` synchronicity section) stays exactly the same. Only the target table name changes.

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

Everything else in this plan. One PR (or a small number of tightly-coupled PRs). The rewrite cannot land in pieces — the surfaces are interdependent.

Implementation order inside the PR:

1. **Migration first.** Write `db/migrations/NNN_rename_signals_to_notifications.sql`. Test via `scripts/migrate.sh`. Mirror into `db/init.sql`.
2. **Schemas and types.** Delete `PendingUpdate`, `memberUpdates`, `pendingUpdate` Zod schema, `sseUpdateEvent` references. Add `activityEvent`, `notificationItem`, `notificationReceipt`, `notificationsResponse`, `activityResponse`. Update `sharedContext` field name from `pendingUpdates` to `notifications`.
3. **Contract interface.** Update `src/contract.ts` with the new Repository shape.
4. **Repository implementation.** Delete `listMemberUpdates` and friends from `src/postgres.ts`. Add `listClubActivity`, `listNotifications`, `acknowledgeNotifications`, `getAdmission`.
5. **Action handlers.** Create `src/schemas/activity.ts` and `src/schemas/notifications.ts`. Delete `src/schemas/updates.ts`.
6. **Dispatch layer.** Update envelope assembly in `src/dispatch.ts` to populate `sharedContext.notifications` by calling `listNotifications` during every authenticated response. Update the ack-filter logic at line 217 to operate on the new field name.
7. **Stream handler.** Rewrite `/updates/stream` → `/stream` in `src/server.ts`. Add the typed frame emission logic. Wire in the extended `WaitResult` from the notifier.
8. **Notifier.** Update `src/member-updates-notifier.ts` to listen on `stream` instead of `updates`, parse the `kind` field from payloads, return the typed `WaitResult`.
9. **Synchronicity worker.** Update `src/workers/synchronicity.ts` to write to `member_notifications`.
10. **Tests.** Delete `test/integration/non-llm/signals.test.ts` test names referencing `updates.list` for signals; rewrite against `notifications.list`. Rewrite DM polling tests against the new stream frames. Add `test/integration/non-llm/activity.test.ts` and `test/integration/non-llm/notifications.test.ts`.
11. **Docs.** Rewrite `docs/design-decisions.md` "Update transport" and "Member signals" sections. Rewrite `SKILL.md` "Checking for new messages" (lines 26-32) and "`updates.list` / `updates.acknowledge`" (lines 264-266) sections.
12. **Schema snapshot.** Regenerate `test/snapshots/api-schema.json`.
13. **Patch bump.** `package.json` version.

## Phase 2: What happens next

Phase 2 is now purely additive. New notification kinds land as new rows in `member_notifications` (materialized) or as new derived queries composed into `notifications.list`.

Concrete next notification types, when their use cases arrive:

- `billing.past_due` — derived from subscription state plus grace window
- `billing.charge_failed` — materialized, written when a Stripe webhook fires
- `billing.invoice_ready` — materialized
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
- `src/postgres.ts` — remove `listMemberUpdates` and friends, add new methods
- `src/server.ts` — `/stream` handler, typed frame emission
- `src/member-updates-notifier.ts` — channel rename, typed WaitResult
- `src/schemas/transport.ts` — `sharedContext.notifications`, SSE frame schemas
- `src/schemas/responses.ts` — delete `pendingUpdate`, add `activityEvent`, `notificationItem`
- `src/schemas/registry.ts` — capability list update
- `src/schemas/clubadmin.ts` — Phase 0 `clubadmin.admissions.get`
- `src/dispatch.ts` — sharedContext population, ack filter rename
- `src/identity/auth.ts` — sharedContext init field rename
- `src/clubs/admissions.ts` — Phase 0 helper extension
- `src/clubs/index.ts` — promote `listClubActivity` to Repository
- `src/workers/synchronicity.ts` — writes to `member_notifications`
- `db/init.sql` — mirror migration after test
- `docs/design-decisions.md` — rewrite Update Transport + Member Signals sections
- `SKILL.md` — rewrite polling/streaming sections
- `test/integration/non-llm/admissions.test.ts` — Phase 0 tests
- `test/integration/non-llm/signals.test.ts` — rewrite as notification tests or fold into `notifications.test.ts`
- `test/integration/non-llm/messages.test.ts` — update DM stream frame expectations
- `test/integration/non-llm/stream-scope-refresh.test.ts` — update for new stream URL and frame types
- `test/integration/non-llm/smoke.test.ts` — update any tape-references
- `test/unit/fixtures.ts` — delete `makePendingUpdate`, add `makeActivityEvent`, `makeNotificationItem`
- `test/unit/app.test.ts` — update `sharedContext` field name references
- `test/snapshots/api-schema.json` — regenerate
- `package.json` — patch bump

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

### Phase 1 — notifications

- `notifications.list` returns materialized rows from `member_notifications` (migrated signal data)
- `notifications.list` returns derived admission notifications for clubadmins
- Materialized and derived items merge in the response
- `truncated` flag fires when derived admissions exceed `MAX_NOTIFICATIONS`
- Stable truncation: repeated polls return the same truncated subset until earlier admissions resolve
- FIFO ordering across multiple admin clubs
- Non-admin member gets an empty derived set
- `notifications.list` → `clubadmin.admissions.get` round trip succeeds using returned `clubId` + `ref.admissionId`
- Derived notification disappears when admission transitions away from `submitted`
- Newly-promoted admin sees current pending admissions on next poll
- `notifications.acknowledge` updates materialized rows and returns receipts
- `notifications.acknowledge` rejects derived notification IDs with `422 invalid_input`

### Phase 1 — envelope piggyback

- Every authenticated response carries `sharedContext.notifications` populated from `listNotifications`
- `notifications.acknowledge` on a materialized row removes the row from the same response's `sharedContext.notifications`
- A non-admin calling an unrelated action sees an empty `sharedContext.notifications`
- Piggyback respects the same FIFO cap and `MAX_NOTIFICATIONS`

### Phase 1 — stream

- `GET /stream` replaces `GET /updates/stream`; old URL returns 404
- `ready` frame includes initial notifications set and activity cursor
- `activity` frames carry `ActivityEvent` payloads
- `message` frames carry DM inbox entries
- `notifications_dirty` fires on `member_notifications` insert (via migrated signal path)
- `notifications_dirty` fires on `admission_versions` insert
- `notifications_dirty` does not fire on unrelated wakeups
- Untagged / malformed NOTIFY payloads don't emit `notifications_dirty`

### Phase 1 — migration

- Existing `signal_deliveries` data survives the rename intact
- Read-time filtering (entity-still-published guard) still works against the renamed table
- Synchronicity worker writes to the new table name
- `signal_background_matches` FK still points at the renamed delivery table

## What not to re-open

The reviewer of this plan should not re-open any of the following. These decisions are locked based on multiple rounds of design-cycle pressure testing and are the load-bearing foundation of everything else.

- **Do not** argue for keeping the merged tape. The merge was a mistake. Four surfaces, not one.
- **Do not** argue for keeping the `updates.*` namespace. It was always ambiguous between "tape" and "notifications".
- **Do not** argue for keeping `PendingUpdate` as the item type. It was a lowest-common-denominator envelope.
- **Do not** argue for keeping the compound cursor. It exists only to serve the merge.
- **Do not** argue for building a new `member_notifications` table. `signal_deliveries` already is it.
- **Do not** argue for keeping `signal_deliveries` as the table name. The name is wrong; it constrains thinking.
- **Do not** argue that renaming is too much churn. Churn is explicitly not the constraint.
- **Do not** re-open the `events.*` collision question. `events.*` is calendar. `activity.*` is the tape. They are distinct.
- **Do not** argue for adding `notifications.acknowledge` as a future concern. It ships in Phase 1 alongside the migration.
- **Do not** argue for preserving `sharedContext.pendingUpdates`. It is being repurposed, not cleaned up.
- **Do not** argue for splitting Phase 1 into smaller phases. The migration is atomic — you cannot rename the table without updating everything that reads it.
- **Do not** argue for keeping `/updates/stream` at the old URL. The new URL is `/stream`.
- **Do not** argue for keeping the `updates` NOTIFY channel name. The new channel is `stream`.
- **Do not** argue for keeping `Repository.listMemberUpdates`. It is deleted.

What the reviewer SHOULD pressure-test:

- Implementation traps in the migration SQL (index names, constraint names, FK renames, trigger drops, grants)
- Missing file references the plan overlooked
- Edge cases in the `sharedContext.notifications` piggyback (performance of per-request notification lookup, caching, cap enforcement)
- Edge cases in the stream frame emission (ordering, cursor attachment, Last-Event-ID resumption with typed frames)
- Test-coverage gaps
- Any reference to code or line numbers that have drifted since the plan was written
- Whether the synchronicity worker's existing invariants (TTL, throttling, freshness guards) survive the table rename without behavioral change
- Whether the read-time entity-still-published filter still applies correctly in the new `listNotifications` query path

If you find something that belongs in that second list, speak up. If you find something that belongs in the "do not re-open" list, ignore it.
