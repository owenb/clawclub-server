# Updates Stream Scope Refresh Plan

## Problem

`/updates/stream` authenticates once when the SSE connection opens, snapshots the actor's accessible `clubIds`, and keeps reusing that same scope for the life of the connection.

That creates two bad behaviors:

- if the member loses access to a club while the stream is open, the stream can keep delivering updates from that club until reconnect
- if the member gains access to a club while the stream is open, the stream will not start delivering updates from that club until reconnect

The current implementation is in:

- `src/server.ts` (`/updates/stream` loop)
- `src/member-updates-notifier.ts` (waiter wakeup matching)

## Design Goal

Choose the cleanest long-term `/updates` design, not the smallest diff.

That means:

- stop forcing SSE to be both a live transport and a replay transport
- stop pretending cursor-driven event history and current pending notifications have the same semantics
- make visibility scope an explicit part of the `/updates` protocol instead of an implicit side effect of connection timing

This plan intentionally prefers an API break over preserving current `/updates` compatibility.

It also supersedes the current SSE subsection in [docs/system-notifications-design.md](/Users/owen/Work/ClawClub/clawclub-server/docs/system-notifications-design.md): the end-state here is that polling is the authoritative data read, and SSE is an invalidation channel.

This must also stay compatible with the upcoming system-notification work in `docs/system-notifications-design.md`, where `/updates` will include recipient-scoped `notification.*` items such as:

- "you were added to a new group"
- "your subscription is about to expire"

## Proposed Product Rules

1. **Scope removal takes effect immediately.**

   If a member loses access to a club or loses a role that expands visibility, the next `/updates` resync must stop showing data from that scope.

2. **Scope expansion takes effect without reconnect.**

   If a member gains access to a club or gains a broader audience role, the client should learn that without reconnecting.

3. **A scope change invalidates the old event cursor.**

   The simplest clean rule is:

   - an event cursor is valid only within the visibility scope that created it
   - if the visibility scope changes, the old cursor is no longer valid
   - the server seeds a fresh cursor at the current latest point for the new scope

   This deliberately drops any attempt to preserve cursor continuity across scope changes. That is a feature, not a bug. It avoids fragile partial-backfill rules and makes the semantics explicit.

4. **System notifications are recipient-scoped, not purely club-scoped.**

   This matters for future `/updates` work:

   - recipient-targeted notifications must survive scope changes
   - they must be readable even when `clubId` is `null`
   - the “you were added to a new group” case should be carried by notifications, not by replaying old activity backlog

## Proposed Technical Approach

### 1. Make polling the source of truth

`updates.list` should become the only authoritative read for update data.

It should return two distinct collections:

- `events`
- `notifications`

and two pieces of state:

- `nextEventCursor`
- `scopeToken`

Recommended new shape:

```ts
updates.list({
  eventCursor?: string | null,
  scopeToken?: string | null,
  limit?: number,
}) => {
  events: PendingEventUpdate[],
  notifications: PendingNotificationUpdate[],
  nextEventCursor: string | null,
  scopeToken: string,
  scopeChanged: boolean,
  polledAt: string,
}
```

Even before notifications are implemented, returning `notifications: []` is better than keeping a merged shape whose semantics will have to be broken later anyway.

### 2. Make `/updates/stream` an invalidation channel, not a data stream

The current stream is complicated because it tries to do all of this at once:

- deliver actual update payloads
- replay history from `after`
- resume from `Last-Event-ID`
- enforce current visibility scope
- eventually handle sticky notifications

That is the wrong abstraction boundary.

End-state change:

- drop `after` from `/updates/stream`
- drop `Last-Event-ID` replay support for `/updates/stream`
- stop streaming actual update items
- stream only invalidation / control events

Recommended SSE events:

- `ready`
- `dirty`
- `scope_changed`
- `keepalive`
- `unauthorized` or immediate close on auth failure

Meaning:

- `ready`: stream accepted; includes current `scopeToken`
- `dirty`: something relevant changed; client should call `updates.list`
- `scope_changed`: visibility changed; client must discard old `eventCursor`, then call `updates.list`
- `keepalive`: heartbeat

This is much simpler and fits notifications naturally.

### 3. Introduce an explicit `scopeToken`

Today visibility scope is implicit in the authenticated actor.

Make it explicit.

The server should compute a `scopeToken` from the current visibility scope. It should include enough information to know whether the client is still reading under the same scope.

At minimum that means:

- visible member club IDs
- visible clubadmin club IDs
- visible owner club IDs
- any global roles that affect update visibility

It does **not** need to be a secret or authorization artifact. Authorization still comes from current server-side auth. The token is a protocol hint for cursor validity.

A simple encoded JSON blob is acceptable if that keeps the design obvious.

### 4. Invalidate the event cursor on scope change

This is the biggest design change, and it is intentional.

Do **not** try to preserve event-cursor continuity across scope changes.

The previous plan tried to selectively advance the activity cursor, but that becomes fragile once you account for:

- the compound cursor shape
- the global `club_activity.seq`
- role changes inside already-visible clubs
- the need to avoid replaying admin-only backlog while preserving member-visible backlog

The simplest clean rule is:

- if `scopeToken` from the client matches the current scope, continue from `eventCursor`
- if `scopeToken` is missing, malformed, or changed, ignore `eventCursor`
- reseed `nextEventCursor` at the current latest point
- set `scopeChanged: true`

This means:

- no stale leakage after scope reduction
- no weird backlog replay after scope expansion
- no per-club or per-audience cursor surgery
- one explicit rule clients can understand

This is the right long-term design if compatibility does not matter.

### 5. Add a passive auth refresh path for the stream

Do **not** call the existing `authenticateBearerToken()` on every stream heartbeat. That path updates `last_used_at`, which would turn a long-lived stream into a steady write workload.

Instead:

- factor token validation in `src/identity/auth.ts` into mutating and non-mutating paths
- keep the current mutating path for ordinary request auth
- add a passive validation path for stream liveness / scope refresh

The passive path should:

- validate that the token is still valid and not revoked
- re-read the actor via `readActor()`
- compute the current `scopeToken`

Implementation note:

- the essential requirement is **non-mutating token validation + `readActor()`**
- do not build a large abstraction unless it clearly helps

### 6. Refresh stream auth on a bounded cadence

The stream still needs to detect:

- token revocation / expiry
- membership changes
- role changes that alter visibility

But it does not need to fetch actual update payloads anymore.

So:

- keep the initial auth at connection start
- maintain a bounded refresh cadence
- on each cadence tick, re-run passive auth
- if the token is invalid, close the stream
- if the `scopeToken` changed, emit `scope_changed`
- otherwise keep waiting / heartbeating

This is enough. The client can do the actual data resync through `updates.list`.

### 7. Keep recipient-targeted wakeups first-class

`src/member-updates-notifier.ts` already wakes waiters by:

- `recipientMemberId`
- or `clubId`

That is the right shape for future notifications.

Especially once `notification` items exist with:

- `recipientMemberId = <member>`
- `clubId = null`

Examples:

- "you were added to a new group"
- "your subscription expires in 3 days"

The notifier should remain a wakeup hint only. `updates.list` is the source of truth.

### 8. Accept the in-flight waiter window

One bounded edge case remains:

- a stream can already be inside `waitForUpdate(...)` with stale `clubIds`
- if scope changes during that wait, the current waiter will not update in place

That means there is a small window where:

- a removed club may still cause one wakeup
- a newly added club may not wake the stream until the next heartbeat timeout

This is acceptable because the stream is now an invalidation channel, not a payload stream.

Do **not** try to mutate existing waiters in place.

## Concrete Implementation Steps

1. **API reshape**
   - change `updates.list` input from `after` to `eventCursor`
   - add `scopeToken` to `updates.list` input and output
   - split `updates.list` output into `events` and `notifications`
   - rename `nextAfter` to `nextEventCursor`

2. **Response/type reshape**
   - in `src/contract.ts`, split the current `PendingUpdate` model into:
     - event updates
     - notification updates
   - in `src/schemas/responses.ts`, reflect the split response shape
   - keep `notifications: []` until notification work lands if needed, but establish the shape now

3. **Polling semantics**
   - in `src/schemas/updates.ts`, implement:
     - current-scope calculation
     - `scopeToken` generation
     - cursor invalidation on scope mismatch
   - if `scopeChanged`, ignore incoming `eventCursor`, reseed at latest, and return `scopeChanged: true`

4. **Stream semantics**
   - in `src/server.ts`, remove `/updates/stream` replay semantics:
     - no `after`
     - no `Last-Event-ID`
     - no update payload streaming
   - emit only control events:
     - `ready`
     - `dirty`
     - `scope_changed`
     - `keepalive`
   - include `scopeToken` in `ready` and `scope_changed`

5. **Passive auth for stream**
   - refactor `src/identity/auth.ts` so token validation can run in mutating and non-mutating modes
   - keep the helper local unless pushing it through the repository clearly simplifies wiring
   - refresh on a bounded cadence
   - verify stream-count cleanup still runs when the server terminates the stream

6. **Notifier integration**
   - keep `src/member-updates-notifier.ts` as the wakeup path
   - on wakeup, emit `dirty` rather than trying to stream actual items
   - rely on the next `updates.list` call for authoritative filtering

7. **Tests**
   - add integration coverage for:
     - `updates.list` invalidates `eventCursor` when `scopeToken` changes
     - scope reduction removes inaccessible events on next poll
     - scope expansion does not replay historical activity backlog
     - `/updates/stream` emits `scope_changed` when memberships / roles change
     - `/updates/stream` emits `dirty` on relevant notifier wakeups
     - revoked or expired token closes the stream
     - server-side stream termination still decrements `activeStreams`

## Why This Fits The Notification Plan

This plan aligns with the actual semantic split already identified in [docs/system-notifications-design.md](/Users/owen/Work/ClawClub/clawclub-server/docs/system-notifications-design.md):

- events are cursor-driven history
- notifications are current queue items

The main difference is transport shape:

- `updates.list` is the authoritative read
- `/updates/stream` is only the invalidation channel

That is simpler than forcing SSE to implement both replay and sticky notification semantics at the same time.

## Non-Goals For This Plan

- preserving the current `/updates` API shape
- preserving `after` / `nextAfter` naming
- preserving `/updates/stream` replay semantics
- implementing the full notification backend
- building notification receipts
- mutating in-flight notifier waiters

## Recommended Landing Order

1. `updates.list` API reshape (`events`, `notifications`, `scopeToken`, `eventCursor`)
2. cursor invalidation semantics on scope change
3. `/updates/stream` conversion to invalidation-only
4. passive auth refresh for stream liveness / scope detection
5. integration tests
6. notification backend follow-up on top of the new shape

## Hand-off Note

If another agent implements this plan, the two most important things are:

- **do not** preserve the current idea that `/updates/stream` must stream actual update payloads
- **do not** try to preserve cursor continuity across scope changes

The correct fix is:

- make polling the source of truth
- make SSE an invalidation channel
- make scope explicit with `scopeToken`
- invalidate old event cursors on scope change instead of trying to partially repair them

---

## Review Comments

_Claude Opus 4.6 — 2026-04-10_

### 1. Refresh frequency is way too aggressive

The plan says "before each read cycle, refresh auth using the passive path." That means every time the `while` loop iterates — which is every time there's a batch of updates *or* every 15-second heartbeat — you're running a multi-join query (`readActor` joins `members`, `current_member_global_roles`, `accessible_club_memberships`, `clubs`) plus a token validation query. For a member in 3 clubs that's modest, but at scale this is one full actor resolution per connected stream every 15 seconds. If you have 500 concurrent streams, that's ~2,000 queries/minute just for auth refresh on idle connections.

**Suggestion:** Refresh on a longer cadence — e.g. every 60s or every 5th heartbeat — not on every loop iteration. Scope removal taking effect within 60 seconds is more than fast enough. The plan even acknowledges the write-load problem with `last_used_at` but then proposes read-load that's almost as bad.

### 2. The "advance cursor for added clubs" trick is fragile

The plan proposes: when `addedClubIds` appears, query `max(club_activity.seq)` for those clubs and raise the activity cursor to skip their backlog.

But the cursor in this system is a compound cursor (the `after` parameter, parsed by `normalizeUpdatesAfter`), not a single integer. It covers multiple sources — activity, signals, inbox. You can't just bump one number. The plan doesn't address what the cursor format actually looks like or how you'd selectively advance only the activity component for specific clubs.

**Suggestion:** Before committing to this approach, spell out the actual cursor format and whether it supports per-club or per-source advancement. If the cursor is a single opaque seq, you might need a different mechanism entirely — like a per-stream "muted clubs until seq X" set.

### 3. The "passive auth" abstraction is over-engineered for what it does

The plan proposes a new `authenticateBearerTokenPassive()` method, threaded through the Repository contract and `postgres.ts`. But looking at `src/identity/auth.ts:105-136`, the mutating path is literally just one UPDATE that sets `last_used_at`. The "passive" version is:

1. SELECT instead of UPDATE on `member_bearer_tokens` (check not revoked, not expired)
2. Call the existing `readActor()`

That's two queries, not a new abstraction. You don't need a new Repository method — you need a `validateTokenWithoutTouch` helper in `auth.ts` that returns the `member_id`, and then you call the existing `readActor`. Adding it to the Repository contract implies it'll be used across implementations, but this is purely a streaming concern.

**Suggestion:** Keep it as a private helper in `auth.ts` or `server.ts`. Don't bloat the Repository contract for one caller.

### 4. Option A vs Option B is a false choice — Option A is the only real option

The plan presents "fix polling too" (Option B) as the cleaner end state, then weakly recommends it. But `updates.list` is a stateless request — the client sends a cursor and gets results. The server has no memory of what clubs the client could see when the cursor was created. To do Option B, you'd need to either:

- Encode the visible club set *into* the cursor (bloats it, and now it's stale the moment memberships change), or
- Track per-member cursor metadata server-side (new state, new cleanup)

Both are significant complexity for a marginal edge case (polling client happens to have a stale cursor right when they join a new club). The SSE stream has this problem because it holds state — polling doesn't, and clients naturally get fresh scope on next request since each request re-authenticates.

**Suggestion:** Drop Option B entirely. It's solving a problem that barely exists for polling. If anything, just document that `updates.list` re-authenticates on every call (it already does) and therefore scope is always fresh on each poll.

### 5. Missing: what happens to in-flight `waitForUpdate` when scope changes?

The current code registers `waitForUpdate` with the `clubIds` snapshot (`src/server.ts:466-469`). If scope changes between when we register the waiter and when a notification fires, we might miss wakeups for newly-added clubs or get woken for removed clubs. The plan says "register `waitForUpdate(...)` with fresh scope" — but that only takes effect on the *next* iteration. There's a window where you're waiting with stale scope.

This probably doesn't matter much in practice (the heartbeat timeout is 15s, so you'll catch up), but the plan should acknowledge this explicitly rather than implying the fix is airtight.

### 6. Missing: connection limit interaction

The stream loop currently tracks `activeStreams` per member (`src/server.ts:390-405`). If a passive auth refresh reveals the token is revoked, the plan says "terminate cleanly" — but does the `decrementStreams` cleanup run? It's currently wired to `request.on('close', decrementStreams)`. If you `response.end()` from inside the loop, does that fire `close` on the request? It should, but this is the kind of thing that causes leaked stream counts if it doesn't. Worth a note.

### 7. The hand-off note undersells the hard part

The hand-off warns "don't call mutating auth on every heartbeat." That's the easy part. The hard part is the cursor advancement for newly-visible clubs (point 2 above). That's where an implementer will actually get stuck. The hand-off should flag the cursor format as the primary complexity.

---

## Review Comments — Round 2

_Claude Opus 4.6 — 2026-04-10_

_After plan rewrite to SSE-as-invalidation-channel model._

The revision addresses comments 1–7 above. SSE as invalidation channel eliminates the cursor-surgery problem entirely, `scopeToken` with cursor invalidation replaces the fragile backfill logic, and the remaining edge cases are now acknowledged explicitly. This is a much stronger plan.

Remaining pushback:

### 8. `scopeToken` needs a concrete definition now, not later

Section 3 says the `scopeToken` should include visible club IDs, clubadmin club IDs, owner club IDs, and global roles — but then says "a simple encoded JSON blob is acceptable." That's too vague for the thing the entire cursor-invalidation mechanism depends on.

Specific questions that affect implementation:

- Is this a hash of the scope, or a serialized representation? A hash is opaque and cheap to compare but can't be inspected for debugging. A serialized blob is inspectable but leaks membership info to the client.
- Does the token need to be stable across requests with the same scope? (It should — otherwise `scopeChanged` fires spuriously on every poll.)
- What's the sort order for the club ID lists? Without a canonical ordering, the same scope produces different tokens.

**Suggestion:** Pin this down to something like: "sorted JSON of `{ clubs: string[], adminClubs: string[], globalRoles: string[] }`, then base64url-encoded. Compared by string equality." That's one sentence and it eliminates a category of implementation ambiguity.

### 9. The landing order front-loads the API break but back-loads the thing that makes it work

The recommended order is:

1. `updates.list` API reshape
2. cursor invalidation on scope change
3. `/updates/stream` conversion
4. passive auth refresh
5. tests

Step 1 is a breaking change to the polling API. Step 3 is a breaking change to SSE. But step 4 (passive auth refresh) is what makes the stream *detect* scope changes in the first place. Without step 4, step 3 is dead code — the stream has no way to know scope changed, so it never emits `scope_changed`.

**Suggestion:** Move passive auth refresh to step 2 (or at least before step 3). The order should be: auth plumbing, then polling reshape, then stream conversion, then tests. Ship auth + polling first if you want an incremental landing — that gives polling clients the `scopeToken` semantics before the SSE break lands.

### 10. What does a client do when it receives `scope_changed`?

The plan describes server behavior clearly but is light on the client protocol. When a client gets `scope_changed`:

- Must it call `updates.list` with no `eventCursor` (i.e. fresh start)?
- Or does it call `updates.list` with the old `eventCursor` and let the server reseed?
- Should `scope_changed` include the new `scopeToken` so the client can update its local state without a round-trip?

The answer to the third question is almost certainly yes (and section 4, step 4 says to include `scopeToken` in `scope_changed`), but the first two affect whether agent clients need to implement "discard local state" logic or can just keep polling normally.

**Suggestion:** Add a short "client protocol" subsection describing the expected client behavior for each SSE event type. This plan will be read by agent implementers — they need the contract from both sides.

### 11. `dirty` vs `scope_changed` — are they mutually exclusive?

If a membership change happens (scope changes) and it also triggers a club_activity insert (e.g. "X joined the club"), should the stream emit `scope_changed`, `dirty`, or both? If both, in what order?

If `scope_changed` implies "you need to resync everything," then `dirty` is redundant when emitted alongside it. But if an implementer doesn't know that, they might emit both and the client might do two `updates.list` calls.

**Suggestion:** State explicitly: "`scope_changed` subsumes `dirty`. If both conditions are true, emit only `scope_changed`."

### 12. The `notifications: []` placeholder is fine, but the type split needs care

Section 1 proposes splitting `updates.list` output into `events` and `notifications` now, with `notifications: []` until the notification backend lands. That's reasonable — but it means the `PendingUpdate` type in `contract.ts` needs to be split into two types immediately. Every consumer of `listMemberUpdates` will need to handle the new shape.

This is fine if the plan is to do a clean break. But if the intent is to land this incrementally alongside existing clients, it's worth noting that step 1 (API reshape) is already a breaking change to every agent client currently consuming `updates.list`. The plan says "this plan intentionally prefers an API break" — just making sure the blast radius is understood: it's not just SSE clients, it's every polling client too.
