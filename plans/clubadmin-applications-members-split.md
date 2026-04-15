# clubadmin applications / members API split

Split `clubadmin.memberships.list` into two semantically-scoped actions so the "members" concept and the "applications" concept can never be confused by a caller. Fix the broken `status` filter in the current list action, and back the whole thing with real tests. **API-surface change only; the schema stays unified.**

---

## 1. Why this plan exists

On 2026-04-15 another agent reported "13 members" to Owen for a club that actually had 10 active members + 3 applicants. The agent got this by calling `clubadmin.memberships.list` with no filter and counting rows without inspecting each row's `state.status`. The category error came from two real problems in the same action:

1. **Misleading name.** `clubadmin.memberships.list` sounds like "members" to a caller. It is actually scoped to the entire lifecycle state machine — including `applying` and `submitted` rows that are NOT members yet. The caller has to know to filter.
2. **No sensible default.** Calling the action with no `status` filter means "everything," which is almost never the right answer. "Current members of this club" is the overwhelmingly common intent, and the default return shape doesn't match it.

**A note on "the filter is broken."** The reporting agent initially described the incident as "the filter silently failed — likely a bug where the API ignores the `status` param." A follow-up investigation by a second agent traced the code path end-to-end (wire schema → parse schema → handler → repository → parameterized SQL) and live-tested against `clawclub_dev`: the filter works correctly. `status: "active"` returns only active rows; invalid filter values return clean 400s; the filter is threaded all the way to the `cnm.status = $2` predicate in `src/identity/memberships.ts`. The "filter broken" framing was a misread, most likely the reporting agent looking at the wrong field in the response envelope.

**That strengthens the case for this plan, not weakens it.** The category error happened without any code bug. No broken filter, no silent failure, no regression — just an API surface that invites the mistake. When an agent can make a user-facing category error against code that is working exactly as designed, the code is doing something semantically wrong even though it is mechanically right. The fix is to change the shape of what agents can ask for, not to patch a bug that doesn't exist.

There is, however, a **test coverage gap**: the filter behavior is not locked in by any integration test. Had one existed, the "is this filter broken?" question could have been answered by pointing at the test instead of requiring a full live investigation. This plan closes that gap by backing the two new actions with comprehensive filter-behavior tests (§5).

Owen's framing after the incident: applications are not members and should not be in the same breath. He briefly considered splitting the schema — putting applications in a separate table — but agreed with the counter-argument that (a) the unified state machine is load-bearing (the tokenless-apply-and-onboarding plan depends on it), (b) splitting the schema would force forever-JOIN to reconstruct member history, and (c) the real fix is at the API surface: make it physically impossible for a caller to ask for "members" and receive applicants, while keeping the underlying table unified.

This plan is that fix.

---

## 2. Relationship to other in-flight work

There are three in-flight workstreams touching the clubadmin / membership area. They must land in this order:

1. **Clubadmin subscription lapse bug fix** (Option A, being handed off separately). Removes the `role = 'clubadmin'` bypass from `accessible_club_memberships`, auto-comps owners on `createClub` and `assignClubOwner`, backfills existing owners, updates seeds and harness. **Lands first.**
2. **This plan (clubadmin applications/members API split).** Depends on #1 because `clubadmin.members.list` queries against the "who has access to this club right now" view, and that view must be correct before this plan builds on it. **Lands second.**
3. **Tokenless apply and onboarding** (`plans/tokenless-apply-and-onboarding.md`). Independent of #2 on the schema side, but benefits from the cleaner API surface and is easier to think about once the terms "application" and "member" are separate in the admin API. **Lands third.**

**Assumption for the implementing agent:** the subscription lapse bug fix has already landed. The view is correct, owners are comped, and `accessible_club_memberships` truthfully answers "who has club access right now." Do not plan around the pre-fix view shape.

---

## 3. The split

Replace `clubadmin.memberships.list` with two new actions, plus absorb `clubadmin.memberships.listForReview` into the applications action so the admin API has exactly one way to describe each concept.

### 3.1. `clubadmin.applications.list` (new)

**Purpose.** List in-flight applications for a club — everyone who is asking to join but hasn't been admitted or declined yet.

**Scope.** Returns rows where `status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed')`. These are the non-terminal pre-membership states in the current state machine.

**Auth.** `auth: 'clubadmin'`, `safety: 'read_only'`, scoped to the club admin's clubs. Same authorization discipline as the current `clubadmin.memberships.list`.

**Input.**
```
{
  clubId: string,
  statuses?: MembershipState[],   // optional narrower filter within the applications scope
  limit: number (default 20, max 50),
  cursor: string | null
}
```

- `statuses` is optional. When omitted, the action returns all four application states. When provided, the handler validates that every requested status is within the applications scope — passing `status: "active"` to `applications.list` is a 422 `invalid_input` (with a message that says "active is a member status; use clubadmin.members.list"), not an empty result.
- Array filter, not single-value — consistent with the current `listForReview` shape and more useful than the current single-value `status` on `memberships.list`.

**Output.** Same shape as the current `clubadmin.memberships.listForReview` — returns `membershipReviewSummary` rows (the application-flavored response shape), not `membershipAdminSummary`. The wire-level response shape is deliberately application-flavored: `applied_at`, `application_text`, `proof_kind`, `sponsor_member_id`, `application_submitted_at` are prominent; member-flavored fields like `joined_at`, `is_comped`, `role`, subscription state are NOT included.

**Response-shape rationale.** If the shape returned from `applications.list` included member-flavored fields, a caller could still write code that reads those fields and be confused when they are all `null` on pre-membership rows. The whole point of the split is that the two actions return different response shapes, so the caller's code can never accidentally cross the boundary. Response shape is load-bearing.

### 3.2. `clubadmin.members.list` (new)

**Purpose.** List actual members of a club — people who currently have access, with the status and billing context an admin needs to see.

**Scope.** Returns rows where the member CURRENTLY HAS CLUB ACCESS — i.e., rows that appear in `accessible_club_memberships` for this club. This is the authoritative definition of "member" after the subscription lapse bug fix lands. Under the hood the query is a join against the view, not a flat `status IN (...)` check, so the rule stays truthful as the view evolves (owner-comp, billing grace, future comp flows all flow through automatically).

**Auth.** `auth: 'clubadmin'`, `safety: 'read_only'`. Same scoping as the applications action.

**Input.**
```
{
  clubId: string,
  statuses?: MembershipState[],   // optional narrower filter within the members scope
  roles?: MembershipRole[],       // optional filter: ['clubadmin'] or ['member']
  limit: number (default 50, max 50),
  cursor: string | null
}
```

- `statuses` optional, with the same strict validation as `applications.list`: passing `status: "applying"` or `"submitted"` to `members.list` is a 422 `invalid_input` with a message that says "applying is an application status; use clubadmin.applications.list."
- `roles` optional, lets an admin ask for "just the other admins" or "just regular members."
- Default (no filters): all rows in `accessible_club_memberships` for this club.

**Output.** `membershipAdminSummary` rows (the member-flavored response shape): `joined_at`, `role`, `is_comped`, `comped_at`, subscription state summary, `left_at` (null for active members), etc. Does NOT include application-only fields like `application_text` or `applied_at` (even though those columns exist on the underlying table — the API surface hides them on this path).

**Rationale for querying via the view.** Querying the view (rather than a flat status filter) means the fix for the subscription lapse bug is naturally inherited. A non-owner clubadmin whose subscription lapses loses their access in the view and therefore disappears from `clubadmin.members.list` — which is exactly the behavior the bug fix is trying to establish. If `members.list` instead queried `status = 'active'` directly, it could return members the view considers lapsed, which would be a slow-motion re-introduction of the same bug.

### 3.3. `clubadmin.memberships.list` (removed)

**Removed entirely.** No deprecation window, no backwards-compatibility shim. Agents re-fetch `/api/schema` on every connection per the CLAUDE.md agent-first policy, so the field disappears in one migration.

There is no generic "firehose" replacement. If a superadmin needs to inspect the raw state machine including terminal states, they already have `superadmin.*` surface area and direct database access for emergency inspection. A club admin does not need to see terminal rows — the two new actions cover every legitimate clubadmin use case.

### 3.4. `clubadmin.memberships.listForReview` (removed)

**Also removed.** Its scope (`submitted`, `interview_scheduled`, `interview_completed`) is a subset of `clubadmin.applications.list`'s default scope. Anything a caller could express against `listForReview` can be expressed against `applications.list` with an explicit `statuses` filter. Having two actions that both list applications is exactly the kind of "more than one way to describe the thing" drift that the split is trying to prevent.

If a regression shows up in review-queue ergonomics post-split, we can add back a sugar action, but the default expectation is that `applications.list` alone is enough.

### 3.5. Other unaffected actions

- `clubadmin.memberships.create` — unaffected, keeps its name. It takes an `initialStatus` and can produce either an application-stage or a member-stage row, so neither `applications.create` nor `members.create` is the right home for it. Keep it on the `memberships` namespace, because creation is the one operation that legitimately straddles the boundary.
- `clubadmin.memberships.get` — unaffected, keeps its name. A single-row inspection by id can reasonably return either an application or a member row and the caller knows which they asked for. Keep it on the `memberships` namespace.
- `clubadmin.memberships.setStatus` — unaffected, keeps its name. Status transitions ARE the bridge between "application" and "member" — this is the one action where the unified state machine is most important.

The principle: **list** actions get split because list results are where caller confusion lives. **Point reads and writes** keep the unified namespace because they operate on a single known row.

---

## 4. Test coverage gap

Separate from the split, there is a real test coverage gap that the incident exposed: **no integration test currently locks in the status filter behavior on `clubadmin.memberships.list`.** The only coverage at `test/integration/non-llm/memberships.test.ts:326` tests auth rejection, not filter semantics. A unit test at `test/unit/app.test.ts:910` verifies that the `status` field is threaded through the dispatch layer to the handler, but nothing catches a SQL-level regression where the filter is accepted by the handler and then silently dropped by the query.

The follow-up investigation confirmed the filter works today, but "works today" is a live-test result, not a regression net. A future refactor of `listMemberships` could break the filter and pass all existing tests.

**This plan closes the gap by construction.** The integration tests for `clubadmin.applications.list` and `clubadmin.members.list` in §5 exercise the `statuses` filter end-to-end, with known seeded data and exact expected counts for every filter permutation. They replace the missing coverage on the successor actions and catch the exact class of bug the reporting agent thought they had found.

**No need for a separate "filter-works" follow-up PR.** A second agent offered to add a tiny integration test for the current `clubadmin.memberships.list` filter behavior. That PR is not necessary — this plan's tests cover the same ground on the actions that replace it. Landing this plan closes the gap without intermediate work.

---

## 5. Tests

**The lack of a regression test for this is itself a bad sign.** A list action with an optional filter should have had tests that exercise both "no filter" and "each filter value" from day one. The split will add these tests for the new actions; any test coverage that existed for the old actions is removed with them.

### 5.1. `clubadmin.applications.list` — integration tests

Seed a fresh club with a mix of states: 2 `applying`, 3 `submitted`, 1 `interview_scheduled`, 1 `interview_completed`, 4 `active`, 1 `declined`, 1 `withdrawn`.

1. **Default scope.** Call with no `statuses` filter. Assert the response contains exactly the 2+3+1+1 = 7 in-flight application rows. Assert none of the 4 active members are returned. Assert neither terminal row (declined/withdrawn) is returned.
2. **Narrow filter — single status.** Call with `statuses: ['submitted']`. Assert exactly 3 rows, all with `state.status === 'submitted'`.
3. **Narrow filter — multi status.** Call with `statuses: ['submitted', 'interview_scheduled']`. Assert exactly 4 rows.
4. **Cross-boundary filter rejection.** Call with `statuses: ['active']`. Assert 422 `invalid_input` with a message that contains the string `'clubadmin.members.list'` (so the caller is told exactly where to go).
5. **Cross-boundary filter rejection — terminal states.** Call with `statuses: ['declined']`. Assert 422 `invalid_input`. Terminal states are not in scope for either new action.
6. **Empty-filter edge case.** Call with `statuses: []` (empty array). Assert 422 `invalid_input` — an empty filter is caller error, not "match everything."
7. **Response shape.** Assert every row has the application-flavored fields (`applied_at`, `application_text`, `proof_kind`) and does NOT have member-flavored fields (`joined_at`, `is_comped`, `role` as primary surface fields — the underlying repo may include role but the wire shape should not surface it).
8. **Pagination.** Seed >limit rows in scope, paginate to completion, assert no duplicates or gaps. This is the pagination discipline from the TODO backlog applied to the new actions.
9. **Authorization.** A clubadmin of club A cannot call `applications.list` for club B. A regular member cannot call it at all.

### 5.2. `clubadmin.members.list` — integration tests

Same seeded club as §5.1 plus: one comped non-owner admin, one member with a lapsed subscription (should NOT appear post-bug-fix), one member in `renewal_pending` within the grace window.

1. **Default scope.** Call with no filters. Assert the response contains exactly the rows that appear in `accessible_club_memberships` for this club — the 4 active members + the comped admin + the renewal_pending-within-grace member. Assert the lapsed-subscription member does NOT appear. Assert none of the 7 applications from §5.1 appear.
2. **Status filter.** Call with `statuses: ['active']`. Assert only the 4 active + the comped admin appear; the renewal_pending member is excluded by the narrower filter.
3. **Role filter.** Call with `roles: ['clubadmin']`. Assert only the owner + the comped admin appear.
4. **Combined filter.** Call with `statuses: ['active'], roles: ['member']`. Assert the 4 regular members appear; no admins.
5. **Cross-boundary filter rejection.** Call with `statuses: ['applying']`. Assert 422 `invalid_input` with a message that contains `'clubadmin.applications.list'`.
6. **Cross-boundary filter rejection — submitted.** Call with `statuses: ['submitted']`. Assert 422 `invalid_input`.
7. **Status filter correctness — the lock-in test.** Call `clubadmin.members.list` with `statuses: ['active']` in a club with multiple seeded active members alongside non-active rows (renewal_pending, applying). Assert the count exactly matches the number of seeded active members — not zero, not the total, not the active-plus-renewal-pending count. Seed enough rows that an accidental "ignore the filter" regression would produce a visibly wrong number. Label the test explicitly: `'clubadmin.members.list statuses=active returns only active rows'`. This is the test the 2026-04-15 incident should have been able to point at instead of triggering a live investigation. It is not a regression net for a past code bug (there wasn't one); it is a lock-in that guarantees the filter will keep working across future refactors of `listMemberships`.
8. **View-based semantics.** Expire a subscription for one of the active members (via `billingExpireMembership` or equivalent). Call `clubadmin.members.list` — the now-lapsed member is absent. This proves that the action honors the view rather than raw status, which is the §3.2 rationale in action.
9. **Response shape.** Assert every row has member-flavored fields (`joined_at`, `is_comped`, `role`) and does NOT have application-only fields (`application_text`, `proof_kind`).
10. **Pagination.** Same discipline as §5.1 test 8.
11. **Authorization.** Same scoping check as §5.1 test 9.

### 5.3. Removal tests

1. `clubadmin.memberships.list` no longer exists in the registry. Calling it returns 400 `unknown_action`. Assert the error message points callers at the two new actions.
2. `clubadmin.memberships.listForReview` no longer exists in the registry. Same assertion.
3. `/api/schema` does not contain either removed action. Fetching the schema and grepping for the old names yields zero hits.

---

## 6. SKILL.md update obligation

The SKILL.md "How an admin reviews and approves applications" and "How an admin inspects their club" sections need a small rewrite to use the new action names. Specifically:

- Any reference to `clubadmin.memberships.list` becomes `clubadmin.members.list`.
- Any reference to `clubadmin.memberships.listForReview` becomes `clubadmin.applications.list`.
- A new short paragraph makes the rule explicit for the agent reading SKILL.md: "To list applications, call `clubadmin.applications.list`. To list members, call `clubadmin.members.list`. These are different actions for different concepts. The agent MUST choose the right action for the user's intent; it is a category error to call `applications.list` and count the result as 'members of this club.'"

Do this rewrite in the same commit as the API change. Both are part of the same breaking-change landing.

---

## 7. docs/design-decisions.md update obligation

Add a short section under "Membership and trust" (or wherever admin-API decisions currently live) that records:

- The split exists because applications and members are semantically different and the unified list action was producing real category errors.
- The underlying schema stays unified — this is an API surface decision, not a data model decision.
- The rationale for hiding the old action entirely rather than deprecating it (agent-first policy, `/api/schema` is re-fetched on every connection).
- The response-shape discipline: `applications.list` returns application-flavored rows, `members.list` returns member-flavored rows. Callers cannot accidentally cross the boundary because the shapes are different.

Two short paragraphs is enough. This is a decision that future-us should be able to find without archaeology.

---

## 8. Not in scope

Explicitly out of scope for this plan:

- **Schema-level split of applications and memberships.** Considered and rejected (§1, §2). The unified state machine is load-bearing.
- **Other `clubadmin.*` actions.** `get`, `create`, `setStatus`, `clubs.getStatistics`, etc. are unaffected. Do not touch them.
- **`superadmin.*` list actions.** Out of scope. If a future superadmin audit needs the same split, do it as a follow-up plan.
- **Adding new action verbs** (e.g. `applications.approve` as a sugar for `setStatus(active)`). Keep the state transitions on the existing `memberships.setStatus` action. The split is only for reads.
- **Migrating the `listMemberships` repository method signature.** If it's still the backend for both new actions, keep its signature. If it's only used by one of them, rename or inline. Implementing agent's call, but don't refactor further than necessary.
- **Deprecation metadata or warning headers on the old actions.** They are removed, not deprecated. No alias, no warning, no shim.

---

## 9. Done checklist

- [ ] `clubadmin.applications.list` action defined in `src/schemas/clubadmin.ts` with wire schema, parse schema, handler, and repository call.
- [ ] `clubadmin.members.list` action defined in `src/schemas/clubadmin.ts` with same shape, querying via `accessible_club_memberships`.
- [ ] Both actions enforce cross-boundary status-filter rejection with 422 `invalid_input` and a message that names the sibling action.
- [ ] `clubadmin.memberships.list` and `clubadmin.memberships.listForReview` removed from the registry; removed from `src/schemas/clubadmin.ts`; any repository methods they uniquely called are inlined or renamed as appropriate.
- [ ] SKILL.md updated per §6.
- [ ] `docs/design-decisions.md` updated per §7.
- [ ] Full integration test coverage from §5.1, §5.2, §5.3 passes.
- [ ] `npm run check` passes.
- [ ] `npm run test:integration:non-llm` passes.
- [ ] `npm run test:unit` passes.
- [ ] `package.json` patch version bumped.
- [ ] `test/snapshots/api-schema.json` updated to reflect the new action surface.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit push authorization.

When Owen authorizes, push, then:

- [ ] Confirm `/api/schema` on production no longer contains `clubadmin.memberships.list` or `clubadmin.memberships.listForReview`.
- [ ] Confirm both new actions appear in the schema and respond correctly against seeded production data.
- [ ] Smoke test: call `clubadmin.members.list` on a real production club and verify the count matches the club's actual active member count.

Only then is the work complete.
