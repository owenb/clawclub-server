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
6. **All list/search surfaces are fully cursor-pageable.** `content.list` with `query` uses a 3-part cursor `(relevance_score, effective_at, entity_id)` to keyset-paginate through relevance-ranked results. `events.list` with `query` uses ILIKE filtering (not relevance ranking) so the standard `(effective_at, entity_id)` cursor is valid with or without a query. All search actions project their sort key (`_distance`, `_rank`) for stable cursor pagination.

## Response shape

Every paginated response gains two fields at the same level as the existing `results` array:

```jsonc
{
  "results": [...],
  "hasMore": true,
  "nextCursor": "eyJj..."  // null when hasMore is false
}
```

For `content.list` with `query` (relevance-ranked):

```jsonc
{
  "results": [...],
  "hasMore": true,
  "nextCursor": "eyJj..."  // 3-part cursor: (relevance_score, effective_at, entity_id)
}
```

The cursor format changes based on context — 3-part when `query` is provided, 2-part for chronological listing — but is always opaque to agents.

## Action-by-action decisions

### Notation

- **Sort**: the SQL `ORDER BY` clause today and whether it changes.
- **Cursor key**: the `(sort_value, id)` pair for keyset navigation.
- **Mode**: `cursor` (full keyset pagination).
- **Contract change**: whether the ordering or semantics visible to agents change.

---

### 1. `content.list`

| | |
|---|---|
| **File** | `src/clubs/entities.ts:307` |
| **Current sort** | `relevance_score DESC, effective_at DESC, entity_id DESC` when `query` is set; `effective_at DESC, entity_id DESC` when no query |
| **Mode** | Cursor (both paths) |
| **Cursor key** | `(relevance_score, effective_at, entity_id)` when `query` is set (3-part); `(effective_at, entity_id)` when no query (2-part) |
| **Page size** | default 20, max 20 |
| **Contract change** | None. Sort order is unchanged. |

The relevance score is a deterministic CASE expression (integer 0-400) based on title/summary/body match quality. It is projected as `_relevance_score` and included in the cursor for query-mode pagination. Ties on score fall through to `(effective_at, entity_id)`, making the cursor fully deterministic. The cursor format is opaque — agents pass it back unchanged.

---

### 2. `content.searchBySemanticSimilarity`

| | |
|---|---|
| **File** | `src/clubs/index.ts:260` (via `findEntitiesViaEmbedding`) |
| **Current sort** | `min(embedding <=> query_vector) ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(distance, entity_id)` ascending |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Uses computed vector distance for keyset navigation.

---

### 3. `events.list`

| | |
|---|---|
| **File** | `src/clubs/events.ts:243` |
| **Current sort** | `effective_at DESC, entity_id DESC` (first-stage ID query); same for second-stage full read |
| **Mode** | Cursor (with or without query) |
| **Cursor key** | `(effective_at, entity_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Two-stage query: apply cursor + `limit + 1` to the first (ID) query only. Second query is a lookup by IDs. `query` uses ILIKE as a WHERE filter (not relevance ranking), so the cursor is valid with or without a query.

---

### 4. `members.list`

| | |
|---|---|
| **File** | `src/identity/memberships.ts:192` |
| **Sort** | `max(joined_at) DESC, member_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(joined_at, member_id)` |
| **Page size** | default 50, max 50 |
| **Contract change** | **Yes — ordering change. Was alphabetical, now most-recent-first.** |

**Decision**: Show most recently joined members first. When a member appears via multiple scoped memberships, `max(joined_at)` across the in-scope memberships determines their position. The cursor key is `(joined_at, member_id)` descending — standard keyset pattern using HAVING for the aggregate cursor filter.

**Justification**: Surfacing new members is more important than directory-style lookup. Agents and members primarily care about "who joined recently?" not alphabetical browsing. Name-based lookup is served by `members.searchByFullText`.

---

### 5. `members.searchByFullText`

| | |
|---|---|
| **File** | `src/identity/profiles.ts:198` |
| **Sort** | `ts_rank(search_vector, query) DESC, member_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(rank, member_id)` descending |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

FTS rank is projected as `_rank` for cursor encoding. Ties broken by `member_id DESC`.

---

### 6. `members.searchBySemanticSimilarity`

| | |
|---|---|
| **File** | `src/identity/profiles.ts:237` |
| **Sort** | `min(embedding <=> query_vector) ASC, member_id ASC` |
| **Mode** | Cursor |
| **Cursor key** | `(distance, member_id)` ascending |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

Vector distance projected as `_distance` for cursor encoding.

---

### 7. `vouches.list`

| | |
|---|---|
| **File** | `src/clubs/index.ts:64` |
| **Current sort** | `created_at DESC, edge_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(created_at, edge_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | None. |

---

### 8. `messages.getInbox`

| | |
|---|---|
| **File** | `src/messages/index.ts:272` |
| **Current sort** | `latest_created_at DESC, thread_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(latest_created_at, thread_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | **Yes — ordering change. See below.** |

**Problem**: The original sort was `has_unread DESC, recency DESC, thread_id DESC`. The boolean `has_unread` leading column made keyset pagination unreliable — a thread's unread status can change between page fetches, causing items to shift between the "unread" and "read" partitions and get skipped or duplicated.

**Decision**: Sort by pure message recency: `latest_created_at DESC, thread_id DESC`. No unread state influences the sort order. This is a **product-visible ordering change**: the inbox sorts by when the latest message was sent, not by unread status.

**Justification**: Agents already receive `unread.hasUnread` and `unread.unreadMessageCount` on every inbox entry, so they can prioritize unread threads client-side. The unread-first server sort was a convenience that creates a real pagination problem. Pure recency makes the cursor fully stable — acknowledging a message never changes a thread's position.

**Risk**: An agent that depends on unread threads always appearing on page 1 would need to adapt. Since the API is pre-launch, this is acceptable. The `unreadOnly: true` filter (which already exists) can be used to get only unread threads, which is cursor-pageable on its own.

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
| **Current sort** | `state_created_at DESC, membership_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(state_created_at, membership_id)` |
| **Page size** | default 50, max 50 |
| **Contract change** | **Minor: tiebreaker direction change.** |

This action always requires an explicit `clubId`, so the `club_id ASC` leading sort is redundant. The effective sort is `state_created_at DESC, membership_id DESC`. The tiebreaker changed from `ASC` to `DESC` for consistency with the keyset pattern. This is invisible in practice — ties on `state_created_at` are rare, and the items that shift are indistinguishable to the caller.

---

### 11. `clubadmin.memberships.listForReview`

| | |
|---|---|
| **File** | `src/identity/memberships.ts:151` |
| **Current sort** | `state_created_at DESC, membership_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(state_created_at, membership_id)` — same as `clubadmin.memberships.list` |
| **Page size** | default 20, max 20 |
| **Contract change** | Same tiebreaker direction change as above. |

---

### 12. `clubadmin.admissions.list`

| | |
|---|---|
| **File** | `src/postgres.ts:449` |
| **Current sort** | `version_created_at DESC, admission_id DESC` |
| **Mode** | Cursor |
| **Cursor key** | `(version_created_at, admission_id)` |
| **Page size** | default 20, max 20 |
| **Contract change** | **Minor: tiebreaker direction change.** |

Changed `admission_id ASC` to `DESC` for consistency. Same reasoning as clubadmin.memberships.

---

### 13-15. Superadmin list actions

`superadmin.members.list`, `superadmin.content.list`, `superadmin.messages.listThreads` use keyset `(createdAt, id)` cursors and return `hasMore`, `nextCursor`.

**Done:** `hasMore` added to all three outputs. Shared cursor helpers used. `limit + 1` fetch for precise `hasMore`.

---

## Compatibility notes

### Backward compatible (additive only)

- `cursor` is a new optional input field. Omitting it returns page 1. Existing callers are unaffected.
- `hasMore` and `nextCursor` are new output fields. Additive — existing callers ignore fields they don't know.
- Page size defaults increase from 8 to 20 or 50. Existing callers that omit `limit` get more results, but they already handle variable-length arrays.

### **Not backward compatible**

- **`members.list` ordering change.** Was alphabetical (`display_name ASC`). Now most-recent-first (`max(joined_at) DESC`). Surfacing new members is prioritized over directory-style lookup.
- **`messages.getInbox` ordering change.** Was unread-first, then recency. Now pure message recency (`latest_created_at DESC`). Agents already receive `unread.hasUnread` per entry for client-side prioritization.
- **Tiebreaker direction changes** on `clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, and `clubadmin.admissions.list`. These flip the tiebreaker from `ASC` to `DESC` for ties on the same timestamp. Effectively invisible.

### Preserved

- **`content.list` chronological (no-query) and `events.list` stay `effective_at DESC`.** `content.list` with `query` adds relevance as the leading sort key via a 3-part cursor.
- **`messages.getThread` stays `created_at DESC` (reversed for display).** No change.

## Implementation order

Ordered by risk and dependency:

### Phase 1: Shared infrastructure
- Add `wireLimitOf()`, `parseLimitOf()`, `encodeCursor()`, `decodeCursor()` to `src/schemas/fields.ts`.
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
- Changed to most-recent-first: `max(joined_at) DESC, member_id DESC` with HAVING-based cursor.

### Phase 8: Search actions (fully cursor-pageable)
- `content.searchBySemanticSimilarity`, `members.searchByFullText`, `members.searchBySemanticSimilarity`.
- All three use projected sort keys (`_distance` or `_rank`) as cursor components.
- `content.list` with `query` uses a 3-part cursor `(relevance_score, effective_at, entity_id)`.
- `events.list` with `query` uses ILIKE filtering (not ranking), so the standard 2-part cursor works.

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
5. Assert ordering within each page (descending by sort key).
6. For `content.list` with `query`: verify the 3-part cursor navigates through relevance-ranked results correctly.

### Edge cases

1. Empty result set — `hasMore: false`, `nextCursor: null`, `results: []`.
2. Exact page boundary — result count exactly equals page size. `hasMore: false` (not true).
3. Invalid cursor — `400 invalid_input`.

## Page size summary

| Action | Default | Max | Cursor key |
|--------|---------|-----|------------|
| `content.list` | 20 | 20 | `(effective_at, entity_id)` DESC; `(score, effective_at, entity_id)` DESC with `query` |
| `content.searchBySemanticSimilarity` | 20 | 20 | `(distance, entity_id)` ASC |
| `events.list` | 20 | 20 | `(effective_at, entity_id)` DESC |
| `members.list` | 50 | 50 | `(joined_at, member_id)` DESC |
| `members.searchByFullText` | 20 | 20 | `(rank, member_id)` DESC |
| `members.searchBySemanticSimilarity` | 20 | 20 | `(distance, member_id)` ASC |
| `vouches.list` | 20 | 20 | `(created_at, edge_id)` DESC |
| `messages.getInbox` | 20 | 20 | `(latest_created_at, thread_id)` DESC |
| `messages.getThread` | 50 | 50 | `(created_at, message_id)` DESC |
| `clubadmin.memberships.list` | 50 | 50 | `(state_created_at, id)` DESC |
| `clubadmin.memberships.listForReview` | 20 | 20 | `(state_created_at, id)` DESC |
| `clubadmin.admissions.list` | 20 | 20 | `(version_created_at, id)` DESC |
| `superadmin.members.list` | 50 | 50 | `(created_at, id)` DESC |
| `superadmin.content.list` | 50 | 50 | `(created_at, id)` DESC |
| `superadmin.messages.listThreads` | 50 | 50 | `(created_at, id)` DESC |

All 15 actions are fully pageable via keyset cursor.
