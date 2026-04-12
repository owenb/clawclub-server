# Plan: System Notifications

## Context for the reviewing agent

This plan is still pre-implementation. We are trying to lock the model before code starts.

- The immediate user problem is cross-club admin pending admissions.
- The broader product goal is a reusable system-notification model for admissions, billing, email delivery, moderation, and similar operational notices.
- The codebase is moving under unrelated feature work while this plan is being written. Treat path references as approximate and re-check the current checkout before editing.
- Do not assume the current SSE transport is permanent. Keep the design compatible with future transport changes.
- Prefer a staged rollout. Do not build every possible notification backend upfront.

## Recommendation in one sentence

Treat notifications as a queue distinct from the cursor-based update tape; ship derived admissions notifications first, with no ack, through `updates.list`, and defer materialized notification storage until the first concrete non-derivable notification actually needs it.

## Problem

Today a club admin who spans multiple clubs has to fan out across `clubadmin.admissions.list` for each club to answer "any applications to approve?".

That happens because the admission write path only produces a club-scoped activity event:

- `admission.submitted` is appended to `club_activity`
- admins can see that event in `/updates`
- but the event is only history, not a durable per-admin pending-work item

So the server can answer:

- "what happened recently in this club?"

but it cannot directly answer:

- "what does this admin still need to deal with right now?"

We need a system-notification surface that can eventually carry:

- pending admin work: "a new application needs review"
- unresolved account state: "your subscription expires in 3 days"
- one-off historical events: "we sent an email to x"

and surface all of that through the existing `/updates` entrypoint.

## Current System

As of this plan, `/updates` is a merged event tape made from three sources:

- `club_activity`
- `signal_deliveries`
- `dm_inbox_entries`

All three are fundamentally cursor-forward:

- give me what is newer than `after`
- advance the cursor
- do not re-show older items unless the source itself keeps them unread and the query explicitly scans below the cursor

That is correct for:

- club activity
- recommendation signals
- DM nudges

It is not correct for pending work.

Example:

1. Admin polls `/updates`
2. sees a pending admission notification
3. does nothing
4. polls again five minutes later

If that notification is modeled like a normal signal, it disappears after first sight even though the admission is still pending.

That is the load-bearing constraint. The real design problem is not just storage. It is read semantics.

## Hard Design Calls

These are the decisions this plan recommends. The implementer should not casually reopen them.

1. Notifications are not just a new signal topic. They are a distinct semantic source.
2. Admissions notifications should be derived from live admission state, not materialized into per-recipient rows.
3. Derived notifications should not support acknowledgement in phase 1.
4. `clubadmin.admissions.get` should land first as a standalone change.
5. Materialized notification storage should be deferred until there is a real non-derivable use case.
6. Notification payloads should stay refs-first, not denormalized display blobs.
7. We should not build a separate cross-club "check all admissions" action just to paper over the missing notification model.

## Why the first pass was wrong

The original instinct was to reuse `signal_deliveries` directly for everything.

That would have been the smallest diff, but it mixes two different invariants:

- `signal_deliveries` is currently recommendation-shaped
- pending operational notifications are queue-shaped

Problems with direct reuse:

- the current signal read path is cursor-forward, so pending work does not naturally persist across polls
- the current signal schema is recommendation-oriented: `match_id`, `acknowledged_state`, `suppression_reason`, entity-based read filters
- the existing signal SQL in `src/postgres.ts` already has topic-specific branches; pushing operational notification logic into it turns it into a god query

The repo docs currently describe `signal_deliveries` as more general than synchronicity. This plan intentionally narrows phase-1 scope instead of taking that statement literally.

## Notification Taxonomy

We need to distinguish two kinds of things that have both been loosely called "notifications".

### Event-tape updates

These are replayable events or unread nudges:

- `activity`
- `signal`
- `inbox`

Semantics:

- cursor-forward
- history-like
- good fit for replay and Last-Event-ID

### Queue-like notifications

These represent current pending or unresolved information for a member:

- `notification.admission.submitted`
- `notification.billing.past_due`
- `notification.subscription.expires_soon`

Semantics:

- derived from current state or explicitly stored as active rows
- still visible even if the event cursor has moved on
- disappear when resolved or invalidated

## Recommended Model

Introduce a new `notification` source in the read model.

That source should eventually support two production backends:

### 1. Derived notifications

Computed from current durable state at read time.

Use for:

- pending admissions
- unresolved billing states
- expiry warnings derived from existing timestamps

Benefits:

- no write-time fanout
- no dedupe key
- no backfill when roles change
- no cleanup of stale materialized rows
- no invalidation logic beyond "the query no longer matches"

Cost:

- every poll pays the read cost

That cost is acceptable for the current problem because clubadmin scope is small and pending admissions are low-cardinality. It should still be called out explicitly so future derived notification types are added deliberately, not casually.

### 2. Materialized notifications

Stored rows for events that are not derivable later.

Use for:

- `notification.email.sent`
- `notification.billing.charge_failed`
- `notification.billing.invoice_ready`
- one-off moderation or operational notices

These are not needed to solve the admission problem, so they should not block phase 1.

## Admissions Should Be Derived

For admissions specifically, compute notifications from current live state.

Read model:

- actor is clubadmin in one or more clubs
- query current admissions in those admin clubs
- keep only `status = 'submitted'`
- project each result into a notification item

Why this is the right choice for admissions:

- no write-time fanout
- no backfill on promote-to-admin
- no dedupe-key coordination between normal write path and backfill path
- no materialized rows that become stale when another admin accepts or declines the admission
- newly promoted admins automatically see current pending admissions on the next read

The admission itself is already the durable source of truth. Re-materializing it as N rows, one per admin, adds bookkeeping without adding information.

## Phase-1 Notification Semantics

Phase 1 is admissions-only, derived-only, no ack.

### Source

Extend `PendingUpdate.source` with:

- `notification`

Meaning in phase 1:

- `activity`, `signal`, `inbox` remain event-tape sources
- `notification` means "current system notification derived from live state"

### Visibility

On every `updates.list` call, notification items are computed irrespective of the event cursor.

That means:

- event sources answer "what changed since `after`?"
- notification source answers "what is still pending right now?"

### Acknowledgement

Do not support ack for derived notifications in phase 1.

Reason:

- if the admission is still `submitted`, the notification should still exist
- if the admission is no longer `submitted`, the notification should disappear automatically

Trying to add ack or snooze for derived notifications immediately creates hidden state that has to be invalidated against the live source of truth. That is a different feature and should not be smuggled into phase 1.

Recommendation:

- `updates.acknowledge` should explicitly reject `notification:` IDs in phase 1 with a clear client-facing error, not silently treat them as missing inbox updates

## Notification Shape

Phase 1 should reuse the existing `PendingUpdate` envelope for compatibility, but this is a pragmatic compromise rather than a perfect type fit.

Recommended projected values for derived admission notifications:

- `updateId = notification:admission-submitted:<admissionId>:v<versionNo>`
- `source = 'notification'`
- `recipientMemberId = actor member id`
- `clubId = admission club id`
- `entityId = null`
- `entityVersionId = null`
- `dmMessageId = null`
- `topic = 'notification.admission.submitted'`
- `payload = { admissionId, clubId }`
- `createdAt = submitted-version created_at`
- `createdByMemberId = null`

### On `streamSeq`

The current `PendingUpdate` shape requires `streamSeq`, but derived notifications are not on the cursor tape.

Phase-1 recommendation:

- populate `streamSeq` with a stable ordering number derived from `createdAt`
- document clearly that `streamSeq` is not part of notification cursor semantics

This is slightly ugly, but it avoids a large response-shape break in phase 1.

Longer term, if notification volume grows, the clean answer is to split `updates.list` into separate `events` and `notifications` sections instead of forcing every source through one item shape.

### Why not split the API shape now

We considered immediately changing `updates.list` to something like:

- `events: { items, nextAfter, polledAt }`
- `notifications: { items, polledAt }`

That is architecturally cleaner.

We are not recommending it in phase 1 because:

- it breaks every existing polling client and many tests
- the immediate admissions-only notification set should be tiny
- the user problem can be solved without a response-shape migration

So phase 1 deliberately accepts a slightly awkward shared item shape in order to keep the implementation small. If notification count or complexity grows, the response split becomes the next clean step.

## Polling Semantics

### `after`

`after` applies only to event-tape sources:

- `activity`
- `signal`
- `inbox`

It does not filter notifications.

### `nextAfter`

`nextAfter` continues to be the event cursor only.

Notifications do not participate in cursor advancement.

### `limit`

Phase-1 recommendation:

- `limit` continues to apply only to event-tape sources
- active notifications are returned in addition to the event batch

Why this is acceptable in phase 1:

- admissions-only notifications should be few
- the user problem is "tell me if there is pending admin work", so hiding queue items behind the event limit would defeat the goal

This should be documented explicitly. If notification count grows later, revisit the response shape rather than bolting more pagination hacks onto the flat array.

## SSE / Stream Semantics

The current stream loop is designed for cursor-forward event items.

Do not force sticky notifications into that loop in phase 1.

If the stream tried to emit current notifications as ordinary `update` items, it would immediately hit two problems:

- replay forever while the notification remains active
- no clean way to tell the client that a previously-visible derived notification disappeared

### Phase-1 recommendation

Keep stream delivery asymmetric on purpose:

- continue streaming event-tape items as today
- add an additive invalidation-style SSE event for notifications, for example `notifications_dirty`
- when the client sees `notifications_dirty`, it should call `updates.list` and reconcile notifications there

This keeps polling authoritative for notification state while preserving realtime wakeups.

### Why this is better than streaming notification items directly

- no per-connection notification replay cache
- no explicit removal event required
- no conflict with Last-Event-ID semantics
- easier to change later if SSE is replaced with another transport

If we later decide notifications must be fully streamed as payloads, that should come with an explicit notification snapshot / removal protocol, not as an accidental extension of the current tape loop.

## NOTIFY Plumbing For Derived Notifications

Derived notifications have no insert row, so they do not naturally wake the stream.

We still need wakeup plumbing.

### Recommendation

Add a trigger on `admission_versions` inserts that emits on the existing unified `updates` channel with the relevant `clubId`.

Pragmatic rule:

- notify on every admission version insert
- let the read path decide whether the visible notification set changed

Why this is better than trying to encode transition logic in the trigger:

- simpler and easier to reason about
- low expected write volume
- handles both entering and leaving `submitted`

Tradeoff:

- some spurious wakeups for members in the club who are not clubadmins

That is acceptable. The read path remains authoritative.

## Dependency On Stream Scope Refresh

This plan does not itself solve stale scope on long-lived streams.

If a member becomes a clubadmin while already connected to `/updates/stream`, then:

- `updates.list` is fine on the next poll because it authenticates per request
- the stream may still need the separate scope-refresh fix or a reconnect before club-scoped wakeups behave correctly

That is a separate transport issue already covered by [updates-stream-scope-refresh.md](/Users/owen/Work/ClawClub/clawclub-server/plans/updates-stream-scope-refresh.md).

Do not expand this notification plan to absorb that transport bug.

## `clubadmin.admissions.get`

This should land first as a standalone change.

Recommended contract:

- action: `clubadmin.admissions.get`
- auth: `clubadmin`
- input: `{ clubId, admissionId }`
- output: `{ admission: AdmissionSummary }`

Why it matters even without notifications:

- direct fetch by ID is obviously useful on its own
- notification payloads can stay refs-first
- agents should not have to call list-and-filter just to inspect one admission

This is the cleanest first PR because it has no dependency on the notification model.

## Billing Guidance

The admission design should pressure-test cleanly against billing because billing is the most likely next notification domain.

### Derived billing notifications

These are sticky unresolved states:

- `notification.billing.past_due`
- `notification.subscription.expires_soon`
- clubadmin-facing unresolved operator-fee or payment-state warnings

These should follow the same pattern as admissions:

- derived from live state
- no ack in the first version
- disappear when resolved

### Materialized billing notifications

These are historical or one-off events:

- `notification.billing.charge_failed`
- `notification.billing.invoice_ready`
- `notification.billing.refund_processed`

These require stored rows because the event itself matters even after the underlying state changes.

Important note:

- "your account is still past due" and "we attempted a charge and it failed" are different notifications
- do not try to collapse a sticky state notification and a one-off event notification into one abstraction

## Future Materialized Notification Backend

Do not build this in phase 1, but the plan should make the expected shape explicit so the next agent does not reinvent it.

### Table

When the first real event-backed notification arrives, add a dedicated per-recipient table such as:

- `member_notifications`

Suggested columns:

- `id`
- `notification_key`
- `recipient_member_id`
- `club_id` nullable
- `topic`
- `payload`
- `dedupe_key` nullable
- `created_at`
- `acknowledged_state` nullable
- `acknowledged_at` nullable
- `suppression_reason` nullable
- optional `invalidated_at` or `expires_at`

### Why no separate receipts table

Because `member_notifications` is already per recipient.

The ack state should live on the row itself unless a future use case proves otherwise.

Do not build a generic `member_notification_receipts` table before there is a concrete problem that requires one.

### Global notifications

Materialized notifications must allow:

- `club_id = null`

because some notifications are account-scoped rather than club-scoped.

## Design Pressure: docs/design-decisions.md

If this plan is accepted, `docs/design-decisions.md` needs to be updated later.

Today it says:

- the canonical update model has three sources
- `signal_deliveries` is the general-purpose targeted system-notification primitive

This plan intentionally revises that direction:

- keep `signal_deliveries` recommendation-focused in phase 1
- add `notification` as a distinct read-model source
- add materialized notification storage later only when needed

Do not update `docs/design-decisions.md` yet unless the code follows this plan. But do not forget that the current prose will be misleading once implementation starts.

## Concrete Implementation Sequence

### Phase 0: standalone admissions get

1. Add `clubadmin.admissions.get`
2. Add tests for direct admission lookup by ID

### Phase 1: derived admissions notifications

1. Extend contracts / schemas to allow `source = 'notification'`
2. Add a repository helper for derived notifications rather than stuffing the logic directly into the existing signal SQL
3. Query current submitted admissions in admin clubs and project them into notification items
4. Merge notification items into `updates.list` irrespective of cursor
5. Keep `nextAfter` and `limit` event-only
6. Make `updates.acknowledge` reject `notification:` IDs explicitly
7. Add `admission_versions` NOTIFY trigger
8. Add additive stream invalidation event such as `notifications_dirty`

### Phase 2: first materialized notification

Only start this phase when there is a real event-backed use case such as:

- email delivery
- invoice ready
- charge failed

Then:

1. Add `member_notifications`
2. Extend `updates.list` composition to include active materialized notifications
3. Extend `updates.acknowledge` for materialized `notification:` IDs only
4. Add cleanup / retention policy for acknowledged or invalidated rows

## Files likely affected

Approximate paths only. Re-check the current checkout before editing.

- `src/contract.ts`
- `src/schemas/responses.ts`
- `src/schemas/transport.ts`
- `src/schemas/updates.ts`
- `src/schemas/clubadmin.ts`
- `src/postgres.ts`
- `src/server.ts`
- `src/clubs/admissions.ts` or shared admissions read helpers
- `db/init.sql`
- `src/member-updates-notifier.ts` only if the NOTIFY payload shape changes
- integration tests under `test/integration/non-llm/`

## Tests to add in phase 1

- `clubadmin.admissions.get` returns one admission by ID inside scope
- regular member cannot call `clubadmin.admissions.get`
- cross-club admin sees derived admission notifications across their admin clubs
- derived notifications reappear across repeated polls while the admission remains `submitted`
- derived notifications disappear automatically once admission transitions away from `submitted`
- `updates.acknowledge` rejects `notification:` IDs
- `notifications_dirty` stream event fires when an admission enters or leaves `submitted`

## What not to do

### Do not add a bespoke cross-club admissions action

That would solve one prompt and leave the general notification model unsolved.

### Do not materialize admission notifications per admin

That buys bookkeeping and invalidation work we do not need.

### Do not bolt notification branches into the existing signal SQL until it becomes unreadable

Split the read composition into helpers early instead.

### Do not add ack or snooze for derived notifications in phase 1

That is a different feature with different semantics.

### Do not build the materialized backend before there is a real event-backed notification

The admissions problem can be solved cleanly without it.
