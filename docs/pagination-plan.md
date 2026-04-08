# Pagination Plan

Keyset cursor pagination for list actions. `hasMore` on every paginated response.

Revised 2026-04-08 against the current hybrid event schema and codebase.

## Scope

Covers all list and search actions in the member, clubadmin, and superadmin API surfaces. Does **not** cover `updates.list` or `updates.acknowledge` — those use the compound update cursor and are a separate concern.

## Design rules

1. **Keyset cursor using `(sort_value, id)`.** Matches the proven pattern in `superadmin.members.list`. Cursor is opaque base64url-encoded JSON `[sortValue, id]`.
2. **`hasMore` boolean on every paginated response.** Fetch `limit + 1` rows, return at most `limit`, set `hasMore = true` if the extra row existed. One extra row, zero extra queries.
3. **`nextCursor` returned on every paginated response.** `null` when `hasMore` is `false`. Agents pass it back as `cursor` to fetch the next page.
4. **No `offset` parameter.** Offset is O(n) and breaks under concurrent writes.
5. **Cursor is optional.** Omitting it returns the first page. This is backward compatible.
6. **Search/ranked actions get `hasMore` only, no cursor.** Relevance-ranked and vector-distance-ranked results are not keyset-pageable. Still return `hasMore` so agents know results were truncated.

## Response shape

Every paginated response gains two fields at the same level as the existing `results` array:

```jsonc
{
  "results": [...],
  "hasMore": true,
  "nextCursor": "eyJj..."  // null when hasMore is false
}
```

For search actions (hasMore only, no cursor):

```jsonc
{
  "results": [...],
  "hasMore": false,
  "nextCursor": null  // always null — not cursor-pageable
}
```

## Action-by-action decisions

### Notation

- **Sort**: the SQL `ORDER BY` clause today and whether it changes.
- **Cursor key**: the `(sort_value, id)` pair for keyset navigation.
- **Mode**: `cursor` (full keyset pagination) or `hasMore-only` (limit + hasMore, no cursor).
- **Contract change**: whether the ordering or semantics visible to agents change.

---

### 1. `content.list`

| | |
|---|---|
| **File** | `src/clubs/entities.ts:304` |
| **Current sort** | `CASE relevance_score DESC, effective_at DESC, entity_id DESC` when `query` is set; `effective_at DESC, entity_id DESC` when no query |
| **Mode** | Cursor (no-query path); hasMore-only (query path) |
| **Cursor key** | `(effective_at, entity_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | None. Sort order is unchanged. |

When `query` is provided, the sort is relevance-first and not cursor-pageable. The `cursor` input is ignored and `nextCursor` is always `null`. `hasMore` still works. Document: "Cursor pagination applies to chronological listing. When `query` is provided, results are ranked by relevance and cursor is ignored."

---

### 2. `content.searchBySemanticSimilarity`

| | |
|---|---|
| **File** | `src/clubs/index.ts:260` (via `findEntitiesViaEmbedding`) |
| **Current sort** | `min(embedding <=> query_vector) ASC` |
| **Mode** | hasMore-only |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Vector distance is not cursor-pageable. Add `hasMore` via `limit + 1` fetch.

---

### 3. `events.list`

| | |
|---|---|
| **File** | `src/clubs/events.ts:243` |
| **Current sort** | `effective_at DESC, entity_id DESC` (first-stage ID query); same for second-stage full read |
| **Mode** | Cursor (no-query path); hasMore-only (query path) |
| **Cursor key** | `(effective_at, entity_id)` — same as `content.list` |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Two-stage query: apply cursor + `limit + 1` to the first (ID) query only. Second query is a lookup by IDs.

---

### 4. `members.list`

| | |
|---|---|
| **File** | `src/identity/memberships.ts:192` |
| **Current sort** | `min(club_name) ASC, display_name ASC, member_id ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(display_name, member_id)` |
| **Page size** | default 50, max 50 |
| **Contract change** | **None. Keep alphabetical ordering.** |

The previous plan proposed changing to `joined_at DESC`. This is rejected — `members.list` is a member directory, and alphabetical ordering is the natural expectation for directory browsing. Most-recent-first would be disorienting when looking for someone by name. The current sort `min(club_name) ASC, display_name ASC, member_id ASC` is already pageable with a `(display_name, member_id)` cursor key.

The `min(club_name)` leading sort key is an artifact of the query supporting multiple clubs in one call. In practice, `members.list` is almost always single-club scoped, so `display_name ASC, member_id ASC` is the effective sort. The cursor operates on `(display_name, member_id)`.

Note: ascending keyset WHERE clause is `(display_name > $cursor_name OR (display_name = $cursor_name AND member_id > $cursor_id))` — the reverse of descending actions.

---

### 5. `members.searchByFullText`

| | |
|---|---|
| **File** | `src/identity/profiles.ts:198` |
| **Current sort** | `ts_rank(search_vector, query) DESC` |
| **Mode** | hasMore-only |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

FTS rank is not cursor-pageable. Add `hasMore` via `limit + 1` fetch.

---

### 6. `members.searchBySemanticSimilarity`

| | |
|---|---|
| **File** | `src/identity/profiles.ts:237` |
| **Current sort** | `min(embedding <=> query_vector) ASC` |
| **Mode** | hasMore-only |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Same as `content.searchBySemanticSimilarity`. Vector distance is not cursor-pageable.

---

### 7. `vouches.list`

| | |
|---|---|
| **File** | `src/clubs/index.ts:64` |
| **Current sort** | `created_at DESC` (no tiebreaker today) |
| **Mode** | Cursor |
| **Cursor key** | `(created_at, edge_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | None. Add `edge_id DESC` as tiebreaker to existing sort. |

---

### 8. `messages.getInbox`

| | |
|---|---|
| **File** | `src/messages/index.ts:269` |
| **Current sort** | `has_unread DESC, COALESCE(latest_unread_at, latest_created_at) DESC, thread_id DESC` |
| **Mode** | Cursor |
| **Page size** | default 20, max 20 |
| **Contract change** | **Yes — ordering change. See below.** |

**Problem**: The current sort is `has_unread DESC, recency DESC, thread_id DESC`. The boolean `has_unread` leading column makes keyset pagination unreliable — a thread's unread status can change between page fetches, causing items to shift between the "unread" and "read" partitions and get skipped or duplicated.

**Decision**: Change to `COALESCE(latest_unread_at, latest_created_at) DESC, thread_id DESC`. Drop the `has_unread` leading sort column. This is a **product-visible ordering change**: the inbox will sort by recency instead of unread-first.

**Justification**: Agents already receive `unread.hasUnread` and `unread.unreadMessageCount` on every inbox entry, so they can prioritize unread threads client-side. The unread-first server sort was a convenience that creates a real pagination problem. Moving to pure recency makes the cursor stable and lets agents page through their full inbox without skipping threads.

**Risk**: An agent that depends on unread threads always appearing on page 1 would need to adapt. Since the API is pre-launch, this is acceptable. If preserving unread-first is critical post-launch, an `unreadOnly: true` filter (which already exists) can be used to get only unread threads, which is cursor-pageable on its own.

---

### 9. `messages.getThread`

| | |
|---|---|
| **File** | `src/messages/index.ts:349` |
| **Current sort** | `created_at DESC, message_id DESC` (then `.reverse()` for chronological display) |
| **Mode** | Cursor |
| **Cursor key** | `(created_at, message_id)` |
| **Page size** | default 50, max 50 |
| **Contract change** | None. |

The SQL fetches newest-first, then the code `.reverse()`s for display. The cursor navigates backward in time — passing the cursor from page 1 returns the next page of older messages. `hasMore: true` means there are older messages.

---

### 10. `clubadmin.memberships.list`

| | |
|---|---|
| **File** | `src/identity/memberships.ts:132` |
| **Current sort** | `club_id ASC, state_created_at DESC, membership_id ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(state_created_at, membership_id)` |
| **Page size** | default 50, max 50 |
| **Contract change** | **Minor: tiebreaker direction change.** |

This action always requires an explicit `clubId`, so the `club_id ASC` leading sort is redundant. The effective sort becomes `state_created_at DESC, membership_id DESC`. The tiebreaker changes from `ASC` to `DESC` for consistency with the keyset pattern. This is invisible in practice — ties on `state_created_at` are rare, and the items that shift are indistinguishable to the caller.

---

### 11. `clubadmin.memberships.listForReview`

| | |
|---|---|
| **File** | `src/identity/memberships.ts:151` |
| **Current sort** | `club_id ASC, state_created_at DESC, membership_id ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(state_created_at, membership_id)` — same as `clubadmin.memberships.list` |
| **Page size** | default 20, max 20 |
| **Contract change** | Same tiebreaker direction change as above. |

---

### 12. `clubadmin.admissions.list`

| | |
|---|---|
| **File** | `src/postgres.ts:449` |
| **Current sort** | `version_created_at DESC, admission_id ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(version_created_at, admission_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | **Minor: tiebreaker direction change.** |

Change `admission_id ASC` to `DESC` for consistency. Same reasoning as clubadmin.memberships.

---

### 13-15. Superadmin list actions (already have cursors)

`superadmin.members.list`, `superadmin.content.list`, `superadmin.messages.listThreads` already use keyset `(createdAt, id)` cursors and return `nextCursor`.

**Remaining work:**
- Add `hasMore` to their output. Currently they return `nextCursor` but not `hasMore`, so agents have to test for `nextCursor !== null` as a proxy. Add the explicit boolean.
- Refactor `encodeSuperadminCursor`/`decodeSuperadminCursor` to use the shared cursor helpers.
- Fetch `limit + 1` so `hasMore` is precise (currently they return whatever the DB gives, so `nextCursor` can be non-null even on the exact last page if the result count equals the limit).

---

## Compatibility notes

### Backward compatible (additive only)

- `cursor` is a new optional input field. Omitting it returns page 1. Existing callers are unaffected.
- `hasMore` and `nextCursor` are new output fields. Additive — existing callers ignore fields they don't know.
- Page size defaults increase from 8 to 20 or 50. Existing callers that omit `limit` get more results, but they already handle variable-length arrays.

### **Not backward compatible**

- **`messages.getInbox` ordering change.** Current: unread-first, then recency. Proposed: pure recency. An agent that assumes unread threads are always on page 1 would see them interleaved with read threads. Since the API is pre-launch, this is acceptable.
- **Tiebreaker direction changes** on `clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, and `clubadmin.admissions.list`. These flip the tiebreaker from `ASC` to `DESC` for ties on the same timestamp. Effectively invisible — no agent depends on the relative order of items with identical timestamps.

### Not changed (explicitly preserved)

- **`members.list` stays alphabetical.** The previous plan proposed changing to `joined_at DESC`. This is rejected. Alphabetical is the natural directory order.
- **`content.list` and `events.list` stay `effective_at DESC`.** No change.
- **`messages.getThread` stays `created_at DESC` (reversed for display).** No change.

## Implementation order

Ordered by risk and dependency:

### Phase 1: Shared infrastructure
- Add `wireLimitOf()`, `parseLimitOf()`, `encodeCursorPair()`, `decodeCursorPair()` to `src/schemas/fields.ts`.
- These are pure utility functions with no runtime impact until used.

### Phase 2: Superadmin retrofit
- Refactor `superadmin.ts` to use shared cursor helpers.
- Add `hasMore` to superadmin list outputs.
- Add `limit + 1` fetch to the three superadmin list queries.
- This validates the shared infra on low-risk, low-traffic endpoints.

### Phase 3: `content.list` + `events.list`
- Full cursor pagination on the two highest-traffic list actions.
- Same cursor key, same sort — validates the end-to-end pattern.
- Tests: seed > page size items, paginate, verify no duplicates.

### Phase 4: `vouches.list`
- Small action, simple sort. Good warm-up before the harder ones.

### Phase 5: `messages.getInbox` + `messages.getThread`
- Two actions in the same file.
- `getInbox` requires the sort order change (unread-first → recency). This is the riskiest change — do it after the pattern is validated on simpler actions.
- `getThread` is straightforward.

### Phase 6: `clubadmin.memberships.list` + `clubadmin.memberships.listForReview` + `clubadmin.admissions.list`
- Three admin actions, same file/pattern. Tiebreaker direction changes.

### Phase 7: `members.list`
- Ascending keyset cursor (different from all the descending ones). Do it last to avoid confusion during implementation.

### Phase 8: Search actions (hasMore only)
- `content.searchBySemanticSimilarity`, `members.searchByFullText`, `members.searchBySemanticSimilarity`.
- Just add `hasMore` via `limit + 1`. No cursor logic.

### Phase 9: Schema snapshot + docs
- Regenerate `test/snapshots/api-schema.json`.
- Update `SKILL.md` pagination section.

## Test plan

### Cursor-paginated actions

For each action, the integration test should:

1. Seed enough records to exceed one page (e.g., 25 for page size 20).
2. Fetch page 1 — assert `hasMore: true`, `nextCursor` is non-null, `results.length === pageSize`.
3. Fetch page 2 with `cursor = nextCursor` — assert `hasMore: false`, `nextCursor: null`, `results.length === remainder`.
4. Collect all IDs across pages — assert no duplicates.
5. Assert ordering within each page (descending chronological, or ascending alphabetical for `members.list`).

### hasMore-only actions

1. Seed enough records to exceed the limit.
2. Fetch — assert `hasMore: true`, `nextCursor: null`, `results.length === limit`.
3. Fetch with higher limit — assert `hasMore: false`.

### `content.list` / `events.list` with query

1. Fetch with cursor + query — assert cursor is ignored, results are relevance-ranked, `nextCursor: null`.

### Edge cases

1. Empty result set — `hasMore: false`, `nextCursor: null`, `results: []`.
2. Exact page boundary — result count exactly equals page size. `hasMore: false` (not true).
3. Invalid cursor — `400 invalid_input`.

## Page size summary

| Action | Default | Max | Mode |
|--------|---------|-----|------|
| `content.list` | 20 | 20 | cursor (no query) / hasMore (query) |
| `content.searchBySemanticSimilarity` | 20 | 20 | hasMore-only |
| `events.list` | 20 | 20 | cursor (no query) / hasMore (query) |
| `members.list` | 50 | 50 | cursor (ascending) |
| `members.searchByFullText` | 20 | 20 | hasMore-only |
| `members.searchBySemanticSimilarity` | 20 | 20 | hasMore-only |
| `vouches.list` | 20 | 20 | cursor |
| `messages.getInbox` | 20 | 20 | cursor |
| `messages.getThread` | 50 | 50 | cursor |
| `clubadmin.memberships.list` | 50 | 50 | cursor |
| `clubadmin.memberships.listForReview` | 20 | 20 | cursor |
| `clubadmin.admissions.list` | 20 | 20 | cursor |
| `superadmin.members.list` | 50 | 50 | cursor (existing) |
| `superadmin.content.list` | 50 | 50 | cursor (existing) |
| `superadmin.messages.listThreads` | 50 | 50 | cursor (existing) |
