# Updates Stream Scope Refresh

## Problem

`/updates/stream` authenticates once when the SSE connection opens, snapshots the actor's `clubIds`, and reuses that scope for the life of the connection.

Two bad behaviors:

- member loses access to a club while connected — stream keeps delivering that club's updates until reconnect
- member gains access to a club while connected — stream won't deliver that club's updates until reconnect

Affected code:

- `src/server.ts` (`/updates/stream` loop, lines ~446–476)
- `src/member-updates-notifier.ts` (waiter wakeup matching)

## Design Evolution

### The big plan we considered and rejected

We initially designed a full protocol rewrite:

- make `updates.list` the only authoritative data read, with a new `events`/`notifications` split response shape
- convert `/updates/stream` from a data stream to a pure invalidation channel (`dirty`, `scope_changed`, `keepalive`)
- introduce an explicit `scopeToken` (base64url-encoded visibility scope) so clients can detect scope changes and the server can invalidate stale cursors
- break the entire `/updates` API — polling and streaming — in one coordinated change

That design is architecturally clean and sets up well for the notification system planned in `docs/system-notifications-design.md`. The full plan is preserved in git history for reference.

We rejected it for now because:

1. **It's massive.** It breaks every polling client, every streaming client, every integration test that touches updates, and the schema/SKILL.md contract. The original bug is "scope goes stale on a long-lived stream."

2. **We may move to Centrifugo.** If we adopt Centrifugo for realtime delivery, our custom SSE loop goes away entirely and the transport-layer concerns (scope refresh, heartbeat, replay) become Centrifugo's problem. Investing heavily in a protocol rewrite for a transport we might replace doesn't make sense.

3. **The minimal fix is small and correct.** Refreshing scope in the stream loop fixes both symptoms with no API break, no protocol change, and no client-side work. The bounded backfill behavior on scope expansion (a few recent items from a newly-joined club appearing) is arguably correct and is the same as what a reconnecting client would see.

The `scopeToken` idea and the `events`/`notifications` response split remain good ideas for later — they can be added as non-breaking changes to `updates.list` when the notification backend work begins, independent of the transport layer.

## Fix

Refresh the stream's auth and scope periodically so it reflects current reality.

### 1. Add a non-mutating token validation path

The current `authenticateBearerToken()` in `src/identity/auth.ts` updates `last_used_at` on every call. That's correct for normal request auth but wrong for a long-lived stream — it would turn every connected stream into a steady write.

Add a read-only helper alongside it:

- SELECT from `member_bearer_tokens` — check token is valid, not revoked, not expired
- call the existing `readActor(pool, memberId)` to get current memberships
- return the same `AuthResult` shape

Route it through the Repository interface, not as a direct pool call. `server.ts` accesses everything through the Repository — bypassing it to grab the pool directly would break the abstraction and fail when tests inject a custom repository (where `pool` is `null`).

Wiring:

- `src/identity/auth.ts` — add the `validateBearerTokenPassive(pool, bearerToken)` function
- `src/identity/index.ts` — expose it on `IdentityRepository`, wire it to the pool
- `src/contract.ts` — add `validateBearerTokenPassive?:` to the `Repository` type (one line, optional method)
- `src/postgres.ts` — wire it through (one line)

The method is optional on the Repository so that test mocks that don't implement it simply disable scope refresh — which is fine for short-lived test streams.

### 2. Refresh scope in the stream loop

In `src/server.ts`, inside the `while (!abortController.signal.aborted)` loop:

- track the last refresh time (start with connection time)
- every 60 seconds, call `repository.validateBearerTokenPassive(bearerToken)`
- if null (token invalid or revoked): end the stream cleanly
- if the actor's `clubIds` changed: swap in the fresh set
- use the current `clubIds` for `listMemberUpdates(...)` and `waitForUpdate(...)`

The 60-second cadence means scope changes take effect within a minute, which is fast enough. The stream already calls `readActor` inside `listMemberUpdates` on every iteration (`postgres.ts:1038`), so the auth refresh adds roughly one extra query per stream per minute — negligible.

Note: the periodic refresh only needs to update the stream-side `clubIds` (membership additions and removals). Role and audience visibility changes within an already-visible club are already handled at read time — `listMemberUpdates` calls `readActor` on every iteration and derives fresh `adminClubIds`/`ownerClubIds` from the result (`postgres.ts:1039–1040`).

The 60-second cadence should be configurable via the server options (e.g. `streamScopeRefreshMs`) so integration tests can use a shorter interval without waiting a full minute.

### 3. Scope expansion behavior

The cursor is compound: `{ a: activitySeq, s: signalSeq, t: inboxTimestamp }`. All three components are global, not per-club.

When a member gains access to a new club:

- **Activity:** `club_activity.seq` is global. Recent activity from the new club with seq above the current cursor appears. Older activity below the cursor does not. In practice this means a handful of recent items, not a full backlog dump.
- **Signals:** `signal_deliveries.seq` is global and also filtered by `recipient_member_id`. Unlikely to have pending signals in a club just joined.
- **Inbox:** Timestamp-based, per-member. Unaffected by club scope.

This bounded backfill is the same behavior a client would see if it disconnected and reconnected after joining the club. It's acceptable.

### 4. Scope removal behavior

When a member loses access to a club, the fresh `clubIds` simply exclude it. `listMemberUpdates` filters by `clubIds`, so activity and signals from the removed club stop appearing immediately on the next read cycle.

### 5. Stream count cleanup

The stream tracks `activeStreams` per member (server.ts:390–405). When the passive auth refresh terminates the stream via `response.end()`, the `request.on('close', decrementStreams)` handler fires and cleans up. Verify this in the integration test.

### 6. In-flight waiter window

If the stream is already inside `waitForUpdate(...)` when scope changes, the current waiter has stale `clubIds`. This means:

- a removed club might cause one spurious wakeup
- a newly-added club might not wake the stream until the 15-second heartbeat timeout

This is acceptable. The wakeup leads to a `listMemberUpdates` call with fresh scope, so no stale data is delivered. Do not try to mutate in-flight waiters.

## Files Changed

- `src/identity/auth.ts` — add `validateBearerTokenPassive()` (~15 lines)
- `src/identity/index.ts` — expose on `IdentityRepository`, wire to pool (2 lines)
- `src/contract.ts` — add optional method to `Repository` type (1 line)
- `src/postgres.ts` — wire through (1 line)
- `src/server.ts` — add cadence-based scope refresh in the stream loop, add `streamScopeRefreshMs` to server options, change `clubIds` from `const` to `let` (~20 lines)
- `test/integration/harness.ts` — thread `streamScopeRefreshMs` through to `createServer`
- `test/integration/non-llm/stream-scope-refresh.test.ts` — new test file

## Implementation Steps

1. **Passive auth helper** — add `validateBearerTokenPassive()` in `src/identity/auth.ts`, wire through `identity/index.ts`, `contract.ts`, `postgres.ts`
2. **Stream loop refresh** — add cadence-based scope refresh in `src/server.ts`, configurable via `streamScopeRefreshMs`
3. **Integration tests:**
   - stream stops showing removed-club activity after membership removal
   - stream shows future activity from a newly-added club without reconnect
   - revoked or expired token causes the stream to close
   - `activeStreams` count decrements correctly on server-initiated stream close

## Non-goals

- changing the `updates.list` API shape
- adding `scopeToken` or cursor invalidation semantics
- splitting events and notifications
- changing polling behavior (polling re-authenticates on every request already)
- converting SSE to an invalidation-only channel

These are all good ideas for later, especially when the notification backend lands or if we stay on custom SSE long-term. But they're separate from fixing the scope-staleness bug.
