# Onboarding ceremony, notification fanout, and state-machine hardening

**Status:** ready for review
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-16
**Supersedes:** the auth-invariant portions of `plans/tokenless-apply-and-onboarding.md`. The credential-redesign portions of that plan are split out to `plans/credential-redesign.md` and deferred pending a decision about whether we keep bearer tokens, move to HMAC-style signed requests, or move to a public-key identity scheme.

This plan delivers three orthogonal improvements that are **credential-invariant** — nothing in here depends on how a caller authenticates. These pieces are useful under the current bearer-token model and would remain useful (with only cosmetic changes to SKILL.md wording) under any future signed-request scheme.

The three pieces:

1. **A state-machine bug fix.** `clubadmin.memberships.setStatus` currently accepts any state → any state. Today a clubadmin can move `banned → active`, skipping the application gate entirely. This must be closed before we ship anything else.
2. **An onboarding ceremony.** New members currently authenticate as soon as they have a credential, with zero welcome and zero introduction to the club. We add a server-enforced gate on `members.onboarded_at` that restricts a brand-new credentialed member to exactly two actions (`session.getContext`, `clubs.onboard`) until the welcome ceremony runs. The ceremony itself is a single-call action returning a server-authored welcome payload that the agent relays verbatim.
3. **Notification fanout at admission.** Sponsors are currently silent when their invitee gets in. Cross-joiners are currently silent when a new club is unlocked for them. We add two new materialized notification topics — `invitation.accepted` for sponsors, `membership.activated` for cross-joiners — with server-authored prose payloads the agent relays verbatim.

None of this introduces new credential primitives, changes the `clubs.join` response shape, or changes how bearer tokens are issued. That is the separate Phase B work.

---

## 1. What is NOT in this plan

To prevent the implementing agent from pattern-matching on "while we're here, let's also…" — and to make the boundary with Phase B unambiguous — the following are deliberately out of scope:

- **Credential primitives and lifecycle.** No `applicationKey`. No removal of `memberToken` from `clubs.join`. No delay of bearer-token issuance from `clubs.join` to admission. No `clubadmin.accessTokens.create`. No `accessToken` in the `setStatus` response envelope. Those all live in `plans/credential-redesign.md`.
- **The billing-path delivery question.** "How does the bearer token get to a paid-club applicant when Stripe drives the `payment_pending → active` transition" is a Phase B problem because it only exists if Phase B's admin-delivery model is adopted.
- **Email transport of any kind.** Ceremony is structural; delivery is orthogonal.
- **Web-based apply form.** Agent-first stays.
- **Legality gate logic changes.** Untouched.
- **`accessible_club_memberships` view semantics.** Unchanged. We read from it; we do not alter it.

---

## 2. State-machine bug fix — `clubadmin.memberships.setStatus`

### 2.1. The bug

`clubadmin.memberships.setStatus` today takes a `status` input and updates `club_memberships.status` without validating that the transition is legal. A clubadmin can drive a membership from `banned` to `active`, from `declined` to `active`, from `active` back to `applying`, or any other combination. This is a real security hole: a compromised or malicious clubadmin can bypass the application gate by moving an old `declined` membership straight to `active`, or un-ban a banned member silently, or rewrite membership history.

It also breaks assumptions elsewhere. Several handlers currently trust that if a membership is `active`, it was admitted through the normal path. That trust is unfounded today.

### 2.2. The fix

Add a `VALID_TRANSITIONS` map, keyed by current state, valued as the set of next states the admin surface will accept. Every call to `setStatus` validates `(current, next) ∈ VALID_TRANSITIONS[current]` before touching the database. Invalid transitions return HTTP 422 with error code `invalid_state_transition` and a plain-English message that names both states and the closest legal alternative.

The scope of this ship is specifically the ADMIN surface. The implementing agent derives `ADMIN_VALID_TRANSITIONS` from what `clubadmin.memberships.setStatus` actually should permit today. Rough shape:

- **From `submitted`**: `interview_scheduled`, `interview_completed`, `payment_pending`, `active`, `declined`. Plus `banned` / `removed` as moderation exits (see §2.3).
- **From `interview_scheduled`**: `interview_completed`, `declined`. Plus moderation exits.
- **From `interview_completed`**: `payment_pending`, `active`, `declined`. Plus moderation exits.
- **From `payment_pending`**: `declined`. Plus moderation exits. Note: `payment_pending → active` is billing-owned and must NOT be an admin-driven transition.
- **From `active`**: `banned`, `removed`. Everything else from `active` is billing-owned or member-owned.
- **From `renewal_pending`**: `banned`, `removed` only. Everything else is billing-owned or member-owned.
- **From `cancelled`** / **`expired`**: moderation exits (`banned`, `removed`) only, if those are currently legal.
- **Terminal (no transitions out of admin surface)**: `banned`, `declined`, `withdrawn`, `removed`.

Transitions that are NOT admin-owned and must be rejected by `clubadmin.memberships.setStatus`:

- **Applicant-owned**: `applying → submitted` (already happens through `clubs.applications.submit`, not admin). `applying → withdrawn` and `submitted → withdrawn` exist as states but there is no surfaced applicant-withdraw action today — these are aspirational. Do not add them to the admin table.
- **Billing-owned**: `payment_pending → active`, `active → renewal_pending`, `active → cancelled`, `active → expired`, `renewal_pending → active`, `renewal_pending → expired`, `cancelled → active` (re-subscribe), `payment_pending → expired`. These are all implemented in billing sync paths in `src/postgres.ts` (search for `syncMembershipStateFromBilling` and friends). The admin surface must reject them regardless of whether they're legal elsewhere.
- **Does-not-exist today**: `expired → active`. Do not add.

The implementing agent MUST enumerate the actual allowed set from the current code rather than trust this rough list. This is a bug fix, not a feature add — if a transition isn't supported today, do not add it.

### 2.3. Moderation transitions from non-`active` states

A decision to pin: can an admin drive `submitted → banned`, `payment_pending → banned`, `submitted → removed`, etc.? Current billing-ban code (for example, the ban-on-chargeback path) treats **all non-terminal memberships as bannable**, which implies yes.

**Pinned answer: yes.** The admin-surface table admits `banned` and `removed` as transitions out of every non-terminal state (`submitted`, `interview_scheduled`, `interview_completed`, `payment_pending`, `active`, `renewal_pending`, `cancelled`, `expired`). Rationale: a clubadmin seeing a clearly bad-faith applicant mid-review, or a payment-pending membership that is clearly fraudulent, needs to be able to ban or remove immediately rather than wait for admission. This matches current implicit behavior; making it explicit in the validator is the right call.

Normal decision/approval transitions stay on their narrow tables — `submitted → declined` is still a decline, `submitted → active` is still an approval, and only `banned` / `removed` escape to moderation states.

### 2.4. Out of scope: billing-owned validation

Billing-driven transitions (`payment_pending → active`, `active → renewal_pending`, `active → cancelled`, `active → expired`, re-subscribe paths) currently live in `src/postgres.ts` billing sync routines with their own explicit guards. **This plan does not add a first-class `BILLING_VALID_TRANSITIONS` table.** Doing so would turn a narrow bug fix into a billing refactor, which belongs in a separate workstream.

The admin-surface validator must still **reject** billing-owned transitions when called via `setStatus`. That is enforced by the absence of those pairs from `ADMIN_VALID_TRANSITIONS`, not by a parallel billing table.

If a future billing workstream wants to unify both surfaces behind one validator, it can do that then. For now, the admin surface is tightened and billing keeps its existing per-path guards.

### 2.5. Tests

- Parameterized test over `ADMIN_VALID_TRANSITIONS`: for every (from, to) pair in the table, the admin surface accepts the transition. For every pair NOT in the table, the admin surface rejects with 422 `invalid_state_transition`.
- Specifically named test: `banned → active` is rejected.
- Specifically named test: `declined → active` is rejected.
- Specifically named test: `active → cancelled` via admin surface is rejected (billing-owned).
- Specifically named test: `payment_pending → active` via admin surface is rejected (billing-owned).
- Specifically named test: `submitted → banned` and `payment_pending → banned` are ACCEPTED (moderation, per §2.3).
- Billing sync paths still work (regression): every `syncMembershipStateFromBilling`-adjacent test that drives a legal billing transition still passes.
- Regression test: every test in the existing `memberships.test.ts` that drives a legal admin transition still passes — the validator should not break the happy paths.

### 2.6. Why this is in Phase A

It is credential-invariant. It is a security hole. It is small. It compounds with the ceremony work — if we add the onboarding ceremony on top of a `setStatus` that can be abused to bypass the application gate, the ceremony's audit value is undermined. Fix the foundation first.

---

## 3. Retry-budget tuning

Small pre-decided parameter changes, bundled into this ship because they're trivial and land next to the ceremony work.

- `APPLICATION_CHALLENGE_TTL_MS`: **1 hour → 24 hours.** Applicants have a full day to iterate within a single PoW challenge.
- `MAX_APPLICATION_ATTEMPTS`: **5 → 6.** One extra attempt. No more — each attempt is a paid LLM call against the legality gate.
- **The 24-hour clock is a hard wall from challenge creation, not a rolling window.** It does not reset on each revision. Prevents zombie applications.
- **The PoW solution travels with the membership for the full 24-hour window.** Retries do not re-mine. Only `challenge_expired` (past the wall) or `invalid_proof` forces a re-solve.

These changes apply to the existing `clubs.applications.submit` path regardless of the credential used to authenticate it, so they are credential-invariant.

---

## 4. `members.onboarded_at` and the onboarding gate

### 4.1. The rule

Add a nullable `onboarded_at timestamptz` column to `members`. The gate fires when **both** of these are true:

1. `actor.member.onboarded_at IS NULL`
2. `actor.memberships.length > 0` — the actor has at least one accessible (active / renewal_pending / cancelled) membership, per `accessible_club_memberships`.

Both conditions matter. Under the current bearer-at-join flow, an applicant calls `clubs.join`, receives a bearer token, and is mid-application with `onboarded_at = NULL` and zero accessible memberships (the view excludes `applying`/`submitted`/`payment_pending`). If the gate fired on condition (1) alone, the applicant could not call `clubs.applications.submit` and would be locked out of their own application. The accessible-membership check is the signal that admission has actually happened — only then does the ceremony become the required next step. This keeps Phase A compatible with the current credential lifecycle without dragging in any of Phase B.

**Allowlist (exactly two actions):**

- `session.getContext`
- `clubs.onboard`

**Every other action** returns `HTTP 403 onboarding_required`:

```json
{
  "error": {
    "code": "onboarding_required",
    "message": "You are authenticated but haven't completed onboarding yet. Call clubs.onboard to receive your welcome and activate your membership. No other action will succeed until this is done."
  }
}
```

### 4.2. Where the check lives

**One place: the dispatch layer in `src/dispatch.ts`.** The check runs immediately after the authentication layer resolves the actor and BEFORE any of the following run, on both the authenticated dispatch path (`dispatchAuthenticated`) and the optional-member dispatch path (`dispatchOptionalMember`):

1. **Before `parseActionInput`.** Otherwise many actions would return `422 invalid_input` before the agent ever sees `403 onboarding_required`.
2. **Before `def.requiredCapability` / `requireCapability`.** A gated user calling an unbuilt-on-this-deployment capability should get `onboarding_required`, not `not_implemented`.
3. **Before `def.preGate`.** `preGate` hooks assume a fully-authorized actor.
4. **Before the LLM legality gate.** Gated users must not be able to burn LLM calls before the gate fires.

On the optional-member path, the gate fires only when a credential was actually presented and resolved to a member. An anonymous call on an `optional_member` action goes through unchanged — the gate targets authenticated-but-unonboarded actors specifically.

The check itself is a two-condition conditional:

```typescript
if (
  actor.member &&
  actor.member.onboarded_at === null &&
  actor.memberships.length > 0
) {
  const ALLOWED_PRE_ONBOARDING = new Set(['session.getContext', 'clubs.onboard']);
  if (!ALLOWED_PRE_ONBOARDING.has(action)) {
    throw new AppError(403, 'onboarding_required', '...');
  }
}
```

The `actor.memberships` field is the already-resolved list of accessible memberships that actor loading populates from `accessible_club_memberships`. Checking `length > 0` is cheap (no extra query) and captures "this member has been admitted to at least one club" exactly.

No handler changes. Future actions added to the registry inherit the gate automatically. If a developer forgets to gate their new action, the gate is still there because the gate does not live in handlers at all.

### 4.3. Existing members are not gated

All existing members are functionally "onboarded" today — they've been using the system. The migration (§9) backfills `onboarded_at = created_at` for every existing row. Only NEW members created after the deploy will start with `onboarded_at IS NULL` and run through the ceremony.

### 4.4. Idempotency

Calling `clubs.onboard` when `members.onboarded_at` is already set is a no-op that returns `{ alreadyOnboarded: true }`. It does NOT re-run the welcome copy. This matters for "re-paste credential from delivery thread into a fresh agent" scenarios — the agent can safely call `clubs.onboard` defensively in its init flow without worrying about duplicate ceremonies.

### 4.5. Direct-mint paths must set `onboarded_at`

Any code path that issues a credential to a member OUTSIDE the normal admission flow MUST atomically set the target's `members.onboarded_at` in the same transaction as the credential issuance. The rule is **`COALESCE(onboarded_at, now())`** — preserves historical timestamps for already-onboarded members, sets a fresh one for never-onboarded members.

Under the current bearer-token model, the direct-mint paths are:

- **`superadmin.accessTokens.create`** — emergency recovery.
- **`superadmin.members.createWithAccessToken`** — backed by `createMemberDirect` in `src/identity/memberships.ts`; creates a new member row and issues a bearer token in one go.
- **`accessTokens.create`** (member-scoped self-service rotation) — already safe because the caller must be onboarded, but should set `COALESCE` defensively.
- **`db/seeds/dev.sql`** and any self-hosting bootstrap scripts that insert into `member_bearer_tokens` directly.

**Rule:** a member with a credential but `onboarded_at IS NULL` is an invalid state, except for the intermediate window inside the admission flow where the credential exists but the user hasn't yet called `clubs.onboard`. Any other code path that produces that state is a bug.

If Phase B ships and introduces `clubadmin.accessTokens.create`, that path joins this list.

### 4.6. `session.getContext` exposes the gate signal

`session.getContext` gains `actor.onboardingPending: boolean`. Scoped under `actor` to match the existing actor-centric shape.

**Derivation must match the gate exactly.** The flag is `true` iff the same two-condition check from §4.1 evaluates true: `actor.member.onboarded_at IS NULL` AND `actor.memberships.length > 0`. Any other derivation desynchronizes the flag from the gate, which would misdirect pre-admission bearer holders into `clubs.onboard` (and into the orphaned branch).

Concretely: a fresh applicant who has a bearer from `clubs.join` but has not been admitted yet has `onboarded_at = NULL` and zero accessible memberships. Their `onboardingPending` is **false** — the gate is not firing for them, and SKILL.md must not tell them to call `clubs.onboard`. The flag flips to `true` only after admission (when an accessible membership appears) and back to `false` after the ceremony (when `onboarded_at` is set).

All other fields are returned in full. Nothing is stripped pre-onboarding. The agent needs to see its member id, any memberships, and the explicit `onboardingPending` flag to understand what to do next. Active memberships (from `accessible_club_memberships`) are populated normally — the gate controls what actions the caller can *invoke*, not what the actor shape *contains*.

Note: `accessible_club_memberships` already excludes `payment_pending` rows by design (we confirmed this in the admin/member read surfaces split), so a just-admitted-but-pending-payment member will not see that club listed. That is correct behavior for Phase A and independent of any credential decision.

---

## 5. `clubs.onboard`

### 5.1. Action definition

- Name: `clubs.onboard`
- Auth: `member`
- Safety: `mutating`
- Required capability: `onboardMember`
- Input: empty object `{}`
- Output: the welcome envelope (§6.1) OR `{ alreadyOnboarded: true }`

### 5.2. Handler logic

All steps inside one `withTransaction` with `SELECT ... FOR UPDATE` on the `members` row first, to serialize against concurrent onboards / mint paths:

1. Read `actor.member.onboarded_at`. If non-null, return `{ alreadyOnboarded: true }` without side effects.
2. Select all accessible memberships for this member from `accessible_club_memberships`, ordered by `joined_at ASC`. `joined_at` is immutable after the first `applying → active` transition (enforced by trigger), so it is semantically "first activated at."
3. Edge case: if the list is empty, return `{ alreadyOnboarded: false, orphaned: true }` and log a server warning. Do NOT hard-error — a hard error would lock the member out entirely. This should only happen if admission wiring is broken.
4. The **first** (oldest) membership is the ceremony target. Compose the full welcome payload for it.
5. **The remaining memberships are admission-race casualties.** For each of them, insert a `membership.activated` notification with the same shape §7 describes for cross-join activations. This is the critical fix for the multi-admission race: if two clubs approve the same never-onboarded member before they onboard, both admissions skipped `membership.activated` at `setStatus` time (per §7.2's rule), and without this step the second+ club would never surface. Emitting at onboard time catches all of them.
6. Set `members.onboarded_at = now()`.
7. Return the welcome payload for the ceremony target.

### 5.3. Concurrency

`SELECT ... FOR UPDATE` on the member row at step 1 serializes onboards against each other and against any direct-mint path that might be running (`createMemberDirect`, `superadmin.accessTokens.create`, etc.). A second concurrent `clubs.onboard` call will block, then observe `onboarded_at IS NOT NULL`, and fall through to the idempotent `{ alreadyOnboarded: true }` branch.

The multi-admission race itself (two `setStatus(active)` transitions landing on the same member before any onboard) is handled at step 5: the late-arriving memberships don't need to be visible at `setStatus` time — they just need to be noticed the first time the member actually onboards.

---

## 6. The welcome payload

This is what `clubs.onboard` returns. It carries the ceremonial weight of the new-member moment and is **load-bearing copy**.

### 6.1. Shape

```
{
  alreadyOnboarded: false,
  member: {
    id: "a7k9m2p4q8r3",
    displayName: "Susan Chen"
  },
  club: {
    id: "clb_...",
    slug: "dogclub",
    name: "DogClub",
    summary: "..."
  },
  welcome: {
    greeting: "Welcome to DogClub, Susan.",
    preamble: "You've been accepted as a member. In a moment I'll show you what you can do here.",
    capabilities: [
      "Ask me to show you who else is in DogClub.",
      "Ask me to summarize recent activity — posts, events, asks, opportunities.",
      "Ask me to introduce you to someone specific.",
      "Ask me to write a post to the club, or DM another member.",
      "Ask me to list upcoming events."
    ],
    closing: "Take a look around, and let me know when you're ready to post your first introduction."
  }
}
```

**Note on credential-related fields.** The original plan included `tokenInstruction` and `lossWarning` fields that explained how to save the bearer token and what to do if it was lost. Those fields are **intentionally omitted from Phase A**. The welcome copy should describe membership and capabilities, not credentials. If Phase B lands and the credential story changes, the welcome copy gains credential-specific fields at that time. Today's welcome payload stays clean.

### 6.2. Server-authored, agent-relayed

The `welcome` block is composed by the server and relayed verbatim by the agent. SKILL.md (§10) instructs the agent to **relay the welcome block verbatim or near-verbatim before doing anything else.** Don't paraphrase. Don't shorten. This is the moment the club introduces itself.

### 6.3. Three composer functions in `src/clubs/welcome.ts`

Used across this phase and Phase B (if it ships):

- **`buildOnboardingWelcome({ clubName, memberName, sponsorPublicName? })`** → the full ceremonial payload returned by `clubs.onboard`. Sponsor-aware when the membership has an associated invitation.
- **`buildSecondClubWelcome({ clubName, memberName, sponsorPublicName? })`** → the lighter cross-join welcome. No save-credential instructions; the user is already onboarded. Used as the payload for the `membership.activated` notification.
- **`buildSponsorHeadsUp({ newMemberPublicName, clubName })`** → the short sponsor-facing message. Used as the payload for the `invitation.accepted` notification.

All three parameterized, all generic, no ClawClub branding. Self-hosters inherit clean defaults.

**Implementing-agent note:** scaffold with `TODO OWEN:` placeholders and surface them in the hand-back. Owen writes the actual default strings — tone matters too much to guess.

### 6.4. Future per-club customization

Add a nullable `welcome_template jsonb` column to the `clubs` table. For the first ship this column is added but not yet consumed — composers read it and, if non-null, substitute custom copy. Adding the column now future-proofs the data model.

### 6.5. Tone guidelines for the default copy

- **Invitations to action, not API dumps.** "Ask me to show you who else is in the club," not "You can call `members.searchByFullText`."
- **Five or six capabilities, not twenty.** First-day new members need three things to try first, not a menu.
- **Premium tone.** This is a private club, not a sign-up form.

---

## 7. Notification fanout at admission

Uses the existing `member_notifications` infrastructure. No new tables, no new actions — two new `topic` strings fired from the right code path.

### 7.1. The two new topics

**`invitation.accepted`** — sent to the sponsor when their invited applicant is admitted.

- `recipient_member_id`: the sponsor, from `invitations.sponsor_member_id` via the membership's linked invitation
- `club_id`: the club the new member just joined
- `topic`: `'invitation.accepted'`
- `payload`: `{ newMemberId, newMemberPublicName, invitationId, clubName, headsUp }` — `headsUp` carries the prose from `buildSponsorHeadsUp(...)` for verbatim relay
- `acknowledged_state`: null at insert time
- **Fired when:** **any** `→ active` transition lands on a membership with a non-null `invitation_id`. Both the admin-driven path (`clubadmin.memberships.setStatus(active)` on a `submitted` membership) and the billing-driven path (`payment_pending → active` in the billing sync, `src/postgres.ts`) fire this. See §7.2 for where this hangs in the code.

**`membership.activated`** — sent to a member activated into a new club WITHOUT running the full onboarding ceremony. The "second-club welcome."

- `recipient_member_id`: the new club member
- `club_id`: the new club
- `topic`: `'membership.activated'`
- `payload`: `{ clubId, clubName, summary, sponsorMemberId?, sponsorPublicName?, welcome }` — `welcome` is the structured payload from `buildSecondClubWelcome(...)`
- `acknowledged_state`: null at insert time
- **Fired when:** **any** `→ active` transition where the target member's `onboarded_at IS NOT NULL` at the moment of transition. Both admin-driven and billing-driven paths fire this. Concretely that means cross-joiners and invited cross-joiners — members who were already onboarded through some earlier club and are now being activated into an additional one. **First-time members are NOT covered by this notification**, regardless of whether they arrived via the current bearer-at-join flow or any future Phase B flow: their `onboarded_at` is still NULL at admission time (until `clubs.onboard` runs), so this fanout correctly skips, and the ceremony welcome payload carries the moment for them.
- **Does NOT fire when** the target member's `onboarded_at IS NULL` at transition time. In that case the later `clubs.onboard` ceremony handles surfacing — both the welcomed club itself (via the welcome payload) and any admission-race siblings (via notifications emitted at onboard time, per §5.2 step 5).

### 7.2. Where the fanout lives

**Not in the `clubadmin.memberships.setStatus` handler.** That handler only covers the admin-driven admission path. Paid-club admissions land at `active` via a billing sync path that never passes through the admin handler — if fanout lived there, paid-club admissions would silently miss both notifications.

Instead, both inserts hang off the shared **"transition to active"** code path at the repository layer. In current code, the natural seam is the helper (or helpers) in `src/identity/memberships.ts` / `src/postgres.ts` that all paths funnel through to actually UPDATE `club_memberships.status = 'active'`. The implementing agent identifies that seam — if there's more than one today (admin path + billing sync path) they are unified or both sites invoke the shared fanout helper. Grep after implementation for every UPDATE that can result in `status = 'active'`; each must either go through the helper or be annotated as deliberately-bypassing (e.g. test harness seeding).

Within the helper, two independent decisions run:

```
invitationAcceptedFanout():
  if membership.invitation_id is not null:
    insert invitation.accepted notification for the sponsor

membershipActivatedFanout():
  if target member's onboarded_at IS NOT NULL:
    insert membership.activated notification for the new member
  else:
    skip — admission-race siblings will be caught by clubs.onboard (§5.2 step 5);
    a first-time admission will be covered by the welcome payload itself.
```

Cross-product under Phase A (where `clubs.join` still issues a bearer token the way it does today, so every first-time applicant arrives at admission with `onboarded_at IS NULL`):

| Case | `invitation.accepted` for sponsor? | `membership.activated` for new member? | Notes |
| --- | --- | --- | --- |
| First-time cold applicant, no sponsor, free club | — | ✗ | Ceremony welcome payload covers it |
| First-time invited applicant, free club | ✓ | ✗ | Ceremony welcome covers the new member; sponsor hears about it |
| First-time cold applicant, paid club (becomes active via billing) | — | ✗ | Ceremony covers it; fires on billing path, not admin |
| First-time invited applicant, paid club | ✓ | ✗ | Sponsor hears about it via billing path |
| Cross-join, no sponsor | — | ✓ | No ceremony; notification is the welcome |
| Invited cross-join | ✓ | ✓ | |
| Admission-race second club (first-time member, never-onboarded yet) | Admin: ✓ if invited; Billing: ✓ if invited | ✗ at transition time | Caught later by `clubs.onboard` step 5 |

The admission-race row is the non-obvious one: at transition time both `invitation.accepted` (if applicable) fires AND `membership.activated` is skipped because `onboarded_at IS NULL`. The sponsor hears about the second admission immediately. The new member finds out when they eventually call `clubs.onboard`, which welcomes the oldest club and emits `membership.activated` for every other race-sibling.

### 7.3. Atomicity

All inserts happen **inside the same transaction** as the state transition. If either insert fails, the whole `→ active` operation rolls back and the membership stays in the prior state. This applies equally to the admin path and the billing path — both must wrap transition + notification inserts in `withTransaction(pool, async (client) => { ... })` and use the same client for every step.

Rationale:
1. **No silent loss.** If we transitioned but failed to insert, the new member would be functionally admitted with no welcome moment and no signal.
2. **No phantom notifications.** If we inserted but failed to transition, the sponsor would see "your invitee was approved" while the membership is still pending.

### 7.4. `notifications.acknowledge` — already handled

The blocklist flip from allowlist (`synchronicity.*` only) to blocklist (`application.*` excluded) already shipped in the admin/member read surfaces split. The new topics are acknowledgeable by default. **No change needed here.**

The implementing agent should verify this is still true when they land Phase A — a regression would re-break acknowledgement of the new topics.

### 7.5. How the agent surfaces the new notifications

No new agent action is needed:

- New rows appear in `notifications.list` ordered FIFO with everything else.
- They piggyback on `sharedContext.notifications` on every authenticated response.
- They flow through `/stream` as `notification` frames.
- Agents acknowledge them via `notifications.acknowledge` once relayed.

---

## 8. API surface changes

### 8.1. New action

- **`clubs.onboard`** — per §5.

### 8.2. Modified actions

- **`session.getContext`** — gains `actor.onboardingPending: boolean`.
- **`clubadmin.memberships.setStatus`** — validates transitions per §2. Atomic notification fanout per §7.3. The response envelope does NOT gain `accessToken` in Phase A; that is Phase B.

### 8.3. No removals

`clubs.join` continues to return `memberToken` under Phase A. Removal is Phase B.

---

## 9. Data model changes

### 9.1. Migration file

Create `db/migrations/NNN_onboarding_ceremony.sql` using the next unused migration number. Apply via `scripts/migrate.sh`. Never apply directly with `psql -f`.

### 9.2. Schema changes

```sql
alter table public.members
  add column onboarded_at timestamptz;

alter table public.clubs
  add column welcome_template jsonb;
```

### 9.3. Data backfill

```sql
update public.members
  set onboarded_at = created_at
  where onboarded_at is null;
```

This ensures no existing member is gated by the new middleware check.

### 9.4. Pre-cutover prod queries

Per CLAUDE.md's pre-cutover protocol, run against production before pushing:

```sql
-- How many existing members will be backfilled?
select count(*) from members where onboarded_at is null;

-- Any members without a created_at? (Sanity — should be zero.)
select count(*) from members where created_at is null;

-- Pending applications that will survive unchanged.
select status, count(*) from club_memberships group by status order by 2 desc;
```

If anything unexpected shows up, pause and investigate. The backfill assumes every existing member has a `created_at`, which is a NOT NULL column today.

### 9.5. Migration test

Per CLAUDE.md, test the data rewrite against synthetic pre-migration data, not just an empty DB:

1. `git show main:db/init.sql > /tmp/init_pre.sql`
2. Create a scratch DB, apply `/tmp/init_pre.sql`.
3. INSERT synthetic rows: several members with and without active memberships, memberships across every status.
4. Run `scripts/migrate.sh` against the scratch DB.
5. Verify `onboarded_at` is non-null for every member, `welcome_template` exists and is null, no membership rows corrupted.

---

## 10. SKILL.md rewrite

The "Core behaviors" section gains a new rule about the onboarding ceremony and the notification topics. The "How someone joins a club" section does NOT change its credential story in Phase A — that waits for Phase B. What changes is the activation half of the flow.

### 10.1. New section: "How someone activates their membership"

- The applicant receives a credential (under Phase A, still the bearer token from `clubs.join`).
- Agent's init protocol: fetch schema, call `session.getContext`.
- **If the response contains `actor.onboardingPending: true`**, the next action MUST be `clubs.onboard`.
- The agent MUST relay the returned `welcome` block verbatim to the human before calling any other action.
- Explicit rule: "The server composes the welcome message. Relay it in full. Do not paraphrase. Do not shorten the capabilities list. Do not collapse the preamble into a one-liner. This is the moment the club introduces itself."
- Explicit rule: "If you call any action other than `session.getContext` or `clubs.onboard` before the member is onboarded, the server will return 403 `onboarding_required`. Read the message literally and recover by calling `clubs.onboard`."

### 10.2. Notifications section additions

Document the two new topics in the existing notification-vocabulary section (alongside `synchronicity.*`, `vouch.received`, `application.submitted`):

- **`invitation.accepted`** — *for sponsors.* Your invitee has been admitted. The payload's `headsUp` field carries a prose message to relay verbatim: "Your invitee Jenny was just approved into DogClub. You might want to send her a welcome DM." Offer the human the chance to send a DM via `messages.send`. Acknowledge after relaying.
- **`membership.activated`** — *for a member admitted to a new club via cross-join.* The payload's `welcome` field carries a lightweight club-specific welcome (greeting, club summary, capabilities, closing). Relay verbatim. Acknowledge after relaying.

Relay rule: "For any notification whose payload contains a `welcome`, `headsUp`, or similar prose-bearing field, relay the prose verbatim. These are server-authored messages."

### 10.3. Club-admin sub-note

When a clubadmin approves an applicant via `setStatus(active)`, today they just see the state transition succeed. Under Phase A that's unchanged. No new admin-side instruction needed in SKILL.md for this phase. Phase B will add the "deliver the access token out-of-band" instruction once the credential redesign lands.

### 10.4. Quality bar

After the rewrite, a fresh agent reading SKILL.md should be able to:

1. Handle the onboarding ceremony on a new member's first session (see `onboardingPending: true`, call `clubs.onboard`, relay the welcome).
2. Recognize `invitation.accepted` notifications as sponsor call-to-actions and prompt the sponsor to welcome the new member via DM.
3. Recognize `membership.activated` notifications as cross-join welcomes and relay the prose payload to the new member.
4. Know that calling a non-allowlisted action before onboarding returns 403 `onboarding_required` and the recovery is `clubs.onboard`.

---

## 11. docs/design-decisions.md updates

All updates land in the same commit as the implementation. Do not ship the code without the docs.

### 11.1. Membership and trust — edit scope

Add paragraphs:

- **Onboarding ceremony.** Describe the gate (`members.onboarded_at`), the allowlist, the 403 error, the idempotent `clubs.onboard`, the server-authored welcome payload.
- **Cross-join rule.** A member admitted to a new club whose `onboarded_at` is already set does not re-run the ceremony. They receive a `membership.activated` notification carrying a lightweight club-specific welcome.
- **Sponsor heads-up.** An invitation-backed membership transition to `active` fires `invitation.accepted` to the sponsor, prompting a welcome DM.
- **State-machine validation.** `clubadmin.memberships.setStatus` now validates every transition against `ADMIN_VALID_TRANSITIONS` and rejects illegal moves with 422 `invalid_state_transition`. Billing-owned transitions (`payment_pending → active`, `active → renewal_pending`, `active → cancelled`, re-subscribe paths) continue to live in billing sync and are NOT accessible via the admin surface. Document the table's shape or link to the code.

Do NOT describe any credential-timing changes or `accessToken` envelope field — those are Phase B.

### 11.2. Member notifications — additions

Add to the materialized topic list:

- `invitation.accepted` — fired to the sponsor when their invited applicant is admitted. Payload includes `newMemberId`, `newMemberPublicName`, `invitationId`, `clubName`, and a prose `headsUp` field for verbatim relay.
- `membership.activated` — fired to a member admitted to a new club when their `onboarded_at` is already set (cross-join path). Payload includes `clubId`, `clubName`, `summary`, optional `sponsorMemberId`/`sponsorPublicName`, and a structured `welcome` block for verbatim relay.

Note that the `notifications.acknowledge` blocklist (already inverted to reject only `application.*`) handles both new topics natively — no handler change needed.

### 11.3. Security and permissions — additions

- **Onboarding gate.** The dispatch layer gates a two-action allowlist (`session.getContext`, `clubs.onboard`) for any actor whose `members.onboarded_at IS NULL` AND who has at least one accessible membership (i.e. who has been admitted but has not yet run the ceremony). No club action can be called by that actor until `clubs.onboard` completes. Pre-admission applicants — who hold a bearer from `clubs.join` but have no accessible memberships yet — are NOT gated, and this matches the `actor.onboardingPending` signal exposed on `session.getContext`.
- **State-machine validation.** `clubadmin.memberships.setStatus` validates transitions against `ADMIN_VALID_TRANSITIONS`. Closed states (`banned`, `declined`, `withdrawn`, `removed`) cannot be reopened via the admin surface.

### 11.4. Current implementation milestones — additions

Append to the "Already landed" bulleted list at ship time:

- `members.onboarded_at` column with backfill; dispatch-layer onboarding gate
- `clubs.onboard` single-call ceremony, idempotent
- `invitation.accepted` and `membership.activated` notification fanout at admission, atomic with state transitions
- State-machine validation (`ADMIN_VALID_TRANSITIONS`) for `clubadmin.memberships.setStatus`

---

## 12. Test plan

All integration tests exercise the full HTTP path through `TestHarness`.

### 12.1. Unit tests

- `src/clubs/welcome.ts`: all three composer functions correctly substitute names and produce all required fields. Sponsor-aware variants vs generic variants.

### 12.2. Integration tests — state-machine validation

- Parameterized: for every (from, to) pair in `ADMIN_VALID_TRANSITIONS`, the admin surface accepts. For every pair NOT in the table, 422 `invalid_state_transition`.
- Named: `banned → active` rejected.
- Named: `declined → active` rejected.
- Named: admin cannot drive `active → cancelled` via `setStatus` (billing-owned).
- Named: admin cannot drive `payment_pending → active` via `setStatus` (billing-owned).
- Named: `submitted → banned` and `payment_pending → banned` are ACCEPTED (moderation per §2.3).
- Regression: existing billing sync paths for `payment_pending → active`, `active → renewal_pending`, `active → cancelled`, re-subscribe paths still work end-to-end.

### 12.3. Integration tests — onboarding gate

**The parameterized onboarding gate test is critical.** It MUST iterate the action registry, not hard-code per action.

Setup (gated actor):
1. Create a fresh member via `clubs.join` and drive them through admission to `setStatus(active)`, so they have at least one accessible membership.
2. `onboarded_at` is still NULL at this point (Phase A's gate requires BOTH `onboarded_at IS NULL` AND `memberships.length > 0`).
3. Do NOT call `clubs.onboard` yet.

Test body:
1. Iterate every action in `src/schemas/registry.ts`.
2. For each action not in `{'session.getContext', 'clubs.onboard'}`:
   - Call with a literal empty object `{}` as input.
   - Assert HTTP 403.
   - Assert `error.code === 'onboarding_required'`.
   - Assert `error.message` contains the literal string `'clubs.onboard'`.

**Why `{}` and not "minimal valid input":** the gate MUST fire before input parsing, capability checks, `preGate`, and the LLM legality gate. If the gate ordering is correct, `{}` triggers `onboarding_required` for every action regardless of what valid input would look like. If the gate ever drifts after parse, this test starts returning `invalid_input` for many actions instead of `onboarding_required`, and fails loudly. That failure IS the correctness check for ordering.

After onboarding:
1. Call `clubs.onboard`.
2. Assert `members.onboarded_at` is non-null.
3. Re-run a sample of actions; they should now pass the gate (and fail or succeed based on their own semantics, not on the onboarding check).

**Why this test matters:** a future developer cannot add a new action and forget to gate it. The gate is in middleware; this test iterates the registry.

### 12.3.1. Pre-admission bearer-at-join regression

The gate must NOT fire, and `actor.onboardingPending` must NOT report true, for an applicant who has a bearer token from `clubs.join` but has not yet been admitted to anything. Both the gate and the flag are two-condition checks (§4.1, §4.6); a single-condition regression would break this case.

- Create a fresh anonymous member via `clubs.join`. Bearer issued. `onboarded_at IS NULL`. Zero accessible memberships.
- Call `session.getContext`. Assert `actor.onboardingPending === false`. This is the regression net for the `onboardingPending` derivation — a naive `onboarded_at IS NULL` implementation would report true here and misdirect the agent into the orphaned branch.
- Call `clubs.applications.submit` with a valid application.
- Assert the call succeeds (it may fail for other reasons — PoW, legality — but it must NOT fail with 403 `onboarding_required`).
- Specifically assert that if the call does fail, the error code is anything other than `onboarding_required`.

This is the exact case the two-condition rule exists to protect, and the exact case that would have broken the first draft of this plan.

### 12.4. `clubs.onboard` idempotency

1. First call → full welcome returned.
2. Second call → `{ alreadyOnboarded: true }`, no state change.
3. Assert `members.onboarded_at` did not move between the two calls.

### 12.5. Notification fanout tests

- Invited cross-join: admin approves Bob in CatClub (already a DogClub member, invited by Amy). Assert `invitation.accepted` appears on Amy's queue with correct payload; `membership.activated` appears on Bob's queue with correct sponsor-aware welcome.
- Cold cross-join: admin approves Alice in CatClub (already a DogClub member, no invitation). Assert no `invitation.accepted`; `membership.activated` on Alice's queue with generic welcome.
- First-time cold admission: admin approves Susan. Assert no `membership.activated` (ceremony will cover it). Susan's `onboarded_at` is still NULL until she calls `clubs.onboard`.
- First-time invited admission: admin approves Jenny (invited by Amy). Assert `invitation.accepted` on Amy's queue; no `membership.activated` for Jenny.
- **Billing-path admission** (the new row that was missing): admin approves Paul on a paid club → he lands at `payment_pending`; then billing sync drives `payment_pending → active`. Assert no fanout fires at the admin step; assert BOTH `invitation.accepted` (if invited) and `membership.activated` (if `onboarded_at IS NOT NULL`) fire at the billing step. Both fire from the shared transition-to-active helper, not from `setStatus`.
- **Admission race caught at onboard**: two clubs approve the same never-onboarded member before they onboard. Both `setStatus(active)` calls skip `membership.activated` (correct — `onboarded_at IS NULL`). The member then calls `clubs.onboard`. Assert the welcome payload targets the oldest club by `joined_at ASC`. Assert a `membership.activated` notification is emitted for the second (race-sibling) club from within the `clubs.onboard` transaction. The member's queue now has exactly one `membership.activated` for the sibling, plus the ceremonial welcome they just relayed to the human.
- Atomicity (admin path): force a notification insert failure and assert the whole `setStatus` rolls back — membership state did NOT advance.
- Atomicity (billing path): force a notification insert failure in the billing sync and assert the whole transition rolls back — membership stays `payment_pending`.
- Scoping: forged or missing `invitation_id` → no `invitation.accepted` fired.

### 12.6. Tuning-change tests

- Exhaust 6 attempts → 7th returns `attempts_exhausted`.
- Fast-forward past 24h → `challenge_expired`.
- Retry within 24h does NOT re-mine PoW — same nonce accepted.

### 12.7. Direct-mint onboarding semantics

Cover every writer in §4.5, not just `superadmin.accessTokens.create`. The invariant ("member with credential but `onboarded_at IS NULL` is a bug") must hold on every direct-mint path.

- **`superadmin.accessTokens.create` — never-onboarded target.** Superadmin mints a fresh token for a brand-new member with `onboarded_at IS NULL`. Assert the mint succeeded AND `onboarded_at` was atomically set via `COALESCE`. Assert the minted token is immediately usable for non-allowlisted actions (the gate does not fire because `onboarded_at IS NOT NULL` now).
- **`superadmin.accessTokens.create` — already-onboarded target.** Mint for a member whose `onboarded_at` is already set. Assert `onboarded_at` was NOT overwritten — original timestamp preserved.
- **`superadmin.members.createWithAccessToken` (via `createMemberDirect`).** Superadmin creates a brand-new member with an access token in one call. Assert the member row is created with `onboarded_at = now()` (NOT NULL), and the minted token is immediately usable for non-allowlisted actions without calling `clubs.onboard`.
- **Member self-rotation via `accessTokens.create`.** An onboarded member rotates their own token. Assert `onboarded_at` is preserved (COALESCE leaves it alone).
- **Seed data integrity.** After `./scripts/reset-dev.sh`, assert every member row in `members` has `onboarded_at IS NOT NULL`. This is the regression net for `db/seeds/dev.sql` and any bootstrap script that inserts into `member_bearer_tokens` directly.

### 12.8. Acknowledge-filter regression

The blocklist inversion for `notifications.acknowledge` shipped previously. Verify the two new topics are acknowledgeable and that `application.*` is still rejected.

### 12.9. Manual live-server dry run

Before committing, run a manual end-to-end test against local dev:

1. Create a fresh applicant; drive them through to admission.
2. With their credential, call a mutating action BEFORE `clubs.onboard` → 403 `onboarding_required`.
3. Call `session.getContext` → succeeds with `actor.onboardingPending: true`.
4. Call `clubs.onboard` → welcome payload present.
5. Call the same mutating action AFTER → succeeds.
6. Call `clubs.onboard` again → `alreadyOnboarded: true`.
7. Trigger an invited cross-join and confirm both notifications fire.
8. Attempt `banned → active` via `setStatus` → 422 `invalid_state_transition`.

---

## 13. Open questions

Not showstoppers — flag to Owen before shipping:

1. **Default welcome copy.** Owen writes the actual strings for all three composer functions. Scaffold with `TODO OWEN:` placeholders and surface in hand-back.
2. **Shared transition-to-active seam.** Is there already a unified helper in `src/identity/memberships.ts` / `src/postgres.ts` that every `→ active` path funnels through, or do the admin path and the billing-sync path currently UPDATE independently? If the latter, this plan's §7.2 requires either unifying them or having both sites invoke a shared fanout helper. Implementing agent inspects and reports before starting.

**Resolved (pinned):**

- ~~Target-club selection rule for `clubs.onboard`.~~ Oldest active membership by `joined_at ASC` from `accessible_club_memberships`. See §5.2.
- ~~Gate condition under current bearer-at-join flow.~~ Two-condition check: `onboarded_at IS NULL` AND `actor.memberships.length > 0`. See §4.1.
- ~~`actor.onboardingPending` derivation.~~ Same two-condition check as the gate. Not `onboarded_at IS NULL` alone. See §4.6.
- ~~Multi-admission race.~~ `clubs.onboard` emits `membership.activated` for every accessible membership except the one it welcomes. See §5.2 step 5.
- ~~`notifications.acknowledge` blocklist flip.~~ Already shipped.
- ~~`payment_pending` membership visibility.~~ Admin applications surface only. Not in member-facing surfaces. See commit `dfcb6d2`.
- ~~`onboarded_at` writer set.~~ See §4.5 (includes `createMemberDirect`).
- ~~Moderation transitions from non-`active` states.~~ Admins can drive `banned` / `removed` from any non-terminal state. See §2.3.
- ~~Billing-owned validation as part of Phase A.~~ Deferred. Billing keeps per-path guards; admin surface is tightened via `ADMIN_VALID_TRANSITIONS` only. See §2.4.

---

## 14. Decision log

Short reference for why each choice was made.

| Decision | Why |
| --- | --- |
| State-machine validation goes in Phase A, not deferred | Pure security bug. Independent of credential decision. Fixing it now prevents the ceremony from being built on a compromised foundation. |
| Admin surface tightened via `ADMIN_VALID_TRANSITIONS`; billing keeps its existing per-path guards | Narrower fix, smaller blast radius. A first-class billing validator belongs in a separate billing workstream. |
| Moderation exits (`banned`, `removed`) allowed from every non-terminal state | Admins need to act on clearly bad-faith applicants mid-review and on fraudulent payment-pending memberships. Matches current implicit behavior. |
| Server-enforced onboarding gate in middleware, not SKILL.md | Owen has directly observed agents ignoring SKILL.md guidance. Enforcement must be structural. One middleware check, one parameterized test, impossible to bypass. |
| Two-condition gate: `onboarded_at IS NULL` AND `memberships.length > 0` | The single-condition form breaks Phase A's compatibility with the current bearer-at-join flow — applicants would be locked out of their own `clubs.applications.submit`. Checking for at least one accessible membership means the gate fires only once admission has actually happened. Keeps Phase A independent of Phase B. |
| Gate lives on `members.onboarded_at`, not on membership state | The ceremony is about the MEMBER and the SYSTEM as a whole, not about a specific club. Cross-joiners are naturally exempt. |
| Allowlist is exactly `session.getContext` + `clubs.onboard` | Minimum surface area. Any agent that tries anything else gets a clear 403 that tells them what to do. |
| `clubs.onboard` idempotent | Supports re-paste recovery. Agent can always defensively call onboard on startup. |
| Full `session.getContext` pre-onboarding with `actor.onboardingPending` flag | Agent needs to see member id, memberships, club names to understand what's happening. Nothing leaked that the admin hasn't already granted. |
| `actor.onboardingPending` derives from the SAME two-condition check as the gate | If the flag fires on `onboarded_at IS NULL` alone, a pre-admission bearer holder (post `clubs.join`, pre-admission) would be misdirected into `clubs.onboard` and hit the orphaned path. Flag and gate must stay in lockstep. |
| Welcome copy omits credential instructions in Phase A | Phase A is credential-invariant. If the copy references "save your key," it leaks the Phase B decision upstream. Phase B adds the credential fields to the welcome payload when it ships. |
| Three welcome composer functions | Different welcomes for different moments: full ceremony, cross-join, sponsor heads-up. |
| `welcome_template` JSONB column added but unused in Phase A | Future per-club customization without a follow-up migration. |
| Cross-joiners get no ceremony | Their `onboarded_at` is already set. Their existing credential already widens scope through `accessible_club_memberships`. Ceremony only runs for first-admission. |
| Server composes the welcome copy, agent relays verbatim | Consistent tone across all agents. Maintainable in one place. Prevents truncation and hallucination. |
| `invitation.accepted` fires for sponsor whenever an invitation-backed membership is approved | Acknowledges the sponsorship without putting credential-delivery burden on the sponsor. |
| `membership.activated` fires on admission when `onboarded_at IS NOT NULL` | First-time members get the full ceremony; already-onboarded members need the moment-of-admission delivered as a notification. |
| Notification fanout hangs off the shared transition-to-active helper, not the admin handler | Paid-club admissions land at `active` via the billing sync path, which never passes through `clubadmin.memberships.setStatus`. Hanging fanout off the shared seam catches both admin-driven and billing-driven admissions. |
| `clubs.onboard` emits `membership.activated` for admission-race siblings | Handles the case where two clubs approve the same never-onboarded member before they onboard. Both `setStatus` calls correctly skip `membership.activated` because `onboarded_at IS NULL`; the ceremony catches them all when it runs. |
| Notification fanout atomic with the state transition | No silent loss, no phantom notifications. |
| `notifications.acknowledge` blocklist flip — already shipped | No work needed; just verify no regression. |
| `MAX_APPLICATION_ATTEMPTS: 5 → 6`, TTL 1h → 24h, hard wall | A full day matches real human pacing. Hard wall prevents zombies. Extra attempt is ~free; two extras is expensive (LLM calls). |

---

## 15. Security checklist

A reviewing agent should verify each concretely before declaring the work ready.

1. **The onboarding gate fires on EVERY non-allowlisted action.** The parameterized test in §12.3 is the guarantee.
2. **The allowlist is defined in ONE place.** Grep for the literal after implementation.
3. **`clubs.onboard` is member-authenticated.** A call without valid credentials returns 401, not the welcome payload.
4. **Rate limit on `clubs.onboard`.** Per-IP limits to prevent thrashing.
5. **The gate works for superadmins too.** A superadmin with `onboarded_at IS NULL` is still gated. Seed data / admin provisioning must set `onboarded_at` appropriately for new superadmins.
6. **Notification fanout is atomic with the state transition on BOTH the admin path and the billing path.** Force an insert failure at each and verify full rollback.
7. **Fanout hangs off the shared transition-to-active seam, not the admin handler.** Grep every UPDATE that can produce `status = 'active'` after implementation; each must either go through the helper or be annotated as deliberately bypassing.
8. **`invitation.accepted` goes only to the real sponsor.** Resolved from `invitations.sponsor_member_id` via FK. Forged or missing → no notification.
9. **`membership.activated` goes only to the real new member.** Payload scoped to the one club. Cross-scope data does NOT leak.
10. **Multi-admission race has a deterministic landing.** Ceremony picks oldest by `joined_at ASC`; every race-sibling gets a `membership.activated` notification emitted from within the `clubs.onboard` transaction. Verify with a concurrency test.
11. **Gate does NOT fire pre-admission.** Regression test in §12.3.1 specifically protects the bearer-at-join compatibility property.
12. **Notification acknowledge is in lockstep across dispatch and repo layers.** Verify the blocklist inversion holds at both sites after this ship.
13. **State-machine validation cannot be bypassed.** Parameterized test over the transition table. Every direct `UPDATE club_memberships.status` site audited.
14. **Terminal states cannot be reopened.** `banned`, `declined`, `withdrawn`, `removed` have no transitions out of them in `ADMIN_VALID_TRANSITIONS`.
15. **Billing-owned transitions are NOT driveable via `setStatus`.** `payment_pending → active`, `active → renewal_pending`, `active → cancelled`, `active → expired`, re-subscribe paths — all rejected with 422 when called through the admin surface.
16. **`onboarded_at` writer set is exactly §4.5** (including `createMemberDirect`). Grep after implementation. No other code path writes this column.
17. **Direct-mint paths set `onboarded_at` via `COALESCE`.** Every `insert into member_bearer_tokens` site outside the normal admission flow has a corresponding `UPDATE members SET onboarded_at = COALESCE(onboarded_at, now())` in the same transaction.

---

## 16. Rollout plan

### 16.1. Implementation order

1. **State-machine validation.** `ADMIN_VALID_TRANSITIONS` table + validator. Tests pass.
2. **Migration.** Write `NNN_onboarding_ceremony.sql`. Test against scratch DB with synthetic data (§9.5). Apply via `scripts/migrate.sh`.
3. **Welcome copy module.** Create `src/clubs/welcome.ts` with scaffolded `TODO OWEN:` placeholders.
4. **Repository methods.** Extend the repository interface with `markMemberOnboarded`, `getWelcomeTargetForMember`, `insertInvitationAcceptedNotification`, `insertMembershipActivatedNotification`.
5. **Dispatch-layer gate.** Add the onboarding check at the pinned positions in §4.2 on both `dispatchAuthenticated` and `dispatchOptionalMember`.
6. **`session.getContext` update.** Add `actor.onboardingPending`.
7. **`clubs.onboard`.** Per §5.
8. **Shared transition-to-active fanout.** Identify the seam in `src/identity/memberships.ts` / `src/postgres.ts` that all `→ active` paths funnel through (or unify if they don't today). Hang the atomic fanout off it per §7.2. Cover both admin path and billing sync path.
9. **Tuning.** Bump `APPLICATION_CHALLENGE_TTL_MS` and `MAX_APPLICATION_ATTEMPTS`.
10. **SKILL.md and docs.** Per §10 and §11. Same commit as code.
11. **Integration tests.** Per §12. All pass.
12. **Manual live-server dry run.** Per §12.9.
13. **Pre-cutover prod queries.** Per §9.4.
14. **Commit.** Bump `package.json` patch version. **DO NOT push.** Present to Owen for explicit push authorization.

### 16.2. Deploy

When authorized, push triggers Railway auto-deploy. Monitor production:

- `/api/schema` contains `clubs.onboard` and the `actor.onboardingPending` field.
- `setStatus(active)` rejects illegal transitions.
- Fresh applicant flow: create member, drive through admission, confirm gate fires and ceremony works.
- Existing members remain unaffected (their `onboarded_at` is backfilled).

### 16.3. If anything breaks

Roll back the server with `git revert` and push. The migration is additive; the data stays. Fix forward.

---

## 17. What "done" looks like

- [ ] `ADMIN_VALID_TRANSITIONS` implemented; admin surface rejects illegal transitions.
- [ ] Migration written, tested against scratch DB with synthetic data, applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated to reflect target schema.
- [ ] Repository methods in `src/contract.ts` and `src/postgres.ts`.
- [ ] Dispatch-layer onboarding gate inserted at the pinned positions in §4.2, both paths.
- [ ] `session.getContext` returns `actor.onboardingPending`.
- [ ] `clubs.onboard` implemented per §5.
- [ ] Atomic fanout in `setStatus(active)` per §7.
- [ ] Welcome copy scaffolded with `TODO OWEN:` markers.
- [ ] Tuning constants bumped.
- [ ] SKILL.md rewritten per §10.
- [ ] `docs/design-decisions.md` updated per §11.
- [ ] Integration tests per §12 pass, including parameterized gate and state-machine tests.
- [ ] Manual live-server dry run passes.
- [ ] Pre-cutover prod queries reviewed.
- [ ] `npm run check` passes.
- [ ] `npm run test:all` passes.
- [ ] `package.json` patch version bumped.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit authorization.

When Owen authorizes, push, then:

- [ ] `/api/schema` on production reflects the new surface.
- [ ] Smoke test a cold-apply → admin-approve → onboard cycle.
- [ ] `banned → active` via `setStatus` rejected with 422.

Only then is Phase A complete.
