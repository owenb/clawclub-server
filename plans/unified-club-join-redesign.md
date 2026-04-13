# Plan: Unified Club Join Redesign

This is the authoritative spec for the coding agent implementing this change. You are not that agent. Another agent will execute this plan. Your job is to do exactly what this document says, come back with questions only if something is genuinely ambiguous, and ship it to completion in a single coordinated change.

## Intent

The system must model every human as a normal member with a normal bearer token from the moment they touch the system, regardless of whether they are joining their first club as a complete stranger, redeeming an invitation from a friend, or cross-applying from one club to another. Applying to a club is a state on `club_memberships`, not a separate `admissions` record. Cold apply, warm (invitation-backed) apply, and cross-apply are one unified flow with different starting conditions the server detects from the request shape.

## Scope

One change, one maintenance window, one deploy. All legacy code and all legacy tables are removed in the same change. There is no coexistence period, no shim layer, no deprecation warning, no "remove in the next PR." When this change is merged and deployed, the codebase contains no trace of `admissions.public.*`, `admissions.crossClub.*`, `admissions.sponsorCandidate`, `clubadmin.admissions.*`, the `admissions` table, the `admission_versions` table, the `admission_challenges` table, the `admission_attempts` table, or the `current_admissions` view. The documentation (`SKILL.md`, `docs/design-decisions.md`, `README.md`) is rewritten in present tense as though the unified model is the only model that has ever existed. The only historical traces that survive are git history and the migration file itself.

## No quick fixes

This plan describes the correct long-term elegant end state. It is not optimized for minimal churn, minimal code motion, or minimal diff size. The reviewer does not care how many files are touched. The reviewer does care that every decision in this plan is the right one for the long-term shape of the system.

If you, the coding agent, find yourself reaching for a workaround — a temporary rename, a shim that returns an old shape, a partial migration that leaves a dangling reference, a `// TODO: remove in follow-up` comment, a deprecation warning, a conditional that handles both old and new shapes, an action that forwards to another action, a column that only exists for backwards compatibility, a test helper that normalizes old and new response shapes, a schema snapshot entry that preserves an old action name "just in case" — **stop**. That is not what this plan asks for. The correct move is the one that leaves the system in its final shape with no trailing threads. Churn is acceptable. Incomplete cleanup is not.

The only constraint on the shape of the change is correctness: the migration must be runnable, the tests must pass, the maintenance window must be short enough to run end-to-end, and the acceptance state machine and the notifications retargeting must land atomically in a single transaction. Inside those constraints, pick the answer that makes the system look as though the old shape never existed.

## Hard rules the coding agent must respect

Read `CLAUDE.md` before touching anything.

1. **Never change the OpenAI model name.** `gpt-5.4-nano` in `src/ai.ts` stays exactly as it is.
2. **Never run destructive git commands** on the working tree.
3. **Bump the patch version in `package.json` before committing.**
4. **All migrations go through `scripts/migrate.sh`.** Never `psql -f` directly. The migration must be tested through `reset-dev.sh` → `scripts/migrate.sh` → manual verification before `db/init.sql` is updated.
5. **Do not ship without real integration tests covering every path in this plan.** This is a major change to the central onboarding flow. A broken admissions path is worse than a broken feature because it blocks every new member from ever entering the system.

## The core decision

One human = one `members` row + one `cc_live_<id>_<secret>` bearer token. One (member, club) pair = one `club_memberships` row that moves through a unified state machine. One sponsorship concept = an `invitations` row that bypasses PoW for a specific (email, club) pair. One application surface = `clubs.join` + `clubs.applications.submit` + `clubs.applications.get` / `list`. One credential type throughout the system.

There is no applicant token. There is no exchange step. There is no "outsider" identity shape. There is no cold-vs-cross-vs-sponsored branching at any layer.

## Notifications and stream baseline (already shipped)

The notifications and stream rewrite from `plans/system-notifications-design.md` has already been executed. It is the current shipped baseline. This plan must carry that baseline forward and retarget it at the unified membership model — it must not overwrite it or silently regress it.

The shipped surfaces that must be preserved by this redesign are:

- `notifications.list` — personal sticky queue; unified read over materialized rows plus server-derived rows; returns `{ items, truncated }`.
- `notifications.acknowledge` — acknowledgement for materialized rows only. Derived rows are rejected with `422 invalid_input` and that error text is a client-facing contract.
- `activity.list` — club activity log with audience filtering (`members`, `clubadmins`, `owners`).
- `messages.getInbox` — paginated DM inbox read, unchanged as the canonical historical inbox surface.
- `messages.acknowledge` — DM inbox acknowledgement.
- `GET /stream` — single unified SSE stream. The old `/updates/stream` URL returns 404 and must not be reintroduced by this redesign. The stream emits `ready` (initial handshake with `notifications`, `notificationsTruncated`, `activityCursor`), `message` (DM inbox payloads), and `notifications_dirty` (invalidation-only, no body).
- `sharedContext.notifications` — notification set piggybacked on every authenticated response envelope via a single per-request cached read.
- `sharedContext.notificationsTruncated` — sibling truncation flag on the envelope piggyback.
- `member_notifications` — the renamed `signal_deliveries` table that backs the materialized half of `notifications.list`. Column `club_id` is nullable for future account-scoped notifications.

The notifications baseline currently derives admin-facing pending-application notifications from admissions-era concepts, which this redesign deletes. Every one of those hooks must be retargeted to the unified membership model as part of this same PR. Specifically:

- The derived "submitted application" notification is currently read from `current_admissions` where `status = 'submitted'` and the target club is in the actor's clubadmin scope. After this redesign it reads from `club_memberships` where `state = 'submitted'` and the target club is in the actor's clubadmin scope, ordered by `application_submitted_at ASC, id ASC`, capped at the same server-internal `MAX_NOTIFICATIONS`.
- The notification item `ref` shape currently carries `admissionId`. After this redesign it carries `membershipId`. The `clubId` ref stays. Any other ref fields the baseline emits (`memberId`, `clubSlug`) stay as the baseline defines them.
- The `kind_family` prefix currently used for the derived admissions item is `admission.submitted:*`. After this redesign it is `application.submitted:*`. `notifications.acknowledge` must continue to reject derived items by prefix detection, so the prefix rename is the only change here.
- The stream wakeup for new pending-application items currently comes from a `notify_admission_version` trigger on `admission_versions` INSERT. After this redesign the wakeup comes from a trigger on `club_membership_state_versions` INSERT that fires `NOTIFY` on the same channel the baseline already uses. The simplest correct trigger fires `notifications_dirty` on every row insert into `club_membership_state_versions`; narrowing to state transitions that affect the pending-application queue (entering or leaving `submitted`) is a valid optimization if it is trivially expressible in the trigger body.
- The admin drill-down target for a pending-application notification currently points at `clubadmin.admissions.get({ clubId, admissionId })`. After this redesign it points at `clubadmin.memberships.get({ clubId, membershipId })` returning a unified membership/application summary. The Phase 0 `clubadmin.admissions.get` action shipped by the notifications baseline is renamed and retargeted in this PR; every call site is updated in the same PR, including SKILL.md guidance, schema snapshot tests, and any notifications-baseline integration tests that name it.
- The `listNotifications` repository helper that assembles the unified read currently reads `member_notifications` plus `current_admissions`. After this redesign it reads `member_notifications` plus `club_memberships` filtered on application states, joined with `club_membership_state_versions` as needed for ordering.

**Hard rule.** After this PR, no code, no database view, no trigger, no notification payload, no documentation file, and no test may reference `current_admissions`, `admission_versions`, `clubadmin.admissions.get`, `ref.admissionId`, `admission.submitted:*`, or the `notify_admission_version` trigger as active behaviour. The notifications surfaces themselves stay. Only the admissions-era plumbing feeding them gets retargeted.

## Security model

The security boundary the old system relied on was "outsiders don't have tokens." That boundary is replaced with a stronger one: **tokens grant identity, not access.** Every club-scoped resource continues to check `accessible_club_memberships` (or its equivalent) before returning anything.

The access-granting set is the same one the existing `accessible_club_memberships` view already uses for paid clubs today:

- **Access-granting states**: `active`, `renewal_pending`, `cancelled` (until period end).
- **Non-access states**: `applying`, `submitted`, `interview_scheduled`, `interview_completed`, `payment_pending`, `declined`, `withdrawn`, `expired`, `removed`, `banned`.

`payment_pending` is explicitly **not** access-granting. A human who has been accepted into a paid club but has not yet completed billing has identity (a bearer token, a `members` row, a `club_memberships` row in `payment_pending` state), is recognized as an admitted member by the admin and billing surfaces, and can call `clubs.billing.startCheckout` to pay — but cannot read any club content, post anything, DM anyone, RSVP to events, or see other members in that club until billing flips their state to `active` via `superadmin.billing.activateMembership`. This is the same behaviour the current system already produces for `payment_pending` paid-club members; this redesign does not loosen it.

The design reuses this existing boundary for the full application lifecycle. A cold applicant in `applying`, a submitted applicant in `submitted`, an interview-scheduled applicant in `interview_scheduled`, and an accepted-but-unpaid applicant in `payment_pending` all sit on the non-access side of exactly the same view the billing model already gates on. There is no new access-control surface. There is no new code path. There is one accessibility view, the existing one, and it returns `active`/`renewal_pending`/`cancelled` for every caller regardless of how they entered the system.

### Threat model by path

**Cold anonymous apply.** A stranger calls `clubs.join(clubSlug, { email })` with no token and no invitation. The server creates a fresh `members` row, mints a bearer token for it, creates a `club_memberships` row in `applying` state for the new member and the target club, and issues a PoW challenge tied to that membership. The cost of spamming this path is one PoW solve per application. Spam protection comes from:

- Fresh-window IP rate limiting on anonymous `clubs.join` calls (reuse the existing cold admission rate limiter shape).
- The PoW challenge at submit time, difficulty tuned the same way cold admissions tune it today.
- The completeness gate at submit time, which rejects empty or policy-ignoring applications.
- Per-member concurrent-pending-applications cap that carries forward from the existing cross-apply cap (max 3 pending applications per member).

The bearer token the new member receives is narrow in practice: it cannot read any club content, post anything, DM anyone, RSVP to events, or see other members, because every one of those surfaces checks accessibility. It can only read the caller's own memberships, submit their own application, and pay for their own membership if accepted. A mass spam attack using this path produces nothing except `applying`-state rows and fresh `members` rows that the admin will never accept.

**Warm invitation-backed apply.** A member issues an invitation for a specific `(email, club)` pair and hands the code (`cc_inv_<id>_<secret>`) to a friend. The friend calls `clubs.join(clubSlug, { email, invitationCode })`. The server parses the invitation id out of the code, loads the invitation row `FOR UPDATE`, validates:

- `revoked_at IS NULL`
- `used_at IS NULL` **or** `used_membership_id` equals the membership about to be replayed (for retry safety)
- `expires_at > now()`
- `club_id` matches the club being joined
- `candidate_email_normalized` matches `lower(btrim(email))`
- `hashTokenSecret(secret)` equals `code_hash`
- The sponsor still has a live (non-terminal, non-banned, non-removed) membership in the club

If any check fails, the call returns a single generic `invalid_invitation_code` error. The server does not distinguish between "wrong code," "wrong email," "expired," "revoked," and "sponsor left the club" in the error message — that would leak information to a code-holder who is probing for context. Internal logs record the actual reason for operational visibility.

The server does not silently fall back from an invalid invitation to a cold PoW flow. If the invitation is invalid the call fails. The agent must either retry with a corrected code or ask the human to apply without one. This is an explicit design choice: ambiguous error behaviour is worse than a clean failure.

Invitation-backed join skips PoW. The trust is that the sponsor has vouched for this specific human, and the sponsor is accountable through the existing platform mechanisms. Sponsors are subject to:

- A quota of at most `N` open invitations per sponsor per club per rolling 30 days (start with `N = 10` and tune). Use the existing quota infrastructure if it fits; otherwise a lightweight counter per sponsor+club is fine.
- Auto-revoke of all open invitations in a club when the sponsor loses their membership in that club (membership transitions to `removed`, `banned`, `expired`). Enforce this either via a trigger on `club_memberships` or a check in the membership-state-transition code path. Prefer the latter for visibility.
- `invitations.issue` goes through the existing legality/quality gate, same as `admissions.sponsorCandidate` does today. Reuse the gate infrastructure.

**Cross-apply (authenticated returning member).** A member already has a bearer token. They call `clubs.join(clubSlug)` for a new club. The server detects the token, reuses the member id, and goes through the same code path as an anonymous caller would — except identity creation is skipped, and the member's stored contact email from `member_private_contacts` is used as the application email if they have one. If they do not have a stored contact email and the join requires one, the call accepts an `email` parameter and persists it. Do not silently ignore `email` for authenticated callers; honour it when useful.

Cross-applying members are still subject to:

- The duplicate-membership constraint: one non-terminal `club_memberships` row per `(club, member)`. If the caller already has a non-terminal membership in this club, `clubs.join` returns the existing `membershipId` and its current proof state (idempotent return, not an error).
- The shared `(club, email)` replay lock (see below) so a returning member cannot race a cold applicant who is using the same email.
- The per-member concurrent-pending-applications cap.

### Ambient authority boundaries

The coding agent must audit every action handler to confirm that it checks `accessible_club_memberships` (or the equivalent view) rather than just "is this token valid." The agent from the last review round already did most of this audit and found the system is mostly correct. The places that specifically need confirmation or tightening:

- **`accessTokens.create`**: MUST be tightened. An authenticated member cannot create additional bearer tokens unless they already have at least one membership in an access-granting state — i.e., `active`, `renewal_pending`, or `cancelled`. A member whose only memberships are `applying`, `submitted`, `interview_scheduled`, `interview_completed`, `payment_pending`, `declined`, or `withdrawn` is rejected with a clear error. `payment_pending` is intentionally on the reject side because a human who has been accepted but has not yet paid has no club access yet and should not be able to fan out additional bearer tokens. Once they complete billing and their membership flips to `active`, they can call `accessTokens.create` normally. This prevents an attacker who has solved PoW from minting durable tokens before acceptance, and it also prevents a paying-but-not-yet-paid applicant from minting durable tokens during the payment-pending window.
- **`accessTokens.list` and `accessTokens.revoke`**: remain identity-level (no tightening needed).
- **`profile.update`**: MUST NOT be able to modify a club-scoped profile for a non-accessible club. Pre-acceptance profile content lives in `club_memberships.generated_profile_draft` only — `member_club_profile_versions` is not created until the acceptance transition. This keeps `profile.list` and `profile.update` automatically clean for pre-acceptance members because there is nothing for them to list or update at the club scope.
- **`profile.list`**: audit. Self-scope currently reads all current memberships. With the draft-on-membership rule, pre-acceptance memberships have no profile version rows, so the list will naturally exclude them. Confirm this is the case in `src/identity/profiles.ts`.
- **`content.create`, `content.update`, `content.list`, `content.getThread`, `events.*`, `mentions.*`**: already anchor on `accessible_club_memberships` per the last review. Confirm during implementation that no path allows writing or reading by token-only check.
- **`messages.send` and `messages.getInbox`**: DM eligibility already requires a shared accessible club. Confirm this still holds and that pre-acceptance members cannot open new conversations.
- **`members.searchByFullText`, `members.searchBySemanticSimilarity`, `members.list`**: must scope to clubs the caller has access to. Pre-acceptance members searching for other members must see an empty result set.
- **`vouches.create`, `vouches.list`**: require caller to be an accessible member of the club.
- **`quotas.getUsage`**: returns zero or empty for pre-acceptance members because they have no accessible clubs.
- **Notifications, activity, inbox, stream, and the envelope piggyback**: the shipped surfaces `notifications.list`, `notifications.acknowledge`, `activity.list`, `messages.getInbox`, `messages.acknowledge`, `GET /stream`, and `sharedContext.notifications` / `sharedContext.notificationsTruncated` in every authenticated response envelope must only surface events for accessible clubs. "Accessible" here means memberships in `active`, `renewal_pending`, or `cancelled`. A member whose only memberships are in any other state — including `payment_pending` — sees an empty materialized notification set, an empty derived notification set, an empty `activity.list` for every club, an empty `messages.getInbox`, an envelope piggyback with `notifications: []` and `notificationsTruncated: false`, and a stream whose `ready` frame carries the same empty state with a null `activityCursor`. `notifications_dirty` may still fire for such a member (for example, immediately after billing flips one of their `payment_pending` memberships to `active`) but until that happens the dirty wake lands on an empty set. DM eligibility already requires a shared accessible club, so no sender can address a non-accessible recipient and the inbox cannot contain entries for them. The derived pending-application notification kind the baseline composes must have already been retargeted onto the unified membership model per the "Notifications and stream baseline" section above, so non-accessible members never see pending-application notifications for clubs they themselves are applying to.

**The coding agent must grep the codebase for every place that takes a bearer token and returns data**, and verify each one gates on accessibility, not just authentication. If any surface is found that returns club-scoped data based on token validity alone, it must be tightened in this change. Do not defer any of this to a follow-up.

### PoW, legality gate, and phasing

The existing three-phase submit structure in `src/clubs/admissions.ts` is the right pattern and must be preserved for the new `clubs.applications.submit`. Read the current cold submit code and mirror its structure exactly:

- **Phase 1** (short transaction): verify the membership belongs to the caller, verify the membership state is `applying`, load the PoW challenge, verify the nonce, count prior attempts, reject if attempts are exhausted. Commit.
- **Phase 2** (no transaction, no advisory locks): run the legality/completeness gate against the application content. Generate the club profile draft. Persist the draft onto the membership row in a short commit of its own.
- **Phase 3** (short transaction): reload the membership, re-verify it is still `applying`, re-verify the nonce is still valid against the challenge, record the submission attempt, persist the application fields onto the membership row, transition the membership state from `applying` to `submitted`, write the `club_membership_state_versions` row for the transition. Commit.

**No LLM call may happen while holding a transaction or an advisory lock.** If the coding agent finds themselves wrapping a `runAdmissionGate` call in `withTransaction`, stop and reread this section.

The PoW solver rule remains unchanged: `sha256(challengeId + ":" + nonce)` must end in `difficulty` hex zeros. Cold difficulty stays at the current cold difficulty. Warm/invitation-backed flows skip PoW entirely. Cross-apply (authenticated members applying to a new club) continues to use the lower difficulty the existing cross-apply path uses.

## User flows

### Flow A: cold anonymous apply

1. Agent calls `clubs.join(clubSlug, { email })` with no bearer token.
2. Server creates a fresh `members` row, mints a `cc_live_<id>_<secret>` bearer token, creates a `club_memberships` row in `applying` state with the supplied email as `application_email`, creates an `application_pow_challenges` row. Returns `{ memberToken, clubId, membershipId, proof: { kind: 'pow', challengeId, difficulty, expiresAt, maxAttempts }, club }`.
3. Agent stores `memberToken` as the durable identity for this human. Solves the PoW.
4. Agent calls `clubs.applications.submit({ membershipId, nonce, name, socials, application })` with `Authorization: Bearer <memberToken>`.
5. Server runs the three-phase submit. On gate pass, membership transitions to `submitted`, application content is persisted, the profile draft is stored. Response confirms the new state.
6. Agent polls `clubs.applications.get({ membershipId })` or `clubs.applications.list()`.
7. When the admin accepts via `clubadmin.memberships.setStatus`, the membership transitions atomically:
   - Free club: `submitted` → `active`. The human now has full club access through the existing accessibility checks. The agent detects the state change on the next poll and tells the human they are in.
   - Paid club: `submitted` → `payment_pending`. The human has identity but no club access yet. The agent detects the state change, tells the human the price, and calls `clubs.billing.startCheckout({ clubId })` to get a Stripe URL. After payment, the billing sync flips the membership to `active` via the existing `superadmin.billing.activateMembership` action.

### Flow B: warm invitation-backed apply

1. A sponsor who is an active member of the club calls `invitations.issue({ clubId, candidateName, candidateEmail, reason })`. The call runs through the legality gate (the same gate the current `admissions.sponsorCandidate` uses). Returns `{ invitation, invitationCode }` where `invitationCode` is `cc_inv_<id>_<secret>`.
2. The sponsor shares the code and the club slug with the candidate out of band.
3. The candidate's agent calls `clubs.join(clubSlug, { email, invitationCode })` with no bearer token.
4. Server parses the invitation id, loads the row `FOR UPDATE`, validates all the invitation checks. On pass: creates a fresh `members` row, mints a bearer token, creates a `club_memberships` row in `applying` state marked `proof_kind = 'invitation'` with `invitation_id` set, sets the invitation's `used_at` and `used_membership_id`. Returns `{ memberToken, clubId, membershipId, proof: { kind: 'none' }, club }`. No PoW challenge.
5. Agent stores the token. Calls `clubs.applications.submit` with no nonce (the `proof_kind` on the membership tells the server PoW is skipped). The gate still runs; the gate is about completeness, not trust.
6. Same polling, acceptance, and payment flow as Flow A.

### Flow C: cross-apply (authenticated returning member)

1. An existing member's agent already holds the member's bearer token. The human tells the agent to join a second club.
2. Agent calls `clubs.join(clubSlug)` with the existing bearer token in the `Authorization` header. No `email` or `invitationCode` needed (the member's stored contact email is used).
3. Server detects the authenticated caller. Reuses the member id. Checks the duplicate-membership constraint — if the caller already has a non-terminal membership in this club, returns the existing `membershipId` and current proof state (idempotent). Otherwise creates a new `club_memberships` row in `applying` state with `application_email` snapshotted from the member's contact email, creates an `application_pow_challenges` row at the cross-apply difficulty. Returns the existing bearer token unchanged plus the new `membershipId` and a PoW challenge.
4. If the member has an invitation for this new club, they pass `invitationCode` and PoW is skipped.
5. Everything from `clubs.applications.submit` onward is identical to Flow A.

### Flow D: accepted into a paid club

1. Agent polls `clubs.applications.list` and sees a membership transition from `submitted` to `payment_pending`.
2. Agent calls `clubs.billing.startCheckout({ clubId })`.
3. Server returns a Stripe checkout URL using the existing billing integration.
4. Human pays via Stripe.
5. Stripe webhook fires the existing `superadmin.billing.activateMembership` action, which transitions the membership from `payment_pending` to `active`.
6. Agent's next poll sees `active`. The human now has full club access through the existing accessibility checks.

### Flow E: lost response recovery (anonymous)

1. Agent calls `clubs.join(clubSlug, { email })`. Server creates the member, mints the token, creates the membership, returns the response.
2. Network drops. Agent never sees the response.
3. Agent retries the same call with the same email and club.
4. Server acquires the advisory lock on `application_join:<clubId>:<lower(btrim(email))>`, finds the existing non-terminal membership for that exact email and club, mints a fresh bearer token bound to the same `members` row, returns the existing `membershipId` and its current proof state.
5. Agent resumes exactly where it left off. The previously-minted token (which the agent never received) sits unused; it can be cleaned up lazily or left to expire.

This replay mechanism is the reason `clubs.join` is anchored on `(clubId, application_email_normalized)` as a natural idempotency key. It is NOT identity-by-email. It is resumption-by-application. Two different humans with the same email applying to the same club cannot happen because the first call creates the one application for that (club, email) slot; the second call finds it and resumes it. This is a feature, not a dedupe rule, and it is local to the application flow.

## API surface

### `clubs.join`

Auth: optional bearer.

Input:

```ts
{
  clubSlug: string;
  email?: string;
  invitationCode?: string;
}
```

Output:

```ts
{
  memberToken: string;
  clubId: string;
  membershipId: string;
  proof:
    | { kind: 'pow'; challengeId: string; difficulty: number; expiresAt: string; maxAttempts: number }
    | { kind: 'none' };
  club: {
    name: string;
    summary: string | null;
    ownerName: string;
    admissionPolicy: string | null;
    priceUsd?: number | null;
  };
}
```

Rules:

- Authenticated caller: reuse the caller's `member_id`. If a non-terminal membership exists for `(memberId, clubId)`, return it idempotently. If a valid invitation is supplied for the caller's contact email and the target club, skip PoW. Otherwise create or return a PoW challenge.
- Authenticated caller with no stored contact email: if `email` is provided, persist it to `member_private_contacts` as part of the join. If `email` is not provided and the join would require one (it always does for `application_email` snapshotting), return a clear error `email_required_for_first_join`.
- Anonymous caller: `email` is required. Never search for an existing member by email. Under the join replay lock on `application_join:<clubId>:<normalized_email>`, look for an existing non-terminal membership with that exact `application_email_normalized` and `club_id`. If found, mint a fresh token for that membership's member and return the existing membership and its current proof state. If not found, create a new member, mint a token, create the membership, and create or validate PoW/invitation state.
- Invitation handling: if `invitationCode` is present, parse the invitation id, `SELECT ... FOR UPDATE` the invitation row, validate every check listed in the threat model above. Reject with `invalid_invitation_code` if any check fails. On pass, mark `used_at = now()` and `used_membership_id = <the membership about to be created or replayed>`.
- Invitation replay: if the invitation row's `used_at` is already set but `used_membership_id` equals the membership currently being returned to the caller, treat it as a successful replay (same caller resuming the same flow). Do not reject.
- `memberToken` in the response: always echo the caller's authenticated token unchanged for Path 1, and mint a fresh token for Paths 2 and 3. In the anonymous replay case (Flow E), mint a fresh token for the same member — the old lost-in-transit token is orphaned.

### `clubs.applications.submit`

Auth: bearer.

Input:

```ts
{
  membershipId: string;
  nonce?: string;   // required when the membership's proof_kind is 'pow'
  name: string;
  socials: string;
  application: string;
}
```

Output:

```ts
type ClubsApplicationsSubmitResult =
  | {
      status: 'submitted';
      membershipId: string;
      applicationSubmittedAt: string;
    }
  | {
      status: 'needs_revision';
      feedback: string;
      attemptsRemaining: number;
    }
  | {
      status: 'attempts_exhausted';
      message: string;
    };
```

Rules:

- The three-phase structure is not optional. Mirror `src/clubs/admissions.ts` exactly.
- If the membership's `proof_kind` is `'pow'`, `nonce` is required; reject with `missing_nonce` if absent. If `proof_kind` is `'invitation'` or `'none'`, any supplied nonce is ignored.
- The legality/completeness gate runs in Phase 2 with no transaction and no advisory locks. The gate is the same gate that currently runs for cold admissions. Reuse the helper.
- Generate the club profile draft in Phase 2 and persist it onto `club_memberships.generated_profile_draft` via a short separate transaction before Phase 3. Do not generate the draft inside Phase 1 or Phase 3.
- Phase 3 is the only place the membership state transitions to `submitted`. The transition writes a `club_membership_state_versions` row for audit.
- On `needs_revision`, the membership stays in `applying` and the attempt is recorded. The nonce is reusable because the PoW check is stateless; the agent should retry `submit` without re-solving PoW. Mirror the existing behaviour.

### `clubs.applications.get`

Auth: bearer.

Input:

```ts
{ membershipId: string }
```

Output:

```ts
{
  application: {
    membershipId: string;
    clubId: string;
    clubSlug: string;
    clubName: string;
    state: MembershipState;
    submissionPath: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated';
    appliedAt: string;
    submittedAt: string | null;
    decidedAt: string | null;
    applicationName: string | null;
    applicationEmail: string | null;
    applicationSocials: string | null;
    applicationText: string | null;
    billing: {
      required: boolean;
      membershipState: MembershipState;
      accessible: boolean;
    };
  };
}
```

Rules:

- Caller must be the owning member of the membership. No read-through for other members, admins, or owners on this surface. Admins use `clubadmin.memberships.get` (the renamed admin action).
- Must not expose admin notes, intake fields, arbitrary metadata, invitation reasons, or invitation counts. This is a workflow-status surface, not a dossier surface.
- `billing.accessible` is `true` iff the membership is in a state that grants club access per the accessibility view.

### `clubs.applications.list`

Auth: bearer.

Input:

```ts
{
  status?: MembershipState | MembershipState[];
  clubId?: string;
}
```

Output:

```ts
{
  applications: ApplicationSummary[];
}
```

Rules:

- Returns all memberships for the caller, optionally filtered by state and/or club. This is the canonical "show me all the things I'm applying to or a member of" surface.
- No pagination required in v1 because a single human cannot have thousands of memberships. If this changes, add pagination later.
- Must only return the caller's own memberships.

### `clubs.billing.startCheckout`

Auth: bearer.

Input:

```ts
{ clubId: string }
```

Output:

```ts
{ checkoutUrl: string }
```

Rules:

- Caller must be the owning member of a `payment_pending` membership in the target club.
- Reuses the existing Stripe checkout integration. The coding agent must confirm that the existing billing integration has a hook for "start checkout for a pending membership" or add one.

### `invitations.issue`

Auth: bearer (member of the target club, not `applying`, not terminal).

Input:

```ts
{
  clubId: string;
  candidateName: string;
  candidateEmail: string;
  reason: string;
}
```

Output:

```ts
{
  invitation: {
    invitationId: string;
    clubId: string;
    candidateName: string;
    candidateEmail: string;
    sponsor: { memberId: string; publicName: string; handle: string | null };
    reason: string;
    status: 'open' | 'used' | 'revoked' | 'expired';
    expiresAt: string | null;
    createdAt: string;
  };
  invitationCode: string;
}
```

Rules:

- Sponsor must be an accessible member of the club at issue time.
- Reason runs through the legality/quality gate (reuse the same gate infrastructure the current `admissions.sponsorCandidate` uses).
- Only one open invitation per `(clubId, sponsorMemberId, candidateEmailNormalized)`. Calling `issue` again for the same tuple revokes the prior open row and creates a fresh one. Serialize this revoke-and-insert under the advisory lock `invitation_issue:<clubId>:<sponsorMemberId>:<normalized_email>`.
- Per-sponsor per-club rolling 30-day cap on open invitations (start at 10). Exceeding the cap returns `invitation_quota_exceeded`.
- If the sponsor loses club access after issuing, the open invitation is auto-revoked by the membership-state-transition code path.
- `invitationCode` is returned only at issue time. Subsequent reads via `listMine` never return the raw code.
- `code_hash` is computed via the existing `hashTokenSecret` helper in `src/token.ts` — same pattern as bearer tokens. Lookup is by `invitationId` (parsed from the code) + `code_hash` verifier.

### `invitations.listMine`

Auth: bearer.

Input:

```ts
{
  clubId?: string;
  status?: 'open' | 'used' | 'revoked' | 'expired';
}
```

Output:

```ts
{ invitations: InvitationSummary[] }
```

Rules:

- Returns only invitations issued by the calling member.
- Status is computed as `revoked` if `revoked_at` is set, `used` if `used_at` is set, `expired` if `expires_at < now()`, otherwise `open`.
- Never returns the raw code.

### `invitations.revoke`

Auth: bearer.

Input:

```ts
{ invitationId: string }
```

Output:

```ts
{ invitation: InvitationSummary }
```

Rules:

- The calling member must be the sponsor OR a club admin/owner of the invitation's club.
- Used invitations cannot be revoked (terminal state).
- Revoked and expired invitations cannot be re-revoked (idempotent: return current state).

## Membership state machine

The unified state machine lives on `club_memberships.state`. The existing enum/check must be extended to cover the application lifecycle states.

### All states

- `applying` — application is being drafted; the member has a membership row but no submitted content yet
- `submitted` — application content persisted, gate passed, awaiting admin decision
- `interview_scheduled` — admin has scheduled an interview
- `interview_completed` — interview completed, awaiting final decision
- `payment_pending` — accepted into a paid club, awaiting billing activation
- `active` — full access; free club acceptance or paid club post-activation
- `renewal_pending` — billing grace period (existing state)
- `cancelled` — member cancelled; access until period end (existing state)
- `expired` — period elapsed (existing state)
- `removed` — operator removed (existing state)
- `banned` — platform-wide ban (existing state)
- `declined` — admin declined the application
- `withdrawn` — applicant withdrew before a decision

### Legal transitions

- `applying -> submitted` (via `clubs.applications.submit`)
- `applying -> withdrawn` (via withdraw action — add a `clubs.applications.withdraw` action or reuse admin surface)
- `submitted -> interview_scheduled` (via `clubadmin.memberships.setStatus`)
- `submitted -> active` (free club acceptance)
- `submitted -> payment_pending` (paid club acceptance)
- `submitted -> declined`
- `submitted -> withdrawn`
- `interview_scheduled -> interview_completed`
- `interview_scheduled -> declined`
- `interview_scheduled -> withdrawn`
- `interview_completed -> active`
- `interview_completed -> payment_pending`
- `interview_completed -> declined`
- `interview_completed -> withdrawn`
- `payment_pending -> active` (via `superadmin.billing.activateMembership`)
- `payment_pending -> expired` (via `superadmin.billing.expireMembership`)
- `active -> renewal_pending`
- `active -> cancelled`
- `active -> expired`
- `active -> removed`
- `active -> banned`
- `renewal_pending -> active`
- `renewal_pending -> expired`
- `renewal_pending -> banned`
- `cancelled -> active`
- `cancelled -> expired`
- `cancelled -> banned`

### Illegal transitions (must be rejected)

- Anything from `active`, `payment_pending`, `renewal_pending`, or `cancelled` back to an application state (`applying`, `submitted`, `interview_*`)
- Anything from a terminal state (`declined`, `withdrawn`, `expired`, `removed`, `banned`) back to a non-terminal state
- Any transition that would leave two non-terminal memberships for the same `(clubId, memberId)` — enforced by a new partial unique index described below. The existing schema enforces a plain `UNIQUE (club_id, member_id)` constraint, which is too strong: it would block a declined or withdrawn applicant from ever re-applying. The migration drops the plain unique and replaces it with a partial unique index that only applies to non-terminal states, allowing re-application after a decision.
- `applying -> active` directly (must go through `submitted`)
- `applying -> payment_pending` directly
- `applying -> declined` directly (must go through `submitted` first; an admin cannot decline a draft)

Enforcement lives in the application layer, in a single transition helper that the `clubadmin.memberships.setStatus` action and the billing sync actions both call. The helper writes a `club_membership_state_versions` row for every transition. Illegal transitions are rejected with a clear error.

Update the membership-state sync trigger in `db/init.sql` so `declined` and `withdrawn` also mirror into `left_at` where appropriate, matching the existing `removed`/`cancelled`/`expired` handling.

## Concurrency and locking

### Anonymous join replay lock

For anonymous `clubs.join` calls, acquire a transaction-scoped advisory lock keyed on `application_join:<clubId>:<normalized_email>` before looking for an existing non-terminal membership. The same lock is held through the create-or-replay decision and the bearer token mint. Compute the lock key in JavaScript using `lower(email.trim())` to match the DB-side `lower(btrim(...))` generated column exactly. Use `pg_advisory_xact_lock(hashtext(...))` the same way the existing `src/clubs/admissions.ts` code does.

### Authenticated cross-apply

For authenticated `clubs.join` calls, acquire the same `application_join:<clubId>:<normalized_email>` lock using the member's current contact email. This serializes cross-apply against concurrent cold applies for the same email. After that, acquire the existing per-member cross-apply concurrency lock (`cross_apply:<memberId>`) to serialize multiple concurrent cross-applies by the same member. Lock order must always be: email lock first, member lock second.

### Invitation issuance

For `invitations.issue`, acquire `invitation_issue:<clubId>:<sponsorMemberId>:<normalized_candidate_email>` before the revoke-prior-plus-insert sequence. This prevents two concurrent `issue` calls from the same sponsor for the same candidate from racing the partial unique index.

### Invitation redemption

For `clubs.join` with an invitation, `SELECT ... FOR UPDATE` the invitation row first (inside the same transaction that will mark it used), then acquire the email replay lock. Lock order: invitation row FOR UPDATE, then email advisory lock.

### Submit phasing

Submit Phase 1 and Phase 3 are each their own transactions. Phase 2 (gate + draft persistence) holds no transaction. Advisory locks are only held within Phase 3 if the duplicate-state check needs them — in practice, the membership row's state is the natural serialization point because Phase 3 does a state update on a specific row and Postgres's row-level locking handles concurrent state updates.

### Acceptance

Admin acceptance via `clubadmin.memberships.setStatus` is a single UPDATE statement on one `club_memberships` row plus an INSERT into `club_membership_state_versions`. This runs in one transaction. Because the member and membership rows already exist by the time the admin clicks accept, there is no multi-table saga. There is no "atomic acceptance refactor" needed — acceptance is naturally atomic because it touches exactly one row of application state.

## Schema changes

### Extend `club_memberships`

Add the following columns:

- `application_name text`
- `application_email text`
- `application_email_normalized text GENERATED ALWAYS AS (lower(btrim(application_email))) STORED`
- `application_socials text`
- `application_text text`
- `applied_at timestamptz`
- `application_submitted_at timestamptz`
- `submission_path text` with check constraint `submission_path IN ('cold', 'invitation', 'cross_apply', 'owner_nominated')`
- `proof_kind text` with check constraint `proof_kind IN ('pow', 'invitation', 'none')`
- `invitation_id short_id` nullable, FK to `invitations(id)`
- `generated_profile_draft jsonb` nullable

Notes:

- `application_email` is a per-application snapshot; it is not the member's global identity.
- `member_private_contacts.email` remains the mutable contact channel.
- `submission_path` is written at membership creation and must be immutable after that. Enforce via a trigger or via transition code that never touches this column on update.
- **Drop the existing `club_memberships_sponsor_check` constraint entirely.** The invariant it tries to express ("every membership has a sponsor unless clubadmin") does not exist in the unified model. Cold applicants never have a sponsor, through every state a cold applicant can reach (`applying`, `submitted`, `interview_*`, `payment_pending`, `active`, `renewal_pending`, `cancelled`, `expired`, `removed`, `banned`, `declined`, `withdrawn`). Any DB-level check that tries to enumerate the allowed sponsor-less states is either incomplete (blocks cold-applicant acceptance) or vacuous. The real invariant — "invitation-backed memberships have a sponsor; cold memberships do not" — keys on `submission_path`, not on `status`, and is enforced by the application code at row-creation time in `clubs.join`. Do not reintroduce this constraint in any form.
- **Do not repurpose `joined_at`**. `applied_at` is the new column for "when the application started." `joined_at` keeps its existing meaning: the moment the human actually joined the club as a full member. Under the new model, "joined" means "first entered an access-granting state," which is `active`. `payment_pending` is not joining; it is accepted-but-not-yet-paid. The first transition into `active` is the join moment.

  The current `club_memberships.joined_at` column is `NOT NULL DEFAULT now()` and immutable. That shape is incompatible with the new semantics — an `applying`-state row created by `clubs.join` does not represent a join and must not have `joined_at` populated. The migration makes the following concrete changes to the column:

  - Drop the `NOT NULL` constraint.
  - Drop the `DEFAULT now()`.
  - Update the immutability trigger (if any) to allow the transition from `NULL` to a concrete timestamp exactly once, at the moment the membership first enters `active`, and to reject any other write to the column. If the current system enforces immutability via a column-level constraint rather than a trigger, replace it with a trigger that expresses the one-way-fill rule.
  - Set `joined_at` in the state-transition helper whenever a membership transitions into `active` for the first time (i.e., `joined_at IS NULL` before the transition). Subsequent transitions in and out of `active` (e.g., `renewal_pending → active`, `cancelled → active`) do not touch `joined_at`; it stays at its original value.
  - Backfill `joined_at` for existing `club_memberships` rows: for any row whose current state is or has ever been an access-granting state, preserve the existing `joined_at` value. For any row whose current state is application-lifecycle (`applying`, `submitted`, `interview_*`) — introduced by the migration for legacy in-flight admissions — set `joined_at = NULL`.

  The migration should include an assertion that every row in an access-granting state after backfill has a non-null `joined_at`, and every row in an application-lifecycle state has a null `joined_at`.
- Create an index on `(club_id, application_email_normalized)` where `application_email_normalized IS NOT NULL` for the replay lookup.
- **Drop the existing plain `UNIQUE (club_id, member_id)` constraint on `club_memberships`** and replace it with a partial unique index:

  ```sql
  CREATE UNIQUE INDEX club_memberships_non_terminal_unique
      ON club_memberships (club_id, member_id)
      WHERE state NOT IN ('declined', 'withdrawn', 'expired', 'removed', 'banned');
  ```

  The predicate is a fixed set of string literals, which is immutable, so Postgres accepts it as a partial index predicate. This allows a declined or withdrawn applicant to re-apply (creating a new `club_memberships` row for the same `(club_id, member_id)` pair) while still preventing two concurrent non-terminal memberships. Any existing code that assumed the plain unique constraint and upserted by `(club_id, member_id)` needs to be updated to query for a non-terminal row explicitly and branch.

  The replay lock on `application_join:<clubId>:<application_email_normalized>` still serializes the "is there an in-flight application I should resume?" check, which the partial unique index alone cannot express (it keys on `member_id`, not `application_email_normalized`). Both mechanisms coexist: the partial unique index enforces "one non-terminal row per (club, member)" at the DB level, and the replay lock enforces "one in-flight application per (club, email)" at the application level.

### The state-machine rewrite is a first-class workstream, not a side-effect

The unified state machine is not an "extend the existing check constraint" task. The existing `club_memberships` states are baked into multiple layers of the system: the schema definition in `db/init.sql`, the `membership_state` type (or `text` + `CHECK` constraint) and its sync trigger, the public-facing state values in `src/schemas/fields.ts`, the admin default state used by `clubadmin.memberships.create` in `src/schemas/clubadmin.ts`, the identity-layer membership helpers in `src/identity/index.ts` and `src/identity/memberships.ts`, and the prose in `docs/billing-sync-contract.md`. All of those must be updated in the same PR.

Commit the following plan for the state rewrite:

1. **Enumerate the new canonical state set.** It is exactly the set listed in "All states" under the "Membership state machine" section above: `applying`, `submitted`, `interview_scheduled`, `interview_completed`, `payment_pending`, `active`, `renewal_pending`, `cancelled`, `expired`, `removed`, `banned`, `declined`, `withdrawn`. Nothing else. No synonyms, no legacy spellings, no aliases.
2. **Drop the existing state check/enum on `club_memberships`.** Whether the current shape is a `CHECK (state IN (...))` constraint or a named enum type, the migration drops it and creates a new one over the full unified set.
3. **Rewrite the membership-state sync trigger** to handle the new set, in particular mirroring `declined` and `withdrawn` into `left_at` where appropriate and leaving `applying`/`submitted`/`interview_*` alone.
4. **Audit every call site that names a state value**, including but not limited to:
   - `src/schemas/fields.ts` — public-facing state enum; rewrite to the unified set.
   - `src/schemas/clubadmin.ts` — `clubadmin.memberships.create` default state and any state-valued input validation; rewrite to the unified set.
   - `src/schemas/superadmin.ts` — around line 804 and any other hit that names membership states directly (the superadmin surface currently enumerates old state values in at least one schema definition); rewrite every hit to the unified set.
   - `src/contract.ts` — around line 15 and any other place the contract layer names a membership state literal. The contract is the public type surface; every state value it enumerates must match the unified set after this PR.
   - `src/identity/index.ts` and `src/identity/memberships.ts` — internal helpers that read or write state; rewrite every hit.
   - `src/postgres.ts` — around line 2089 and any other hit that names membership states directly in SQL or TypeScript. The migration + runtime sides both need to be updated; the coding agent must grep the whole file and sweep.
   - `accessible_club_memberships` view in `db/init.sql` — confirm the access-granting set is `active`, `renewal_pending`, `cancelled` and no other state. If the view currently names anything else, rewrite it.
   - `docs/billing-sync-contract.md` — prose that names states; rewrite to match. The billing sync action names stay; the states they operate on stay at their current shapes (`payment_pending`, `active`, `renewal_pending`, `cancelled`, `expired`, `banned`).

   The file list above is a floor, not a ceiling. The coding agent **must** run a full-codebase grep for every old state name and treat any hit that is not in the list above as a find that needs to be rewritten in the same PR. If the grep produces a hit in a file not named here, do not skip it — rewrite it, and mention it when you hand back the PR so we can keep the plan honest for the next time.
5. **Grep for every string literal that matches an old state name** and confirm each hit is either (a) a state the new system still has, in which case no change, or (b) a string that refers to a concept this redesign is retiring, in which case delete.
6. **Update the schema snapshot test** so every state-valued schema field reflects the unified set.
7. **Update every integration test** that asserts a specific state value. The test suite currently includes state-assertions in multiple places; the coding agent must sweep all of them.

This is a real workstream. It is not a cosmetic rename. Treat it with the same care as the admissions drop and the notifications retarget.

### Membership-state sync trigger

The existing membership-state sync trigger in `db/init.sql` mirrors certain state transitions into `left_at`. Update it so:

- Transitions into `expired`, `removed`, `banned`, `declined`, or `withdrawn` set `left_at = now()`.
- Transitions out of any of those states clear `left_at` (this only applies to `cancelled → active`, which already works; no new transitions exit a terminal state).
- Transitions into `applying`, `submitted`, `interview_scheduled`, `interview_completed`, `payment_pending`, `active`, `renewal_pending`, or `cancelled` do not touch `left_at`.

### Reuse `club_membership_state_versions`

The existing audit table is the right place. Do not create a replacement. Every state transition — including `applying -> submitted` and every application-lifecycle transition — writes a row here.

This table also becomes the wakeup source for the notifications-baseline stream. The notifications rewrite currently attaches a `notify_admission_version` `AFTER INSERT` trigger on `admission_versions` that emits `NOTIFY` on the unified stream channel so `/stream` can issue `notifications_dirty` to clubadmin scopes. This redesign drops `admission_versions`, which removes the trigger. It is replaced in the same PR by an equivalent `AFTER INSERT` trigger on `club_membership_state_versions` that emits the same `NOTIFY` on the same channel.

The trigger fires on every insert into `club_membership_state_versions`. This is the correct shape: `notifications_dirty` is a dirty-wake invalidation, not a payload. Clients handle it via an idempotent re-read of `notifications.list` (or the `sharedContext.notifications` piggyback on their next authenticated response). A spurious wake costs one cheap indexed query on the client's next call and returns the same notification set. A missed wake leaves the client holding stale state until its next unrelated authenticated call. Over-fire is correct; under-fire is a bug. The trigger body does not attempt to narrow to "only transitions that affect the pending-application queue" — that would couple the trigger logic to the notifications-baseline derivation rules, which is exactly the kind of cross-layer coupling the dirty-wake pattern exists to avoid.

### New table: `invitations`

```sql
CREATE TABLE invitations (
    id                         short_id DEFAULT new_id() NOT NULL,
    club_id                    short_id NOT NULL,
    sponsor_member_id          short_id NOT NULL,
    candidate_name             text NOT NULL,
    candidate_email            text NOT NULL,
    candidate_email_normalized text GENERATED ALWAYS AS (lower(btrim(candidate_email))) STORED,
    reason                     text NOT NULL,
    code_hash                  text NOT NULL,
    expires_at                 timestamptz NOT NULL,
    expired_at                 timestamptz,
    used_at                    timestamptz,
    used_membership_id         short_id,
    revoked_at                 timestamptz,
    created_at                 timestamptz DEFAULT now() NOT NULL,
    metadata                   jsonb DEFAULT '{}'::jsonb NOT NULL,

    CONSTRAINT invitations_pkey PRIMARY KEY (id),
    CONSTRAINT invitations_code_hash_unique UNIQUE (code_hash),
    CONSTRAINT invitations_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT invitations_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES members(id),
    CONSTRAINT invitations_used_membership_fkey FOREIGN KEY (used_membership_id) REFERENCES club_memberships(id)
);

CREATE INDEX invitations_candidate_lookup_idx
    ON invitations (club_id, candidate_email_normalized, created_at DESC);

CREATE UNIQUE INDEX invitations_open_per_sponsor_candidate_idx
    ON invitations (club_id, sponsor_member_id, candidate_email_normalized)
    WHERE revoked_at IS NULL AND used_at IS NULL AND expired_at IS NULL;
```

The schema uses two timestamps deliberately:

- `expires_at` is the policy TTL — the moment the invitation should stop being redeemable.
- `expired_at` is the materialized "this row is no longer open" flag used by the partial unique index and the `listMine` status derivation.

Both are needed because Postgres partial indexes cannot reference `now()` — the index predicate must be IMMUTABLE, and `now()` is STABLE. The materialized-flag pattern is the canonical Postgres solution for "unique among open rows where 'open' includes a time component." This is not a workaround; it is the correct shape.

The cleanup worker materializes expiry by setting `expired_at = now()` when `expires_at < now()` for any row that still has `expired_at IS NULL`. The `invitations.issue` code path also eagerly materializes any stale row it touches before checking the uniqueness rule, so concurrent issuance sees a consistent view without waiting for the cleanup worker. Validation code everywhere (begin, submit, listMine status derivation) must check **both** `expired_at IS NULL` **and** `expires_at > now()` — a row whose TTL has passed but whose `expired_at` has not yet been materialized must be treated as expired. The partial index may be briefly stale (a row past `expires_at` with `expired_at IS NULL` still occupies the unique slot), but every read path corrects for that by checking the live time.

The sponsorship TTL is `30 days` from issuance. After `expires_at + 24h` the cleanup worker has had at least one pass at every row, so the stale-index window is bounded and small.

### New table: `application_pow_challenges`

```sql
CREATE TABLE application_pow_challenges (
    id              short_id DEFAULT new_id() NOT NULL,
    membership_id   short_id NOT NULL,
    difficulty      integer NOT NULL,
    expires_at      timestamptz NOT NULL,
    solved_at       timestamptz,
    attempts        integer DEFAULT 0 NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT application_pow_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT application_pow_challenges_membership_fkey
        FOREIGN KEY (membership_id) REFERENCES club_memberships(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX application_pow_challenges_one_active_per_membership
    ON application_pow_challenges (membership_id)
    WHERE solved_at IS NULL;
```

## Migration

Everything ships in one migration file, executed via `scripts/migrate.sh`, tested first via `reset-dev.sh` → `scripts/migrate.sh` → manual verification. Only after the migration is verified end-to-end may `db/init.sql` be updated to reflect the target state.

### Maintenance-window cutover

This is not a rolling deploy. The cutover is a sequence of ordered steps with explicit gates between them. Do not skip a step. Do not fold two steps together. If a gate fails, stop and escalate to me before trying the next step.

**Pre-cutover preparation (done on the day, before traffic is paused).**

0a. **Gather the legacy in-flight applicant list.** Run a read-only query against the live production DB to enumerate every `admissions` row whose status is `submitted`, `interview_scheduled`, or `interview_completed`, grouped by `club_id`. Capture `applicant_email`, `applicant_name`, `club_slug`, and the current status. Save this list somewhere outside the DB — a local file is fine; the point is that the admins have a list of humans to reach out to post-cutover so those applicants know to re-call `clubs.join` with their original email to resume. This is a pre-cutover step rather than a post-cutover step because once the migration runs, the old `admissions` table is gone and the original shape is unrecoverable except through the backup.

0b. **Take a full production database backup.** Run `pg_dump` (or whatever the equivalent Railway-supported mechanism is) against the production database and save the dump to durable storage outside the production box. Verify the dump is restorable by loading it into a throwaway local Postgres and confirming the row counts match expected. Do not proceed to step 1 until the backup has been verified restorable. This backup is the sole rollback path; if the migration fails, you will restore from it.

**Cutover (under maintenance window).**

1. **Pause traffic.** Put the API into a maintenance window; reject or queue incoming requests. All incoming HTTP requests return a clear "maintenance in progress" response (503 with a `Retry-After` header, or similar).
2. **Run the migration.** `scripts/migrate.sh` applies the single migration file. Capture the full stdout/stderr of the migration run. If the migration raises an error (including any of the "fail loudly on historical anomaly" `RAISE EXCEPTION` cases the plan specifies), **stop**. Do not proceed to step 3. Go to the rollback procedure below.
3. **Deploy the new server code.** Push the PR to main (or whatever the Railway deploy trigger is). The new code knows only about the new tables and actions. Wait for the new container to become healthy before step 4.
4. **Smoke-test the new flow.** Run the verification-checklist smoke test against the just-deployed server. At minimum: `clubs.join` (anonymous cold path) → PoW → `clubs.applications.submit` → poll via `clubs.applications.get` → admin accepts via `clubadmin.memberships.setStatus` → caller sees `active`. Also run an authenticated cross-apply join and an invitation join. If any smoke test fails, **stop**. Do not proceed to step 5. Go to the rollback procedure below.
5. **Reopen traffic.** Lift the maintenance window.

**Post-cutover (after traffic reopens).**

6. **Admin follow-up to legacy in-flight applicants.** Using the list gathered in step 0a, admins reach out to every legacy in-flight applicant and instruct them to re-call `clubs.join` with their original email to resume their application. The replay mechanism will find the migrated membership and mint them a fresh bearer token. This is a one-time operational task; after the list is worked through, there are no more legacy-shaped applicants in the system.
7. **Watch the first hour.** Monitor the first real `clubs.join` and `clubs.applications.submit` round-trips against the new system. Watch for error-rate spikes in `notifications.list`, `/stream`, and the activity surfaces that were retargeted. If any post-cutover behaviour looks wrong — especially around notifications derived from application state — capture the error and escalate. Do not silently hotfix in production.

**Rollback procedure.**

Rollback is only invoked if step 2 (migration) fails or step 4 (smoke test) fails. It is not a general-purpose escape hatch; it is the emergency path when something has gone materially wrong in the cutover window.

- R1. **Confirm the failure is not a single-action fix.** If step 2 failed because the migration hit a historical anomaly that can be repaired with a one-line SQL patch, fix the migration file, re-test it against the dev DB, and re-run step 2. If step 4 failed because a smoke-test fixture was stale, fix the fixture and re-run step 4. Do not roll back for trivial fixes — roll back for "we cannot make this work in the next 30 minutes."
- R2. **Restore the database.** Drop the current database and restore from the step-0b backup. Confirm row counts match the pre-migration state.
- R3. **Redeploy the previous git SHA.** The PR containing this redesign is reverted or the previous deploy is re-promoted. Wait for the old container to become healthy.
- R4. **Lift the maintenance window.** Old traffic resumes on old code against the restored database.
- R5. **Post-rollback debrief.** Diagnose the failure offline. The next attempt will need a new maintenance window.

Rationale for the maintenance-window approach: old containers import and expose `admissions.*` actions. Once the old tables are dropped, old code cannot continue to serve safely even during a drain. The maintenance window avoids a multi-PR coordination dance and gives us a clean gate between the migration and the new-code deployment. Rollback is the reason for the pre-cutover backup — if anything goes wrong, `pg_restore` + previous SHA is the escape path. Do not attempt to hand-patch a broken production state without rolling back first.

### Step 1: schema changes (in the single migration file)

- Create the `invitations` table with indexes.
- Create the `application_pow_challenges` table with indexes.
- Add all new columns on `club_memberships`.
- Add the `submission_path` check constraint.
- Add the `proof_kind` check constraint.
- Add the `(club_id, application_email_normalized)` partial index.
- Drop `club_memberships_sponsor_check` entirely. Do not reintroduce it in any form. The "invitation-backed memberships have a sponsor; cold memberships do not" invariant is enforced in application code at `clubs.join` insert time, not via a DB-level cross-state check. See the "Extend `club_memberships`" section for the full reasoning.
- Retarget `club_memberships_require_profile_version()` so it returns early for memberships whose INSERT-time status is not in `('active', 'renewal_pending', 'cancelled')`. The existing `DEFERRABLE INITIALLY DEFERRED` constraint trigger stays in place; only the function body is rewritten via `CREATE OR REPLACE FUNCTION`. This preserves the "new access-state members must have a profile version at commit" check for admin direct-adds while permitting pre-acceptance memberships (which hold their profile content in `club_memberships.generated_profile_draft` until acceptance) to INSERT without a profile version. Note that under the new flow, the common path is `clubs.join` creating a row in `applying`, then a separate admin transition UPDATE-ing the row to `active` via the sync trigger — the INSERT trigger never fires on the `active` case because the row is never INSERTed directly as `active`. The state-transition helper in the application layer is responsible for inserting the profile version row in the same transaction as the acceptance transition; the DB-level check is a safety net only for direct-active INSERTs.
- Drop the plain `club_memberships_club_member_unique UNIQUE (club_id, member_id)` constraint. Create the partial unique index `club_memberships_non_terminal_unique ON club_memberships (club_id, member_id) WHERE state NOT IN ('declined', 'withdrawn', 'expired', 'removed', 'banned')` in its place.
- **Swap the `membership_state` enum.** This is done as a three-phase ALTER sequence because Postgres does not allow dropping and recreating an enum type while columns still use it:

  1. `ALTER TABLE club_memberships ALTER COLUMN status DROP DEFAULT;` — the current default is `'active'`, which must be gone before the column type changes.
  2. `ALTER TABLE club_memberships ALTER COLUMN status TYPE text USING status::text;` — temporarily move the column off the enum so the legacy values can be rewritten.
  3. Run every legacy-value rewrite from the "Legacy membership state mapping" subsection below. Every row in `club_memberships` must hold a canonical new-world value before step 4.
  4. `DROP TYPE membership_state;` — the old type has no remaining users.
  5. `CREATE TYPE membership_state AS ENUM ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending', 'active', 'renewal_pending', 'cancelled', 'expired', 'removed', 'banned', 'declined', 'withdrawn');` — the new canonical set. Exactly thirteen values, no synonyms, no legacy cruft.
  6. `ALTER TABLE club_memberships ALTER COLUMN status TYPE membership_state USING status::membership_state;` — re-bind the column. If any row still holds a non-canonical value at this point the cast fails and the migration aborts; that is intended behaviour.
  7. **Do not restore the default.** The previous `DEFAULT 'active'` was a footgun — it silently produced accepted members if a caller forgot to set the state. Under the unified model, every insert into `club_memberships` must explicitly name the starting state (`applying` for anonymous and invitation-backed joins before submit, `active` for direct admin-adds, `submitted` for legacy in-flight migrations, etc.). Leave the column `NOT NULL` with no default so every call site is forced to be explicit.

- Drop the `club_memberships.source_admission_id` column entirely, along with its `club_memberships_source_admission_unique` partial index. The column pointed at `admissions`, which is being dropped. Any code currently reading it must have been updated in the same PR per the legacy-removal step.
- Drop `NOT NULL` and `DEFAULT now()` from `club_memberships.joined_at`. Update the `lock_club_membership_mutation` trigger so `joined_at` may transition from `NULL` to a concrete timestamp exactly once (at the first entry into `active`), and otherwise remains immutable. See the `joined_at` bullet in the "Extend `club_memberships`" section for the full rule.
- Update the membership-state sync trigger to mirror `declined` and `withdrawn` into `left_at` where appropriate, matching the existing `removed` / `cancelled` / `expired` handling. The trigger also clears `joined_at`-related side-effects appropriately per the rewritten column semantics.

### Step 2: data migration (same migration file)

#### Legacy `membership_state` enum value mapping

The existing `membership_state` enum contains six values that are not in the unified set: `invited`, `pending_review`, `paused`, `left`, `revoked`, `rejected`. Every row holding one of these must be rewritten to a canonical new-world value before the enum swap (step 1.4 above). The mapping is deterministic, per-row, and runs during step 1.3 of the enum-swap sequence while the column is in text mode.

After this rewrite, the `membership_state` enum contains **exactly** the thirteen unified values. No legacy values survive anywhere in the type, the column, or the code. There are no synonyms and no compatibility aliases.

The mapping:

| Legacy value | New value | Rule |
|---|---|---|
| `active` | `active` | No change. |
| `invited` | `applying` | Legacy sponsored placeholder rows become in-flight applications in the unified model. The candidate already has a `members` row; their agent resumes by re-calling `clubs.join` (authenticated cross-apply path: the server sees the existing non-terminal membership and returns it idempotently, and the agent proceeds through PoW + submit). If the candidate never resumes, the row stays in `applying` and is picked up by the standard cleanup worker under whatever stale-application policy lands later. |
| `pending_review` | `submitted` if a corresponding `admissions` row exists with application content (copy `applicant_name`, `applicant_email`, `admission_details->>'application'`, and `admission_details->>'socials'` onto the membership row during the same rewrite), else `applying`. | Reuses the same per-row admission lookup the "Accepted admissions already linked to memberships" subsection below specifies. The agent handling the rewrite walks the `club_memberships` rows in `pending_review`, joins to `admissions` by `club_memberships.source_admission_id` (before that column is dropped), and decides per-row. |
| `paused` | `expired` | Old-model "unpaid subscription" becomes new-model "lapsed." The lapsed human must re-apply via `clubs.join` to come back. There is no conditional mapping based on subscription grace windows — a simple uniform rule is more elegant than a subscription-state lookup, and the billing sync can handle re-admissions through the normal flow if the human returns. |
| `left` | `expired` | Voluntary departure becomes "lapsed." Same uniform rule as `paused`. The human re-applies if they want to come back. |
| `revoked` | `removed` | Club-level access revocation. `banned` is reserved for platform-wide bans only, and no legacy row distinguished between club-level and platform-level, so the conservative mapping is `removed`. |
| `rejected` | `declined` | Clean synonym. |
| `removed` | `removed` | No change. |
| `payment_pending` | `payment_pending` | No change. |
| `renewal_pending` | `renewal_pending` | No change. |
| `cancelled` | `cancelled` | No change. |
| `expired` | `expired` | No change. |
| `banned` | `banned` | No change. |

#### `left_at` consistency backfill

After the state rewrite, any row whose new state is `expired`, `removed`, `banned`, `declined`, or `withdrawn` must have a non-null `left_at`. The migration audits the rows it rewrote and sets `left_at = now()` for any target-state row whose `left_at` is still NULL. Rows that were already in one of those states pre-migration keep their existing `left_at` value. The membership-state sync trigger already handles this going forward; this backfill is a one-time consistency pass for the migration boundary.

#### Assert no legacy values remain

After the rewrites in step 1.3, run an assertion query: `SELECT DISTINCT status FROM club_memberships;` must return only values in the unified set (text comparison, while the column is still in text mode). If any non-canonical value remains, the migration raises an exception naming the offending value and aborts. This is a defensive check against an unmapped enum value appearing in production that the dev DB doesn't have.

#### Accepted admissions already linked to memberships

For each `admissions` row with `applicant_member_id IS NOT NULL` AND the corresponding `club_memberships` row exists:

- Map the old `admissions.status` into the new `club_memberships.state`:
  - `submitted -> submitted`
  - `interview_scheduled -> interview_scheduled`
  - `interview_completed -> interview_completed`
  - `accepted` → whatever state the membership is already in (`active`, `payment_pending`, etc.); trust the membership
  - `declined -> declined`
  - `withdrawn -> withdrawn`
- Copy application fields onto the membership row:
  - `application_name` from `admissions.applicant_name`
  - `application_email` from `admissions.applicant_email`
  - `application_socials` from `admission_details->>'socials'` if present, else `NULL`
  - `application_text` from `admission_details->>'application'` if present, else `NULL`
  - `generated_profile_draft` from `admissions.generated_profile_draft` if present
- Set `applied_at` to `admissions.created_at`
- Set `application_submitted_at` to the `admission_versions` row with `status = 'submitted'` and the lowest `version_no`, or `admissions.created_at` as a fallback
- Set `submission_path` to `'cold'` for `self_applied` origin with no cross-apply marker, `'cross_apply'` for `self_applied` with cross-apply marker (first `admission_versions` row with a non-null `created_by_member_id`), `'invitation'` for `member_sponsored`, `'owner_nominated'` for `owner_nominated`
- Set `proof_kind` to `'pow'` for `cold`/`cross_apply` origins, `'invitation'` for `member_sponsored`, `'none'` for `owner_nominated`
- **Insert exactly one `club_membership_state_versions` row per migrated legacy in-flight membership**, describing the current state at migration time (`submitted` / `interview_scheduled` / `interview_completed` / `declined` / `withdrawn` as appropriate), with `created_at = admissions.created_at` for `submitted` rows and the corresponding `admission_versions.created_at` for any non-`submitted` current state. Do not backfill the full `admission_versions` history. Pre-acceptance admission history is not preserved into the membership-state audit log; only the current state is. This is a deliberate choice: merging two version-numbered audit streams into one without introducing ambiguity is expensive and the historical records are available in git history and DB backups for any operational case that genuinely needs them. The forward-running system operates on current state plus its own state-versions audit, all of which are populated correctly by the migration and by the new state-transition helper going forward.

#### In-flight outsider admissions not linked to memberships

For each `admissions` row with `applicant_member_id IS NULL` AND no corresponding `club_memberships` row:

- **Create a fresh `members` row per admission.** Do not merge by email. Each in-flight legacy outsider becomes their own new member identity.
- Create a `club_memberships` row in the corresponding state (`submitted`, `interview_scheduled`, etc. — whatever the old `admissions.status` was).
- Copy application fields as above, including `application_email`. The generated `application_email_normalized` column is automatically populated. This is the field the replay mechanism uses to resume the flow for these legacy applicants.
- Set `applied_at`, `application_submitted_at`, `submission_path`, and `proof_kind` as above.
- **Do not mint a bearer token for these legacy rows.** The legacy applicant resumes via the same `clubs.join` replay mechanism that Flow E uses for lost-response recovery. The applicant's agent calls `clubs.join(clubSlug, { email })` with the same email they originally applied with; the anonymous replay lock on `(clubId, application_email_normalized)` finds the existing migrated membership and mints a fresh bearer token bound to its migrated member row. The existing draft state, the existing state-versions audit, and the existing submission content all survive the replay — the applicant lands in exactly the place they left off. There is exactly one token-minting path in the new system (`clubs.join`) and legacy applicants converge on it naturally rather than via a special-case admin action.
- Insert exactly one `club_membership_state_versions` row per migrated legacy in-flight membership, representing its current state at migration time. Do not backfill the full admission version history. The same rule as for accepted admissions linked to memberships applies here.
- The cutover runbook must include a post-cutover step instructing the admin to notify any legacy in-flight applicants that they can resume by re-calling `clubs.join` with their original email. This is a one-time operational task, not an ongoing code path.

#### Legacy sponsored admissions

For each `admissions` row with `origin = 'member_sponsored'`:

- If `sponsor_member_id` is not null:
  - Create an `invitations` row with `sponsor_member_id` from the admission, `candidate_name`/`candidate_email` from the admission, `reason` from `admission_details->>'reason'` (or a placeholder if missing), `expires_at = created_at + 30 days` (or `now() + 1 day` if that is in the past; the invitation has effectively already been acted on).
  - If the admission already became a membership (see "Accepted admissions" above or "In-flight outsider admissions" above), mark the invitation as `used_at = <the admission's first transition timestamp>` and `used_membership_id = <the corresponding membership id>`.
- If `sponsor_member_id` is null (a real historical anomaly — the schema currently allows this):
  - **Do not synthesize an invitation.** Migrate the admission into a membership via the normal outsider path (new member row, membership in appropriate state, `submission_path = 'cold'`, metadata flag `legacy_missing_sponsor = true` on the membership row).

#### Historical anomalies

The migration MUST validate and fail loudly on unrepairable historical rows. Specifically:

- Accepted `admissions` rows with both `membership_id IS NULL` and `applicant_member_id IS NULL` — the migration cannot deterministically produce a matched membership. Fail with a clear error unless the coding agent can write a targeted repair query first.
- `admissions.membership_id` referring to a deleted or missing `club_memberships` row — cross-check `club_memberships.source_admission_id` as a second source of truth; if both fail, fail the migration.
- `owner_nominated` admissions with no `applicant_email` — this is valid historical data. Migrate without backfilling contact email; `application_email` stays NULL for these rows.
- Malformed `admission_details` JSON (missing `application` or `socials`, wrong types, null values). Normalize defensively: cast to text, fall back to empty string, never crash.
- Legacy `generated_profile_draft` with an unexpected shape. Preserve it as-is; the new code should tolerate draft schemas from old rows or ignore them and regenerate at the next acceptance.

If the migration encounters a row it cannot repair, it must `RAISE EXCEPTION` with a clear message naming the admission id, the shape of the anomaly, and what manual intervention would look like. Do not silently skip rows. Do not invent state.

#### Ephemeral state

- Discard all rows from `admission_challenges` and `admission_attempts`. In-flight cold applicants will need to call `clubs.join` again after the cutover. This is acceptable because the cutover is a maintenance window and the ephemeral rows are a few hundred at most.

### Step 3: destructive drop

Inside the same migration file, after the data migration succeeds:

```sql
DROP TABLE admission_versions CASCADE;
DROP TABLE admission_attempts CASCADE;
DROP TABLE admission_challenges CASCADE;
DROP TABLE admissions CASCADE;
```

Drop any associated views, indexes, and triggers that exclusively reference these tables. In particular:

- Drop the `current_admissions` view. It is the one the notifications baseline currently queries for derived pending-application notifications, so dropping it without retargeting the derived query first would immediately break `notifications.list`. The derived-notification retargeting described in the "Notifications and stream baseline" section must be implemented and deployed in the same PR, so the drop of `current_admissions` and the retarget of the derived query onto `club_memberships` land together atomically.
- Drop the `notify_admission_version` trigger on `admission_versions` (the underlying table is being dropped anyway, but be explicit about the trigger so its replacement — the trigger on `club_membership_state_versions` — is clearly the new source of `notifications_dirty` wakeups).
- Drop the `admission_status` enum type if it existed as a separate type.
- Drop any stored procedures or trigger functions that only served the old tables.

### Step 4: legacy code and symbol removal (this is the coding agent's responsibility in the same PR)

**All of the following must be deleted from the codebase before the PR is mergeable.** No deprecation warnings. No compatibility shims. No "remove in a follow-up." If the code still compiles with any of these references present, the PR is not done.

- `src/schemas/admissions-cold.ts` — deleted
- `src/schemas/admissions-cross.ts` — deleted
- The `sponsorCandidate` portion of `src/schemas/membership.ts` — deleted
- The `createAdmissionChallenge`, `solveAdmissionChallenge`, `createCrossChallenge`, `solveCrossChallenge`, and related functions in `src/clubs/admissions.ts` — deleted or replaced by the new helpers the unified flow needs. The file itself can remain if the coding agent keeps it for the new unified helpers; the file name `admissions.ts` is fine as a historical name for the directory even though the concept has been renamed.
- The acceptance saga block in `src/postgres.ts` that handles outsider member creation + membership creation + linking — deleted. Acceptance is now a single-statement state transition and no saga is needed.
- All imports of the deleted symbols in `src/dispatch.ts`, `src/server.ts`, `src/schema-endpoint.ts`, `src/registry.ts`, and any other registry wiring — deleted.
- `admissions.public.requestChallenge`, `admissions.public.submitApplication`, `admissions.crossClub.requestChallenge`, `admissions.crossClub.submitApplication`, `admissions.sponsorCandidate`, and `clubadmin.admissions.issueAccessToken` from the action registry — **deleted**, not renamed. These names must not appear in `/api/schema` after the change. `clubadmin.admissions.issueAccessToken` is specifically deleted rather than renamed because it existed only because the old admissions flow produced accepted members who had no tokens; in the unified model every applicant already has a token from the moment they called `clubs.join`, so there is nothing for an admin-side token-issuance action to do. Legacy in-flight applicants from the pre-cutover system recover their own tokens via the `clubs.join` replay mechanism described in the migration section, not via an admin action. After this PR, the only bearer-token minting paths in the system are: `clubs.join` (for applicants, new or resuming), `accessTokens.create` (for an already-accepted member to create additional tokens, subject to the tightened rule below), and the superadmin/ops paths in `src/identity/memberships.ts` and `src/token-cli.ts` (for owner creation and operational use). There is no club-admin-level token minting.
- All tests that target the deleted actions — deleted or rewritten to target the new actions. In particular every file under `test/integration/non-llm/` and `test/integration/with-llm/` that exercises `admissions.public.*`, `admissions.crossClub.*`, or `admissions.sponsorCandidate` must be updated or replaced.
- Test fixtures and seed data in `test/integration/harness.ts`, `db/seeds/dev.sql`, and any CLI scripts that reference the old admissions tables — updated to the new model.
- Any CLI helper in `src/token-cli.ts` or elsewhere that issues tokens via the old admission acceptance path — updated or removed.

Notifications-baseline artifacts that must also be removed or retargeted in the same PR (these were introduced or preserved by `plans/system-notifications-design.md` when it shipped; they must not survive this redesign in their admissions-era form):

- The `current_admissions` view — dropped as part of Step 3. The derived pending-application notification must be retargeted to read `club_memberships` where `state = 'submitted'` before this drop, inside the same PR. There must be no window in which the notifications path references a dropped view.
- The `notify_admission_version` trigger function on `admission_versions` — dropped along with the table. Its replacement is a trigger on `club_membership_state_versions` that emits the same unified-stream `NOTIFY`. This replacement must be committed in the same migration.
- `clubadmin.admissions.get` — **renamed** to `clubadmin.memberships.get` in the action registry, with its input retargeted from `{ clubId, admissionId }` to `{ clubId, membershipId }` and its output retargeted from an `AdmissionSummary` to the unified membership/application summary. Every call site updates in this PR, including the notifications drill-down prose, the SKILL.md one-line mention added by the notifications rewrite, the schema snapshot, and any integration test that round-trips `notifications.list` → `clubadmin.admissions.get` to validate the derived notification payload.
- `ref.admissionId` in notification item payloads — **renamed** to `ref.membershipId`. The ref type definition, the derived-notification row composer, and any consumer code that reads the ref must be updated in the same PR. No notification payload may carry both `admissionId` and `membershipId`; no notification payload may carry a naked `admissionId` after this change.
- The `admission.submitted:*` `kind_family` prefix used by the derived-admissions notification — **renamed** to `application.submitted:*`. `notifications.acknowledge` must continue to reject derived items by prefix detection, so its prefix constant gets updated in the same PR. Any existing materialized rows carrying the old prefix (should be none, because the old kind_family was derived-only) get migrated defensively in the data migration step.
- The `listNotifications` repository helper that assembles the unified read — updated in place to read `member_notifications` plus `club_memberships` filtered on `state = 'submitted'` in the actor's clubadmin clubs. Its implementation must not reference `current_admissions`, `admission_versions`, `admission_id`, or any column from the dropped tables.
- Any notifications integration test that currently mentions `current_admissions`, `admission_versions`, `clubadmin.admissions.get`, `ref.admissionId`, or the `admission.submitted` kind_family — updated to the new surfaces. The tests themselves stay; only the identifiers and action names change.
- The notifications-baseline acceptance/verification test that rounds-trips a `notifications.list` derived item back through the admin drill-down — rewritten to round-trip through `clubadmin.memberships.get` instead.

The notifications-baseline rename is a coupled change. The coding agent cannot rename `clubadmin.admissions.get` without also updating the notifications drill-down guidance that names it, the test that round-trips through it, and the SKILL.md bullet that mentions it. These all land in the same PR.

**The coding agent must grep the codebase for `admission`, `admissionChallenge`, `sponsorCandidate`, `applicantEmail`, `applicant_member_id` (careful: `applicant_member_id` as a column on `admissions` is removed, but `members.source_admission_id` may still exist and the FK is to a dropped table — drop the column too), `current_admissions`, `admission_versions`, `notify_admission_version`, `clubadmin.admissions.get`, `ref.admissionId`, and `admission.submitted`** and audit every hit. Every reference that points at a deleted symbol, dropped table/view, dropped trigger, renamed action, or renamed payload field must be removed or retargeted. After the audit, a second grep for the same identifiers must return zero hits outside git history and this plan file itself.

The surviving `clubadmin.admissions.*` actions (`list`, `setStatus`, `get`) are renamed to `clubadmin.memberships.*` (`list`, `setStatus`, `get`). This is a commitment, not a recommendation. The rename updates every call site in one pass: action handlers, schema registry, `/api/schema` output, `SKILL.md` prose, schema snapshot tests, integration tests, the notifications-baseline drill-down prose, and any admin UI prototype or client that references the old names. After this PR, the string `clubadmin.admissions.` must not appear anywhere in the codebase.

The action surface after the rename:

- `clubadmin.memberships.list({ clubId, status? })` — list memberships for this club, filtered by state. Replaces `clubadmin.admissions.list`.
- `clubadmin.memberships.get({ clubId, membershipId })` — single membership drill-down. Replaces `clubadmin.admissions.get` (the action shipped by the notifications baseline as Phase 0). Input key is `membershipId`, not `admissionId`. Output is a unified membership/application summary, not an `AdmissionSummary`.
- `clubadmin.memberships.setStatus({ clubId, membershipId, nextStatus, ... })` — state transition (accept, decline, schedule interview, etc.). Replaces `clubadmin.admissions.setStatus`. The state machine transitions listed in the "Membership state machine" section are the complete set of legal `nextStatus` values.

There is no `clubadmin.memberships.issueAccessToken`. That action is deleted, not renamed, per the explicit rule above.

### Step 5: refresh `db/init.sql`

After the migration has been tested against a fresh dev DB via `reset-dev.sh` + `scripts/migrate.sh`, update `db/init.sql` to reflect the target schema. The `db/init.sql` file must show the new `club_memberships` shape, the new `invitations` table, the new `application_pow_challenges` table, and must not mention `admissions`, `admission_versions`, `admission_challenges`, or `admission_attempts` anywhere. Fresh installs should produce the new shape directly, not the old shape followed by the migration.

Update `db/seeds/dev.sql` to seed the new model. Dev data should include at least: a club owner, a club admin, a regular member, an open invitation, a membership in `applying`, a membership in `submitted`, a membership in `active`, and a membership in `payment_pending` (for paid clubs).

## Documentation updates

The following documentation files must be rewritten in present tense, as though the unified model is the only model that has ever existed. Do not include language like "we used to," "we replaced," "the old admissions system," or "this was previously." The reader of these documents should be unable to tell that a migration ever happened.

### `SKILL.md`

Replace the entire "How someone joins a club" section with a rewrite describing the unified flow. The new section should:

- Explain that every human who touches the system gets a normal bearer token from the start, whether they are joining their first club as a stranger, redeeming an invitation, or cross-applying.
- Describe the unified three-flow entry point: cold, invitation-backed, cross-apply, all via `clubs.join`.
- Document the call sequence: `clubs.join` → optional PoW → `clubs.applications.submit` → poll via `clubs.applications.get` / `list` → on acceptance, either done (free club) or `clubs.billing.startCheckout` (paid club).
- Document the drafting rule unchanged (it still applies — the completeness gate is still a literal completeness check against the club's policy).
- Document the timing rule unchanged.
- Document the retry-on-`needs_revision` rule unchanged.
- Document the failure modes on the new surface:
  - `needs_revision` — same meaning as the current admissions revision flow: the submitted application did not pass the completeness gate; the client patches the content and resubmits without re-solving PoW.
  - `challenge_expired` (410) — the PoW challenge row in `application_pow_challenges` has expired. The client re-calls `clubs.join` to get a fresh challenge against the same membership.
  - `attempts_exhausted` — same behaviour as today.
  - `invalid_proof` (400) — re-solve PoW with a fresh nonce; do not rewrite the application.
  - `gate_unavailable` (503) — infrastructure outage, not a content problem. Retry the same submit after a short delay.
  - `invalid_invitation_code` — new, for warm flow. Single generic error for every invitation validation failure.
  - `email_required_for_first_join` — new, for authenticated cross-apply with no stored contact email.

  Duplicate or replay cases on `clubs.join` are **not** failure modes. They are idempotent success: if a non-terminal membership for `(memberId, clubId)` already exists (cross-apply case) or if an in-flight anonymous application for `(clubId, application_email_normalized)` already exists (cold replay case), `clubs.join` returns the existing `membershipId` and its current proof state with a fresh bearer token. The client resumes exactly where it left off. There is no `membership_exists` error, no `already_applied` error, and no distinction in the response between "I just created this" and "I am resuming this." The SKILL.md prose must teach agents to treat `clubs.join` as safely retryable on the same `(clubSlug, email)` pair.
- Preserve the PoW solver code example. Update the call sites to use `membershipId` and the new `clubs.applications.submit` shape instead of the old `challengeId` / submit shape.
- Preserve the "how to connect" section unchanged — the schema fetch bootstrap is the same.
- Preserve the notifications and stream sections added by the notifications rewrite. The surfaces themselves — `notifications.list`, `notifications.acknowledge`, `activity.list`, `messages.getInbox`, `messages.acknowledge`, `GET /stream`, `sharedContext.notifications`, `sharedContext.notificationsTruncated` — stay in SKILL.md exactly as they are. Only the identifiers they mention change.
- In the notifications section, rewrite the admin drill-down prose so it names `clubadmin.memberships.get` with `{ clubId, membershipId }` instead of `clubadmin.admissions.get` with `{ clubId, admissionId }`. The one-line "Core behaviors" bullet that mentions the drill-down action gets updated to the new name in the same edit.
- In the notifications section, rewrite any prose about the derived pending-application notification so it describes it as coming from `club_memberships` in `state = 'submitted'` rather than from `admissions`. The ref field the agent should read out of the payload is `membershipId`, not `admissionId`. The `kind_family` prefix the agent should recognize is `application.submitted:*`, not `admission.submitted:*`.
- Replace any references to `admissions.public.*`, `admissions.crossClub.*`, or `admissions.sponsorCandidate` throughout the file with the new action names (`clubs.join`, `clubs.applications.submit`, `invitations.issue`, etc.).
- Add a new section or update the existing "Sponsor an outsider" section to use `invitations.issue` instead of `admissions.sponsorCandidate`, with the same quality-bar language.
- Update the "Apply to join a club" section to point at the unified flow.

Frame all of this as the normal way things work. Not "this is the new way." Just the way. The reader of `SKILL.md` must not be able to tell either that admissions existed as a separate concept or that the notifications rewrite originally shipped with admissions-era plumbing underneath it.

### `docs/design-decisions.md`

Replace the following sections:

- **"Membership and trust"** section. Rewrite it to describe the unified model. Every human has a `members` row and a bearer token. Club access is per-resource and gated by `club_memberships.state` through the `accessible_club_memberships` view. Applying to a club is a state on `club_memberships`, not a separate object. Invitations replace sponsorships. The language should be entirely present tense: "identity is global; membership is club-local," "the sponsor is the accountable inviter for invitation-backed applications," etc. Remove any mention of `admissions` as a distinct table or concept.
- **"Action namespaces"** section. Replace `admissions.*` with the new namespace names in the approved list: `clubs.*` (for `clubs.join`, `clubs.applications.*`, `clubs.billing.*`) and `invitations.*`. Keep the rest.
- **"Append-only default"** section. Replace "admission versions" with "membership state versions" (or whatever canonical name is already used — `club_membership_state_versions` is the existing table and should be the canonical reference).
- **"Versioning standard"** section. Same: replace the admission-versions reference with the membership-state-versions reference.
- **"Current implementation milestones"** section. Remove the old `admissions.public.*`, `admissions.crossClub.*` (wait, the old doc already lists `admissions.public.*` — but the new doc must not), `admissions.sponsorCandidate`, and `clubadmin.admissions.get` entries. Add entries for `clubs.join`, `clubs.applications.submit`, `clubs.applications.get`, `clubs.applications.list`, `clubs.billing.startCheckout`, `invitations.issue`, `invitations.listMine`, `invitations.revoke`, and `clubadmin.memberships.get`. Keep the existing notifications-baseline entries (`notifications.list`, `notifications.acknowledge`, `activity.list`, `messages.acknowledge`, `GET /stream`, `sharedContext.notifications` piggyback) exactly as-is — those are shipped baseline and survive this redesign unchanged as surfaces.
- **"Quality / legality gate"** section. Update the list of gated actions. The new list is: `content.create`, `content.update`, `profile.update`, `vouches.create`, `invitations.issue`, `clubs.applications.submit`. Remove `admissions.sponsorCandidate` and `admissions.public.submitApplication` from the list.
- **Notifications / stream prose** (wherever in `docs/design-decisions.md` the notifications rewrite added it). Update any example that references `current_admissions`, `admission_versions`, `clubadmin.admissions.get`, `ref.admissionId`, or `admission.submitted:*` so it describes the unified model instead: derived pending-application notifications come from `club_memberships` in `state = 'submitted'`, the drill-down action is `clubadmin.memberships.get`, the ref field is `membershipId`, the `kind_family` prefix is `application.submitted:*`, and the stream wakeup trigger lives on `club_membership_state_versions`. Present-tense framing throughout — no "we used to."

Add a new subsection under "Membership and trust" describing:

- Tokens grant identity, not access.
- Per-resource access is gated through `accessible_club_memberships`.
- Pre-acceptance members (`applying`, `submitted`, `interview_*`) have zero club access.
- `accessTokens.create` requires at least one non-pre-acceptance membership.
- Pre-acceptance profile content lives as a draft on `club_memberships.generated_profile_draft` and does not materialize into `member_club_profile_versions` until acceptance.

Frame all of this as the way the system has always worked.

### `README.md`

Check for any public-facing documentation that mentions the old admissions flow, cold application examples, or sponsor candidate examples. Replace with the unified flow using the new action names. If the README does not currently mention the old flow in detail, leave it alone — do not manufacture new content.

### Schema snapshot test and `/api/schema`

Update the schema snapshot test so the snapshot file reflects the new action set. The snapshot must not include any `admissions.*` action (the `invitations.*` namespace replaces them, not a renamed `admissions.*`). The snapshot must include the full action contracts for every new action listed in this plan: `clubs.join`, `clubs.applications.submit`, `clubs.applications.get`, `clubs.applications.list`, `clubs.billing.startCheckout`, `invitations.issue`, `invitations.listMine`, `invitations.revoke`, and the renamed `clubadmin.memberships.get`.

`clubadmin.admissions.get` — shipped as Phase 0 of the notifications rewrite — is gone from the snapshot. In its place is `clubadmin.memberships.get`. The snapshot diff will show the rename. The notifications-baseline snapshot entries for `notifications.list`, `notifications.acknowledge`, `activity.list`, `messages.acknowledge`, and `GET /stream` stay as-is — those surfaces survive unchanged, and their input/output contracts do not mention `admissionId` anymore, so the only snapshot changes in those contracts are the payload field renames (`admissionId` → `membershipId`) and the `kind_family` prefix rename (`admission.submitted` → `application.submitted`) where those identifiers appear in the schema.

After the PR lands, running the schema snapshot test must produce zero diffs against the checked-in snapshot, and `/api/schema` fetched from a fresh-deploy dev server must report no action name beginning with `admissions.` and no output schema containing the string `admissionId`.

## Test plan

Full test coverage is non-negotiable. Do not ship without these tests passing.

### Unit tests (`test/unit/`)

Add or update:

1. Token parsing and formatting for member tokens, invitation codes, and any other tokens. Verify `cc_live_*` stays unchanged. Verify `cc_inv_*` parses correctly.
2. Membership state machine transition helper: every legal transition passes, every illegal transition throws.
3. `application_email_normalized` generated column matches the JavaScript normalization helper used for advisory lock keys. This is critical for the replay lock to work correctly. Test with Unicode emails, whitespace, mixed case, etc.
4. Invitation code hashing uses `hashTokenSecret` and lookup is by id + hash.
5. `clubs.join` rules: anonymous requires email, authenticated ignores email unless no stored contact email, invitation validates every field, etc.
6. `invitations.issue` same-sponsor same-candidate replacement semantics.
7. ASCII email validation at the action schema boundary for `clubs.join` and `invitations.issue`.

### Integration tests non-LLM (`test/integration/non-llm/`)

Add or replace:

1. Cold anonymous join → PoW → submit → poll → admin accept (free club) → membership is `active` → member can read club content.
2. Cold anonymous join → PoW → submit → poll → admin accept (paid club) → membership is `payment_pending` → `clubs.billing.startCheckout` returns a URL → billing webhook activates → membership is `active`.
3. Cold anonymous join — lost first response replay → second call returns the same `membershipId` with a fresh token.
4. Warm invitation join → no PoW → submit → poll → admin accept → same outcomes as cold.
5. Warm invitation join — lost first response replay → second call with same code returns the same `membershipId` with a fresh token, invitation is used exactly once.
6. Warm invitation with wrong email → rejected with `invalid_invitation_code`.
7. Warm invitation with revoked code → rejected with `invalid_invitation_code`.
8. Warm invitation with expired code → rejected with `invalid_invitation_code`.
9. Warm invitation whose sponsor has since lost club access → rejected with `invalid_invitation_code`, and the invitation row has been auto-revoked.
10. Authenticated cross-apply from an existing member → reuses member id, returns same token, new membership in `applying`, PoW challenge at cross-apply difficulty.
11. Authenticated cross-apply with no stored contact email and no email parameter → rejected with `email_required_for_first_join`.
12. Authenticated cross-apply with invitation → no PoW.
13. Concurrent cold joins for the same `(clubSlug, email)` → exactly one membership is created, the other call returns the same one.
14. Concurrent cold join and cross-apply for the same `(clubSlug, normalized_email)` → serialized by the shared replay lock, exactly one wins.
15. Concurrent invitation redemptions for the same code → one succeeds, the other fails with `invalid_invitation_code`.
16. `clubs.applications.submit` phasing: the gate runs outside the Phase 1 and Phase 3 transactions. This can be asserted via a test pool wrapper that counts `BEGIN`s during a submit request and confirms Phase 2 is not inside one.
17. `clubs.applications.submit` with `needs_revision` → same nonce can be reused for the next submit attempt without re-solving PoW.
18. `clubs.applications.submit` with `attempts_exhausted` → clean state, the agent can request a new challenge via re-calling `clubs.join` (or however the new flow handles re-challenging; specify this during implementation).
19. Admin acceptance of a free-club application → membership transitions `submitted` → `active` → caller sees club access on next poll.
20. Admin acceptance of a paid-club application → membership transitions `submitted` → `payment_pending` → billing activation → `active`.
21. Admin decline → `submitted` → `declined`, terminal.
22. Admin withdrawal on behalf of applicant → state transitions to `withdrawn`, terminal.
23. `clubs.applications.list` returns only the caller's own memberships.
24. `clubs.applications.get` returns `403` or `404` for a membership that doesn't belong to the caller.
25. `invitations.listMine` returns open/used/revoked/expired statuses correctly.
26. `invitations.listMine` does not return the raw code.
27. `invitations.revoke` by the sponsor succeeds; by a different member fails.
28. Sponsor losing club access → their open invitations auto-revoke.
29. Sponsor issuance quota → eleventh open invitation in a month fails with `invitation_quota_exceeded`.
30. Pre-acceptance member (`applying` state only) cannot create additional access tokens via `accessTokens.create` → rejected.
31. Pre-acceptance member cannot read any club content → `content.list` returns empty for all clubs, `content.getThread` on a specific thread returns `403`/`404`.
32. Pre-acceptance member cannot post content → `content.create` rejected.
33. Pre-acceptance member cannot DM anyone → `messages.send` rejected (no shared accessible club).
34. Pre-acceptance member cannot search members → `members.searchByFullText` returns empty.
35. Pre-acceptance member cannot vouch → `vouches.create` rejected.
36. Pre-acceptance member cannot RSVP → `events.rsvp` rejected.
37. Pre-acceptance member's profile is NOT reflected in `member_club_profile_versions` for any club.
38. Billing sync: `superadmin.billing.activateMembership` correctly transitions `payment_pending` → `active` through the new code path.
39. Billing sync: `superadmin.billing.markRenewalPending`, `expireMembership`, `cancelAtPeriodEnd`, `banMember`, `setClubPrice` all continue to work unchanged with the extended state set.
40. Legacy-migrated accepted memberships read correctly through `clubs.applications.get` and `clubadmin.memberships.get`.
41. Legacy-migrated invitation rows (previously `admissions.sponsorCandidate` entries) show up in `invitations.listMine` correctly with the right `used_at` state if redeemed or `open` state if not.
42. Pre-acceptance member calls `notifications.list` → receives an empty `items` array and `truncated: false`. No derived pending-application item leaks from any club.
43. Pre-acceptance member reads an authenticated action's response envelope → `sharedContext.notifications` is `[]` and `sharedContext.notificationsTruncated` is `false`.
44. Pre-acceptance member calls `activity.list` for any club → receives an empty activity list regardless of audience filter.
45. Pre-acceptance member calls `messages.getInbox` → receives an empty inbox. A pre-acceptance member cannot be addressed by any sender, so no inbox entry exists to return.
46. Pre-acceptance member connects to `GET /stream` → the `ready` frame contains `notifications: []`, `notificationsTruncated: false`, and `activityCursor: null`. No `message` events are delivered. `notifications_dirty` events are not observed until the member transitions into an access-granting state.
47. Clubadmin of a club calls `notifications.list` while an applicant of that club is in `state = 'submitted'` → receives a derived notification item whose `kind_family` begins with `application.submitted:`, whose `ref.membershipId` points at the pending membership, and whose `ref.clubId` points at the club. No payload contains `admissionId` or any `admission.submitted` kind.
48. `notifications.acknowledge` with a derived-item id whose `kind_family` begins with `application.submitted:` → rejected with the same `422 invalid_input` contract the baseline promises for derived items.
49. Inserting a `club_membership_state_versions` row with the new `state = 'submitted'` fires a `notifications_dirty` wake-up on `GET /stream` to the relevant clubadmins, and those clubadmins' next authenticated response carries the derived notification in `sharedContext.notifications` without an extra `notifications.list` round-trip.
50. Admin drill-down round-trip: a derived `application.submitted:*` notification payload from `notifications.list` can be passed straight into `clubadmin.memberships.get({ clubId: ref.clubId, membershipId: ref.membershipId })` and returns the unified membership/application summary. No code path in this round-trip mentions `admissionId`.
51. After the migration, no notification payload in the materialized `member_notifications` table (either the pre-existing rows carried forward by the migration or new rows produced post-cutover) contains the string `admissionId` anywhere in its JSON refs. Defensive migration assertion.

### Integration tests with-LLM (`test/integration/with-llm/`)

Add or replace:

1. Cold join → submit → gate pass → `submitted` state. Runs the real gate.
2. Cold join → submit → gate `needs_revision` → patch the application → resubmit with same nonce → passes.
3. Warm invitation join → submit → gate pass → `submitted` state.
4. `invitations.issue` with a reason that passes the quality gate.
5. `invitations.issue` with a reason that fails the quality gate.

### Migration fixtures

The migration must be tested against fixture data representing every legacy shape:

1. Accepted admission linked to a `club_memberships` row.
2. Accepted admission with the membership missing — migration should fail loudly.
3. In-flight outsider admission not yet linked to any member.
4. In-flight cross-apply admission with `applicant_member_id` set.
5. `member_sponsored` admission with a valid `sponsor_member_id`.
6. `member_sponsored` admission with `NULL` `sponsor_member_id` (historical anomaly).
7. `owner_nominated` admission with no email.
8. Admission with malformed `admission_details` JSON.
9. Multiple in-flight outsider admissions sharing the same email — each becomes its own new member.
10. `source_admission_id` cross-check: migration prefers `club_memberships.source_admission_id` when `admissions.membership_id` is inconsistent.

Build these fixtures in `test/integration/` as seed data and run the migration against them before running the rest of the integration suite.

### Security regression tests

Explicit negative tests for every ambient-authority boundary. Every surface that reads club-scoped data must have a test that confirms a pre-acceptance bearer token cannot access it. Grep for every such surface during implementation and add a test per surface. The list explicitly includes the shipped notifications-baseline surfaces:

- `notifications.list` — pre-acceptance member receives no derived or materialized club-scoped items.
- `notifications.acknowledge` — pre-acceptance member cannot acknowledge derived items that do not belong to them (derived items are rejected anyway, but the test is still worth writing against the rejection path).
- `activity.list` — pre-acceptance member sees no audience-filtered activity for any club.
- `messages.getInbox` — pre-acceptance member sees an empty inbox and cannot be a DM recipient.
- `messages.acknowledge` — pre-acceptance member cannot acknowledge an inbox entry that does not exist for them.
- `GET /stream` — pre-acceptance member's `ready` frame is empty and no events follow until they become accessible.
- `sharedContext.notifications` and `sharedContext.notificationsTruncated` — the envelope piggyback on every authenticated response is empty for pre-acceptance members.

The same regression suite must assert that the shipped notifications-baseline behaviours continue to hold for real accessible members after the retargeting: a clubadmin whose club has a `submitted` application sees the derived item in `notifications.list`, in the `sharedContext.notifications` piggyback on any authenticated response, and in `GET /stream` via a `notifications_dirty` wake on insert into `club_membership_state_versions`. The derived item carries `ref.membershipId`, `ref.clubId`, and the `application.submitted:*` `kind_family` prefix — never `ref.admissionId` and never `admission.submitted:*`.

## Implementation checklist

This is the order the coding agent should work in. Do not skip steps.

1. Read `CLAUDE.md` and confirm you understand the hard rules.
2. Read `src/clubs/admissions.ts` and understand the existing three-phase submit structure. The new submit mirrors it.
3. Read `src/postgres.ts` acceptance block and understand what is being replaced with a single-statement transition.
4. Read `docs/billing-sync-contract.md` and confirm the new state names are compatible.
5. Write the single migration file in `db/migrations/NNN_unified_club_join.sql`.
6. Test the migration via `reset-dev.sh` → `scripts/migrate.sh` against a fresh dev DB. Iterate until it runs cleanly.
7. Test the migration against a snapshot of production-shaped data with every historical anomaly. Iterate until it handles every case or fails loudly with a clear error.
8. Only after the migration is verified, update `db/init.sql` to reflect the target schema.
9. Update `db/seeds/dev.sql` to match the target schema.
10. **Add `optional_member` as a first-class auth kind.** The current auth union is `none | member | clubadmin | clubowner | superadmin` and the dispatcher branches binary between `auth === 'none'` and the authenticated path. This addition touches more than the registry + dispatcher — it also ripples into the actor type, the action contract types, and the response envelope builder. Every file in the list below must be updated in the same PR:

    - `src/schemas/registry.ts` — add `'optional_member'` to the `auth` enum. Also audit any internal types in the same file (e.g. the per-kind actor-shape map around `src/schemas/registry.ts:79`) that currently assume every authenticated action has an `actor.member`. Extend those types so `optional_member` actions receive an actor shape that may or may not carry a `member`.
    - `src/contract.ts` — the current action-contract and actor types assume `actor.member` always exists for authenticated actions (see around `src/contract.ts:281` and the action-contract interfaces near `src/contract.ts:15`). Introduce a `MaybeMemberActor` (or equivalent) shape and wire it into the `optional_member` contract type so `clubs.join` handlers get a `{ member: MemberActor | null }` actor, not an assumed member. Do not paper over this with `!` non-null assertions at the handler layer — that would hide the real boundary.
    - `src/dispatch.ts` — the current dispatch path branches on `def.auth === 'none'` at around `src/dispatch.ts:281`, and the envelope builder around `src/dispatch.ts:199` assumes the actor carries a member. Add an `optional_member` branch that:
      - If the `Authorization` header is **missing**: resolve the actor to the anonymous shape (`{ member: null }`) and proceed.
      - If the `Authorization` header is **present but malformed, expired, or revoked** (i.e. the current member-auth resolver would reject it): return `401` exactly the way `auth: 'member'` does. **Do not silently downgrade an invalid token to anonymous.** A typoed, expired, or revoked token must not be able to create or resume a different human's application via the anonymous path. The only way `clubs.join` reaches the anonymous branch is by not sending an `Authorization` header at all.
      - If the `Authorization` header is **present and valid**: resolve the member and proceed through the authenticated branch.
      - Update the envelope builder so it tolerates an actor without a member when the dispatched action is `optional_member` and the caller was anonymous. The anonymous-response envelope is a real shape, not an error state.
    - Any test harness or integration-test helper that constructs an `actor` fixture — update to the new `MaybeMemberActor` shape where the action under test is `optional_member`.

    `clubs.join` is the only action in v1 that declares `auth: 'optional_member'`. Do not model this as a special-cased `auth: 'none'` that conditionally reads a token — that would hide a real boundary and it would leak the token-downgrade bug through the gap. It is its own auth kind with its own explicit handling.
11. Implement the new action handlers: `clubs.join`, `clubs.applications.submit`, `clubs.applications.get`, `clubs.applications.list`, `clubs.billing.startCheckout`, `invitations.issue`, `invitations.listMine`, `invitations.revoke`.
12. Implement the unified submit helper with the three-phase structure.
13. Replace the acceptance saga in `src/postgres.ts` with the single-statement transition.
14. Tighten `accessTokens.create` to require at least one non-pre-acceptance membership.
15. Audit every club-scoped read and write surface. Add tests for every ambient-authority boundary. Tighten any surface that doesn't already check `accessible_club_memberships`.
16. Retarget the notifications baseline onto the unified membership model, as one coupled set of edits in the same PR:
    - Update `listNotifications` (the repository helper that assembles the unified read) so its derived half reads `club_memberships` where `state = 'submitted'` instead of `current_admissions`.
    - Rename the notification item `ref.admissionId` field to `ref.membershipId`, including its TypeScript type definition, its composer, and every consumer that reads it.
    - Rename the derived `kind_family` prefix from `admission.submitted:*` to `application.submitted:*`, and update the `notifications.acknowledge` prefix-rejection constant in the same change.
    - Rename the action `clubadmin.admissions.get` to `clubadmin.memberships.get`, retarget its input from `{ clubId, admissionId }` to `{ clubId, membershipId }`, retarget its output from `AdmissionSummary` to a unified membership/application summary, and update every call site in the codebase, tests, schema snapshot, and SKILL.md.
    - Replace the `notify_admission_version` trigger on `admission_versions` with a trigger on `club_membership_state_versions` that emits the same `NOTIFY` on the same unified stream channel.
    - Make sure none of the above ship before the admissions drop in the same migration, so there is never a window in which the notifications code references a dropped view or a renamed action.
17. Delete all legacy code and symbols listed in "Step 4: legacy code and symbol removal" above, including the notifications-baseline artifacts enumerated there. Grep for every hit of the old names and confirm zero matches.
18. Rewrite `SKILL.md` in present tense per the documentation section of this plan, including the notifications-baseline prose retarget.
19. Rewrite the relevant sections of `docs/design-decisions.md` in present tense, including the notifications-baseline prose retarget.
20. Update `README.md` if it currently mentions the old flow.
21. Update the schema snapshot test to match the new action set.
22. Write and pass all unit tests.
23. Write and pass all integration tests (non-LLM and with-LLM), including the new security regression tests for the shipped notifications-baseline surfaces.
24. Run `npm run check`, `npm run test:unit`, `npm run test:integration:non-llm`, and the relevant `npm run test:integration:with-llm` files. Everything must pass.
25. Bump the patch version in `package.json`.
26. Confirm via `git status` and `grep` that no legacy symbols remain (including the notifications-baseline identifiers listed in the verification checklist).
27. Prepare the maintenance-window cutover runbook: drain traffic → migrate → deploy → smoke-test → reopen.

## Verification checklist (what I will check when you say you are done)

I will run these checks before approving the change. The coding agent should run them first to save round trips.

1. `grep -r "admissions\." src/` returns zero hits for `admissions.public`, `admissions.crossClub`, `admissions.sponsorCandidate`, or `clubadmin.admissions.`.
2. `grep -r "admission_challenges\|admission_attempts\|admission_versions\|current_admissions\|\badmissions\b" db/init.sql` returns zero hits.
3. `grep -r "sponsorCandidate" src/ test/` returns zero hits.
4. `grep -r "current_admissions\|notify_admission_version\|clubadmin\.admissions\.get\|ref\.admissionId\|admission\.submitted" src/ test/ docs/ SKILL.md` returns zero hits. These are the notifications-baseline identifiers introduced or preserved by the notifications rewrite; after this PR none of them may survive as active behaviour.
5. The `/api/schema` output does not contain any action with a namespace starting with `admissions.`. It does contain `clubadmin.memberships.get` (the renamed drill-down action) and the other new actions listed in the API surface section. No output schema in the payload contains the string `admissionId`.
6. `SKILL.md` contains no references to `admissions.public`, `admissions.crossClub`, `admissions.sponsorCandidate`, `clubadmin.admissions.get`, `ref.admissionId`, `admission.submitted`, or the phrase "cold applications." It does contain the unchanged notifications-baseline surface names (`notifications.list`, `activity.list`, `GET /stream`, etc.), now speaking in unified vocabulary.
7. `docs/design-decisions.md` contains no references to the old admissions namespace or the admissions-era notification plumbing. It does contain the shipped notifications-baseline surface entries unchanged.
8. `db/init.sql` contains the new `invitations` table, the new `application_pow_challenges` table, the extended `club_memberships` shape, and the new `club_membership_state_versions` trigger that fires `notifications_dirty` on the unified stream channel. It does not contain any `admissions*` table, the `current_admissions` view, the `notify_admission_version` trigger, or the `admission_versions` table.
9. All tests pass, including the new security regression tests against the shipped notifications-baseline surfaces.
10. The schema snapshot test passes with the new shape. The snapshot file does not contain `admissionId`, `clubadmin.admissions.get`, or `admission.submitted`.
11. A fresh `reset-dev.sh` produces a DB that matches the post-migration state exactly, including the new trigger on `club_membership_state_versions`.
12. The patch version in `package.json` is bumped.
13. A manual smoke test through the new flow works end-to-end against a local dev server: cold join → PoW → submit → accept → member can read content. A separate clubadmin session sees the pending application show up in `notifications.list` with the retargeted `application.submitted:*` kind_family and `ref.membershipId`, and the drill-down via `clubadmin.memberships.get` returns the unified membership/application summary.
14. An SSE smoke test against `GET /stream` produces a `ready` frame with the unified payload, and inserting a new `club_memberships` row with `state = 'submitted'` in a separate session fires a `notifications_dirty` wake on the admin stream within the expected window.

## Handoff notes for the executing coding agent

This plan is the source of truth. It is a set of committed decisions, not a set of options. If you hit an ambiguity this plan does not explicitly resolve, stop and ask. Do not invent a resolution.

Every decision listed below is committed. These are settled. The plan has already weighed each trade-off; the coding agent's job is to execute, not to re-litigate.

- `clubadmin.admissions.*` is renamed to `clubadmin.memberships.*`. `clubadmin.admissions.get` becomes `clubadmin.memberships.get` with input `{ clubId, membershipId }` and output in the unified membership/application summary shape.
- `clubadmin.admissions.issueAccessToken` is **deleted**, not renamed. Legacy in-flight applicants use `clubs.join` replay to recover. There is no club-admin-level token issuance in the new system.
- PoW challenge state lives on its own `application_pow_challenges` table, not embedded on the membership row. Solve-once semantics are expressed via a partial unique index on unsolved rows.
- The legacy `source_admission_id` column on `club_memberships` is **dropped**, along with its partial unique index. It points at a table that no longer exists. Any caller currently reading it has to stop reading it in the same PR.
- `member_private_contacts.email` has no uniqueness constraint. Two members can share an email address — email is a contact channel, not an identity key. If the coding agent finds a `UNIQUE` index on `member_private_contacts.email`, drop it as part of this redesign (and note that this means the notification drill-down cannot look up a member by email).
- The `club_membership_state_versions` `AFTER INSERT` trigger fires `notifications_dirty` on every row insert. Do not narrow it. The dirty-wake pattern handles over-fire via idempotent re-reads.
- `auth: 'optional_member'` is added as a first-class auth kind. The addition touches `src/schemas/registry.ts` (the auth enum and the per-kind actor-shape map around line 79), `src/contract.ts` (the action-contract and actor type definitions around line 15 and line 281), `src/dispatch.ts` (the dispatch branch around line 281 and the envelope builder around line 199), and any test harness that constructs an actor fixture. `clubs.join` is the only action in v1 to declare `auth: 'optional_member'`. It is not modelled as a special-cased `auth: 'none'` that conditionally reads a token — that would hide a real boundary. The rule the dispatcher enforces: **missing `Authorization` header → anonymous; present-but-invalid `Authorization` header → `401`, same as `auth: 'member'`.** A typoed, expired, or revoked token must never silently downgrade to the anonymous branch — that would let a bad token create or resume the wrong human's application. The only way `clubs.join` reaches the anonymous branch is by sending no `Authorization` header at all.
- The invitation partial unique index uses the materialized `expired_at` column, not `expires_at > now()`. The schema in this plan already shows the correct shape.

If a decision above turns out to be wrong in practice — that is, you find a concrete correctness, performance, or operational problem that the plan did not anticipate — stop and flag it. Do not silently deviate. The plan is not immutable, but deviations are a conversation, not a judgment call.

**The notifications-baseline coupling.** The notifications rewrite in `plans/system-notifications-design.md` has already shipped. It is currently reading `current_admissions`, dispatching `notifications_dirty` off `admission_versions`, composing `ref.admissionId`, emitting `admission.submitted:*` `kind_family`, and drilling down through `clubadmin.admissions.get`. This redesign deletes every one of those dependencies and must retarget them all **in the same PR**. Before you drop `current_admissions`, `admissions`, or `admission_versions`, the retargeting of the derived notification query, the rename of the drill-down action, the rename of the `ref` field, the rename of the `kind_family` prefix, and the trigger retargeting must already be implemented and pointed at `club_memberships` / `club_membership_state_versions` / `clubadmin.memberships.get`. Do not split this into two PRs. Do not drop anything before the retargeting lands. Do not leave the notifications path in a state where it points at a dropped view or a renamed action. The acceptance rule is: the full PR, applied as one atomic change, leaves every shipped notifications-baseline behaviour working against the unified membership model with zero admissions-era identifiers left behind.

**What I explicitly do not want pushback on:**

- "This is a big change." Yes. That's the point.
- "The existing tests are numerous and rewriting them is work." Yes. Rewrite them.
- "Migration is risky." Yes. That's why it runs through `scripts/migrate.sh` against a fresh dev DB first, then is tested against legacy fixture shapes, then is run in a maintenance window.
- "Can we do this in two PRs?" No. One PR. One migration. One maintenance window. One deploy.
- "Should we keep the applicant token concept as a safety net?" No. The applicant token concept is what made the old design complicated. It does not come back.

**If you find a genuine correctness bug in this plan**, stop and flag it. I will review and either correct the plan or confirm the design trade-off. Specifically, I want you to push back if:

- You find a surface that grants ambient club authority that I have not listed in the ambient-authority section and that is harder to fix than I think.
- You find a historical data shape in the production schema that none of the migration patterns cover.
- You find a concurrency hole in the lock ordering (cross-apply and cold apply must never deadlock).
- You find that the three-phase submit pattern's Phase 2 cannot safely hold the profile-draft persist outside a transaction without a race (in particular, consider what happens if two concurrent submits for the same membership both persist drafts).
- You find that the legacy code removal would leave the system unable to serve pre-existing accepted members because some code path was load-bearing in a way I did not anticipate.
- You find that the notifications-baseline retargeting cannot land atomically with the admissions drop — for example, if the `listNotifications` helper reads `current_admissions` from a helper that also feeds another unrelated surface, and retargeting one would break the other. Flag it and propose the minimum-churn resolution; do not silently leave `current_admissions` alive just to avoid the churn. We do not care how much code churn the correct solution costs; we care that it is correct and shipped in one coordinated change.
- You find that the `notifications_dirty` trigger on `club_membership_state_versions` causes a real operational problem at production write rates (not a theoretical concern — actual measured pressure on `NOTIFY`/`LISTEN` or on the stream fanout). Bring the measurement; do not narrow the trigger preemptively. Narrowing is a layer-coupling decision that needs explicit approval, not a default optimization.

**What success looks like**: after this change, the `admissions` concept is gone from the codebase, the unified flow works for every path, all tests pass, the documentation reads as though the unified model is the only model, and a new member can join a free club in under five minutes with no admin involvement beyond clicking accept.

I will be available to answer questions and verify your work. When you are ready for review, tell me what you have built, run the verification checklist yourself, and show me the output.

## Final note

The system now answers one question directly: who is this human, and what state is their membership in for this club? Every design decision in this plan serves that single question. If something in the implementation does not serve it, the implementation is wrong.
