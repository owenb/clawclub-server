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
4. **Repurpose `sharedContext.pendingUpdates` as `sharedContext.notifications`**, typed `NotificationItem[]`, populated on every authenticated response by the dispatch layer. Strict per-request caching on the default head read: the envelope always calls the memoized `ctx.getNotifications()` accessor, which hits the repository at most once per request with default head params. This is the primary agent read path for the head of the queue. `notifications.list` is the authoritative **paginated** full-read path for draining the tail — it reuses the memo for default-params calls (no extra reads) and bypasses the memo for paginated calls (a separate read per page, by design).
5. **Rename `/updates/stream` to `/stream`.** One SSE endpoint with typed frames for each concept.
6. **Rename the `updates` NOTIFY channel to `stream`.** One-line change in each trigger and in the listen statement.
7. **Synchronicity matching keeps its internal vocabulary for lifecycle state.** `signal_background_matches`, `signal_recompute_queue`, and the `signal_background_matches.signal_id` column stay named as-is. Only the user-visible delivery table (`signal_deliveries` → `member_notifications`) is renamed, and only its stored `topic` values get rewritten to the `synchronicity.*` vocabulary.
8. **Phase 0 ships `clubadmin.admissions.get` standalone.** Unchanged from prior plan revisions.
9. **`notifications.list` is the paginated FIFO worklist full-read path.** Materialized rows from `member_notifications` and derived admissions from `current_admissions` merge into a single FIFO-ordered queue (`createdAt ASC, notificationId ASC`). Pagination is a per-item opaque cursor — `{ limit, after }` input, `{ items, nextAfter, polledAt }` output, with `nextAfter: null` signalling end-of-queue. Every `NotificationItem` carries a `cursor: string` field so agents can resume pagination from any item received (piggyback, `ready` frame, or a prior list response). The piggyback and `ready` frame carry the FIFO head only, capped at `NOTIFICATIONS_PAGE_SIZE`, with a sibling `notificationsTruncated: boolean` that tells agents to paginate the tail via `notifications.list`. No `truncated` boolean on the `notifications.list` response itself — pagination replaces it.
10. **Typed wakeup cause plumbing.** NOTIFY triggers tag with `kind`, `waitForUpdate()` returns `{ outcome, cause? }`, a `NOTIFICATION_WAKEUP_KINDS` allowlist gates `notifications_dirty` emission.
11. **Existing `admission.submitted` activity append stays.** It is historical club activity, not a personal notification. The two are distinct and both valid.
12. **`member_notifications.club_id` becomes nullable in the migration.** Phase 2 account-scoped notifications must work without another schema migration.
13. **The DM stream read path is a first-class Repository primitive.** Extract from the merged-tape query into `Repository.listInboxSince`, preserving all four behaviors of the current inbox section: (a) removed-message filter via `dm_message_removals`, (b) sender display joins, (c) sharedClubs resolution per sender, and (d) per-field `mentions` array with the `included.membersById` resolution bundle. The stream `message` frame payload is `{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }` — a direct single-message projection of `messages.getThread`'s output shape. No dedicated `MessageEvent` or `DirectMessageInboxEntry` type is invented. See "The single stream → `message` frame" for the exact shape.
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

Sticky queue of everything personally targeted at the member. **This is the authoritative paginated full-read path for the notification worklist.** Agents that need to drain the entire backlog walk `notifications.list` with pagination until they reach the end of the queue; there is no other API that returns "everything". The piggyback and stream seed are free head-of-queue hints, not replacements for this walk.

- action: `notifications.list`
- auth: `member`
- input: `{ limit?: number, after?: string | null }` (lax — unknown keys ignored, matching the rest of the action surface)
- output: `{ items: NotificationItem[], nextAfter: string | null, polledAt: string }`

`nextAfter: null` means the caller has reached the end of the queue — there are no more pages. A non-null `nextAfter` is an opaque cursor the caller passes back as `after` on the next call to read the next page. There is no `truncated: boolean` field on this response: pagination replaces it. `nextAfter !== null` is the single "there's more" signal, and the caller can act on it directly (walk forward) or ignore it (stop when they have enough).

`NotificationItem` shape:

```ts
type NotificationItem = {
  notificationId: string;        // <kind_family>:<primary_ref>
  cursor: string;                // opaque; pass back as `after` to resume pagination from this item
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

The `cursor` field is opaque — the agent never parses or constructs it, only passes it back verbatim. It is populated for both materialized and derived items so any notification reference (including one received via the piggyback or the stream seed) is a valid resume point for pagination.

**Phase-1 `kind` values** (the external vocabulary, used in both the API response and the stored `topic` column after migration):

- `admission.submitted` — derived from `current_admissions` where `status = 'submitted'` and the actor is a clubadmin of the admission's club
- `synchronicity.ask_to_member` — materialized; was stored as `signal.ask_match`
- `synchronicity.offer_to_ask` — materialized; was stored as `signal.offer_match`
- `synchronicity.member_to_member` — materialized; was stored as `signal.introduction`
- `synchronicity.event_to_member` — materialized; was stored as `signal.event_suggestion`

These four `synchronicity.*` kinds map one-to-one with the four `match_kind` values in the synchronicity worker (rg `function topicForMatchKind` in `src/workers/synchronicity.ts`). The migration UPDATE rewrites stored rows to this vocabulary atomically.

Reads are a union of two sources, paginated together under a single FIFO cursor.

**Ordering (pinned): `createdAt ASC, notificationId ASC`.** FIFO — the oldest pending item is returned first. This is the worklist mental model: an agent working through a backlog sees the most-neglected items first, not the most recent. Both sources project onto the same sort keys and merge at the same ordering.

**Cursor (pinned): opaque string encoding `(createdAt, notificationId)`.** The repository encodes/decodes it (base64 of a JSON tuple is the simplest implementation); the caller treats it as opaque. Cursor comparisons are lexicographic on the decoded tuple: `after` means strictly after that position. Every `NotificationItem` carries its own `cursor` field so agents can resume pagination from any item they have seen — including items received via `sharedContext.notifications` or the SSE `ready` frame, not just items from a prior `notifications.list` response.

**Page size (pinned): one server-internal constant — `NOTIFICATIONS_PAGE_SIZE`.** The same value is used as the default for `notifications.list` and as the cap for the piggyback head. Callers may request a smaller `limit`; values above `NOTIFICATIONS_PAGE_SIZE` are clamped down to it. One constant, one meaning, no drift between surfaces.

Sources:

1. **Materialized:** read unacknowledged rows from `member_notifications` where `recipient_member_id = actor`, `club_id` is in the actor's accessible clubs OR `club_id IS NULL` (for account-scoped notifications), and `(created_at, id) > (cursor_ts, cursor_id)` when a cursor is supplied. Ordered `created_at ASC, id ASC`. Read-time filtering preserves the two guards from the current `listMemberUpdates` SQL (rg the `signal.offer_match` branch in `src/postgres.ts`) — both the generic published-entity check and the topic-specific offer-match `yourAskEntityId` check. Both guards move with the query into `listNotifications`, updated to reference the new stored topic value (`synchronicity.offer_to_ask` instead of `signal.offer_match`). Fetch `limit + 1` rows to detect whether there is a next page (the +1 is trimmed off before returning).
2. **Derived admissions:** read from `current_admissions` where `status = 'submitted'`, `club_id` is in the actor's clubadmin clubs, and `(version_created_at, admission_id) > (cursor_ts, cursor_id)` when a cursor is supplied. Ordered `version_created_at ASC, admission_id ASC`. Projects `version_created_at` as the item's `createdAt` and the derived `notificationId` (`admission.submitted:<admission_id>`) as the sort id. Fetch `limit + 1` rows to detect next page.

**Merge:** concatenate both limited lists, re-sort by `(createdAt, notificationId)` ASC, then slice to `limit` items. If the combined sorted list had more than `limit` entries, the cursor of the first trimmed item becomes `nextAfter`. If the combined list had `limit` or fewer entries, `nextAfter = null` (end of queue).

**The completeness guarantee:** an agent that wants every pending notification calls `notifications.list()` with no `after`, reads the returned page, and keeps calling with `after: <nextAfter>` until `nextAfter === null`. The walk is finite (both sources are finite and forward-only), terminates deterministically, and previously-seen items do not reappear on later pages because acknowledgement removes materialized rows from the source and status transition removes submitted admissions from the derived query. New items arriving at the tail during the walk appear in later pages (or after the walk terminates if they slot in past the current cursor), but they do not disturb earlier pages the caller has already read. This is what makes "I have processed everything" verifiable — no silent partial state.

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

Repurpose it. The envelope's `sharedContext` gains two new fields, replacing the old `pendingUpdates: PendingUpdate[]`:

```ts
sharedContext: {
  notifications: NotificationItem[];
  notificationsTruncated: boolean;
}
```

Steps:

- Delete the `pendingUpdates: PendingUpdate[]` field from the `sharedContext` Zod schema in `src/schemas/transport.ts` and the corresponding `SharedResponseContext` type in `src/contract.ts`
- Add `notifications: NotificationItem[]` and `notificationsTruncated: boolean` in their place
- Populate both fields on every authenticated response via the memoized `ctx.getNotifications()` accessor during envelope assembly in `src/dispatch.ts`. **The envelope does NOT call `Repository.listNotifications` directly.** It goes through the per-request memo so that a handler reading the same head on the same request shares the cached result. The memo itself calls the repository once with the default head params `{ actorMemberId, accessibleClubIds, adminClubIds, limit: NOTIFICATIONS_PAGE_SIZE, after: null }`, using the actor-derived `accessibleClubIds` and `adminClubIds` already computed on the handler context — not a raw `{ actorMemberId }`-only call. See the "Per-request notification caching" section for the memo's exact shape and caching rules.
- The envelope copies the memo's returned `items` into `sharedContext.notifications` and computes `sharedContext.notificationsTruncated = (result.nextAfter !== null)`. That is the only transformation — the dispatch layer does not reinterpret the repository's pagination state into a different flag.
- Keep the existing filter-on-acknowledge logic (rg the `pendingUpdates: sharedContext.pendingUpdates.filter` site) so `notifications.acknowledge` removes items from the piggyback set for the same response. The filter operates on the items array; `notificationsTruncated` is unaffected by per-request acks because removing already-cached items from the piggyback view does not change whether the underlying read had more pages available.

The effect: agents reading the envelope of any response they were already making get the head of their current notification queue **and** an honest "there is more — paginate to drain" flag for free. Polling `notifications.list` explicitly is the path for agents that want to walk the full backlog, force-refresh, or resume pagination from any item they have already seen — the piggyback items carry cursors, so the walk can start directly past what the piggyback already delivered with no redundant re-read of the head.

The existing `ActionResult.acknowledgedUpdateIds` field in `src/schemas/registry.ts` is renamed to `acknowledgedNotificationIds`. The filter in `src/dispatch.ts` updates its target field, its comment, and its type.

### Completeness semantics: pagination vs piggyback truncation

Two different "is there more?" signals depending on the read path. Both kinds exist because the piggyback and the list endpoint do different jobs — one is a free head-of-queue hint shipped on every response, the other is the authoritative paginated full-read path.

1. **`notifications.list` response** — returns `nextAfter: string | null`. Non-null means there is another page; the caller paginates by passing `nextAfter` back as `after` on the next call. Null means the caller has reached the end of the queue. This is the authoritative full-read path: any agent that needs the complete set paginates until `nextAfter === null`. **There is no `truncated` boolean on this response** — pagination makes it redundant. `nextAfter !== null` is the "more exists" signal.
2. **`sharedContext.notifications` envelope piggyback** — returns `sharedContext.notificationsTruncated: boolean`. True means the underlying head read had more items than fit in the single capped page; the agent drains by calling `notifications.list` and paginating. The piggyback itself is intentionally not paginated — it is a free head-of-queue hint shipped on every authenticated response, not a full-read API. A paginated envelope would break the "one read per request" rule that makes the piggyback affordable. Agents that want the full set walk `notifications.list`.
3. **`ready` SSE frame at connect** — same shape as the piggyback: carries `notificationsTruncated: boolean` next to the inline `notifications: NotificationItem[]` seed. Agents that see `true` on connect call `notifications.list` over HTTP to drain the cap before relying on the seed for completeness. The stream does not paginate notifications on its own — the SSE channel delivers the head seed and invalidation signals, nothing more.
4. **`notifications_dirty` SSE frame** — does NOT carry any flag. It is invalidation-only with no payload. Clients reading the next authenticated response after `notifications_dirty` get fresh `sharedContext.notifications` + `notificationsTruncated` from the piggyback, or they call `notifications.list` explicitly.

**The invariant: every populated read path is honest about whether there is more.** Either the response exposes a `nextAfter` cursor for paginated drainage (`notifications.list`), or it exposes a `notificationsTruncated: boolean` telling the agent to drain via `notifications.list` (`sharedContext.notifications`, `ready` frame). There is no silent partial-read state. **There is always a full-read path:** the worklist is always fully drainable via the paginated list endpoint, and the piggyback / stream seed are always honest about being capped. This is what makes "I am done with my admin work" verifiable under the worklist mental model.

If any of the three populated read paths returns a notification set without its completeness signal (`nextAfter` for the list endpoint, `notificationsTruncated` for the piggyback and the `ready` frame), the contract is broken and an agent could silently act on partial state.

### Failure and retry semantics (pinned)

**Fail-open on piggyback errors.** If `getNotifications()` throws during envelope assembly (DB timeout, transient error, unexpected data), the dispatch layer catches the error, logs it, and returns `sharedContext.notifications: []` and `sharedContext.notificationsTruncated: false` on the successful response. The piggyback is an enrichment, not a core response field — a piggyback read failure must not turn a successful handler call into a 5xx. The action result is preserved. The `notificationsTruncated: false` fallback is the conservative default: a fail-open empty set is not "truncated", it is "unknown but treated as empty". Agents that want a reliable read after seeing an empty piggyback can always call `notifications.list` explicitly — the fail-open piggyback degrades gracefully to the explicit paginated read, not to a silent data loss.

**Retries are not byte-identical.** `sharedContext.notifications` and `sharedContext.notificationsTruncated` both read current state at envelope assembly time. Clients that retry mutating actions with a `clientKey` (the idempotency pattern per `docs/design-decisions.md`) may see different notification sets and different truncation flags across retries as new notifications arrive or get acknowledged elsewhere. Neither field is part of the idempotency boundary. Document this in `SKILL.md` so agents don't assume byte-level identity.

## Per-request notification caching

**This is the single biggest implementation risk if handled wrong.** The piggyback design means every authenticated request triggers a potential `listNotifications` call. Without caching, the worst cases are:

- `notifications.list` handler reads notifications to populate `data`; envelope assembly reads them again to populate `sharedContext.notifications`. Two DB roundtrips per call to the one action specifically designed to read notifications.
- A session that makes 30 unrelated actions pays 30 extra `listNotifications` calls, each taking a partial set of locks on `member_notifications` and `current_admissions`.
- A polling client hitting a high-frequency read endpoint pays one extra notification read per poll.

**Pinned rule: one notification read per request for the default (head) call.** Paginated calls with a non-null `after` are a separate read by design — they do different work (walking past a cursor vs. returning the head), and collapsing them into a single read would require per-params caching which adds complexity for no real savings.

Implementation:

1. Extend `HandlerContext` (defined in `src/schemas/registry.ts`) with a lazy memo: `getNotifications(): Promise<{ items: NotificationItem[]; nextAfter: string | null }>`. The memo always calls `Repository.listNotifications` with the default head params — `{ actorMemberId, accessibleClubIds, adminClubIds, limit: NOTIFICATIONS_PAGE_SIZE, after: null }`. The first call hits the repository; subsequent calls return the cached result. The memo caches exactly one result per request for the default head read; it is not a per-params cache.
2. The `notifications.list` handler is **cursor-aware**:
   - Called with no `after` (or `after: null`): reuses `ctx.getNotifications()` — same result the envelope uses, zero extra DB roundtrips. Sets the response `data.items` and `data.nextAfter` directly from the memo's return shape.
   - Called with `after: <cursor>`: bypasses the memo and calls `Repository.listNotifications` directly with the caller's `{ limit, after }`. This is a separate read because the memo only caches the default head. Pagination-walk callers pay exactly one repository read per page.
3. The envelope assembly in `src/dispatch.ts` calls `ctx.getNotifications()` (NOT a raw `Repository.listNotifications` call) to populate `sharedContext.notifications` and computes `sharedContext.notificationsTruncated = (memoResult.nextAfter !== null)`. Same call, same result, one DB hit per request regardless of whether the handler also read it.
4. Handlers that don't need notifications don't call `ctx.getNotifications()`. The envelope assembly still calls it after the handler returns — this is the one unavoidable read per authenticated request. The `acknowledgedNotificationIds` filter runs on that cached set.
5. **Unauthenticated actions** (cold admission flows) never call `listNotifications` because they use `unauthenticatedSuccessEnvelope` which has no `sharedContext`. Confirm in `src/schemas/transport.ts`.
6. **The stream handler is NOT a standard handler** and does not use the `HandlerContext` memo. It calls `Repository.listNotifications` directly once at connect with the default head params (`{ actorMemberId, accessibleClubIds, adminClubIds, limit: NOTIFICATIONS_PAGE_SIZE, after: null }`) to produce the `ready` frame seed. This is the single exception to the per-request rule and is acceptable because stream connections have their own lifecycle.

Result: `notifications.list` with no cursor pays one read (shared with the envelope via the memo), `notifications.list` with a cursor pays two reads (envelope head via memo + paginated page direct), every other authenticated action pays one read, unauthenticated actions pay zero, stream connections pay one read at connect and zero thereafter (they rely on `notifications_dirty` invalidation + the next authenticated action's piggyback).

The "two reads on a paginated list call" is acceptable because pagination is rare (only agents draining large backlogs) and the two reads are doing different jobs: the envelope always returns the head, the paginated call always walks forward from a cursor. Collapsing them into a single read would require per-params caching in the memo, which is more complexity than the savings justify.

If performance profiling later shows the per-request head read is too expensive on hot paths, the mitigation is to add an `ActionDefinition.skipSharedNotifications?: boolean` flag for high-frequency read endpoints. That is a Phase 2 concern, not a Phase 1 concern.

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

- `ready` — initial handshake. Payload: `{ member, requestScope, notifications: NotificationItem[], notificationsTruncated: boolean, activityCursor: string | null }`. Seeds the FIFO head of the notification set (same cap and same shape as `sharedContext.notifications`), the truncation flag (so connecting clients know the seed is capped and need to call `notifications.list` with pagination to drain the full backlog before relying on it for completeness), and the activity cursor in one frame. SSE `id:` is set to the activity tip.
- `activity` — a new activity event. Payload: `ActivityEvent`. SSE `id:` is the activity seq.
- `message` — a new DM. **Pinned payload shape (using only types that exist today in `src/schemas/responses.ts` and `src/schemas/messages.ts` — no invented types):**

  ```ts
  {
    thread: DirectMessageThreadSummary,   // src/schemas/responses.ts::directMessageThreadSummary — threadId, sharedClubs, counterpart info, latestMessage
    messages: DirectMessageEntry[],       // src/schemas/responses.ts::directMessageEntry — messageId, threadId, senderMemberId, role, messageText, mentions, payload, createdAt, inReplyToMessageId (updateReceipts REMOVED in Phase 1)
    included: IncludedBundle              // src/schemas/responses.ts::includedBundle — { membersById: Record<memberId, includedMember> }
  }
  ```

  **This is a single-message projection of `messages.getThread`'s exact output shape** — not a dedicated `MessageEvent`, not a `DirectMessageInboxEntry` (neither type exists). `messages.getThread` today returns `{ thread, messages, hasMore, nextCursor, included }`; the stream frame drops `hasMore`/`nextCursor` (they are list-read concepts) and otherwise carries the identical shape with `messages` narrowed to the one new entry. A client that has a parser for `messages.getThread` output reuses it verbatim for `message` frames — one entity shape, one parser, zero drift.

  **Why single-message projection of `messages.getThread` and not `messages.getInbox`:** `messages.getInbox` is thread-summary-level (returns `directMessageInboxSummary[]` with unread counts and `latestMessage` nested); `messages.getThread` is message-level (returns the individual `directMessageEntry[]` that constitute the thread). A real-time DM push is the arrival of **one specific message**, which is message-level granularity. Pushing a thread summary would force the client to make a follow-up call to read the actual message body — wasteful and wrong for a push transport. The `thread` field on the frame carries the thread context (counterpart info, sharedClubs) so the push is self-contained: agents receiving a DM from a stranger don't need extra roundtrips to see what club they share.

  **Array vs singular `entry`:** the `messages` field is an array even though a typical push carries exactly one entry. This is deliberate: it matches `messages.getThread`'s shape exactly (same field name, same type), so the parser reuses cleanly. It also leaves a natural extension point if batching is ever needed (reconnect catch-up, rate-limit coalescing) without a schema change. The push emits `messages: [newEntry]` in the common case; a single-parser-handles-both-reads-and-pushes property is the long-term elegance win.

  **sharedClubs preservation:** `sharedClubs` lives on `directMessageThreadSummary` (the `thread` field), not on individual `directMessageEntry` rows. This matches how `messages.getThread` already exposes sharedClubs — thread-level, not per-message. The existing `listInboxSince` behavior of surfacing sharedClubs per sender is preserved by populating `thread.sharedClubs` for every frame using the same `batchResolveSharedClubs` helper the current inbox query calls. No new field on `directMessageEntry`, no extension to `includedMember` — the data lives where it structurally belongs.

  **`included.membersById` bundle** is per-frame: each frame carries only the members referenced by its own entry (sender + mentioned members), mirroring how list reads ship their own `included` bundles scoped to their result set. The existing `includedMember` shape (`memberId`, `publicName`, `displayName`, `handle`) is unchanged.

  **`updateReceipts` removal:** `directMessageEntry` currently has an `updateReceipts: DirectMessageUpdateReceipt[]` field that is dead code (always empty in production) and is being deleted in Phase 1 per the "Delete dead receipt cruft" section. The stream frame shape uses the **post-Phase-1** `directMessageEntry` with `updateReceipts` removed. Both `messages.getThread` and the stream frame see the same cleaned shape — the cleanup is shared between them, not stream-only.

  **No SSE `id:`** — the stream loop tracks inbox position via an internal cursor, not via Last-Event-ID (see "DM stream read path" below).
- `notifications_dirty` — invalidation-only. No payload body. No SSE `id:`. Clients react by reading `sharedContext.notifications` on their next authenticated request, or by explicitly calling `notifications.list`.
- `: keepalive` comment — unchanged.

**Rule: after the initial `ready` frame, the stream does NOT emit standalone notification payloads.** The `ready` frame carries notifications inline as a connect-time seed. After that, notification state changes are signalled via `notifications_dirty` only. The client re-reads via `sharedContext.notifications` on the next authenticated request or via an explicit `notifications.list` call.

Clients that only care about notifications can connect `/stream` and ignore everything except `notifications_dirty`. Clients that care about activity or DMs process those frames directly. The frame type is the discriminator — no client-side branching on `source` or `kind` within a shared envelope.

## DM stream read path

The current merged-tape query (rg `dm_inbox_entries ie` in `src/postgres.ts`) contains a dedicated inbox read. This logic needs to be extracted into a new Repository primitive so the stream loop can emit `message` frames cleanly. **The extraction must preserve every behavior of the existing inbox section AND project its output into the pinned `message` frame shape.** The projection is just as important as the preservation — the primitive has to speak the canonical `messages.getThread` data vocabulary, not a bespoke stream-only shape.

**New:** `Repository.listInboxSince({ actorMemberId, after: string | null, limit: number }): Promise<{ frames: MessageFramePayload[] }>` where each `MessageFramePayload` is exactly `{ thread, messages, included }` per the pinned stream frame shape above — a single-message projection of `messages.getThread`'s output for each new inbox entry. The primitive returns a list of ready-to-emit frame payloads, one per new message; the stream loop does not post-process.

The four behaviors from the current inbox section must all survive the extraction:

1. **Filter out removed messages** via `and not exists (select 1 from dm_message_removals rmv where rmv.message_id = ie.message_id)`. Without this filter, removed DMs leak into `message` frames — this is a real regression on the existing test in `test/integration/non-llm/removal.test.ts`. The extraction must keep this clause.
2. **Populate the `directMessageEntry` fields for each new message.** A join or second query against `dm_messages` (and related tables) projects each row into the `directMessageEntry` shape defined in `src/schemas/responses.ts` — `messageId`, `threadId`, `senderMemberId`, `role`, `messageText`, `mentions`, `payload`, `createdAt`, `inReplyToMessageId`. (The `updateReceipts` field is removed from `directMessageEntry` in Phase 1 per the "Delete dead receipt cruft" section and must NOT be populated by `listInboxSince`.) This replaces the old ad-hoc sender-display projection that the merged-tape query was doing — the primitive speaks the canonical `directMessageEntry` vocabulary directly.
3. **Resolve shared clubs per thread.** The existing code calls `batchResolveSharedClubs(pool, actorMemberId, dmSenderIds)` (rg the function name). `listInboxSince` must preserve this by populating `thread.sharedClubs` on each frame's `directMessageThreadSummary`, using the same helper. The new home for `sharedClubs` is the thread summary on the frame, not a side-channel field on the entry — `directMessageThreadSummary` already has `sharedClubs: SharedClubRef[]` so this is where the data structurally belongs. `directMessageEntry` does NOT carry `sharedClubs` and the stream frame does NOT invent a new field for it.
4. **Preserve mentions and build the `included` bundle.** `messages.getInbox` and `messages.getThread` return DM entries with a per-field `mentions` array (memberId + authoredHandle spans) plus a deduplicated `included.membersById` bundle, documented in `SKILL.md` under "Mentions". The `message` stream frame emitted by `listInboxSince` must carry the same mention spans on each `directMessageEntry.mentions` AND must populate `included.membersById` with the sender + every mentioned member for that frame, using the existing `includedMember` shape (`memberId`, `publicName`, `displayName`, `handle`). The bundle is scoped per-frame — each frame carries only the members referenced by its own entry, matching how list reads ship their own `included` bundles.

For each new inbox entry, `listInboxSince` builds a self-contained `{ thread, messages, included }` payload:

- `thread: DirectMessageThreadSummary` — populated from the thread row + the `batchResolveSharedClubs` helper. `thread.threadId`, `thread.sharedClubs`, `thread.counterpartMemberId`, `thread.counterpartPublicName`, `thread.counterpartHandle`, `thread.latestMessage` (which will equal the new message being pushed — this matches `messages.getInbox` / `messages.getThread` semantics where `latestMessage` is the most-recent message at read time), `thread.messageCount`.
- `messages: [DirectMessageEntry]` — exactly one entry per frame in the normal push path, populated from the new inbox row joined against `dm_messages`.
- `included: IncludedBundle` — `membersById` for the sender and any members referenced in `mentions`, populated by the same resolution logic that `messages.getThread` uses.

If the implementer writes `listInboxSince` from the plan's one-line spec without preserving these four behaviors and projecting into the correct shape, the `message` frame regresses in five ways: stale removed messages leak through, the frame carries the wrong entity shape (not `directMessageEntry`), sharedClubs disappears or lands on the wrong level, mentions drop to plain text, and the `included` bundle is missing. The integration tests in `removal.test.ts` and `messages.test.ts` should catch #1 and (partially) #2, but frame-shape-alignment and sharedClubs-on-thread need explicit new tests — see the expanded test list below.

Stream loop usage:

1. On connect, the stream captures the current inbox head timestamp as its internal `inboxCursor` state, seeded from a one-shot read (e.g., `SELECT max(created_at) FROM dm_inbox_entries WHERE recipient_member_id = $1`).
2. On wakeup with `cause.kind === 'message'`, call `listInboxSince({ actorMemberId, after: inboxCursor, limit: ... })`, emit each returned `{ thread, messages, included }` payload as a `message` frame verbatim (no post-processing), advance `inboxCursor` to the last delivered message's `createdAt`.
3. On reconnect, the client issues `messages.getInbox({ unreadOnly: true })` to reconcile anything missed during the disconnect window.

`messages.getInbox` itself (the user-facing paginated thread-summary inbox read) is unchanged. It remains the canonical historical inbox read. `messages.getThread` is also unchanged — but the stream frame shape matches its output exactly, so any parser written for one works for the other.

## Activity audience computation

The current merged-tape query (rg `adminClubIds = actor\?.memberships` in `src/postgres.ts`) computes `adminClubIds` and `ownerClubIds` from the actor's memberships, then passes them into `listClubActivity` for the audience filter (rg `audience = 'clubadmins'` in `src/clubs/index.ts`). Under the new surface, this computation must happen in the `activity.list` action handler.

**Pinned:** the `activity.list` handler computes the audience arrays from `ctx.actor.memberships`:

```ts
const adminClubIds = ctx.actor.memberships.filter(m => m.role === 'clubadmin').map(m => m.clubId);
const ownerClubIds = ctx.actor.memberships.filter(m => m.isOwner).map(m => m.clubId);
```

These are passed into `Repository.listClubActivity` as explicit arguments. The repository method does not re-read the actor.

The stream loop in `src/server.ts` does the same computation at the top of the loop (using the captured `auth.actor`) and passes them into `Repository.listClubActivity` for activity frame production.

`Repository.listClubActivity` is promoted from an internal `ClubsRepository` method (rg `listClubActivity(input:` in `src/clubs/index.ts`) to a top-level **required** `Repository` method in `src/contract.ts`. Current `Repository` interface (rg `listMemberUpdates?`) does not expose it — adding it is a real edit, not a trivial rename. Wire the method through `src/postgres.ts` by calling the existing `clubs.listClubActivity`. Do NOT add `'listClubActivity'` to the capability list — required Repository methods rely on TypeScript's compile-time check, not the runtime capability registry. See the "Repository shape" section for the full required-vs-optional split.

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

Add to `src/contract.ts` as **required** (non-optional) `Repository` methods, matching the existing pattern for messaging methods (rg `listDirectMessageInbox` in `src/contract.ts` for the precedent — those are required, not optional):

- `listClubActivity({ actorMemberId, clubIds, adminClubIds, ownerClubIds, limit, afterSeq })` — promoted from the internal `ClubsRepository` definition. The top-level `Repository` interface does not currently expose this. Adding it is a real edit, not a re-export.
- `listNotifications({ actorMemberId, accessibleClubIds, adminClubIds, limit, after })` — **paginated FIFO union** of materialized reads from `member_notifications` and derived reads from `current_admissions`. Signature: `{ actorMemberId: string; accessibleClubIds: string[]; adminClubIds: string[]; limit: number; after: string | null }` → `Promise<{ items: NotificationItem[]; nextAfter: string | null }>`. Ordering is `createdAt ASC, notificationId ASC` (oldest-first worklist). `after` is an opaque cursor the repository encodes/decodes internally; callers treat it as a string. `limit` is clamped to `NOTIFICATIONS_PAGE_SIZE`. `nextAfter` is non-null iff there are more items past the returned page. The repository populates the `cursor: string` field on every returned `NotificationItem` (both materialized and derived). See "The four surfaces in full → `notifications.list`" for the full read semantics including per-source cursor comparisons.
- `acknowledgeNotifications({ actorMemberId, notificationIds, state, suppressionReason })` — updates materialized rows only; rejects derived IDs.
- `listInboxSince({ actorMemberId, after, limit })` — incremental DM read for the stream loop. Returns `{ frames: Array<{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }> }` — ready-to-emit `message` frame payloads, one per new inbox row, each a single-message projection of `messages.getThread`'s output shape. Extracted from the current merged-tape query with all four preserved behaviors (removed-message filter, `directMessageEntry` field population, sharedClubs on `thread.sharedClubs` via `batchResolveSharedClubs`, mention span preservation with `includedMember` resolution into `included.membersById`). See "DM stream read path" for the projection detail.
- `acknowledgeDirectMessageInbox({ actorMemberId, threadId })` — wraps the existing-but-dead `acknowledgeInbox` helper from `src/messages/index.ts`. The action handler for `messages.acknowledge` calls this.

Add to `src/contract.ts` as **optional** `?` (Phase 0 rollout seam only):

- `getAdmission?({ actorMemberId, admissionId, accessibleClubIds })` — Phase 0. Optional so the action gracefully reports `not_implemented` against test fixtures that do not implement it. All other new methods above are required because they are load-bearing for Phase 1.

**NOT added:** `getLatestActivityCursor`. The existing `listClubActivity` seed-on-first-call behavior handles `after='latest'` — the action handler resolves it inline.

### Capability list updates

Because the five Phase-1 methods are required (not optional), they do **not** appear in the capability list at `src/schemas/registry.ts`. Required methods on `Repository` cannot be missing at runtime — TypeScript enforces them — so a runtime capability check is dead weight. This matches the existing pattern: `listDirectMessageInbox`, `sendDirectMessage`, etc. are required and have no capability entry.

Add to `src/schemas/registry.ts` capability list:

- `'getAdmission'` — the only new entry; matches the optional `getAdmission?` repository method

Delete from the capability list:

- `'listMemberUpdates'`
- `'getLatestCursor'`
- `'acknowledgeUpdates'`

The implementer should not add `'listClubActivity'`, `'listNotifications'`, `'acknowledgeNotifications'`, `'listInboxSince'`, or `'acknowledgeDirectMessageInbox'` to the capability list. If those methods are missing on `Repository`, the build fails — that is the correct check.

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

**SKILL.md discoverability (Phase 0).** Add one line to the `SKILL.md` "Core behaviors" section near the `clubadmin.*` guidance: "If a club admin wants to inspect one specific application, use `clubadmin.admissions.get` directly instead of list-and-filter". This is a Phase 0 edit, not Phase 1, so that Phase 0 ships self-contained — agents that fetch `/api/schema` after Phase 0 deploys see the new action and the guidance arrives together. Phase 1 does a much larger SKILL.md rewrite that leaves this line intact.

Tests in `test/integration/non-llm/admissions.test.ts`: happy path fetch in scope, regular member 403, superadmin bypass, response shape matches `AdmissionSummary`.

## Phase 1: The full rewrite

Everything else in this plan. One PR (or a small number of tightly-coupled PRs). The rewrite cannot land in pieces — the migration, the action surfaces, the stream, the worker update, and the scope refresh are interdependent.

Implementation order inside the PR:

1. **Migration first.** Write `db/migrations/NNN_rename_signals_to_notifications.sql` exactly as pinned in the Data Migration section. Test via `scripts/migrate.sh`. Mirror into `db/init.sql` by regenerating from a dev database (not hand-editing).
2. **Schemas and types.** Delete `PendingUpdate`, `memberUpdates`, `pollingResponse`, `pendingUpdate` Zod schema, `sseUpdateEvent` comment references, and the "Polling response (`updates.list` via POST /api)" section header in `src/schemas/transport.ts`. Add `activityEvent`, `notificationItem` (**must include `cursor: string` as a required field**), `notificationReceipt`, `notificationsResponse` (shape is `{ items, nextAfter, polledAt }` — `nextAfter: z.string().nullable()`, NOT a `truncated: boolean`), `activityResponse`, `sseNotificationsDirtyEvent` (empty body). Replace `sharedContext.pendingUpdates: PendingUpdate[]` with the two new fields `sharedContext.notifications: NotificationItem[]` and `sharedContext.notificationsTruncated: boolean`. Update `sseReadyEvent` to carry `notifications: NotificationItem[]`, `notificationsTruncated: boolean`, and `activityCursor: string | null` instead of `nextAfter` / `latestCursor`. Rename `ActionResult.acknowledgedUpdateIds` → `acknowledgedNotificationIds` in `src/schemas/registry.ts` and update the comment that references `sharedContext.pendingUpdates`.
3. **Contract interface.** Update `src/contract.ts` with the new Repository shape per the "Repository shape" section: delete `listMemberUpdates?`, `getLatestCursor?`, `acknowledgeUpdates?`; add `listClubActivity`, `listNotifications`, `acknowledgeNotifications`, `listInboxSince`, `acknowledgeDirectMessageInbox` as **required** (non-optional) methods; add `getAdmission?` as optional. Delete the `PendingUpdate` type definition (rg `export type PendingUpdate` in `src/contract.ts`) and replace the `pendingUpdates: PendingUpdate[]` field in `SharedResponseContext` with both `notifications: NotificationItem[]` and `notificationsTruncated: boolean`. Delete `DirectMessageUpdateReceipt` and remove `updateReceipts` from `DirectMessageEntry`.
4. **Repository implementation.** In `src/postgres.ts`: delete `listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates`. Remove the `import { PendingUpdate }` at the top of the file. Wire `listClubActivity` by calling the existing `clubs.listClubActivity`. Add `listNotifications` — **paginated FIFO union**: encode/decode opaque `(createdAt, notificationId)` cursors (base64 of a JSON tuple is the simplest implementation), fetch `limit + 1` from each of the materialized and derived sources (using the cursor tuple in the `WHERE` clause when `after` is non-null), merge the two lists at the application layer, re-sort by `(createdAt, notificationId)` ASC, slice to `limit`, compute `nextAfter` from the first trimmed item's cursor if the merged list had more than `limit` entries otherwise `null`, populate the `cursor: string` field on every returned item (both materialized and derived, computed from the row's sort keys), and preserve the two read-time guards from the old `listMemberUpdates` query (the generic published-entity check and the topic-specific `synchronicity.offer_to_ask` ask-drift check). Also add `acknowledgeNotifications`, `listInboxSince` (preserving the four behaviors from the DM stream read path section — removed-message filter, sender joins, sharedClubs, mentions), `acknowledgeDirectMessageInbox`, `getAdmission`.
5. **Handler context.** Extend `HandlerContext` in `src/schemas/registry.ts` with the memoized `getNotifications()` accessor. Wire the per-request cache.
6. **Action handlers.** Create `src/schemas/activity.ts` and `src/schemas/notifications.ts`. Delete `src/schemas/updates.ts`. Extend `src/schemas/messages.ts` with `messages.acknowledge` wired to the new top-level DM-ack repository method. Pin that `activity.list` handler computes `adminClubIds` and `ownerClubIds` from `ctx.actor.memberships` and resolves `after='latest'` by passing `afterSeq: null` to `listClubActivity`. Pin that `notifications.list` handler is **cursor-aware**: with no `after` (or `after: null`), it calls `ctx.getNotifications()` and copies `items` + `nextAfter` directly into its response `data` — zero extra DB reads, shared with the envelope. With `after: <cursor>`, it calls `Repository.listNotifications` directly with the caller-supplied `{ limit, after }` (clamping `limit` to `NOTIFICATIONS_PAGE_SIZE`), bypassing the memo because the memo only caches the default head read. In both modes the returned shape is `{ items, nextAfter, polledAt }` — no `truncated` boolean.
7. **Dispatch layer.** Delete the `import './schemas/updates.ts';` side-effect line in `src/dispatch.ts` (rg `schemas/updates`). Add `import './schemas/activity.ts';` and `import './schemas/notifications.ts';` next to the other action imports. Update envelope assembly to populate **both** `sharedContext.notifications` and `sharedContext.notificationsTruncated` via a single `ctx.getNotifications()` call. The memo returns `{ items, nextAfter }` — the envelope copies `items` into `sharedContext.notifications` and sets `sharedContext.notificationsTruncated = (nextAfter !== null)`. **The envelope does NOT make a raw `Repository.listNotifications({ actorMemberId })` call — it goes through `ctx.getNotifications()`**, which internally calls the repository with the full default head params (`accessibleClubIds`, `adminClubIds`, `limit`, `after: null`) using the club subsets already computed on the handler context. Wrap the call in a try/catch that logs and falls back to `{ notifications: [], notificationsTruncated: false }` on error (fail-open rule). Update the ack-filter logic (rg `result.acknowledgedUpdateIds`) to operate on `sharedContext.notifications` and `acknowledgedNotificationIds`. The filter modifies the items array but does not change `notificationsTruncated`. Update the `sharedContext = auth.sharedContext ?? { pendingUpdates: [] }` fallback to `{ notifications: [], notificationsTruncated: false }`.
8. **Auth init.** Update `src/identity/auth.ts` (rg `pendingUpdates: \[\]` to find both sites) to initialize `sharedContext: { notifications: [], notificationsTruncated: false }`. Do **not** add `validateBearerTokenPassive` here — it already exists. This step is only the envelope-field rename plus the new truncation flag.
9. **Stream handler.** Rewrite `/updates/stream` → `/stream` in `src/server.ts`. Update the unsupported-path error message (rg `Only GET /, GET /skill`) to list `/stream` instead of `/updates/stream`. Add the typed frame emission logic. Wire in the extended `WaitResult` from the notifier. Rename the `outcome` variable to `result` (rg `const outcome = await updatesNotifier`). Extend the **existing** periodic scope refresh (already present, 60s cadence via `streamScopeRefreshMs`) so it recomputes `clubIds`, `adminClubIds`, and `ownerClubIds` together in the rewritten loop. The stream handler calls `Repository.listNotifications` directly once at connect with the default head params `{ actorMemberId, accessibleClubIds, adminClubIds, limit: NOTIFICATIONS_PAGE_SIZE, after: null }` for the `ready` frame seed, copies `items` into the frame payload's `notifications`, and sets `notificationsTruncated = (nextAfter !== null)` — it does NOT use the `HandlerContext.getNotifications` memo because the stream is not a standard handler. The `message` frame payload is `{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }` — a single-message projection of `messages.getThread`'s exact output shape (NOT `messages.getInbox`). The stream handler emits each `{ thread, messages, included }` payload returned by `Repository.listInboxSince` verbatim, with no post-processing or shape translation. No dedicated `MessageEvent` type, no invented `DirectMessageInboxEntry` type.
10. **Schema endpoint.** In `src/schema-endpoint.ts` (rg `/updates/stream` and `updates.acknowledge` in this file): update the `stream` endpoint entry to `path: '/stream'` and rewrite the acknowledgment description text to describe `notifications.acknowledge` and the piggyback envelope pattern. `/api/schema` is the canonical contract agents fetch at boot — this file is agent-visible and must match the new surface exactly.
11. **Notifier.** Update `src/member-updates-notifier.ts` to listen on `stream` instead of `updates`, parse the `kind` field from payloads, return the typed `WaitResult`.
12. **Synchronicity worker.** Update `src/workers/synchronicity.ts` per the "Synchronicity worker update" section above: change the INSERT target, rewrite `topicForMatchKind` to return `synchronicity.*` values, update any internal topic branches.
13. **Tests.** See "Files affected" and "Tests to cover" sections below. Update or replace coverage across `admissions.test.ts`, `signals.test.ts`, `messages.test.ts`, `stream-scope-refresh.test.ts`, `smoke.test.ts`, `matches.test.ts`, `synchronicity.test.ts`, `removal.test.ts`, and `test/unit/server.test.ts`. Add new `activity.test.ts` and `notifications.test.ts` files.
14. **Unit tests and fixtures.** In `test/unit/fixtures.ts`: delete `makePendingUpdate`, delete the `PendingUpdate` import, add `makeActivityEvent` and `makeNotificationItem` (the latter must populate a synthetic `cursor` field — test fixtures should produce valid opaque cursor strings so pagination assertions work end-to-end; the simplest scheme is `btoa(JSON.stringify({ ts: item.createdAt, id: item.notificationId }))`), update the `sharedContext: { pendingUpdates: [] }` initializer to `{ notifications: [], notificationsTruncated: false }`. In `test/unit/app.test.ts`: update every `sharedContext.pendingUpdates` reference (there are more than the plan's earlier version enumerated — rg `pendingUpdates` in the file and fix every hit), making sure each replacement initializer also includes the new `notificationsTruncated: false` default. Delete or update the local `makePendingUpdate` definition that shadows the fixture one (rg `function makePendingUpdate` in `test/unit/app.test.ts`), delete the `PendingUpdate` type import, and delete the dead `updateReceipts` mock setups that were only exercising the always-empty `DirectMessageUpdateReceipt` shape. In `test/unit/server.test.ts`: update the `makePendingUpdate` import and its single call site.
15. **Docs.** Apply the `SKILL.md` and `docs/design-decisions.md` rewrites exactly as pinned in the "Documentation rewrite" section below. The new prose is prescriptive — paste it near-verbatim rather than composing from scratch. Also delete the dangling `docs/member-signals-plan.md` reference from `docs/design-decisions.md:243`.
16. **Schema snapshot.** Regenerate `test/snapshots/api-schema.json`.
17. **Patch bump.** `package.json` version.

## Documentation rewrite

Two files need substantial rewrites plus one minor vocabulary pass. Both ship in the same PR as Phase 1 (not as a follow-up). The prose below is prescriptive — the implementer should paste it near-verbatim and tune for style, not compose it from scratch.

### `SKILL.md` rewrite

`SKILL.md` is agent-facing behavioral guidance. The schema at `GET /api/schema` tells agents which actions exist and what their shapes are; `SKILL.md` tells them how to compose those actions into workflows. Post-rewrite it must describe the four-surface split and the piggyback read path, not the old merged tape.

#### Replace the "Checking for new messages" section

Current content lives around lines 26-32 of `SKILL.md` (rg `### Checking for new messages`) and describes three polling paths (`messages.getInbox`, `updates.list`, `/updates/stream`) plus an ack instruction that references `updates.acknowledge` with `source: "inbox"`.

Rename the section header from "Checking for new messages" to **"Checking for new state"** and replace the body with:

```markdown
### Checking for new state

Four canonical surfaces, each with its own purpose:

1. **Current pending work for me** — read `sharedContext.notifications` from any authenticated response you are already making. Every authenticated `POST /api` response carries the head of the current notification queue on the envelope as an automatic piggyback, FIFO-ordered (oldest-pending first). The same envelope carries `sharedContext.notificationsTruncated: boolean` — if it is `true`, the queue is longer than fits on the piggyback, and you drain the rest via `notifications.list` paginating from the last item you already have. Each piggyback item carries an opaque `cursor: string` field; pass the last item's `cursor` as `after` on your next `notifications.list` call and keep paginating (using each response's returned `nextAfter`) until `nextAfter === null`. You do not need a separate poll otherwise.
2. **DMs I have not read yet** — `messages.getInbox` with `unreadOnly: true`
3. **What happened recently in a club I am in** — `activity.list` with `after={lastCursor}` (or `after='latest'` to skip backlog)
4. **Real-time** — `GET {baseUrl}/stream`, which emits typed SSE frames:
   - `ready` — connection-time seed carrying actor context, the FIFO head of the current notification queue, `notificationsTruncated: boolean` (if true, call `notifications.list({ after: <last ready-frame item's cursor> })` to drain the full backlog before relying on the seed for completeness), and the current activity cursor
   - `activity` — a new club-activity event (SSE `id:` is the activity seq; use `Last-Event-ID` on reconnect to resume)
   - `message` — a new DM. Payload shape is `{ thread, messages, included }` — a single-message projection of `messages.getThread`'s output shape. `thread` is the `directMessageThreadSummary` (counterpart info, `sharedClubs`, etc.), `messages` is a `directMessageEntry[]` containing exactly one new message in the common case, and `included` is the `includedBundle` with the sender and any mentioned members resolved in `membersById`. If your client already has a parser for `messages.getThread` output, reuse it verbatim for `message` frames — same types, same structure. No SSE `id:`; reconcile via `messages.getInbox({ unreadOnly: true })` on reconnect.
   - `notifications_dirty` — invalidation signal with no payload; when you see this, either read `sharedContext.notifications` from your next authenticated POST or call `notifications.list` to force a refresh
   - `: keepalive` — heartbeat

After reading:

- **Notifications** — call `notifications.acknowledge` with `state: "processed"` or `"suppressed"` for materialized items you have processed. Derived notifications (currently `admission.submitted`) resolve automatically when the underlying state changes and cannot be acknowledged — the server rejects ack attempts on them with `422 invalid_input`. Mixed batches that include any derived notification ID are rejected whole.
- **DMs** — call `messages.acknowledge` with the `threadId` of the thread you have read.
- **Activity** — activity items advance via the cursor on `activity.list` and are not explicitly acknowledged.

An activity item with `topic = 'admission.submitted'` and a notification item with `kind = 'admission.submitted'` are two different signals about the same underlying admission: the activity item is a historical fact ("at 09:14 someone submitted"), the notification item is current state ("this admission is still pending"). Do not deduplicate across them.

`sharedContext.notifications` is **current-state enrichment**, not part of the idempotency boundary. Retries of the same `clientKey` may see different notification sets across retries because new notifications can arrive or get acknowledged between calls. Do not assume byte-level response identity.
```

#### Replace the "`updates.list` / `updates.acknowledge`" subsection

Current content lives around lines 297-299 of `SKILL.md` (rg `### \`updates.list\``) as a single combined section header under "When To Clarify First". Delete that section header and replace with four separate subsections, still under "When To Clarify First":

```markdown
### `activity.list`

Use to read recent club activity in cursor-forward order. `after='latest'` skips backlog and starts from the current tip. No ack path — cursor advance is the acknowledgement. For the real-time equivalent, read `activity` frames from `GET /stream`.

### `notifications.list`

The authoritative paginated full-read path for the notification queue. Ordering is FIFO: `createdAt ASC, notificationId ASC` — the oldest pending item is always on page one.

Input: `{ limit?: number, after?: string | null }`. `limit` is clamped to a server-internal page size; requesting a larger value is fine but you get at most one page. `after` is an opaque cursor string from a prior response's `nextAfter` or from any `NotificationItem.cursor` field (including piggyback and `ready`-frame items); pass it back verbatim, do not parse or construct it yourself.

Output: `{ items: NotificationItem[], nextAfter: string | null, polledAt: string }`. `nextAfter === null` means you have reached the end of the queue — there are no more pages. A non-null `nextAfter` is the cursor you pass as `after` on the next call. There is no `truncated` boolean on this response — pagination replaces it.

Every returned `NotificationItem` carries an opaque `cursor: string` field. This is the same format as the `after` input, and it is populated for every item returned anywhere (list response, piggyback, `ready` frame), so you can resume pagination from any item you have seen without re-reading the head.

Call this action when:

- You see `sharedContext.notificationsTruncated: true` on any authenticated response and want the items past the piggyback head. Pass `after: <last piggyback item's cursor>` to jump directly to the next page, then walk forward until `nextAfter === null`. This avoids a redundant re-read of the head the piggyback already delivered.
- You see `notificationsTruncated: true` on the `ready` SSE frame. Same walk as above, starting from the cursor of the last item in the seed.
- You see a `notifications_dirty` stream frame and have no authenticated POST pending. Call with no `after` to fetch the current head; paginate forward if the first response has `nextAfter !== null`.
- You want to walk the full queue on demand from the beginning, or force-refresh without waiting for the next piggyback. Call with no `after`, read page 1, then paginate via `after: nextAfter` until `nextAfter === null`.

Otherwise the normal read path is `sharedContext.notifications` on any authenticated POST, not this action. The piggyback is the primary read path for the head; `notifications.list` is the authoritative full-read path for draining the tail. Both are honest about completeness: the piggyback says "there's more, paginate to drain" via `notificationsTruncated`, `notifications.list` says "there's more, call again with `after: nextAfter`" via the cursor.

### `notifications.acknowledge`

Use to mark a materialized notification as `processed` or `suppressed`. Derived notifications (currently `admission.submitted`) cannot be acknowledged — they disappear automatically when the underlying state resolves. Mixed batches that include a derived notification ID are rejected whole with `422 invalid_input`.

### `messages.acknowledge`

Use to mark unread DMs in a thread as read. Takes a `threadId`. Idempotent — calling again with the same `threadId` when there are no unread entries is a no-op.
```

#### Verify nothing else in `SKILL.md` mentions the old surface

Before committing, `rg '/updates/stream|updates\.list|updates\.acknowledge|pendingUpdates|PendingUpdate'` against `SKILL.md` and fix every hit. The rewrite should leave zero references to the old vocabulary.

Do not touch the Mentions section (currently around lines 207-238). It is unrelated to this rewrite and stays intact. The new `message` stream frame and the `listInboxSince` primitive must carry its mention shapes through — see the DM stream read path section for the preservation requirement.

### `docs/design-decisions.md` rewrite

#### Replace the "Update transport" section

Current content lives around lines 150-171 of `docs/design-decisions.md` (rg `## Update transport`). It describes the merged three-source model with `updates.list` as the canonical merged polling action. Replace wholesale with:

```markdown
## Update transport

ClawClub no longer ships any outbound webhook delivery transport.

The canonical model splits member-visible state into four distinct surfaces, each with its own semantics:

- `club_activity` → `activity.list` — append-only club-wide activity log with audience filtering, cursor-forward reads
- `member_notifications` → `notifications.list` / `notifications.acknowledge` — per-recipient sticky queue of pending work and targeted server-generated notifications, derived-or-materialized, with durable `processed` / `suppressed` acknowledgement state
- `dm_inbox_entries` → `messages.getInbox` / `messages.acknowledge` — per-recipient DM inbox with boolean read state
- `GET /stream` — single SSE endpoint carrying typed frames for all three surfaces (`ready`, `activity`, `message`, `notifications_dirty`) plus keepalive comments

The notification surface is a FIFO worklist: items are ordered `createdAt ASC, notificationId ASC` so the oldest pending item is always first. An agent working through a backlog sees the most-neglected items first, and the API always provides a full-read path so "I am done with my admin work" is verifiable. There is no firehose-head mental model where older items are hidden — the queue is always fully drainable.

The primary agent read path for the queue's head is the `sharedContext.notifications` envelope field, populated on every authenticated response via a per-request cache. `notifications.list` is the authoritative paginated full-read path for draining the tail.

Completeness semantics differ by read path — every populated read path is honest about whether there is more:

- `notifications.list` is the authoritative paginated full-read path. Its response carries `nextAfter: string | null`; non-null means there is another page, null means end of queue. Callers walk forward by passing `nextAfter` back as `after` until it comes back null. Every `NotificationItem` also carries an opaque `cursor` field, so callers can resume pagination from any item they have seen (including items received via the piggyback or the stream seed).
- `sharedContext.notifications` on the envelope is the FIFO head (capped at the same page size), and carries `notificationsTruncated: boolean` so callers know whether there is more to drain via `notifications.list`.
- The `ready` SSE frame at connect carries the same capped head + `notificationsTruncated: boolean` with the same semantics.

There is always a full-read path: callers that need every pending notification paginate `notifications.list` until `nextAfter === null`. The piggyback and stream seed are deliberately capped (free head-of-queue hints shipped for zero extra work) but are always honest about being capped, and their items carry cursors so the walk can start directly past what they delivered.

`notifications_dirty` SSE frames carry no payload (they are invalidation-only); clients learn the new state from the next authenticated response's piggyback or from an explicit `notifications.list` call.

Rules:

- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- clients reconnect normally; only `activity` frames advance a cursor (via SSE `Last-Event-ID` carrying the activity seq). `message` and `notifications_dirty` frames do not advance any cursor.
- DM inbox entries are acknowledged via `messages.acknowledge(threadId)`
- DM data uses **one canonical shape** across all message-level surfaces: `messages.getThread` and the SSE `message` stream frame both return `{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }`. The stream frame is a single-message projection of `messages.getThread`'s exact output (minus the list-specific `hasMore`/`nextCursor`). A client parser written for one works verbatim for the other. There is no dedicated `MessageEvent`, no `DirectMessageInboxEntry`, no invented stream-only types. Thread-summary reads (`messages.getInbox`) return a different shape because they serve a different purpose (thread-level summaries with unread counts), but individual DMs everywhere they appear use the same `directMessageEntry` type.
- materialized notifications are acknowledged via `notifications.acknowledge` with durable `processed`/`suppressed` state
- derived notifications (e.g. `admission.submitted`) resolve automatically and cannot be acknowledged
- club-wide activity is cursor-tracked, not explicitly acknowledged
- activity audience filtering (`members`, `clubadmins`, `owners`) restricts visibility by role
- read-time filtering in `notifications.list` suppresses materialized notifications whose referenced entity is no longer published
- `sharedContext.notifications` and `sharedContext.notificationsTruncated` are current-state enrichment, not part of the idempotency boundary; retries may see different sets and different truncation flags
- if `sharedContext.notificationsTruncated` is true on a piggyback or `ready` frame, agents call `notifications.list` with pagination (passing the last seen item's `cursor` as `after`) to drain the full backlog

Polling and SSE are two views of the same underlying surfaces, not separate transports.
```

#### Replace the "Member signals" section

Current content lives around lines 182-193 of `docs/design-decisions.md` (rg `## Member signals`). It describes `signal_deliveries` as a general-purpose transport primitive. Rename the section header to **"Member notifications"** and replace with:

```markdown
## Member notifications

`member_notifications` is the per-recipient materialized notification table. Any code path that needs to tell a specific member something — billing, moderation, admissions, synchronicity — inserts a row and the existing stream delivery path handles wakeup and client refresh.

Design decisions:

- notifications are not DMs: no sender, no thread, no reply expected. They are structured data for the agent, not human-readable messages
- notifications are not club_activity: activity is broadcast to all members; notifications are targeted to one specific recipient
- payloads are ID-first: stable identifiers + score + author identity. No denormalized entity titles or summaries — agents fetch current details via referenced IDs, so removed/edited content never leaks through stale payloads
- acknowledgement is durable: `acknowledged_state` is `processed` or `suppressed` with a `suppression_reason`, not just a boolean. This data drives quality tuning for recommendation-style notifications.
- the surface is a FIFO worklist: ordering is `createdAt ASC, notificationId ASC` so the oldest pending item is always first. An agent working through a backlog sees the most-neglected items first, and the paginated `notifications.list` always provides a full-read path so "I'm done" is verifiable
- NOTIFY trigger fires on the unified `stream` channel with `kind: 'notification'` for SSE wakeup
- unique partial index on `match_id` prevents duplicate notifications on synchronicity crash-retry
- `club_id` is nullable so account-scoped notifications (future billing, email delivery) can coexist with club-scoped ones

Derived notifications are a separate, additive category that share the `NotificationItem` response shape but are not materialized in the table:

- computed from live state at read time rather than stored as rows
- phase 1 implements `admission.submitted` as the first derived kind, read from `current_admissions` where `status = 'submitted'` and the actor is a clubadmin of that club
- cannot be acknowledged (they resolve automatically when the underlying state transitions)
- composed into the `notifications.list` response alongside materialized rows, and appear in the `sharedContext.notifications` piggyback on every authenticated response
```

#### Patch the "Synchronicity matching" section for vocabulary drift

The "Synchronicity matching" section at lines 207-243 of `docs/design-decisions.md` stays structurally. Do **not** rewrite it wholesale. Apply these in-place vocabulary fixes:

1. Change "delivers them as member signals" → "delivers them as member notifications"
2. Change every remaining `signal_deliveries` reference in the prose → `member_notifications`
3. Change "per-kind delivery throttling: introductions capped at 2/week, general signals at 3/day" → "per-kind delivery throttling: introductions capped at 2/week, general notifications at 3/day"
4. Change "read-time filtering suppresses signals whose referenced entity" → "read-time filtering suppresses notifications whose referenced entity"
5. Add `event_to_member` to the Match types list (currently three kinds at lines 217-220), matching the actual four kinds the worker produces (`ask_to_member`, `offer_to_ask`, `member_to_member`, `event_to_member`). The existing list missing this fourth kind is a pre-existing doc bug that this rewrite opportunistically fixes.
6. **Delete the dangling reference at line 243 entirely:** `See docs/member-signals-plan.md for the full design rationale and implementation plan.` — that file does not exist in the current checkout.

Leave `signal_background_matches` and `signal_recompute_queue` references alone. Those are synchronicity-internal state tables and their names deliberately stay (locked decision #7). The prose can describe them as "synchronicity lifecycle state" without reintroducing the "signal" vocabulary for the delivery path.

#### Verify nothing else in `docs/design-decisions.md` mentions the old surface

Before committing, `rg 'signal_deliveries|updates\.list|updates\.acknowledge|/updates/stream|pendingUpdates|PendingUpdate'` against `docs/design-decisions.md` and fix every hit.

### Ideation docs (leave alone by default)

These docs reference `signal_deliveries` or `updates.list` in historical / design-exploration contexts:

- `docs/hyperscale.md` (scaling concerns)
- `docs/new_feature_dreaming.md` (feature ideation)
- `docs/location_synchronicity_design_exploration.md` (location matching design)

They are not load-bearing for operational behavior. Default is to leave them as historical record. The implementer may optionally do a bulk vocabulary pass on them if they want to, but this is not required for the PR to ship.

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

- `src/contract.ts` — delete `PendingUpdate` type, Repository interface changes (including paginated `listNotifications` signature `{ ..., limit, after }` → `{ items, nextAfter }`), `SharedResponseContext` field rename, add `cursor: string` to `NotificationItem`
- `src/postgres.ts` — remove `listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates`; add new methods including `listInboxSince` and the `listClubActivity` wire-through; remove `PendingUpdate` import
- `src/messages/index.ts` — expose the existing `acknowledgeInbox` helper through the top-level Repository surface; extend it to return an acknowledged count if needed
- `src/server.ts` — `/stream` handler, typed frame emission, periodic scope refresh, `validateBearerTokenPassive` integration, unsupported-path error message
- `src/member-updates-notifier.ts` — channel rename, typed WaitResult, kind parsing
- `src/schemas/transport.ts` — `sharedContext.notifications`, `sseReadyEvent` update, add `sseNotificationsDirtyEvent`, delete `pollingResponse` and the `memberUpdates` import
- `src/schemas/responses.ts` — delete `pendingUpdate`, `memberUpdates`, `updateReceipt`, and `directMessageUpdateReceipt`; remove `updateReceipts` from direct-message entries; add `activityEvent`, `notificationItem` (with required opaque `cursor: string` field), `notificationReceipt`, and response shapes for the new actions (`notificationsResponse` uses `nextAfter: string | null`, not `truncated: boolean`). Keep the shared `updateReceiptState` enum in `src/schemas/fields.ts`.
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
- Materialized and derived items merge in the response, FIFO-ordered by `(createdAt, notificationId)` ASC — the oldest pending item is always first, regardless of source
- Every item in every `notifications.list` response (and in `sharedContext.notifications`, and in the `ready` frame seed) carries a non-empty opaque `cursor: string` field, populated for both materialized and derived items
- Initial `notifications.list()` call with no `after` on a small set returns `nextAfter: null` (end of queue — no pagination needed)
- Initial `notifications.list()` call on a large set returns a full page of `items` plus `nextAfter: <cursor>` (more pages exist)
- **Pagination walks the full queue:** seed a total backlog greater than 2× `NOTIFICATIONS_PAGE_SIZE` across both materialized and derived sources, call `notifications.list()` with no `after` to get page 1, then repeatedly call `notifications.list({ after: nextAfter })` until `nextAfter === null`, and assert the concatenated items exactly equal the full expected set with no duplicates and no gaps
- Pagination order is FIFO (`createdAt ASC, notificationId ASC`) across both materialized and derived items — the oldest pending item is always on page 1, the newest pending item is always on the last page
- **Pagination is stable under concurrent acks:** start walking the queue, ack a later-page item out-of-band mid-walk, continue walking, assert no previously-returned items reappear on later pages and no duplicate IDs are emitted
- **New items arriving at the tail** during a walk show up in later pages (or after the walk terminates) but do not disturb the pages the caller has already read — validate by inserting a new materialized row mid-walk and confirming it appears only on a page at or past the insertion cursor
- **Pagination works from a piggyback cursor:** seed a backlog > cap, read the piggyback from any authenticated response to get `sharedContext.notifications` + `notificationsTruncated: true`, take the last item's `cursor`, call `notifications.list({ after: <that cursor> })`, assert the response picks up exactly past where the piggyback left off (no duplication with the piggyback items, no gap)
- `limit` parameter is respected and clamped: request `limit: 5`, receive exactly 5 items; request `limit: 10000`, receive at most `NOTIFICATIONS_PAGE_SIZE` items
- `notifications.list` FIFO ordering holds across multiple admin clubs (items from different clubs interleave by timestamp, not by club grouping)
- Non-admin member gets an empty derived set
- `notifications.list` → `clubadmin.admissions.get` round trip succeeds using returned `clubId` + `ref.admissionId`
- Derived notification disappears when admission transitions away from `submitted` (walking the queue before and after the transition produces different paginated results but neither reports stale state)
- Newly-promoted admin sees current pending admissions on next poll
- `notifications.acknowledge` updates materialized rows and returns receipts
- `notifications.acknowledge` rejects any batch containing derived notification IDs with `422 invalid_input`
- `notifications.acknowledge` receipts contain only IDs that actually transitioned state (idempotent re-acks do not appear)
- Account-scoped notification (`club_id = null`) round-trips correctly and appears in the FIFO merge at its own `createdAt` timestamp
- After migration, every row in `member_notifications` has a `synchronicity.*` topic (no stale `signal.*` values remain) — verify with `SELECT DISTINCT topic`

### Phase 1 — envelope piggyback

- Every authenticated response carries `sharedContext.notifications` populated
- Every authenticated response also carries `sharedContext.notificationsTruncated: boolean`
- Every item in `sharedContext.notifications` carries a populated `cursor: string` field (so agents can resume pagination from any piggyback item)
- `notifications.list` handler **with no `after`** and envelope assembly share the per-request cache (query-counter assertion: exactly one `listNotifications` call on `Repository` per request, not two)
- `notifications.list` handler **with `after: <cursor>`** bypasses the memo and makes its own repository call (query-counter assertion: two `listNotifications` calls — the envelope head call via the memo, and the paginated call direct)
- `notifications.acknowledge` on a materialized row removes the row from the same response's `sharedContext.notifications`. The same response's `sharedContext.notificationsTruncated` is unchanged by ack-driven filtering — ack removes items from the visible set, it does not change whether the underlying read had more pages available.
- Non-admin calling an unrelated action sees an empty `sharedContext.notifications` and `notificationsTruncated: false`
- Piggyback respects the same FIFO ordering and `NOTIFICATIONS_PAGE_SIZE` cap as the `notifications.list` head call
- **Truncation surfaces on the piggyback:** seed enough notifications to exceed `NOTIFICATIONS_PAGE_SIZE`, call any authenticated action, assert `sharedContext.notificationsTruncated === true` AND `sharedContext.notifications.length === NOTIFICATIONS_PAGE_SIZE`. Resolve a few notifications to drop the count back below the cap, call again, assert `notificationsTruncated === false`.
- **Piggyback drainage via pagination:** seed a backlog larger than `NOTIFICATIONS_PAGE_SIZE`, call any authenticated action to observe `notificationsTruncated: true` and the head items in `sharedContext.notifications`, then walk `notifications.list` with `after: <last piggyback item's cursor>` until `nextAfter === null`, and assert the combined (piggyback head + paginated tail) set covers the full backlog with no duplicates and no gaps
- The dispatch layer's envelope assembly goes through `ctx.getNotifications()` — assert by mocking `Repository.listNotifications` and confirming the dispatch-layer call path uses the memoized accessor, not a direct repository call with `{ actorMemberId }` only
- Unauthenticated actions (cold admission) do not trigger notification reads at all
- **Fail-open on piggyback error:** mock `listNotifications` to throw, call any authenticated action, assert the response is successful with `sharedContext.notifications: []` and `sharedContext.notificationsTruncated: false`, and an error is logged — NOT a 500 response
- **Retry non-byte-identity:** make a mutating call with `clientKey`, have another notification land, retry the same `clientKey`, assert the second response has a different `sharedContext.notifications` set even though the action result is idempotent

### Phase 1 — stream

- `GET /stream` replaces `GET /updates/stream`; old URL returns 404
- Unsupported-path error message lists `/stream`
- `ready` frame includes initial notifications set, `notificationsTruncated: boolean`, and activity cursor, with SSE `id:` set to the activity tip
- **Truncation surfaces on the `ready` frame:** seed enough notifications to exceed `NOTIFICATIONS_PAGE_SIZE`, connect `/stream`, assert the `ready` frame payload has `notificationsTruncated === true` AND `notifications.length === NOTIFICATIONS_PAGE_SIZE`
- **`ready` frame items carry cursors:** every item in the `ready` frame's `notifications` array has a populated `cursor: string` field, so a connecting client can call `notifications.list({ after: <last ready-frame item's cursor> })` over HTTP to drain the backlog past the seed
- `activity` frames carry `ActivityEvent` payloads with seq as SSE `id:`
- **`message` frame payload shape is `{ thread, messages, included }`** — a single-message projection of `messages.getThread`'s output shape. Same real types (`directMessageThreadSummary`, `directMessageEntry[]`, `includedBundle`). No dedicated `MessageEvent`, no `DirectMessageInboxEntry`, no invented shapes. A snapshot test between a stream `message` frame and an equivalent projection of `messages.getThread` output should match field-for-field: same `thread` fields, same `messages[0]` fields, same `included.membersById` entries for members referenced by that one message.
- **`message` frame `thread.sharedClubs` is populated** via the same `batchResolveSharedClubs` helper the current inbox query uses. Seed two members in different clubs with a shared club, have one DM the other, connect the recipient's stream, assert the `message` frame's `thread.sharedClubs` contains the shared club.
- **`message` frame `messages[0]` does NOT carry an `updateReceipts` field** (deleted in Phase 1 from `directMessageEntry`). The post-cleanup `directMessageEntry` shape is shared between `messages.getThread` and the stream frame — neither surface has `updateReceipts`.
- **`message` frame `included.membersById`** is populated with the sender and every member referenced in `messages[0].mentions`, using the existing `includedMember` shape (`memberId`, `publicName`, `displayName`, `handle`). Send a DM that mentions a third member, connect the stream, assert the frame's `included.membersById` has entries for both the sender and the mentioned third member.
- `message` frames carry DM data with no SSE `id:` (do not advance any cursor)
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
- `listInboxSince` preserves the per-field `mentions` array when the DM body contains a literal `@handle` mention, matching the shape returned by `messages.getInbox` / `messages.getThread`. The `included.membersById` bundle flows through to the client. Verify by sending a DM that mentions another member, connecting the stream, confirming the `message` frame payload has `mentions` populated with the correct `memberId` and the `included.membersById` entry matches.

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
- **Do not** argue for making the new Phase-1 Repository methods optional with capability checks. They are required at the type level. Only `getAdmission?` is optional, and only because Phase 0 ships first as its own rollout seam.
- **Do not** argue against `sharedContext.notificationsTruncated` or `ready.notificationsTruncated`. Without those flags, the piggyback and stream seed are partial-read traps where agents can act on incomplete state without knowing it. The truncation flag must surface on every populated read path that exposes a notification set without its own cursor-based completeness signal.
- **Do not** argue against pagination on `notifications.list`. The worklist mental model (agents must be able to drain the queue and verify "I'm done") requires a full-read path, and pagination is the only way to provide one without breaking the "one notification read per authenticated request" rule that makes the piggyback affordable. The piggyback stays capped (free head-of-queue hint on every response); `notifications.list` is the authoritative paginated full-read path. They are intentionally different reads with different jobs and different caching rules. No pagination on `notifications.list` means no full-read path for agents with backlogs larger than the cap, and that is unacceptable for a multi-year system where queues grow.
- **Do not** argue for keeping `truncated: boolean` on the `notifications.list` response. Pagination replaces it with `nextAfter: string | null`. The boolean is redundant under the pagination model — `nextAfter !== null` is the single "there is more" signal, and the caller can act on it directly by walking forward. Keeping both would be two ways to express the same state. `notificationsTruncated` survives on the piggyback and the `ready` frame only because those surfaces are deliberately not paginated.
- **Do not** argue against putting `cursor: string` on `NotificationItem`. The cursor field is what lets an agent resume pagination from any item it has seen — including items received via the piggyback or the `ready` frame, not just items from a prior `notifications.list` response. Without per-item cursors, an agent draining the queue after a truncated piggyback must either make a redundant first call (wasted read) or expose a second cursor on the envelope (more envelope complexity). Per-item cursors are strictly simpler and let the piggyback items themselves be pagination-resume points.
- **Do not** argue for a dedicated `MessageEvent` type on the SSE `message` frame, and **do not** reintroduce `DirectMessageInboxEntry` (that type does not exist in the codebase and never should). The frame payload is `{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }` — a single-message projection of `messages.getThread`'s exact output shape, using only types that already exist in `src/schemas/responses.ts`. One canonical data shape for a thread-and-messages everywhere it appears — list read, stream push, any future surface. A second shape for the stream would drift from the list-read shape as fields are added to one but not the other, and agents would need two rendering paths for the same entity. The invariant "one canonical data shape per entity" is load-bearing across the rewrite.
- **Do not** argue for aligning the `message` frame with `messages.getInbox` instead of `messages.getThread`. `messages.getInbox` is thread-summary-level (it returns `directMessageInboxSummary[]` with unread counts and `latestMessage` nested); `messages.getThread` is message-level (it returns `directMessageEntry[]` — the actual messages). A DM push is the arrival of one specific message, which is message-level granularity. Using the inbox shape would force a round-trip to read the message body, which is wrong for a push transport. The thread-level context (counterpart info, sharedClubs) still rides on the frame via the `thread` field, so the push is self-contained.
- **Do not** argue for adding a `sharedClubs` field to `directMessageEntry` or to `includedMember`. `sharedClubs` is thread-level, not message-level — the same thread has the same sharedClubs for every message in it. It already lives on `directMessageThreadSummary.sharedClubs`, which is where the `message` frame carries it via the `thread` field. Duplicating it onto individual messages or onto `includedMember` would be data duplication for no structural gain.
- **Do not** argue for naming the frame field `entry` (singular) instead of `messages: DirectMessageEntry[]` (array). The array matches `messages.getThread`'s exact shape, which lets a single parser handle both surfaces, and it leaves a natural extension point for future batching (reconnect catch-up, coalesced pushes) without a schema change. A singular `entry` field would break the shape alignment.
- **Do not** argue for putting the envelope's `listNotifications` call directly on the repository interface from `src/dispatch.ts`. The envelope goes through the memoized `ctx.getNotifications()` accessor so that a handler calling the same memo on the same request shares the cached result. Calling the repository directly from the envelope breaks the "one read per request" caching rule and also creates two code paths for "read the head of the notification queue" that can drift. The memo is the single entry point for the default head read.
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

## Self-review checklist for the implementing agent

Use this checklist to self-audit before handing the PR back for review. Each item is a pass/fail check, not a subjective assessment. The reviewer will run through the same list.

### Phase 0 (standalone PR)

- [ ] New action `clubadmin.admissions.get` is declared in `src/schemas/clubadmin.ts` with `auth: 'clubadmin'`, input `{ clubId, admissionId }`, output `{ admission: AdmissionSummary }`
- [ ] `Repository.getAdmission?` is added to `src/contract.ts` as an optional method
- [ ] `'getAdmission'` is added to the capability list in `src/schemas/registry.ts`
- [ ] The repository implementation either extends `readAdmission` with applicant/sponsor display joins OR writes a new single-row query mirroring the `listAdmissions` projection
- [ ] Returned shape matches `AdmissionSummary` field-for-field (no drift vs. `clubadmin.admissions.list`)
- [ ] Superadmin bypass works via `ctx.requireClubAdmin(clubId)` without any extra code
- [ ] Tests exist for: happy path fetch in scope, regular member 403, superadmin bypass, shape match
- [ ] `SKILL.md` "Core behaviors" section has the one-line `clubadmin.admissions.get` discoverability mention
- [ ] `test/snapshots/api-schema.json` is regenerated and contains the new action
- [ ] `package.json` patch version is bumped
- [ ] `rg 'clubadmin\.admissions\.get'` across the repo turns up no stale references

### Phase 1 — Migration

- [ ] `db/migrations/NNN_rename_signals_to_notifications.sql` exists and includes, in order:
  - [ ] `ALTER TABLE signal_deliveries RENAME TO member_notifications`
  - [ ] `ALTER TABLE member_notifications ALTER COLUMN club_id DROP NOT NULL`
  - [ ] `ALTER SEQUENCE signal_deliveries_seq_seq RENAME TO member_notifications_seq_seq`
  - [ ] Both index renames (`_recipient_poll_idx`, `_match_unique_idx`)
  - [ ] All 8 constraint renames (pkey, seq_unique, 3 check constraints, 3 FKs)
  - [ ] Topic UPDATE with all 4 mappings (`signal.ask_match`, `signal.offer_match`, `signal.introduction`, `signal.event_suggestion` → `synchronicity.*`)
  - [ ] DROP + CREATE of all 4 trigger functions landing on the `stream` channel with typed `kind` payloads
  - [ ] New `notify_admission_version` trigger with `SELECT club_id INTO v_club_id FROM admissions WHERE id = NEW.admission_id`
- [ ] `scripts/migrate.sh` runs the migration cleanly against a fresh dev database
- [ ] `db/init.sql` is regenerated from a dev database post-migration (not hand-edited)
- [ ] Running `rg signal_deliveries` across the repo shows zero hits outside historical docs and deliberate synchronicity-internal references (`signal_background_matches`, `signal_recompute_queue`, `signal_id` column)
- [ ] `\d+ member_notifications` in psql shows all constraint/index names match the new table

### Phase 1 — Action surface

- [ ] `src/schemas/updates.ts` is deleted
- [ ] `src/dispatch.ts` no longer imports `./schemas/updates.ts` and does import both `./schemas/activity.ts` and `./schemas/notifications.ts`
- [ ] `src/schemas/activity.ts` exists with `activity.list` action
- [ ] `src/schemas/notifications.ts` exists with `notifications.list` and `notifications.acknowledge` actions
- [ ] `notifications.list` input is `{ limit?: number, after?: string | null }` and output is `{ items: NotificationItem[], nextAfter: string | null, polledAt: string }` — the response does NOT have a `truncated: boolean` field
- [ ] `NotificationItem` (both the Zod schema and the TypeScript type) includes a **required** `cursor: string` field
- [ ] `Repository.listNotifications` signature takes `{ actorMemberId, accessibleClubIds, adminClubIds, limit, after }` and returns `{ items, nextAfter }`
- [ ] The repository implementation merges materialized + derived sources, orders by `(createdAt, notificationId)` ASC (FIFO), fetches `limit + 1` per source to detect next-page, slices to `limit`, populates `nextAfter` from the first trimmed item's cursor (or `null` if no trimming), and populates the opaque `cursor` field on every returned item (materialized and derived alike)
- [ ] Cursors round-trip: pass an item's `cursor` back as `after` and the next page starts strictly after that item
- [ ] `src/schemas/messages.ts` has a new `messages.acknowledge` action wired to the top-level DM-ack repository method
- [ ] `Repository.listMemberUpdates`, `getLatestCursor`, `acknowledgeUpdates` are deleted from `src/contract.ts` and `src/postgres.ts`
- [ ] `Repository.listClubActivity`, `listNotifications`, `acknowledgeNotifications`, `listInboxSince`, and `acknowledgeDirectMessageInbox` are added to `src/contract.ts` as **required** (non-optional) methods and implemented in `src/postgres.ts`
- [ ] `Repository.getAdmission?` is the only new optional method (Phase 0 rollout seam)
- [ ] The capability list in `src/schemas/registry.ts` no longer has `'listMemberUpdates'`, `'getLatestCursor'`, or `'acknowledgeUpdates'`
- [ ] The capability list in `src/schemas/registry.ts` has `'getAdmission'` as the only new entry — and does NOT have `'listClubActivity'`, `'listNotifications'`, `'acknowledgeNotifications'`, `'listInboxSince'`, or `'acknowledgeDirectMessageInbox'` (those are required methods, not optional capabilities)
- [ ] `NotificationItem.kind` enum includes all five Phase-1 values (`admission.submitted`, `synchronicity.ask_to_member`, `synchronicity.offer_to_ask`, `synchronicity.member_to_member`, `synchronicity.event_to_member`)

### Phase 1 — Piggyback envelope

- [ ] `sharedContext.pendingUpdates` is replaced by **two** fields in `src/schemas/transport.ts`: `notifications: NotificationItem[]` and `notificationsTruncated: boolean`
- [ ] `src/identity/auth.ts` initializes `sharedContext: { notifications: [], notificationsTruncated: false }` at both sites (rg `pendingUpdates: \[\]`)
- [ ] `HandlerContext` in `src/schemas/registry.ts` exposes `getNotifications(): Promise<{ items: NotificationItem[]; nextAfter: string | null }>` as a memoized per-request accessor. The memo always calls `Repository.listNotifications` with default head params (`after: null`, `limit: NOTIFICATIONS_PAGE_SIZE`), not with caller-provided pagination params.
- [ ] `src/dispatch.ts` envelope assembly calls `ctx.getNotifications()` once (NOT a direct `Repository.listNotifications({ actorMemberId })` or any other raw repository call), copies its `items` into `sharedContext.notifications`, computes `sharedContext.notificationsTruncated = (result.nextAfter !== null)`, and wraps the call in a try/catch that logs and falls back to `{ notifications: [], notificationsTruncated: false }` on error
- [ ] Grep assertion: `rg 'Repository\\.listNotifications|repository\\.listNotifications' src/dispatch.ts` returns zero hits — the dispatch layer only touches notifications via the `ctx.getNotifications()` memo, never a raw repository call
- [ ] `ActionResult.acknowledgedUpdateIds` is renamed to `acknowledgedNotificationIds` and the dispatch filter operates on `sharedContext.notifications` and `notificationId`
- [ ] The `notifications.list` handler is **cursor-aware**:
  - With no `after` / `after: null`: calls `ctx.getNotifications()` to share the cached head with envelope assembly (query-counter assertion: exactly one repository read)
  - With `after: <cursor>`: bypasses the memo and calls `Repository.listNotifications` directly with `{ actorMemberId, accessibleClubIds, adminClubIds, limit, after }` (query-counter assertion: two repository reads — the memoized envelope head + the direct paginated call)
- [ ] The stream handler in `src/server.ts` reads notifications directly from `Repository.listNotifications` at connect with default head params, NOT via `ctx.getNotifications()` (streams are not standard handlers)
- [ ] Every item in every `sharedContext.notifications` response has a populated `cursor: string` field

### Phase 1 — Stream

- [ ] `/updates/stream` URL returns 404; `/stream` is the new URL
- [ ] Unsupported-path error message in `src/server.ts` lists `/stream` instead of `/updates/stream`
- [ ] Stream emits only `ready`, `activity`, `message`, `notifications_dirty`, and `: keepalive` frames
- [ ] Only `activity` frames attach an SSE `id:`
- [ ] `ready` frame payload includes `{ member, requestScope, notifications: NotificationItem[], notificationsTruncated: boolean, activityCursor: string | null }`
- [ ] Every item in the `ready` frame's `notifications` array has a populated `cursor: string` field (enabling pagination from any item in the seed)
- [ ] `notifications_dirty` has no payload body
- [ ] `message` frame payload shape is **`{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }`** — a single-message projection of `messages.getThread`'s output shape, using only types that exist today in `src/schemas/responses.ts`. There is no dedicated `MessageEvent` type and no `DirectMessageInboxEntry` type declared anywhere (`rg 'MessageEvent|DirectMessageInboxEntry'` returns zero hits in the new code).
- [ ] `messages[0]` in a `message` frame is a post-Phase-1 `directMessageEntry` — includes `messageId`, `threadId`, `senderMemberId`, `role`, `messageText`, `mentions`, `payload`, `createdAt`, `inReplyToMessageId`, and does NOT include `updateReceipts` (deleted in Phase 1)
- [ ] `message` frame `thread.sharedClubs` is populated via `batchResolveSharedClubs` — sharedClubs lives on the `thread` summary, NOT on individual `messages[]` entries (there is no `sharedClubs` field added to `directMessageEntry`)
- [ ] `message` frame `included.membersById` is populated with the sender and every member referenced in `messages[0].mentions`, using the unchanged `includedMember` shape
- [ ] Snapshot test: stream `message` frame payload matches the shape of `messages.getThread`'s output projected to a single `messages[0]` entry (minus `hasMore` / `nextCursor`)
- [ ] Last-Event-ID parse failure falls back to "latest" (current activity tip)
- [ ] The existing 60-second scope refresh now recomputes `clubIds`, `adminClubIds`, and `ownerClubIds` together
- [ ] `NOTIFICATION_WAKEUP_KINDS = new Set(['notification', 'admission_version'])` allowlist gates `notifications_dirty` emission
- [ ] The `outcome` variable at the waitForUpdate call site is renamed to `result` and the timed-out check is `result.outcome === 'timed_out'`

### Phase 1 — DM stream primitive

- [ ] `Repository.listInboxSince` returns `{ frames: Array<{ thread: DirectMessageThreadSummary, messages: DirectMessageEntry[], included: IncludedBundle }> }` — ready-to-emit `message` frame payloads, one per new inbox row, each a single-message projection of `messages.getThread`'s output shape
- [ ] `listInboxSince` preserves the `dm_message_removals` filter (removed messages do not appear in any returned frame)
- [ ] `listInboxSince` populates each frame's `messages[0]` using the canonical `directMessageEntry` shape (`messageId`, `threadId`, `senderMemberId`, `role`, `messageText`, `mentions`, `payload`, `createdAt`, `inReplyToMessageId`) — NOT a bespoke shape and NOT the pre-Phase-1 entry with `updateReceipts`
- [ ] `listInboxSince` populates each frame's `thread.sharedClubs` via `batchResolveSharedClubs` — sharedClubs lives on the thread summary, not on any per-message field
- [ ] `listInboxSince` preserves the per-field `mentions` array on each `messages[0]` and populates `included.membersById` per-frame with the sender and every mentioned member using the existing `includedMember` shape
- [ ] The stream loop in `src/server.ts` emits each returned frame payload verbatim as a `message` SSE frame — no post-processing, no re-wrapping, no shape translation
- [ ] `messages.acknowledge` wires the existing-but-dead `acknowledgeInbox` helper to a new action handler
- [ ] Post-Phase-1, `rg 'set acknowledged = true'` shows at least one live code path for `dm_inbox_entries`

### Phase 1 — Synchronicity worker

- [ ] `src/workers/synchronicity.ts` inserts into `member_notifications` (no remaining `signal_deliveries` references)
- [ ] `topicForMatchKind` returns the four `synchronicity.*` values (no `signal.*` strings)
- [ ] The `default: signal.${kind}` catchall is either removed or rewritten as `synchronicity.${kind}`
- [ ] `signal_background_matches` and `signal_recompute_queue` are UNCHANGED (except that the FK target auto-updates transparently)
- [ ] The `signal_id` column name on `signal_background_matches` is unchanged

### Phase 1 — Tests

- [ ] New files: `test/integration/non-llm/activity.test.ts` and `test/integration/non-llm/notifications.test.ts`
- [ ] All tests in the "Tests to cover" section have at least one corresponding test case
- [ ] `test/integration/non-llm/synchronicity.test.ts` rewrite is complete (expected ~20 sites, direct INSERTs in test fixtures use new table name and new topic vocabulary)
- [ ] `test/integration/non-llm/signals.test.ts` is rewritten (or folded into `notifications.test.ts`) — zero remaining `signal_deliveries` references
- [ ] `test/integration/non-llm/matches.test.ts` uses the new table name in its test-fixture INSERT
- [ ] `test/integration/non-llm/messages.test.ts` updates DM stream frame expectations
- [ ] `test/integration/non-llm/removal.test.ts` updates for `listInboxSince` filter behavior
- [ ] `test/integration/non-llm/stream-scope-refresh.test.ts` uses `/stream` and the new frame types
- [ ] `test/unit/fixtures.ts` has `makeActivityEvent` and `makeNotificationItem`, no `makePendingUpdate`
- [ ] `test/unit/app.test.ts` updates every `pendingUpdates` reference (rg, fix every hit) and removes the local `makePendingUpdate` shadow function
- [ ] `test/unit/server.test.ts` updates the `makePendingUpdate` import and call site
- [ ] Dead `DirectMessageUpdateReceipt` mock setups at `test/unit/app.test.ts:2913-2944` (or wherever they currently live) are removed
- [ ] `test/snapshots/api-schema.json` is regenerated and contains `activity.list`, `notifications.list`, `notifications.acknowledge`, `messages.acknowledge`; does not contain `updates.list`, `updates.acknowledge`, `pendingUpdates`, or `PendingUpdate`

### Phase 1 — Docs

- [ ] `SKILL.md` "Checking for new messages" section is replaced with "Checking for new state" using the prescribed prose
- [ ] `SKILL.md` `updates.list` / `updates.acknowledge` subsection is replaced with four new subsections (`activity.list`, `notifications.list`, `notifications.acknowledge`, `messages.acknowledge`) using the prescribed prose
- [ ] `rg '/updates/stream|updates\.list|updates\.acknowledge|pendingUpdates|PendingUpdate'` against `SKILL.md` returns zero hits
- [ ] `docs/design-decisions.md` "Update transport" section is replaced with the prescribed prose
- [ ] `docs/design-decisions.md` "Member signals" section is renamed to "Member notifications" and replaced with the prescribed prose
- [ ] `docs/design-decisions.md` "Synchronicity matching" section has the six in-place vocabulary fixes applied
- [ ] `event_to_member` is added to the "Match types" list in "Synchronicity matching"
- [ ] `docs/design-decisions.md:243` dangling `member-signals-plan.md` reference is deleted
- [ ] `rg 'signal_deliveries|updates\.list|updates\.acknowledge|/updates/stream'` against `docs/design-decisions.md` returns zero hits

### Phase 1 — Archival

- [ ] `plans/updates-stream-scope-refresh.md` is deleted or explicitly marked as superseded
- [ ] `plans/system-notifications-design.md` (this file) can stay as the historical record

### Phase 1 — Final verification

- [ ] `npm run check` (TypeScript) passes cleanly
- [ ] `npm run test:unit` passes
- [ ] `npm run test:unit:db` passes
- [ ] `npm run test:integration:non-llm` passes
- [ ] Full repo `rg signal_deliveries` returns only deliberate synchronicity-internal hits
- [ ] Full repo `rg '/updates/stream|updates\.list|updates\.acknowledge|pendingUpdates|PendingUpdate|memberUpdates|pollingResponse'` returns zero hits except in historical design docs explicitly left alone (`docs/hyperscale.md`, `docs/new_feature_dreaming.md`, `docs/location_synchronicity_design_exploration.md`) and this plan file
- [ ] `package.json` patch version bumped
- [ ] The deploy runbook mentions the expected `409 stale_client` burst and the bounded synchronicity worker error window

## For the reviewing agent (me)

When the implementing agent hands back the PR, I will walk through the self-review checklist above and verify each item. Beyond that, I will:

1. Run the full test suite myself and confirm it passes
2. `rg` for every token in the "final verification" block and confirm zero unexpected hits
3. Read the migration SQL line by line against `db/init.sql` to confirm no missing constraint/index renames
4. Read the new `listInboxSince` implementation against the old inbox query section to confirm all four behaviors (removed-message filter, sender joins, shared clubs, mentions) are preserved
5. Read the new `activity.list`, `notifications.list`, `notifications.acknowledge`, `messages.acknowledge` handlers end-to-end
6. Read the new `/stream` handler and confirm the frame emission rules match the plan exactly
7. Read the `sharedContext.notifications` population path and confirm the per-request cache works as specified (one `listNotifications` call per request, fail-open on errors, retries see current state)
8. Read the `SKILL.md` and `docs/design-decisions.md` rewrites against the prescriptive prose in this plan
9. Spot-check the renamed constraint and index names in the live migrated database via `\d+ member_notifications`
10. Verify the schema snapshot diff is the expected set of deletions and additions (no surprise changes to unrelated action shapes)

If any item fails, I will push back with a specific citation and expect the implementing agent to fix it before re-submission. The plan is the contract; the checklist is how we enforce it.
