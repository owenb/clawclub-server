# Admin and member read surfaces split

Split the admin and member read surfaces around two orthogonal axes — entity type (members vs applications) and visibility level (public vs admin) — so the API physically prevents category errors ("I thought this list was members") and privacy leaks ("regular members should not see payment details") at the type boundary. Replace three muddled admin response shapes with three cleanly disjoint shapes. Remove the old `clubadmin.memberships.*` list/get actions. Rewrite the public `members.list` to surface vouches inline. Add a new `members.get` action. Add a new `vouch.received` notification topic so being vouched for is no longer silent. **API surface + response shape redesign; schema stays unified; no migrations required.**

---

## 1. Why this plan exists

On 2026-04-15 an agent reported "13 members" for a club that actually had 10 active members + 3 applicants. The agent called `clubadmin.memberships.list` with no filter and counted rows without inspecting each row's state. A follow-up investigation confirmed that the status filter works correctly, so this was not a code bug — the category error happened against code that was working exactly as designed. **No broken filter, no silent failure, just an API surface shape that invites the mistake.** That makes the fix unambiguously an API redesign, not a code patch: you cannot fix a bug that isn't there.

The scope of this plan has grown since the original draft. As Owen and I worked through the design from all four caller perspectives — regular member, clubadmin, clubowner, superadmin — three more problems surfaced that should be fixed in the same pass rather than as three separate plans:

1. **Payment data is exposed to nobody today.** Not even clubadmins. `isComped`, `compedAt`, `approvedPriceAmount`, `approvedPriceCurrency`, subscription state — none of these appear in any response shape in `src/schemas/responses.ts`. After workstream #1 (commit `77e293d`) made owner-comping a first-class product fact, admins need to be able to see who is paying and who is comped without a round-trip. This plan adds that exposure — admin-only.

2. **Regular members' `members.list` doesn't surface vouches.** Kind-1 vouches (the in-club peer trust signal) currently appear only on the admin review queue (`membershipReviewSummary.vouches[]`). A regular member looking at their club's roster cannot see who has vouched for whom, which makes in-club vouching a private admin-visibility signal when it should be a public trust signal. This plan surfaces Kind-1 vouches inline on the public member shape.

3. **Being vouched for is silent.** There is no notification topic for vouches today. If Alice vouches for Bob, Bob never finds out unless he reads the roster. This plan adds a new `vouch.received` notification topic fired atomically inside `vouches.create`, so the vouchee's agent can surface the event to the human immediately.

This plan also encodes a critical invariant **Owen explicitly pinned**: regular members have zero visibility into in-flight applications. The only member-facing role in the application flow is sponsorship/invitation (`invitations.issue`). Once someone is invited or sponsored, reviewing and approving is admin-only. This plan enforces the invariant structurally — applications get an admin-only surface with NO public counterpart. A regular member asking "who is applying to join our club right now" should get a SKILL.md-documented answer from the agent that says "that's admin-only information."

**Leak audit result.** A one-time audit against the current codebase (before this plan ships) confirmed that today's member-facing read surfaces — `members.list` (`src/identity/memberships.ts:312-374`), `members.searchByFullText` (`src/identity/profiles.ts:627-702`), `members.searchBySemanticSimilarity`, `profile.list` via `listVisibleClubs` (`src/identity/profiles.ts:188-229`), and `invitations.listMine` (`src/schemas/invitations.ts:108-144`) — do NOT leak application data to regular members. All of them query `accessible_club_memberships` (which excludes application states by construction after workstream #1) or scope to the caller's own rows. **There is no current leak to close.** The plan's job is to ensure the new surfaces do not introduce one, which is guaranteed by a parameterized regression test (§9.1).

---

## 2. Relationship to other in-flight work

Three workstreams touch the admin / membership area. They land in this order:

1. **Clubadmin subscription lapse bug fix — DONE, LIVE.** Commit `77e293d` "Auto-comp owners and remove clubadmin access bypass" shipped 2026-04-15. Removed the `role = 'clubadmin'` bypass from `accessible_club_memberships`, auto-comped club owners in `createClub` and `assignClubOwner`, backfilled existing owners via migration `013_comp_owners_and_remove_clubadmin_bypass.sql`, added `test/integration/non-llm/clubadmin-access.test.ts`. The view is now the authoritative source of truth for "who currently has club access."

2. **This plan — workstream #2.** Depends on #1 because both `members.list` and `clubadmin.members.list` query via `accessible_club_memberships`, and that view must be correct before building on it. **Lands second.**

3. **Tokenless apply and onboarding — `plans/tokenless-apply-and-onboarding.md`.** Independent of #2 at the schema layer, but benefits from the cleaner admin API surface — SKILL.md's admin section is easier to describe once the split is in place. **Lands third.**

**Assumption for the implementing agent:** workstream #1 has already landed. `git log --oneline -10` should show `77e293d Auto-comp owners and remove clubadmin access bypass` on `main`. Do not plan around the pre-fix view.

---

## 3. Design principles

These are the rules that determined every shape in this plan. Understand them before touching the code — each principle is load-bearing.

### 3.1 Two orthogonal axes, with one quadrant deliberately empty

**Axis 1: entity type.** Applications and members are semantically different entities. They happen to live in the same `club_memberships` table because the state machine is load-bearing (an application's approval IS a status transition, not a copy-paste into a separate member table), but the API surface must hide that unification from callers. Response shapes for the two entity types are DISJOINT on semantic fields: an application shape has no `isComped` (not yet paying), a member shape has no `applicationText` (historical, not current).

**Axis 2: visibility level.** Regular members see a PUBLIC shape. Clubadmins, clubowners, and superadmins see an ADMIN shape that is a strict superset of the public shape. The admin shape adds commercial fields (payment, comp, subscription) and admin-only state (covenant acceptance, full state version history, leftAt).

**2 × 2 = 4 shapes in theory, but only 3 in practice.** Members have both public and admin shapes. Applications have ONLY an admin shape — regular members have no visibility into applications at all, by explicit product rule. That gives three response shapes: `publicMemberSummary`, `adminMemberSummary`, `adminApplicationSummary`.

### 3.2 Vouches and sponsorship are separate concepts, surfaced separately

**Kind 1 — in-club peer vouching.** Lives in `club_edges` with `kind='vouched_for'` (`db/init.sql:909-929`). Created by `vouches.create` (`src/schemas/membership.ts:244-315`) AFTER both parties are active members. Peer trust signal. Appears on both member shapes as an inline `vouches[]` array.

**Kind 2 — sponsorship / invitation.** Lives in `club_memberships.sponsor_member_id` (nullable FK) and `invitations.sponsor_member_id`. Set at application time. "Who originally brought this person in." Appears on both member shapes (to show each member's original sponsor, if any) AND on the application shape (to show who is endorsing this in-flight application).

These are structurally different tables and should not be collapsed into a unified "vouches" concept in the API. A member can have many Kind-1 vouches from peers AND a single Kind-2 sponsor from their application. An applicant can only have Kind-2 (they have no peers yet — the existing `vouches.create` requires both parties to be active members, and the `club_edges_unique_active_vouch` index enforces it).

### 3.3 Payment data is admin-only, enforced by shape

`isComped`, `compedAt`, `compedByMemberId`, `approvedPriceAmount`, `approvedPriceCurrency`, and the subscription state snapshot are admin-only. The distinction is enforced at the response shape level: the public shape simply does not have these fields, so there is no code path where a regular member could accidentally see them. A typo in a handler cannot leak payment data to a regular member because the public shape has no slot for it.

### 3.4 Applications are admin-only, period

There is NO public-facing `applications.list` or `applications.get`. Regular members have ZERO visibility into in-flight applications. The only member-facing role in the application flow is sponsorship/invitation (`invitations.issue`). The plan enforces this structurally — the implementing agent must NOT add a public counterpart to `clubadmin.applications.*` actions. SKILL.md's agent guidance makes this explicit so regular-member agents know that "show me the applicants" is an admin-only query.

### 3.5 Superadmin cascade via existing auth hierarchy

The auth hierarchy in `src/dispatch.ts` already resolves `clubadmin` to include clubowners and superadmins (per the common pattern: anything a clubadmin can do, a clubowner can do; anything a clubowner can do, a superadmin can do). No new superadmin-specific actions are needed for this plan. A superadmin calling `clubadmin.members.list(clubId)` or `clubadmin.applications.list(clubId)` works for any club. Do NOT add `superadmin.members.list` or similar — those already exist as platform-wide cross-club views and serve a different purpose.

### 3.6 Write side stays unified

`clubadmin.memberships.create` and `clubadmin.memberships.setStatus` are NOT renamed or split. They cross the application→member boundary intentionally: `create` lets the caller explicitly pick an `initialStatus` (application-stage or member-stage); `setStatus` is literally how rows move across the boundary. Splitting either would require two actions that cooperate to move a single row — which is absurd. The unified namespace is correct for state-machine writes.

---

## 4. The new action surface

### 4.1 Public read actions (auth: 'member')

All callable by any active member of the club in question. None surface payment data. None surface application data. None can be used to infer application data through any side channel.

**`members.list(clubId, limit?, cursor?)`** — EXISTING action, response shape rewritten.
- Auth: `'member'`
- Scope: `requireAccessibleClub(clubId)` — caller must be an active member of the club
- Query: join via `accessible_club_memberships` (same as today — applicant exclusion is inherited from the view)
- Input: `{ clubId: string, limit: number (default 50, max 50), cursor: string | null }` (unchanged from today)
- Output envelope:
  ```typescript
  z.object({
    limit: z.number(),
    clubScope: z.array(membershipSummary),       // echo of the caller's resolved club, matches today's members.list convention
    results: z.array(publicMemberSummary),       // NEW row shape, §5.1
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  ```
- **Breaking change.** The row shape is different from today's `clubMemberSummary[]`. Existing callers will break. Agent-first policy — no shim, no deprecation. Agents re-fetch `/api/schema` on every connection.
- Flattening: the current row nests a `memberships: [...]` array inside each member, but the array always contains exactly one element (because the query filters to a single `clubId`). The new row shape flattens this — `role`, `joinedAt`, `sponsor` become top-level fields on each row.

**`members.get(clubId, memberId)`** — NEW action.
- Auth: `'member'`
- Scope: `requireAccessibleClub(clubId)` + verify `memberId` is an active member in that club (appears in `accessible_club_memberships` for this club)
- Input: `{ clubId: string, memberId: string }` (both required)
- Output envelope:
  ```typescript
  z.object({
    club: z.object({
      clubId: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    member: publicMemberSummary,                 // §5.1, the single row
  })
  ```
  Rationale for the envelope rather than returning `publicMemberSummary` directly: echoing the resolved club context matches the `clubScope` convention on the list actions and saves the caller a round-trip to `clubs.get` for display purposes. `member` is named explicitly to leave room for future extensions (e.g. adding a `relatedMembers` field later without a breaking rename).
- 404 `not_found` if the target has no active membership in the requested club. The 404 error message does NOT name `clubadmin.applications.get` — regular members should not be told about the admin surface as a redirect target.
- Self-fetch allowed (the caller can `members.get` themselves).

**`members.searchByFullText(clubId, query, limit?, cursor?)`** — EXISTING, unchanged.
- No scope or visibility changes.
- Output shape `memberSearchResult` is NOT replaced by `publicMemberSummary`. Search results are semantically different — ranked search hits, not roster rows. Keep specialized.
- **Optional nice-to-have:** add an inline `vouches[]` field to search result rows for consistency with `members.list`. If the implementing agent has cycles, do it; otherwise skip. Not required.

**`members.searchBySemanticSimilarity(clubId, query, limit?, cursor?)`** — EXISTING, unchanged. Same notes as `searchByFullText`.

**`profile.list(memberId?, clubId?)`** — EXISTING, unchanged.
- Returns `memberProfileEnvelope` — per-club profile data across multiple clubs.
- Different access pattern from `members.get`: `profile.list` shows profile fields across ALL clubs the actor and target share; `members.get` is scoped to one club and returns membership-level facts (role, join date, vouches) in addition to profile fields.
- No collapse. Both stay.

**`vouches.list(memberId?, clubId?)`** — EXISTING, small signature tweak.
- Auth: `'member'`
- Scope: caller's clubs, filtered optionally to one club
- Input: **change the current required `memberId` to optional, defaulting to the calling actor's member id when omitted.** Matches the existing `profile.list(memberId?, clubId?)` pattern. The `clubId` stays optional.
- Rationale: the "my trust footprint" query should be callable as `vouches.list({})` for the caller's own vouches, and as `vouches.list({ memberId: otherId })` for someone else's. Making memberId optional is additive — existing callers passing memberId explicitly still work — so this is a wire-level change, not a breaking one.
- This tweak is also what keeps the `vouch.received` notification message template clean: the message says `vouches.list(clubId: '...')` without needing to repeat the recipient's own memberId.
- Handler change: read `memberId ?? ctx.actor.member.id` before passing to the repository method. No repository-layer change needed.
- Output shape unchanged (still `vouchSummary[]`).

### 4.2 Admin read actions (auth: 'clubadmin')

All require `'clubadmin'` auth, which resolves clubowners and superadmins via the existing auth hierarchy. All return admin shapes with commercial fields.

**`clubadmin.members.list(clubId, statuses?, roles?, limit?, cursor?)`** — NEW action.
- Auth: `'clubadmin'`
- Scope: `requireClubAdmin(clubId)`
- Query: join via `accessible_club_memberships` for this club — same row set as the public `members.list` for this club, but returning the admin shape
- Input: `{ clubId: string, statuses?: MembershipState[], roles?: MembershipRole[], limit: number (default 50, max 50), cursor: string | null }`
- Output envelope:
  ```typescript
  z.object({
    limit: z.number(),
    clubScope: z.array(membershipSummary),
    statuses: z.array(membershipState).nullable(),   // echo: null when caller omitted the filter
    roles: z.array(membershipRole).nullable(),       // echo: null when caller omitted the filter
    results: z.array(adminMemberSummary),            // §5.2
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  ```
- `statuses` filter is optional, defaults to all rows in `accessible_club_memberships` for this club (which is `active` + `renewal_pending` + `cancelled` with live sub). When provided, must be a subset of the "member" statuses (`active`, `renewal_pending`, `cancelled`). Any other value returns 422 `invalid_input` with a message naming `clubadmin.applications.list`.
- `roles` filter is optional, accepts `['clubadmin']`, `['member']`, or both. Defaults to both.

**`clubadmin.members.get(clubId, membershipId)`** — NEW action.
- Auth: `'clubadmin'`
- Scope: `requireClubAdmin(clubId)` + verify `membershipId` belongs to that club AND currently appears in `accessible_club_memberships` (i.e. is a real member, not an applicant or a terminal row)
- Input: `{ clubId: string, membershipId: string }`
- Output envelope:
  ```typescript
  z.object({
    club: z.object({
      clubId: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    member: adminMemberSummary,                      // §5.2
  })
  ```
- 404 if the membership is in an application state (`applying`, `submitted`, `interview_scheduled`, `interview_completed`) — the error message names `clubadmin.applications.get` as the sibling action to call instead.
- 404 if the membership is in a terminal state (`declined`, `withdrawn`, `expired`, `removed`, `banned`) — no sibling action exists, so the error message is plain "no active member with that id."

**`clubadmin.applications.list(clubId, statuses?, limit?, cursor?)`** — NEW action.
- Auth: `'clubadmin'`
- Scope: `requireClubAdmin(clubId)`
- Query: join against `current_club_memberships` (NOT `accessible_club_memberships` — applications are not "accessible" in the view sense) filtered to `status IN ('applying','submitted','interview_scheduled','interview_completed')` AND `club_id = $1` AND `left_at IS NULL`
- Input: `{ clubId: string, statuses?: MembershipState[], limit: number (default 20, max 50), cursor: string | null }`
- Output envelope:
  ```typescript
  z.object({
    limit: z.number(),
    clubScope: z.array(membershipSummary),
    statuses: z.array(membershipState).nullable(),
    results: z.array(adminApplicationSummary),       // §5.3
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  ```
- `statuses` filter is optional, defaults to all four in-flight application states. When provided, must be a subset of the application states. Any other value returns 422 `invalid_input` with a message naming `clubadmin.members.list`.

**`clubadmin.applications.get(clubId, membershipId)`** — NEW action.
- Auth: `'clubadmin'`
- Scope: `requireClubAdmin(clubId)` + verify `membershipId` belongs to that club AND is currently in an application state
- Input: `{ clubId: string, membershipId: string }`
- Output envelope:
  ```typescript
  z.object({
    club: z.object({
      clubId: z.string(),
      slug: z.string(),
      name: z.string(),
      summary: z.string().nullable(),
      admissionPolicy: z.string().nullable(),          // preserves the richer club context that the old membershipApplicationAdminSummary surfaced
      ownerName: z.string().nullable(),
      priceUsd: z.number().nullable(),
    }),
    application: adminApplicationSummary,              // §5.3
  })
  ```
  Rationale for the richer `club` block: the old `clubadmin.memberships.get` returned `membershipApplicationAdminSummary` which carried `{club: {..., admissionPolicy, ownerName, priceUsd}, ...}`. Admins reviewing an application want to see the club's own terms alongside the application, without a separate `clubs.get` round-trip. Preserve the richer club context on this envelope only; the `clubadmin.members.get` envelope keeps the lighter `{clubId, slug, name}` block because admins inspecting a member usually already know the club terms.
- 404 if the membership is in a member state — error message names `clubadmin.members.get`.
- 404 if the membership is in a terminal state — no sibling action exists, plain message.

### 4.3 Removed actions

Removed from the registry entirely. No deprecation window, no shim, no alias. `/api/schema` stops listing them in one commit. Agents re-fetch on every connection per agent-first policy.

- **`clubadmin.memberships.list`** — replaced by `clubadmin.members.list` + `clubadmin.applications.list`
- **`clubadmin.memberships.listForReview`** — absorbed into `clubadmin.applications.list` (the default scope covers all review-stage statuses)
- **`clubadmin.memberships.get`** — replaced by `clubadmin.members.get` + `clubadmin.applications.get`

Removed actions return generic 400 `unknown_action: Unsupported action: ...` via the existing dispatcher path. **No dispatcher special-case redirect text.** From first principles: clients re-fetch the schema on every connection, see the new surface, self-correct. Adding hand-written redirect text for one specific removal would set a bad precedent for every future removal.

### 4.4 Unchanged actions (do not touch)

- `clubadmin.memberships.create` — write-side action, crosses the boundary intentionally via `initialStatus`. Stays on the unified namespace.
- `clubadmin.memberships.setStatus` — write-side action, literally IS the boundary transition. Stays on the unified namespace.
- `clubadmin.clubs.getStatistics` — not related to the member/application split. Stays.
- `superadmin.members.list`, `superadmin.members.get` — platform-wide cross-club admin views, different concern. Stays.
- `clubowner.members.promoteToAdmin`, `clubowner.members.demoteFromAdmin` — write-side role changes. Stays.
- All `members.*`, `profile.*`, `vouches.*` actions except `members.list` and the new `members.get`. Stays.
- All other actions in the registry. Do not touch them.

---

## 5. The new response shapes

Three new shapes, disjoint on semantic fields, layered on visibility. Define them in `src/schemas/responses.ts` during implementation; delete the three old shapes once all callers have moved over.

### 5.1 `publicMemberSummary`

Used by: `members.list`, `members.get`.

```typescript
z.object({
  // Identity
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),

  // Profile (club-scoped, from current_member_club_profiles)
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(z.object({
    url: z.string(),
    label: z.string().nullable(),
  })),

  // Membership position in THIS club
  role: z.enum(['clubadmin', 'member']),
  isOwner: z.boolean(),            // derived: clubs.owner_member_id === member.id
  joinedAt: z.string(),             // immutable first-active timestamp

  // Trust (Kind 2: sponsorship at application time)
  sponsor: z.object({
    memberId: z.string(),
    publicName: z.string(),
  }).nullable(),

  // Trust (Kind 1: in-club peer vouching)
  vouches: z.array(z.object({
    edgeId: z.string(),
    voucher: z.object({
      memberId: z.string(),
      publicName: z.string(),
    }),
    reason: z.string(),
    createdAt: z.string(),
  })),
})
```

**NOT included** (belongs to admin shape — leaking these would be a regression):
- `isComped`, `compedAt`, `compedByMemberId`
- `approvedPriceAmount`, `approvedPriceCurrency`
- `subscription` state
- `acceptedCovenantAt`
- `leftAt`
- `state` version metadata (status, reason, versionNo, createdBy)

**NOT included** (belongs to application shape — would be a semantic lie on a member row):
- `applicationName`, `applicationEmail`, `applicationText`, `applicationSocials`
- `proofKind`, `submissionPath`
- `appliedAt`, `submittedAt`
- `generatedProfileDraft`

### 5.2 `adminMemberSummary` (strict superset of `publicMemberSummary`)

Used by: `clubadmin.members.list`, `clubadmin.members.get`.

```typescript
z.object({
  // --- Everything in publicMemberSummary, inlined ---
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(z.object({ url: z.string(), label: z.string().nullable() })),
  role: z.enum(['clubadmin', 'member']),
  isOwner: z.boolean(),
  joinedAt: z.string(),
  sponsor: z.object({
    memberId: z.string(),
    publicName: z.string(),
  }).nullable(),
  vouches: z.array(z.object({
    edgeId: z.string(),
    voucher: z.object({ memberId: z.string(), publicName: z.string() }),
    reason: z.string(),
    createdAt: z.string(),
  })),

  // --- Admin-only additions ---

  // Commercial (the whole point of this shape)
  isComped: z.boolean(),
  compedAt: z.string().nullable(),
  compedByMemberId: z.string().nullable(),   // null for platform-grant comps (owners); non-null for owner-comped non-owner admins (future feature)
  approvedPriceAmount: z.number().nullable(),
  approvedPriceCurrency: z.string().nullable(),

  // Subscription snapshot — null if comped or no subscription row, populated otherwise
  subscription: z.object({
    status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'ended']),
    currentPeriodEnd: z.string().nullable(),
    endedAt: z.string().nullable(),
  }).nullable(),

  // Admin-only state fields
  acceptedCovenantAt: z.string().nullable(),
  leftAt: z.string().nullable(),             // null for rows returned from members.list; may appear on members.get for audit reads

  // Full state machine position
  state: z.object({
    status: membershipState,                 // full enum, not narrowed
    reason: z.string().nullable(),
    versionNo: z.number().int(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
})
```

### 5.3 `adminApplicationSummary`

Used by: `clubadmin.applications.list`, `clubadmin.applications.get`. **No public counterpart.**

```typescript
z.object({
  // Identity
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string().nullable(),          // may not be set yet at application time

  // Application state machine
  state: z.object({
    status: z.enum(['applying', 'submitted', 'interview_scheduled', 'interview_completed']),
    reason: z.string().nullable(),
    versionNo: z.number().int(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
  appliedAt: z.string(),
  submittedAt: z.string().nullable(),

  // Application content (the whole point of admin access to applications)
  applicationName: z.string(),
  applicationEmail: z.string(),
  applicationSocials: z.string().nullable(),           // current column is `text`, not jsonb — see db/init.sql:633 and src/schemas/responses.ts:138. Redesigning to a structured record would require a data migration and is explicitly out of scope.
  applicationText: z.string(),
  proofKind: z.string(),
  submissionPath: z.string(),
  generatedProfileDraft: z.object({
    tagline: z.string().nullable(),
    summary: z.string().nullable(),
    whatIDo: z.string().nullable(),
    knownFor: z.string().nullable(),
    servicesSummary: z.string().nullable(),
    websiteUrl: z.string().nullable(),
    links: z.array(z.object({
      url: z.string(),
      label: z.string().nullable(),
    })).nullable(),
  }).nullable(),

  // Trust (Kind 2 only — applications have no peers, so no Kind 1 vouches[])
  sponsor: z.object({
    memberId: z.string(),
    publicName: z.string(),
  }).nullable(),

  invitation: z.object({
    id: z.string(),
    reason: z.string().nullable(),
  }).nullable(),

  // Sponsorship context (helps admins calibrate trust in the sponsor)
  sponsorStats: z.object({
    activeSponsoredCount: z.number().int(),
    sponsoredThisMonthCount: z.number().int(),
  }).nullable(),                               // null if no sponsor
})
```

**Note on vouches for applicants.** `adminApplicationSummary` deliberately has NO `vouches[]` field. Kind-1 vouches require both parties to be active members (enforced by `vouches.create` action logic and the `club_edges_unique_active_vouch` index). If a future feature wants "vouches for applicants" as a trust signal, that is a separate scope change — it would need a new edge kind or relaxed preconditions, plus a new field on this shape. **Explicitly out of scope.**

### 5.4 Shape deletions and retentions

**Shapes to DELETE** from `src/schemas/responses.ts`:

- `membershipReviewSummary` — replaced by `adminApplicationSummary`. Used today only by `clubadmin.memberships.listForReview`, which is removed in this plan.
- `membershipApplicationAdminSummary` — replaced by `adminApplicationSummary`. Used today only by `clubadmin.memberships.get`, which is removed.
- `clubMemberSummary` — replaced by `publicMemberSummary`. Used today only by `members.list`, which is rewritten.

The implementing agent should grep for each deleted type name after the rewrite and verify zero hits outside of its definition site before removing the definition. If any hit exists outside of an expected usage site, stop and surface it — it means the plan missed a caller.

**Shapes to KEEP** (explicitly — these are not orphaned):

- `membershipAdminSummary` — **NOT deleted.** This shape is also used by write-side and out-of-scope actions that this plan does NOT touch:
  - `clubadmin.memberships.create` (`src/schemas/clubadmin.ts:197`)
  - `clubadmin.memberships.setStatus` (`src/schemas/clubadmin.ts:279`)
  - `clubowner.members.promoteToAdmin` (`src/schemas/clubowner.ts:32`)
  - `clubowner.members.demoteFromAdmin` (`src/schemas/clubowner.ts:82`)
  - at least one action in `src/schemas/superadmin.ts:915`

  Migrating those actions is out of scope for this plan. Two of them (`memberships.create` and `memberships.setStatus`) have a genuinely polymorphic return type — they can operate on either an application row or a member row depending on the state transition, so a single flat shape like `membershipAdminSummary` is actually the right tool today. If a future plan wants to replace these returns with a discriminated union or split them into separate actions, that's a follow-up, not this plan. For now, `membershipAdminSummary` stays in `src/schemas/responses.ts` as the documented return shape for write-side admin actions.

- `memberSearchResult` — still used by `members.searchByFullText` / `searchBySemanticSimilarity`.
- `membershipSummary` — used across session, stream, and other non-admin surfaces. Verify still referenced before any cleanup attempt; keep.
- `vouchSummary` — still used by `vouches.list` and (as a nested sub-shape) by the new `publicMemberSummary.vouches[]` and `adminMemberSummary.vouches[]` entries. Keep.
- `memberProfileEnvelope` / `clubProfile` — still used by `profile.list`. Keep.

---

## 6. The new `vouch.received` notification topic

### 6.1 The topic

Add a new `member_notifications.topic` value: `'vouch.received'`. No schema change required — `member_notifications.topic` is already a generic `text NOT NULL` column.

### 6.2 Emission

Fired atomically inside `vouches.create`, in the same transaction as the `club_edges` insert. Same pattern as the existing `invitation.accepted` / `membership.activated` design in `plans/tokenless-apply-and-onboarding.md` §8 — use `withTransaction` with one client, insert the edge, insert the notification, commit together. If either insert fails, both roll back.

### 6.3 Recipient and payload

- `recipient_member_id` = the vouchee (`to_member_id` on the new edge)
- `club_id` = the club scope of the vouch
- `topic` = `'vouch.received'`
- `payload` (JSONB):
```json
{
  "voucher": {
    "memberId": "a7k9m2p4q8r3",
    "publicName": "Alice Hound"
  },
  "club": {
    "clubId": "clb_dogclub",
    "slug": "dogclub",
    "name": "DogClub"
  },
  "reason": "Known her professionally for three years — solid judgment, great taste.",
  "createdAt": "2026-04-16T12:34:56.789Z",
  "message": "Alice Hound vouched for you in DogClub. You can call vouches.list(clubId: 'clb_dogclub') to see all the vouches you have received in this club, or members.get(clubId: 'clb_dogclub', memberId: 'yourMemberId') to see your full member profile there. Reason: Known her professionally for three years — solid judgment, great taste."

// Note: `vouches.list(clubId: '...')` without an explicit memberId returns the caller's own vouches, because the signature tweak in §4.1 makes memberId optional-defaulting-to-self. The message deliberately leaves memberId out of the vouches.list call to keep the copy readable.
}
```

**Prose authorship.** The `message` field is **server-authored at emission time** and is the single source of truth for the human-facing copy. This matches the `headsUp` / `welcome` style in the tokenless-onboarding plan — the server composes the text, the agent relays it verbatim. Agents do NOT construct the message from the structured fields; they read `payload.message` directly. The structured fields (`voucher`, `club`, `reason`) are also in the payload so agents can build richer UI or take follow-up actions programmatically, but they are redundant with the rendered `message`.

The voucher does NOT receive a notification (only the vouchee). Self-vouches are structurally impossible — the `club_edges_no_self_vouch` constraint (`db/init.sql`) prevents `from_member_id = to_member_id` when `kind='vouched_for'` — so there is no "notification to self" edge case to handle.

### 6.4 Server-side message composer

Add a small composer function in `src/clubs/welcome.ts` (or a similarly scoped module if `welcome.ts` doesn't exist yet at implementation time — put it next to the other notification copy composers):

```typescript
function buildVouchReceivedMessage(input: {
  voucherPublicName: string;
  clubName: string;
  clubId: string;
  vouchedMemberId: string;
  reason: string;
}): string {
  return `${input.voucherPublicName} vouched for you in ${input.clubName}. ` +
    `You can call vouches.list(clubId: '${input.clubId}') to see all the vouches ` +
    `you have received in this club, or members.get(clubId: '${input.clubId}', ` +
    `memberId: '${input.vouchedMemberId}') to see your full member profile there. ` +
    `Reason: ${input.reason}`;
}
```

The `vouches.create` handler calls this composer inside the same transaction as the edge insert and the notification insert, passing the rendered string into `payload.message` before the insert. Unit-test the composer independently so the copy is locked in.

**Optional future work (NOT in this plan):** if Owen wants per-club override copy (the way the tokenless-onboarding plan allows `clubs.welcome_template`), add a `vouch_received_template` JSONB column later. For now, the composer is generic, one template for all clubs, no override.

### 6.5 Acknowledgement (includes a `notifications.acknowledge` filter flip — new scope)

`vouch.received` must be acknowledgeable — without that, the notification sits in the inbox forever and the agent re-relays it to the human on every new conversation. Not acceptable UX.

**But the current `notifications.acknowledge` rule rejects it.** The current check is an *inverted allowlist* — only notification IDs starting with `synchronicity.` are acknowledgeable; everything else returns a 422 rejection. That predates the materialized-notifications work and is the wrong shape for a system that has multiple legitimate materialized topics (`invitation.accepted`, `membership.activated`, and now `vouch.received`).

**This plan flips the check from allowlist to blocklist** so every materialized notification topic is acknowledgeable by default, and only genuinely derived topics (synthesized on the read path, not stored as rows) are rejected. The flip:

- **Current behavior.** Dispatch layer at `src/schemas/notifications.ts:104-105` rejects any notification id that does not start with `synchronicity.`. Repository layer at `src/postgres.ts` has its own mirror of the same check in `acknowledgeNotifications`. Both need to change together — if the dispatch layer permits a topic but the repo layer drops it, the acknowledge silently no-ops.
- **New behavior.** Both layers change to: **reject only notification IDs whose topic starts with `application.`**. Anything else — including `synchronicity.*`, `invitation.*`, `membership.*`, `vouch.*`, and any future materialized topic — is acknowledgeable. `application.*` stays excluded because those topics are synthesized on the read path from `current_admissions`, not stored as rows, so there is nothing to acknowledge.
- **Why this is a blocklist, not an allowlist.** Future materialized topics should inherit acknowledgeability by default. A developer adding a new notification topic should not also need to remember to add it to a central allowlist — that's the exact kind of maintenance burden that leads to forgotten updates. The blocklist is the structural default that makes the right thing easy.

**Two sites to flip, both in lockstep.** The implementing agent must update:
1. `src/schemas/notifications.ts` around line 104-105 — the dispatch-layer check on `notifications.acknowledge` input.
2. `src/postgres.ts` in the `acknowledgeNotifications` repository method — the mirror check.

Both must invert in the same commit. A one-sided flip silently breaks acknowledge in a hard-to-diagnose way.

**This flip also removes scope from workstream #3.** `plans/tokenless-apply-and-onboarding.md` previously included an item titled something like "notifications.acknowledge topic check inverted from allowlist to blocklist." That item is now unnecessary — this plan does it. When the tokenless-onboarding plan is next read by an agent, it may note the item as "already done in workstream #2" and skip it. Do NOT edit the tokenless-onboarding plan from this workstream; it's out of scope here. Just let the agent reading workstream #3 later discover that the flip is already live.

**Tests for the flip** (added to §9.8):
- Acknowledging a `vouch.received` notification returns 200, not 422.
- Acknowledging a hypothetical `invitation.accepted` notification also returns 200 (lock in that other materialized topics inherit the default).
- Acknowledging a `synchronicity.*` notification still returns 200 (regression — don't accidentally break the previously-working path).
- Attempting to acknowledge an `application.*` notification still returns 422 (the blocklist still rejects derived topics).
- Dispatch-layer check and repo-layer check agree in lockstep — a test that exercises both layers end-to-end and asserts no silent no-op.

### 6.6 Where this integrates

The implementing agent must touch:
- `src/schemas/membership.ts` — the `vouches.create` handler needs to open (or reuse) a transaction that wraps the edge insert and the notification insert.
- The repository layer — if `createVouch` (or similar) is exposed on the Repository interface, add a parameter or a new method that also writes the notification in the same transaction.
- `src/notifications-core.ts` — if there is a central notification topic list or type, add `'vouch.received'` to it.
- SKILL.md — document the new topic in the notifications section (§7.3).

---

## 7. SKILL.md update obligation

Three sections need rewriting or new content. Land the SKILL.md edits in the same commit as the code change.

### 7.1 "How an agent sees a member" section (member-facing)

- Replace every reference to the old `members.list` response shape with the new `publicMemberSummary` shape (vouches inline, flattened fields, no nested `memberships[]` array).
- Add a new paragraph for `members.get(clubId, memberId)`: when to use it, what it returns, the fact that it 404s on non-members without redirecting to an admin action.
- Add an explicit explanation of Kind-1 vs Kind-2 vouches as they appear on the member shape: the `sponsor` field is who originally brought this person into the club; the `vouches[]` array is who has vouched for them since joining. Both are "who vouched for what," just at different phases of the trust lifecycle.
- Add an explicit rule: **regular members never see applications**. If a user asks the agent "who is applying to join our club right now," the agent should respond that application visibility is admin-only and offer to check whether the user is an admin.

### 7.2 "How an admin reviews applications" and "How an admin inspects their club" sections

- Remove every reference to `clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, `clubadmin.memberships.get`. They no longer exist.
- Replace with `clubadmin.members.list` / `clubadmin.members.get` / `clubadmin.applications.list` / `clubadmin.applications.get`.
- Make the category boundary explicit: "To list members, call `clubadmin.members.*`. To list applications, call `clubadmin.applications.*`. These are different concepts with different response shapes. You cannot pass an application membershipId to `clubadmin.members.get` — it returns 404 with a sibling-action redirect."
- Document the new admin-shape commercial fields (`isComped`, `compedAt`, `subscription`, etc.) and what they mean in practice (owners are always comped with `compedByMemberId: null`; non-owner clubadmins pay unless manually comped by the owner; `subscription: null` means comped or no live billing row).
- Confirm that `clubadmin.memberships.create` and `clubadmin.memberships.setStatus` retain their names because they are boundary-crossing state machine operations.

### 7.3 Notifications section

- Add `vouch.received` to the documented topic list:
  - When it fires: "whenever someone vouches for you via `vouches.create`"
  - Recipient: the vouchee only
  - Payload shape (reference §6.3)
  - Expected agent behavior: relay the template message from §6.4 verbatim to the human, then call `notifications.acknowledge`
- Make sure the existing topics (`invitation.accepted`, `membership.activated`, etc. from the tokenless-onboarding plan if that lands first) are still documented alongside the new one.

---

## 8. docs/design-decisions.md update obligation

Add a new subsection under the appropriate admin-API section documenting:

1. **The 2-axis design.** Entity type × visibility level. Three response shapes (`publicMemberSummary`, `adminMemberSummary`, `adminApplicationSummary`). No public application shape because applications are admin-only. Two of the four quadrants are shapes; one is "no surface"; one is the admin application shape.
2. **The vouches vs sponsorship distinction.** Kind 1 (peer vouches, `club_edges`) and Kind 2 (sponsorship, `club_memberships.sponsor_member_id` + `invitations`) are separate concepts, surfaced as separate fields on both member shapes. An applicant can only have Kind 2. A member can have many Kind 1 and at most one Kind 2.
3. **The rationale for keeping write-side unified.** `memberships.create` and `memberships.setStatus` cross the boundary intentionally. Splitting them would require two cooperating actions to transition a row, which is structurally wrong.
4. **The rationale for no public applications surface.** Regular members have zero visibility into in-flight applications. Enforced structurally (no public action exists), not by filtering. The only member-facing role in the application flow is sponsorship/invitation.
5. **Payment exposure is new in this plan.** Before this plan, payment data was exposed to nobody. After this plan, it is exposed to clubadmins, clubowners, and superadmins via the admin shapes. Regular members still see none of it.
6. **The `vouch.received` notification topic.** New materialized topic, recipient = vouchee, atomic with the edge insert, acknowledgeable.
7. **The `notifications.acknowledge` allowlist → blocklist flip.** Previously only `synchronicity.*` topics were acknowledgeable (inverted allowlist). Now every topic is acknowledgeable except `application.*` (blocklist of genuinely derived topics). This is the long-term elegant shape and removes a planned item from workstream #3 (`plans/tokenless-apply-and-onboarding.md`).

Two to three short paragraphs plus a bullet list is enough. This is a decision record that future-us should be able to find without archaeology.

---

## 9. Tests

The incident that triggered this plan was the absence of regression tests locking in filter and shape behavior. The new tests close the gap end-to-end.

### 9.1 Leak audit regression test (the most important test in this plan)

**Goal.** Structurally guarantee that "regular members see zero application data" holds across every current and future member-readable action. A future developer who adds a new member-facing action that surfaces application content must be caught immediately by this test.

**Test file.** `test/integration/non-llm/leak-audit.test.ts` (new).

**Forbidden-field set.** Any response field with any of these names, anywhere in the response body (top-level or nested), is considered a leak:

```
applicationText
applicationEmail
applicationName
applicationSocials
proofKind
submissionPath
generatedProfileDraft
```

Note on `appliedAt` / `submittedAt`: these are deliberately NOT in the forbidden set. Those two fields are timestamps, not content, and there may be legitimate reasons to surface them in future member-facing actions (e.g. a "your application was received" confirmation on `session.getContext` for an in-flight applicant calling their own session). The invariant we're locking in is that application *content* never leaks, not that application *timestamps* never leak. If we later want to tighten the rule, we can add them to the set.

**Fixture map.** Input generation is not auto-derivable from strict Zod schemas (for actions that take `clubId`, `memberId`, `query`, etc., we need real seeded values). Maintain an explicit fixture map keyed by action name, in a file the test imports:

`test/integration/non-llm/leak-audit-fixtures.ts`:

```typescript
export interface LeakAuditFixture {
  /** Input builder. Receives seeded context and returns the action input. */
  buildInput: (ctx: LeakAuditContext) => Record<string, unknown>;
  /** Optional justification — useful when skipping is deliberate. */
  note?: string;
  /** If true, the action is called but the response is not walked (e.g. mutating actions we don't want to trigger). */
  skipResponseWalk?: boolean;
}

export interface LeakAuditContext {
  testClubId: string;
  testMemberId: string;              // the caller, a regular member of the test club
  otherMemberId: string;              // another active member of the test club
  applicantMemberId: string;          // an applicant in the test club (presence of applicant rows is the whole point of the seed)
  otherClubId: string;                // a club the caller is NOT in
}

export const LEAK_AUDIT_FIXTURES: Record<string, LeakAuditFixture> = {
  'members.list':                  { buildInput: (ctx) => ({ clubId: ctx.testClubId, limit: 50 }) },
  'members.get':                   { buildInput: (ctx) => ({ clubId: ctx.testClubId, memberId: ctx.otherMemberId }) },
  'members.searchByFullText':      { buildInput: (ctx) => ({ clubId: ctx.testClubId, query: 'a', limit: 20 }) },
  'members.searchBySemanticSimilarity': {
    buildInput: (ctx) => ({ clubId: ctx.testClubId, query: 'test', limit: 20 }),
    note: 'Requires the test-mode embedding stub from §9.1.1. Included in the sweep so the structural guarantee covers every member-callable read action.',
  },
  'content.searchBySemanticSimilarity': {
    buildInput: (ctx) => ({ clubId: ctx.testClubId, query: 'test', limit: 20 }),
    note: 'Also requires the §9.1.1 stub. Same embedding provider, same seam, same fixture shape.',
  },
  'profile.list':                  { buildInput: (ctx) => ({ memberId: ctx.otherMemberId, clubId: ctx.testClubId }) },
  'vouches.list':                  { buildInput: (ctx) => ({ clubId: ctx.testClubId, limit: 20 }) },  // memberId omitted — relies on the §4.1 signature tweak to default to the caller
  'invitations.listMine':          { buildInput: () => ({}) },
  'session.getContext':            { buildInput: () => ({}) },
  // ... add every other auth: 'member' | 'optional_member' action with safety: 'read_only'
};
```

**Test body.**

```typescript
describe('leak audit: regular members never see application content', () => {
  it('every member-callable read action has a fixture and no leak', async () => {
    const actions = getActionRegistry()
      .filter(a => (a.auth === 'member' || a.auth === 'optional_member') && a.safety === 'read_only');

    const missingFixtures = actions
      .map(a => a.action)
      .filter(name => !(name in LEAK_AUDIT_FIXTURES));

    assert.deepStrictEqual(
      missingFixtures,
      [],
      `These member-callable read actions have no leak-audit fixture. Add them to test/integration/non-llm/leak-audit-fixtures.ts: ${missingFixtures.join(', ')}`,
    );

    for (const action of actions) {
      const fixture = LEAK_AUDIT_FIXTURES[action.action];
      if (fixture.skipResponseWalk) continue;

      const input = fixture.buildInput(ctx);
      const response = await h.apiOk(regularMemberToken, action.action, input);
      const leaks = findForbiddenFields(response, FORBIDDEN_FIELD_SET);
      assert.deepStrictEqual(
        leaks,
        [],
        `Action ${action.action} leaked application content at paths: ${leaks.join(', ')}`,
      );
    }
  });
});
```

`findForbiddenFields` is a recursive walker that returns an array of dotted paths where any forbidden field name appears. A leak-free response returns `[]`.

**Critical property: adding a new action without a fixture FAILS the test.** The `missingFixtures` check at the top of the test body ensures the developer cannot add a new `auth: 'member' | 'optional_member'` read action without explicitly writing a fixture for it, which forces them to think about input shape AND whether the action's response could leak application content. If they skip the thinking, the test fails on the next CI run.

**Seed setup (harness helper).** The test needs a dedicated helper `seedLeakAuditScenario` that produces the `LeakAuditContext` with all the required rows: a test club, a regular member caller, another active member, at least one applicant (in `applying` or `submitted`), and a second unrelated club the caller is NOT in. Drop this helper into `test/integration/harness.ts` next to the other seed helpers.

### 9.1.1 Test-mode embedding stub (prerequisite for the full sweep)

**Current state.** There is NO centralized embedding helper today. `src/ai.ts` contains only constants (model names, dimensions, `EMBEDDING_PROFILES`) — it does NOT wrap any provider call. The `embed` function from the Vercel AI SDK is imported directly at two action-level call sites and one worker call site:

- `src/schemas/membership.ts:432-488` — `members.searchBySemanticSimilarity` handler. Dynamically imports `embed` from `'ai'` and `createOpenAI` from `'@ai-sdk/openai'`, builds a provider per call, invokes `embed({ model, value, providerOptions })`. Member-callable, in the leak audit sweep.
- `src/schemas/entities.ts:725` — `content.searchBySemanticSimilarity` handler. Same inline pattern. **Also member-callable, also in the leak audit sweep.** (Both action-level call sites must go through the same seam so the audit covers both.)
- `src/workers/embedding.ts:242` — `embedMany` call for batch profile embedding. Not an action, not in the sweep, but noted here because the same env-var stub naturally covers it if the seam is module-level.

The leak audit lives in `test:integration:non-llm`, which must not make real network calls to OpenAI. The audit therefore depends on a test-mode embedding stub that returns a deterministic vector for any input string.

**What to build:**

1. **Helper in `src/ai.ts`.** Add a new exported async function `embedQueryText(params: { value: string; profile: EmbeddingProfileKey })` (or similar signature) alongside the existing constants. The helper encapsulates: env-var check for stub mode, OpenAI provider construction, `embed` call, error handling. Return shape: `{ embedding: number[]; usageTokens: number }` (matching what the call sites currently destructure). This is a small refactor — the inline logic at the two action call sites moves into the helper.
2. **Stub mode via env var.** Inside `embedQueryText`, check `process.env.CLAWCLUB_EMBEDDING_STUB === '1'` (or similar — pick a name that matches existing env conventions). When set, return a deterministic vector of length `profile.dimensions` (1536 for `member_profile` and `entity`) without touching the provider. A fixed or query-hashed vector is fine; semantics don't matter, just determinism. Usage tokens = 0 in stub mode.
3. **Update the two member-callable call sites.** `src/schemas/membership.ts:432-488` and `src/schemas/entities.ts:725` both stop inlining `embed`/`createOpenAI` and instead call `embedQueryText(...)`. Keep all the surrounding behavior identical: the `OPENAI_API_KEY` check (503 if missing — but only when NOT in stub mode; stub mode should bypass it), the `logLlmUsage` calls on success and error, the error handling with 503 `embedding_unavailable`. Preserve existing behavior, just move the provider call into the helper.
4. **Optionally also cover `src/workers/embedding.ts:242`.** That site uses `embedMany` (batch), not `embed`. If extracting a parallel `embedManyDocuments` helper in `src/ai.ts` is mechanical, do it for consistency. If it would meaningfully expand scope, leave it as a note for a follow-up — the worker isn't in the leak audit sweep, so it's not blocking.
5. **Harness install hook.** `TestHarness.start()` sets `process.env.CLAWCLUB_EMBEDDING_STUB = '1'` before any test code runs, and restores the previous value on teardown. The stub is installed for ALL tests in `test:integration:non-llm` so any future non-llm test that touches semantic search (member or content) just works without the test author having to remember. Tests in `test:integration:with-llm` should NOT have the env var set — they're the ones that exercise the real provider.
6. **Document the seam.** A short comment block at the top of `embedQueryText` explaining the env-var override pattern, so a future developer understands why the helper checks a test-mode env var before hitting the network.

**Fallback.** If the implementing agent finds the extraction is more tangled than expected (some subtle dependency on `ctx.repository.logLlmUsage` or a provider-construction detail that doesn't cleanly move into a helper), they MAY downgrade to marking BOTH `members.searchBySemanticSimilarity` and `content.searchBySemanticSimilarity` with `skipResponseWalk: true` in the leak audit fixture map, plus a TODO in both the fixture file and this plan section for a follow-up. This is a **last resort**, not a default — the default target is to build the helper. If the agent takes the fallback, they must surface the reason in their implementation report so Owen can decide whether to accept the permanent guarantee gap on two member-callable actions rather than just one.

### 9.2 `members.list` integration tests

Seed a club with 10 members (4 regular, 2 with Kind-1 vouches each from different vouchers, 1 comped owner, 1 invited via sponsor, 3 uninvited active members). Mix in 2 applicants (`applying`/`submitted`) and 1 declined row to verify they do not appear.

1. **Default scope.** Call `members.list(clubId)` as a regular member. Assert exactly 10 rows. Assert none match the 2 applicants or the 1 declined.
2. **Shape.** Assert every row matches `publicMemberSummary` exactly — run strict schema validation. Assert `isComped`, `compedAt`, `subscription`, `applicationText` are NOT present.
3. **Vouches surfaced.** Assert the 2 members who have vouches have populated `vouches[]` arrays with correct `edgeId`, `voucher.{memberId, publicName}`, `reason`, `createdAt`.
4. **Sponsor surfaced.** Assert the 1 invited member has a populated `sponsor` field with the inviter's `memberId` and `publicName`. Non-invited members have `sponsor: null`.
5. **Flattened shape.** Assert there is NO nested `memberships: [...]` array on each row. `role`, `joinedAt`, `isOwner` are top-level.
6. **Pagination.** Seed > limit rows, paginate to completion, assert no duplicates or gaps.
7. **Authorization.** A non-member of the club cannot call the action (403 forbidden).

### 9.3 `members.get` integration tests

Same seeded club as §9.2.

1. **Happy path.** Call `members.get(clubId, memberId)` for one of the 10 members. Assert single-row response matches `publicMemberSummary`.
2. **Self-fetch.** Call `members.get(clubId, actorMemberId)`. Assert success.
3. **Applicant 404.** Call `members.get(clubId, applicantMemberId)`. Assert 404 `not_found`. Assert the error message does NOT contain the string `'clubadmin.applications.get'` — regular members do not get admin-action redirects.
4. **Declined member 404.** Same, assert 404.
5. **Cross-club 404.** Call `members.get(clubA, memberInClubB)` from a caller who is in both. Assert 404.
6. **Vouches and sponsor populated.** Fetch a member who has 2 vouches and a sponsor. Assert both are in the response.

### 9.4 `clubadmin.members.list` integration tests

Seed a club similar to §9.2 plus: 1 member with a lapsed subscription (should NOT appear post-77e293d), 1 comped non-owner admin, 1 member in `renewal_pending` within the 7-day grace window.

1. **Default scope.** Call as admin with no filters. Assert the row set matches `accessible_club_memberships` for the club (10 active + comped admin + renewal_pending = 12, minus the lapsed one).
2. **Shape.** Assert every row has admin-only fields populated: `isComped`, `compedAt`, `subscription` (or null if comped), `state`. Run strict schema validation against `adminMemberSummary`.
3. **Owner comp shape.** Assert the comped owner has `isComped: true`, `compedByMemberId: null`, `subscription: null`.
4. **Non-owner comped admin shape.** Assert that row has `isComped: true`, `compedByMemberId` set to a non-null value, `subscription: null`.
5. **Paying member shape.** Assert a regular active member has `isComped: false`, `compedByMemberId: null`, `subscription: { status: 'active', currentPeriodEnd: ..., endedAt: null }`.
6. **Status filter narrowing.** Call with `statuses: ['active']`. Assert the `renewal_pending` member is excluded.
7. **Role filter.** Call with `roles: ['clubadmin']`. Assert only admins returned.
8. **Combined filter.** Call with `statuses: ['active'], roles: ['member']`. Assert regular active members appear, no admins, no renewal_pending.
9. **Cross-boundary filter rejection.** Call with `statuses: ['applying']`. Assert 422 `invalid_input` with a message containing `'clubadmin.applications.list'`.
10. **Cross-boundary filter rejection — terminal.** Call with `statuses: ['declined']`. Assert 422 (terminal states are not in scope for either new action).
11. **Status filter correctness lock-in.** Call with `statuses: ['active']` in a club with 5 active members plus other non-active rows. Assert the count is exactly 5 — not zero, not everything. Label the test: `'clubadmin.members.list statuses=active returns only active rows'`. This is the permanent net against the class of "did we silently drop the filter" bug the incident was misdiagnosed as.
12. **View-based semantics.** Lapse one active member's subscription via `lapseSubscription` (direct SQL helper from `clubadmin-access.test.ts`). Call `clubadmin.members.list` — the lapsed member is absent.
13. **Pagination and authorization.** Same discipline as §9.2 tests 6 and 7.

### 9.5 `clubadmin.members.get` integration tests

Same seeded club.

1. **Happy path.** Fetch one active member by membershipId. Assert `adminMemberSummary` shape.
2. **Applicant 404 with sibling redirect.** Fetch an applicant by membershipId. Assert 404 AND the error message contains `'clubadmin.applications.get'`.
3. **Terminal state 404 without redirect.** Fetch a declined member. Assert 404 AND the error message does NOT contain `'clubadmin.applications.get'` (plain "not found" message, because no sibling action exists).
4. **Lapsed subscription 404.** After a subscription is lapsed, fetch the previously-active member. Assert 404 — they are no longer in the view.
5. **Commercial fields populated.** Assert payment/comp/subscription fields are correct on the returned row.

### 9.6 `clubadmin.applications.list` integration tests

Seed a club with: 2 `applying`, 3 `submitted`, 1 `interview_scheduled`, 1 `interview_completed`, 4 active members, 1 `declined`, 1 `withdrawn`. One of the submitted rows has a sponsor; one of the applying rows is a cold applicant.

1. **Default scope.** Call as admin with no filters. Assert exactly 7 rows (2+3+1+1). Assert none of the 4 active members appear. Assert neither terminal row appears.
2. **Shape.** Assert every row matches `adminApplicationSummary`. Assert `applicationText`, `applicationEmail`, `proofKind` are populated. Assert `isComped`, `subscription` are NOT present.
3. **Sponsor surfaced when present.** Assert the submitted row with a sponsor has a populated `sponsor` field AND a populated `sponsorStats` field.
4. **Sponsor absent for cold applicants.** Assert the cold applicant has `sponsor: null` and `sponsorStats: null`.
5. **Status filter narrowing.** Call with `statuses: ['submitted']`. Assert exactly 3 rows.
6. **Status filter multi.** Call with `statuses: ['submitted', 'interview_scheduled']`. Assert exactly 4 rows.
7. **Cross-boundary filter rejection.** Call with `statuses: ['active']`. Assert 422 with message containing `'clubadmin.members.list'`.
8. **Cross-boundary filter rejection — terminal.** Call with `statuses: ['declined']`. Assert 422.
9. **Pagination and authorization.** Same discipline.
10. **No vouches field.** Assert the response shape has NO `vouches[]` field on application rows. Kind-1 vouches do not exist on applicants in this model.

### 9.7 `clubadmin.applications.get` integration tests

1. **Happy path.** Fetch one `applying` row. Assert `adminApplicationSummary` shape.
2. **Member 404 with sibling redirect.** Fetch an active member by membershipId. Assert 404 AND the error message contains `'clubadmin.members.get'`.
3. **Terminal state 404 without redirect.** Fetch a withdrawn application. Assert 404 with plain message.

### 9.8 `vouch.received` notification tests AND the `notifications.acknowledge` filter flip

Setup: two active members in a club, Alice and Bob.

1. **Happy path.** Alice calls `vouches.create(clubId, memberId: bob.id, reason: '...')`. Assert the edge exists. Assert Bob has a new `vouch.received` notification with the correct payload shape. Assert Alice does NOT have a new notification.
2. **Notification visible in `notifications.list`.** Call `notifications.list` as Bob. Assert the vouch notification appears.
3. **Acknowledgement (post-flip).** Call `notifications.acknowledge` with the vouch notification id as Bob. Assert 200 OK. This test fails if the filter flip from §6.5 has not been applied, which is the lock-in that both flip sites (dispatch + repo) land together.
4. **Payload contains server-authored `message`.** Assert the payload has a top-level `message` string, produced by `buildVouchReceivedMessage`, containing the voucher name, club name, and reason. Unit-test the composer separately to lock in the copy.
5. **Transactional atomicity.** Arrange a duplicate vouch (Alice vouches for Bob twice). Assert the second call fails (existing unique-index behavior) AND no notification is inserted for the failed attempt. Count the notifications before and after — the delta is exactly 1 (from the first successful vouch), not 2.
6. **Payload structural correctness.** Assert the payload contains `voucher.memberId`, `voucher.publicName`, `club.clubId`, `club.slug`, `club.name`, `reason`, `createdAt`, and `message` — all populated, all correct.
7. **Self-vouch prevention (structural).** Verify via an attempted `vouches.create` where voucher === vouchee that the existing `club_edges_no_self_vouch` constraint rejects it at the database level, and that no notification is created.

**Filter-flip coverage (independent of vouches):**

8. **Synchronicity topics still acknowledgeable (regression).** Create a synchronicity notification (or use an existing seeded one). Call `notifications.acknowledge`. Assert 200 — the flip did not break the previously-working path.
9. **Application topics still rejected.** Attempt `notifications.acknowledge` on an `application.submitted` notification (synthesized via the existing `current_admissions` read path). Assert 422 with the expected error code. The blocklist still rejects derived topics after the flip.
10. **Dispatch / repo lockstep.** Construct a test that exercises both the dispatch-layer check (at `src/schemas/notifications.ts`) and the repo-layer check (at `src/postgres.ts`) end-to-end for a topic that the dispatch layer PERMITS. Assert the notification is actually marked acknowledged in the DB (not silently no-op'd). This is the regression net against the "one layer flipped, the other didn't" failure mode.
11. **Future materialized topic inherits acknowledgeability by default.** Create a fake notification row with a topic string the plan has never seen (e.g. `'test.inherited_ack_default'`). Call `notifications.acknowledge`. Assert 200. This locks in the "blocklist, not allowlist" structural rule — adding a new topic in the future should inherit acknowledgeability without any central registry update.

### 9.9 Removal tests

1. `clubadmin.memberships.list` is no longer in the registry. Calling it returns 400 `unknown_action`. Assert the error is generic (no redirect text).
2. `clubadmin.memberships.listForReview` — same.
3. `clubadmin.memberships.get` — same.
4. `/api/schema` does not contain any of the three removed action names. Grep the schema response body for each — zero hits.

### 9.10 API schema snapshot update

`test/snapshots/api-schema.json` will change significantly. Regenerate the snapshot as part of the implementation. The diff should show: three actions removed (`clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, `clubadmin.memberships.get`); four admin actions added (`clubadmin.members.list`, `clubadmin.members.get`, `clubadmin.applications.list`, `clubadmin.applications.get`); one public action added (`members.get`); `members.list` response shape changed; three response shapes removed (`membershipReviewSummary`, `membershipApplicationAdminSummary`, `clubMemberSummary`); three new response shapes added (`publicMemberSummary`, `adminMemberSummary`, `adminApplicationSummary`); `membershipAdminSummary` retained unchanged (still referenced by the write-side and out-of-scope actions listed in §5.4 — its definition in the snapshot should be unmodified); one notification topic added (`vouch.received`).

---

## 10. Not in scope

Explicitly out of scope for this plan. Do not expand into any of these:

- **Schema-level split of applications and members.** The unified state machine stays. This is an API surface decision, not a data model decision. The data model unification is load-bearing for the tokenless-onboarding plan and for state-machine correctness.
- **`superadmin.members.list` / `superadmin.members.get`.** Platform-wide cross-club admin views serve a different concern and stay as-is.
- **Vouches for applicants.** The existing model requires both parties to be active members. A "vouches for applicants" feature would be a new edge kind with different constraints, plus a new field on the application shape. Separate plan if it becomes a priority.
- **Cross-club vouch aggregation redesign.** `vouches.list` stays.
- **Collapsing `profile.list` into `members.get`.** Different access patterns, both stay.
- **Changes to `members.searchByFullText` / `members.searchBySemanticSimilarity` response shape.** The existing `memberSearchResult` shape is fine. Optional consistency improvement (add `vouches[]` inline) is flagged as a nice-to-have, not required.
- **Any `clubadmin.*` action not named in §4.3 or §4.4.** Do not touch `clubadmin.clubs.getStatistics`, `clubadmin.memberships.create`, `clubadmin.memberships.setStatus`, or any other action not in this plan.
- **Dispatcher special-case redirect text for removed actions.** Generic `unknown_action` is the correct first-principles answer.
- **New notification transport / infrastructure.** `vouch.received` rides on the existing `member_notifications` + `/stream` + `notifications.list` + `notifications.acknowledge` pipeline. No new tables, no new schema columns, no new delivery channel.
- **A public action for manually comping a non-owner clubadmin.** Documented in `docs/design-decisions.md` as a future product rule; no public action exists yet and this plan does not add one. Direct DB operation only.

---

## 11. Done checklist

- [ ] `publicMemberSummary`, `adminMemberSummary`, `adminApplicationSummary` defined in `src/schemas/responses.ts`.
- [ ] `members.list` rewritten in `src/schemas/membership.ts` to return `publicMemberSummary[]`. Underlying repo query flattened (no more `memberships: [...]` with one row). Vouches joined inline.
- [ ] `members.get` action added with `publicMemberSummary` output.
- [ ] `clubadmin.members.list` action added with `adminMemberSummary[]` output, `statuses` and `roles` filters, cross-boundary rejection.
- [ ] `clubadmin.members.get` action added with `adminMemberSummary` output, sibling-redirect 404 on application rows, plain 404 on terminal rows.
- [ ] `clubadmin.applications.list` action added with `adminApplicationSummary[]` output, `statuses` filter, cross-boundary rejection.
- [ ] `clubadmin.applications.get` action added with `adminApplicationSummary` output, sibling-redirect 404 on member rows.
- [ ] `clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, `clubadmin.memberships.get` removed from the registry and from `src/schemas/clubadmin.ts`. Generic `unknown_action` on call.
- [ ] Legacy response shapes `membershipReviewSummary`, `membershipApplicationAdminSummary`, `clubMemberSummary` removed from `src/schemas/responses.ts`. Grep post-edit to confirm zero orphan references.
- [ ] `membershipAdminSummary` retained (explicitly NOT deleted) as the return shape for write-side and out-of-scope actions per §5.4. Confirm it is still referenced by `clubadmin.memberships.create`, `clubadmin.memberships.setStatus`, `clubowner.members.promoteToAdmin`, `clubowner.members.demoteFromAdmin`, and the superadmin action at `src/schemas/superadmin.ts:915`. Do NOT touch those actions.
- [ ] Repository methods `listMemberships` / `listMembershipReviews` replaced or reshaped as needed. New repo methods for the new actions (suggested names: `listMembersAdmin`, `getMemberAdmin`, `listApplicationsAdmin`, `getApplicationAdmin`) querying the right tables/views.
- [ ] New notification topic `'vouch.received'` fired atomically inside `vouches.create` using `withTransaction`. Repository layer updated to accept the notification insert alongside the edge insert. `buildVouchReceivedMessage` composer added and unit-tested.
- [ ] `vouches.list` signature tweak: `memberId` made optional, defaulting to the caller when omitted. Handler reads `memberId ?? ctx.actor.member.id`. No repository-layer change needed. Existing callers that pass memberId explicitly continue to work.
- [ ] `notifications.acknowledge` filter flip landed: dispatch-layer check at `src/schemas/notifications.ts` and repo-layer check at `src/postgres.ts` BOTH inverted from `synchronicity.*`-only allowlist to `application.*`-only blocklist. **Both sites flipped in the same commit — a one-sided flip silently breaks acknowledge.**
- [ ] `embedQueryText` helper added to `src/ai.ts` per §9.1.1. `src/schemas/membership.ts:432-488` and `src/schemas/entities.ts:725` both refactored to call it instead of inlining `embed` + `createOpenAI`. Env-var stub mode returns a deterministic vector. `TestHarness.start()` sets the env var for all non-llm tests. BOTH `members.searchBySemanticSimilarity` and `content.searchBySemanticSimilarity` are included in the leak audit sweep.
- [ ] SKILL.md updated per §7 (member-facing section, admin-facing section, notifications section).
- [ ] `docs/design-decisions.md` updated per §8.
- [ ] `test/integration/non-llm/leak-audit-fixtures.ts` created with fixtures for every current `auth: 'member' | 'optional_member'` read action. `test/integration/non-llm/leak-audit.test.ts` created and passes per §9.1. Adding a new member-callable action without a fixture MUST fail the test.
- [ ] `seedLeakAuditScenario` helper added to `test/integration/harness.ts`.
- [ ] Every test in §9.2 through §9.9 passes.
- [ ] `test/snapshots/api-schema.json` regenerated and diff reviewed.
- [ ] `npm run check` passes.
- [ ] `npm run test:unit` passes.
- [ ] `npm run test:integration:non-llm` passes.
- [ ] `package.json` patch version bumped.
- [ ] Local commit created with a tight commit message that names the scope (admin/member read split, new shapes, vouch notification). **No push.** Implementing agent presents to Owen for explicit push authorization.

When Owen authorizes, push, then:

- [ ] Confirm `/api/schema` on production no longer contains `clubadmin.memberships.list`, `clubadmin.memberships.listForReview`, `clubadmin.memberships.get`.
- [ ] Confirm the four new admin actions and `members.get` appear on production.
- [ ] Smoke test: call `clubadmin.members.list` on a real production club and verify `isComped` populates for owner rows.
- [ ] Smoke test: call `members.list` on a real club as a regular member and verify `vouches[]` appears inline (non-empty for members who have received vouches).
- [ ] Smoke test: create a test vouch via the real API and verify the vouchee receives a `vouch.received` notification via `/stream` or `notifications.list`.

Only then is the work complete.
