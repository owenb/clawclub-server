# Tokenless apply and onboarding ceremony

**Status:** ready for review
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-15
**Supersedes:** `plans/agent-first-onboarding-ceremony.md` (an earlier draft of this same redesign that changed direction mid-document — ignore it and delete once this plan is accepted)

This plan replaces the current pre-approval token flow with a tokenless apply path and a deliberate onboarding ceremony. It is a first-principles redesign, not a patch — the current system is unfit for purpose for humans who are applying to a club. We recently had to manually recover two stuck applicants with emergency superadmin token minting, and this plan explains what to build instead and why.

The redesign stays fully agent-first. **No email infrastructure is added.** The whole point is that a prestigious private-club UX is achievable with nothing but agents, HTTP, and an out-of-band channel controlled by the club admin. If we later add email as a delivery transport, nothing in this plan changes — email simply replaces "admin texts the bearer token" with "server emails the bearer token." The applicant-side flow is identical.

---

## 1. Background — why the current system is broken

### 1.1. The bug, as lived by an applicant

Susan says to her agent: "get me into DogClub." Today the agent:

1. Calls `clubs.join` with her email and the club slug.
2. Receives `memberToken: "cc_live_..."` in the response, plus a PoW challenge and the admission policy.
3. Is instructed by `SKILL.md` to "save `memberToken` immediately. Losing it means losing access."
4. Has **nowhere durable to save it.** An agent is usually a conversation, not an application with persistent storage. Options: (a) ask Susan to paste a 32-character opaque string into a password manager on her very first interaction — jarring UX when she expected a conversation; (b) hold it in ephemeral context and lose it when the conversation rolls.
5. Drafts the application, solves the PoW, submits. Status becomes `submitted`.
6. Susan walks away satisfied.
7. A day later, the admin approves. **No signal reaches Susan.**
8. Susan says to a fresh agent: "did I get into DogClub?" The agent has no token, cannot call `clubs.applications.get`, and there is no unauthenticated status endpoint (correctly — that would leak membership existence). **Dead end.**

Emergency recovery is `superadmin.accessTokens.create`, invoked manually per lost applicant. It shipped under duress. It is not a scalable answer.

### 1.2. Root cause

The bearer token is issued at the moment it provides the *least* value and has the *highest* loss risk: first contact, pre-approval, when the human doesn't even know a token exists and the agent has no place to put it. It is then expected to survive a long waiting period during which *nobody uses it*, and becomes essential only after the human has walked away.

The token is **structurally misplaced in time.** The fix is to delay issuance until the moment the human is actually admitted to a club, and to make that moment a deliberate onboarding handoff rather than a byproduct of a join call.

### 1.3. What we are preserving

- **Agents as the primary API consumers.** Non-negotiable.
- **No web form.** No browser-based apply flow.
- **No email transport.** This plan solves the problem without any new transports.
- **Anonymous `clubs.join` remains non-idempotent.** The account-takeover fix from commit `5e5189f` stays; two anonymous joins for the same email create two unrelated memberships. This plan does not re-open that attack surface.
- **The agent-first init protocol.** Fetch `/api/schema`, then `session.getContext`. Unchanged.
- **The legality gate and its retry semantics.** Unchanged except for the tuning in §3.
- **Cross-joining for existing members.** Already-authenticated members joining another club continue to use their existing bearer token. No new token is issued and no ceremony runs for them — their existing token's scope simply widens through `accessible_club_memberships` when the new membership becomes active.

---

## 2. Design decisions rejected along the way

We considered and rejected these alternatives during a long debate. They are listed here so a reviewing agent does not re-open settled ground.

- **Send the token by email at join time.** Rejected. Email infrastructure is significant work; stuck applicants often never see it because they weren't expecting one; and it couples the OSS product to an email transport that self-hosters may not want.
- **Send the token by email on approval.** Rejected *for now*. Same reasons. Email may come later as an optional transport; this plan proves the design works without it.
- **Short-lived claim link in an email.** Rejected. Extra infrastructure (link redirection, HTTP claim endpoint) when the agent-first model needs none of it.
- **Sponsor delivers credentials for invited applicants.** Rejected. (a) Too much operational burden on sponsors who may forget; (b) creates a dual-delivery code path that would have to be torn out when email is eventually added; (c) admin-delivery is neutral with respect to a future email upgrade — email simply replaces the admin's manual channel with a server-side one, and the applicant-side flow is unchanged.
- **Passphrase-based login.** Rejected. Relies on human memory, leaks membership existence on probe, and is weaker entropy than a server-generated credential.
- **One-time claim code exchanged for a bearer token.** Considered and rejected after extensive debate. Earlier drafts had a separate `cc_welcome_...` claim code that the admin delivered, which the agent exchanged for a bearer token via `clubs.onboard(claimCode)`. The decisive argument: a lazy user told to claim-and-save still won't save, and if they lose track of the token after claiming, the claim code is already burned — they're locked out with no recovery except admin intervention. Direct bearer token delivery is strictly better because the user's delivery channel (WhatsApp, SMS, text, email from the admin's personal account) becomes their natural backup: if they forget to save the token, they can scroll back to the admin's message and find it again, still valid. Claim codes also added significant implementation complexity (new table, new lifecycle, new reissue action, separate TTL management, ~200 lines of tests) that direct delivery avoids. The ceremonial "premium" feel lives in the welcome copy and the admin-delivered nature of the credential, not in the exchange semantics.
- **Two-stage onboarding ceremony (first call prepares the user, second call hands over the token).** Rejected. Appealing as ritual but did not actually enforce anything — a lazy agent could read the first-call response, extract the magic phrase, and immediately call the second call without pausing. The pause depends on agent good behavior under both single-call and two-call designs, and two-call just adds complexity.
- **SKILL.md-only enforcement of the onboarding gate.** Rejected. Owen has directly observed agents ignoring SKILL.md guidance. Enforcement must be structural at the server layer, not advisory in a doc file.

---

## 3. Locked-in tuning decisions

These are small pre-decided parameter changes, separable from the structural redesign but landing in the same ship:

- `APPLICATION_CHALLENGE_TTL_MS`: **1 hour → 24 hours.** The applicant has a full day to submit and iterate within a single PoW challenge.
- `MAX_APPLICATION_ATTEMPTS`: **5 → 6.** One extra attempt. No more — each attempt is a paid LLM call against the legality gate.
- **The 24-hour clock is a hard wall from challenge creation, not a rolling window.** It does not reset on each revision. This prevents zombie applications and gives a clean "you have until tomorrow" promise.
- **The PoW solution travels with the membership for the full 24-hour window.** Retries do not re-mine. Only `challenge_expired` (past the wall) or `invalid_proof` forces a re-solve.

---

## 4. The new flow, end-to-end, per applicant type

### 4.1. Cold applicant (Susan)

Susan has never used ClawClub. She says to her agent: "get me into DogClub at dogclub.example.com."

1. **Agent fetches `/api/schema`.** As always.
2. **Agent calls `clubs.join`** anonymously with `clubSlug` and `email`. Server:
   - Creates a new `members` row for Susan, with `onboarded_at = NULL`.
   - Creates a `club_memberships` row in state `applying` with `proof_kind = 'pow'`.
   - Creates a PoW challenge with the 24h TTL and 6-attempt cap.
   - Generates a new secret: the **application key** (see §6). Stores its hash.
   - **Does NOT issue a bearer token.** This is the core structural change.
   - Returns `{ clubId, membershipId, applicationKey, proof: { kind: 'pow', ... }, club: { name, summary, ownerName, admissionPolicy, priceUsd } }`. The `memberToken` field is gone from this response.
3. **Agent drafts the application** from the admission policy and solves the PoW.
4. **Agent calls `clubs.applications.submit`** with `membershipId`, `applicationKey`, `nonce`, `name`, `socials`, `application`. Server verifies the application key hash-matches the membership, runs PoW check, runs legality gate, transitions to `submitted` (or returns `needs_revision` with feedback and attemptsRemaining).
5. **Agent tells Susan:** "Done. A DogClub admin will review your application and get in touch directly with your access key. When it arrives, paste it to me and I'll walk you through activation."
6. **Susan walks away.** Nothing stored on her side — no token, no key. The application key dies with the session.
7. **Admin reviews and approves** via `clubadmin.memberships.setStatus(active)`. Server, atomically within one transaction:
   - Transitions the membership from `submitted` to `active`.
   - Checks whether Susan has any active (non-revoked, non-expired) bearer tokens. **She does not** — this is her first club.
   - Mints a fresh bearer token bound to Susan's member row. `members.onboarded_at` stays NULL.
   - Returns the plaintext bearer token in the `setStatus` response envelope under `accessToken`, exactly once, with an explicit note that it cannot be retrieved again and must be delivered to the applicant now.
8. **Admin delivers the bearer token out-of-band** via whatever channel they prefer — text, WhatsApp, Signal, phone, in person, email from the admin's own account. **The delivery channel becomes Susan's natural backup:** if she forgets to save the token, she can scroll back to that thread and find it again, still valid. This is the key property that made direct delivery win over claim codes (see §2 and §15).
9. **Susan pastes the token to her agent.** Agent stores it in session context and uses it as its `Authorization: Bearer` credential.
10. **Agent fetches schema and calls `session.getContext`**, per the init protocol. Server resolves the token, sees `actor.member.onboarded_at IS NULL`, and returns the full actor context with an explicit `actor.onboardingPending: true` flag alongside the member and membership info. Full context (id, memberships, club names) is returned pre-onboarding — nothing is stripped.
11. **Agent sees `actor.onboardingPending: true`** and calls `clubs.onboard` (member-authenticated with Susan's new bearer token, no input payload). Server, atomically within one transaction:
    - Verifies `actor.member.onboarded_at IS NULL`.
    - Looks up Susan's active memberships — there is exactly one, DogClub. That is the club being welcomed.
    - Sets `members.onboarded_at = now()` for Susan.
    - Returns the ceremonial welcome payload described in §7.
12. **Agent relays the welcome payload to Susan verbatim**, including the greeting, the token-save instructions, the loss warning, and the list of capabilities.
13. **From this point on, Susan has a normal, fully-activated bearer token.** Her member row has `onboarded_at` set. All subsequent actions work without any further ceremony.

**Why this flow is bulletproof against the lazy-user failure mode.** If Susan ignores the save instructions and later loses her agent's session context, she does **not** need to contact the admin. She goes back to whatever messaging thread the admin used to deliver the token, pastes it to a new agent, the agent calls `session.getContext` → sees `onboarded_at` is already set → proceeds normally. The welcome ceremony does not re-run (idempotent), but she is instantly back in. The delivery thread is the backup.

If she loses BOTH the agent context AND the delivery thread, the recovery path is a 30-second ask to the club admin via `clubadmin.accessTokens.create` (see §9). Even this worst-case is bounded.

**Susan does not receive a `membership.activated` notification.** The full onboarding ceremony covers the welcome moment — the notification fires only when the activation does NOT mint a token (see §8 for fanout rules and §4.3, §4.4 for the cases where it does fire). The cold path's "moment of admission" IS the admin contacting Susan with the access key, and that moment is intentionally human-only.

### 4.2. Invited new applicant (Jenny)

Jenny's friend Amy is a DogClub member. Amy calls `invitations.issue` and texts Jenny the resulting `cc_inv_...` code.

1. Jenny's agent fetches the schema, calls `clubs.join` **anonymously** with `clubSlug`, `email`, and `invitationCode`. Server:
   - Validates the invitation code.
   - Creates a new `members` row for Jenny with `onboarded_at = NULL`.
   - Creates a `club_memberships` row in state `applying` with `proof_kind = 'invitation'`.
   - Generates an application key, stores its hash.
   - Links the membership to the invitation and marks the invitation used.
   - Returns `{ clubId, membershipId, applicationKey, proof: { kind: 'none' }, club: {...} }`.
2. Agent drafts and submits via `clubs.applications.submit` with the application key (no nonce, because invitation-backed joins skip PoW but still go through the legality gate).
3. Jenny walks away.
4. Admin approves via `setStatus(active)`. Server follows the same atomic flow as §4.1: state transitions to `active`, a fresh bearer token is minted for Jenny (no active tokens), plaintext returned in `accessToken`. **Returned to the reviewing admin, not the sponsor.** Amy does not see or handle the token.
5. Admin delivers out-of-band. Sponsor delivery is explicitly rejected (see §2).
6. Jenny pastes the token to her agent, runs the same init protocol, sees `actor.onboardingPending: true`, calls `clubs.onboard`, receives the welcome payload. Done.

**The sponsorship is acknowledged via two channels, not one.** Even though Amy doesn't deliver the credential, the design does not let her disappear from Jenny's experience:

- **Jenny's onboarding welcome payload is sponsor-aware.** Because the membership has an associated `invitation_id` and that invitation has a `sponsor_member_id`, the server resolves the sponsor's `publicName` and threads it through the welcome composer (see §7). Jenny's greeting reads something like *"Welcome to DogClub, Jenny. Amy spoke for you, and her vouch carried real weight here."* Her capabilities list includes a hint to thank Amy. The fact that Amy brought her in is foregrounded, not buried. This is server-side string substitution — no extra round trip, no agent improvisation.
- **Amy receives an `invitation.accepted` notification on her personal queue** the moment Jenny is approved. The notification is materialized into `member_notifications` atomically with the `setStatus(active)` transition (see §8), and naturally flows through the existing `sharedContext.notifications` piggyback, the `/stream` SSE channel, and `notifications.list`. Amy's agent surfaces it on her next interaction: *"Jenny was just approved into DogClub. You might want to send her a welcome DM."* Amy can independently message Jenny via the existing `messages.send`. The sponsor's role is honored without making the sponsor responsible for credential delivery.

Together these give Jenny the warm-handoff feel without putting credential burden on Amy. If Amy is offline or asleep when Jenny is approved, the credential still flows (admin-delivered) and Amy's heads-up is waiting for her when she next checks her notifications.

### 4.3. Cross-joining applicant (Alice)

Alice is already a member of DogClub and wants to join CatClub too.

1. Alice's agent calls `clubs.join` **authenticated** with her existing bearer token, passing `clubSlug: "catclub"`. Server:
   - Recognizes her actor member id from the Authorization header.
   - Creates a CatClub `club_memberships` row in state `applying`.
   - **Does NOT generate an application key.** The key mechanism exists only for tokenless applicants.
   - Returns `{ clubId, membershipId, applicationKey: null, proof: {...}, club: {...} }`.
2. Agent drafts and submits using her existing bearer in the Authorization header. `clubs.applications.submit` accepts either `applicationKey` in input OR a bearer token; Alice's path uses the header.
3. Alice walks away.
4. CatClub admin approves via `setStatus(active)`. Server:
   - Transitions the CatClub membership from `submitted` to `active`.
   - Checks Alice's active bearer tokens: **she has one** (her DogClub-era token).
   - **Does NOT mint a new token.** There is no delivery needed.
   - Returns the normal response envelope with no `accessToken` field.
5. **Alice receives a `membership.activated` notification on her personal queue.** Inserted into `member_notifications` atomically with the state transition (see §8). The payload contains a club-specific welcome — greeting, club summary, capabilities for THIS club. Naturally flows through `sharedContext.notifications`, `/stream`, and `notifications.list`. Her agent surfaces it on her next interaction: *"You've been admitted to CatClub. Here's what CatClub is about: [...]. Here are some things you can ask me to do: [...]"* This is the lightweight cross-join welcome — no save-token instructions, no loss warning, just a discovery moment for the new club.
6. Alice's next call to `session.getContext` also shows CatClub in her active memberships, because `accessible_club_memberships` is driven by membership state, not by per-club tokens. Her `onboarded_at` is already set from her DogClub admission, so no ceremony triggers — CatClub simply appears in her club list, AND she gets the explicit notification welcoming her in. The club list update and the notification are complementary: the list is the durable state, the notification is the proactive announcement.

**Rule for minting at `setStatus`:** a new bearer token is minted if and only if the target member has zero active bearer tokens at the moment the membership transitions into `active`. Otherwise the mint is skipped and the response envelope contains no `accessToken` field.

### 4.4. Compound case: invited cross-joiner (Bob)

Bob is already a DogClub member. Amy invites him to CatClub via an invitation code. This case is the intersection of §4.2 and §4.3 — invited (so there's a sponsor) but already-onboarded (so no token mint and no full ceremony).

1. Bob's agent calls `clubs.join` **authenticated** with his existing bearer token AND the `invitationCode`. Server:
   - Recognizes Bob's actor member id from the Authorization header.
   - Validates the invitation code.
   - Creates a CatClub `club_memberships` row in state `applying` with `proof_kind = 'invitation'`.
   - Links the invitation to the membership and marks the invitation used.
   - **Does NOT generate an application key** (Bob has a bearer token).
   - Returns `{ clubId, membershipId, applicationKey: null, proof: { kind: 'none' }, club: {...} }`.
2. Bob's agent submits the application using his existing bearer for auth, no nonce.
3. Bob walks away.
4. CatClub admin approves via `setStatus(active)`. Server:
   - Transitions the CatClub membership from `submitted` to `active`.
   - Bob has an active bearer token → **does NOT mint a new token**.
   - The membership has an invitation → **fires `invitation.accepted` for Amy** (sponsor heads-up).
   - The activation did not mint a token → **fires `membership.activated` for Bob**, with the sponsor's public name threaded into the welcome payload.
   - Returns the normal envelope with no `accessToken`.
5. Bob's agent surfaces the `membership.activated` notification on his next interaction: *"You've been admitted to CatClub. Amy invited you and her vouch carried weight here. Here's what CatClub is about. You might want to thank Amy for bringing you in."*
6. Amy's agent surfaces the `invitation.accepted` notification on her next interaction: *"Bob was just approved into CatClub. You might want to send him a welcome DM."*

The two flows compose naturally — neither requires special-case logic in `setStatus` beyond the rules already stated. The `membership.activated` payload includes sponsor info if the membership has an invitation; otherwise it doesn't. The `invitation.accepted` notification fires unconditionally when an invitation-backed membership is approved, regardless of whether the invitee was new (Jenny) or already a member (Bob).

---

## 5. The onboarding gate (server-enforced)

This is the single most important enforcement decision in the plan, and it is deliberately NOT in a SKILL.md paragraph. Owen has directly observed agents ignoring SKILL.md guidance, so the gate is **structural**, not advisory.

### 5.1. The rule

A bearer token whose member has `onboarded_at IS NULL` is **structurally valid** — it authenticates calls and resolves a member id — but **functionally gated** to a short allowlist of actions until the ceremony runs.

**Allowlist (exactly two actions):**

- `session.getContext`
- `clubs.onboard`

**Every other action** (including `content.create`, `content.update`, `messages.send`, `messages.getInbox`, `activity.list`, `notifications.list`, `notifications.acknowledge`, `profile.update`, `profile.list`, `members.searchByFullText`, `vouches.create`, `invitations.issue`, `invitations.listMine`, `clubs.join`, `clubs.applications.submit`, `clubs.applications.get`, `clubs.applications.list`, `clubs.billing.startCheckout`, `clubadmin.*`, `superadmin.*`, `quotas.getUsage`, `events.*`, everything) returns `HTTP 403` with a plain-English error payload:

```json
{
  "error": {
    "code": "onboarding_required",
    "message": "You have a bearer token but haven't completed onboarding yet. Call clubs.onboard to receive your welcome and activate your membership. No other action will succeed until this is done."
  }
}
```

### 5.2. Where the check lives

**One place: the dispatch layer in `src/dispatch.ts`.** The check runs in the same layer that today resolves the bearer, loads the actor, and enforces role gates (`requireSuperadmin`, `requireClubAdmin`, etc.).

**Ordering is load-bearing.** The gate MUST fire immediately after `repository.authenticateBearerToken` resolves the actor and BEFORE any of the following run, on both the authenticated dispatch path (`dispatchAuthenticated` at `src/dispatch.ts:439`) and the optional-member dispatch path (`dispatchOptionalMember` at `src/dispatch.ts:347`):

1. **Before `parseActionInput`**. If the gate ran after parsing, many actions would return `422 invalid_input` before the agent ever saw `403 onboarding_required`, which would completely defeat the "plain English message telling the agent exactly what to do" guarantee.
2. **Before `def.requiredCapability` / `requireCapability`** checks. A gated user calling an unbuilt-on-this-deployment capability should get `onboarding_required`, not `not_implemented`.
3. **Before `def.preGate`**. `preGate` hooks assume a fully-authorized actor and often touch the repository.
4. **Before the LLM legality gate**. Gated users must not be able to burn LLM calls before the gate fires — this is both a cost-control and an abuse-prevention concern.

On the optional-member path, the gate fires only when a bearer was actually presented and resolved to a member. An anonymous call on an `optional_member` action goes through unchanged — the gate targets authenticated-but-unonboarded actors specifically.

The check itself is a single conditional:

```typescript
if (actor.member && actor.member.onboarded_at === null) {
  if (action !== 'session.getContext' && action !== 'clubs.onboard') {
    throw new AppError(403, 'onboarding_required', '...');
  }
}
```

No handler changes. Future actions added to the registry inherit the gate automatically. If a developer forgets to gate their new action, the gate is still there because the gate does not live in handlers at all.

**Concrete instruction for the implementing agent:** insert the gate at line 456 of the current `dispatchAuthenticated` (immediately after `const actor = auth.actor;` and before the next `sharedContext` line) AND at line 374 of the current `dispatchOptionalMember` (immediately after `defaultRequestScope = { ... }` and before `if (def.requiredCapability)`). The parameterized test in §13.4 is the enforcement mechanism — if the gate runs in the wrong order, actions will fail with `invalid_input` / `not_implemented` / `gate_rejected` before the test sees `onboarding_required`, and the test will fail loudly.

### 5.3. Idempotency of `clubs.onboard`

Calling `clubs.onboard` when `members.onboarded_at` is already set is a no-op that returns `{ alreadyOnboarded: true }`. It does NOT re-run the welcome copy. This matters for the "re-paste from delivery thread into a fresh agent" recovery scenario: the agent can safely call `clubs.onboard` as part of an init flow without worrying about duplicate ceremonies.

### 5.4. Why this is simpler than it looks

The earlier claim-code alternative (rejected in §2) enforced the gate structurally — no credential, no actions — but required a whole second secret primitive with its own table, lifecycle, reissue action, and ~200 lines of tests. The onboarding gate replaces all of that with **one column, one middleware check, and one parameterized test.** Net code reduction despite adding a new concept.

### 5.5. Direct-mint paths must set `onboarded_at`

This is a **critical invariant** that prevents accidental gated users from operational workflows. Any code path that issues a bearer token to a member OUTSIDE the normal `clubadmin.memberships.setStatus(active)` ceremony MUST atomically set the target's `members.onboarded_at` in the same transaction as the mint. Specifically:

- **`clubadmin.accessTokens.create`** (new, recovery path for lost tokens) → `UPDATE members SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $target`
- **`superadmin.accessTokens.create`** (existing emergency recovery) → same `COALESCE(onboarded_at, now())`
- **`accessTokens.create`** (existing member-scoped self-service rotation) → trivially safe because the caller must already be an onboarded member to call it, but the mint should still set `COALESCE` defensively in case a future change exposes it to an earlier-stage caller.
- **Any seed-data or bootstrap path that inserts into `member_bearer_tokens` directly** (admin provisioning, `db/seeds/dev.sql`, self-hosting setup scripts) → must set `onboarded_at` on the corresponding member row, or they'll create weird gated users.

**The rule:** a member with a bearer token but `onboarded_at IS NULL` is an *invalid state*, except for the one specific intermediate window inside `setStatus(active)` where the token has been minted but the user hasn't yet called `clubs.onboard`. Any other code path that produces that state is a bug.

**Why `COALESCE` and not an unconditional `SET`:** we want recovery operations to leave already-onboarded members' timestamps intact (historical accuracy matters for audit). A recovery mint for a member who onboarded three months ago should not reset their onboarding timestamp to today. The coalesce handles both "never onboarded" and "already onboarded" cleanly in one UPDATE.

**Test coverage:** §13.3 includes a test that uses `clubadmin.accessTokens.create` to mint for a brand-new member who has `onboarded_at IS NULL`, and asserts that after the mint, (a) the token is immediately usable for non-allowlisted actions, (b) `onboarded_at` is now non-null, and (c) the welcome ceremony does NOT run because `clubs.onboard` sees `alreadyOnboarded: true` (the coalesce set it during the mint transaction, not the ceremony).

---

## 6. The application key

One new secret primitive: the application key. It replaces the pre-approval bearer token issued by today's `clubs.join`.

### 6.1. Purpose

Authenticate `clubs.applications.submit` and `clubs.applications.get` for a specific pending application, without issuing a real bearer token. This is the mechanism that lets the cold-applicant agent iterate `needs_revision` retries within the 24-hour challenge window.

### 6.2. Shape and helpers

`cc_appkey_<12-char id>_<24-char secret>`, matching the existing `cc_live_` and `cc_inv_` conventions. Add `buildApplicationKey()` and `parseApplicationKey()` helpers in `src/token.ts` alongside the existing builders, plus unit tests for round-trip and malformed-input rejection.

### 6.3. Scope

An application key authorizes exactly two actions, and only against the one membership it was bound to:

- `clubs.applications.submit` — only if the `membershipId` in the input matches the membership the key was issued for.
- `clubs.applications.get` — same.

It does **not** authenticate `session.getContext`, does not appear in `accessible_club_memberships`, does not grant any read of other members or content, and is **not** a bearer token. It is a capability token for one specific row.

### 6.4. Passing convention

The application key travels as a **field in the input payload**, not in the Authorization header. This is deliberate: it makes it structurally obvious that the key is a capability, not an identity. Both `clubs.applications.submit` and `clubs.applications.get` gain an optional `applicationKey` input field.

**First-class auth kind, not handler prose.** The current `ActionAuth` union in `src/schemas/registry.ts:27` is `'none' | 'optional_member' | 'member' | 'clubadmin' | 'clubowner' | 'superadmin'`. Leaving "bearer OR applicationKey" as per-handler prose would be awkward and easy to get wrong. **Add a new variant `'member_or_application_key'`** to `ActionAuth`, wire it in the dispatch layer in `src/dispatch.ts`, and use it for both `clubs.applications.submit` and `clubs.applications.get`. The dispatch resolver runs this strict precedence, in this order:

1. **If `Authorization: Bearer <token>` is present**, resolve it via the existing bearer path.
   - If it resolves to a valid, non-expired, non-revoked token → use that identity. Ignore any `applicationKey` in the input.
   - **If it is present-but-invalid (malformed, expired, revoked, unknown) → return 401 immediately. Do NOT fall back to the application-key path.** A client that sends a bad bearer cannot silently become a different caller by also sending an application key — that would be a confused-deputy footgun.
2. **Else if `applicationKey` is present in the input**, parse it, hash it, and look it up by `(token_hash, membership_id)` where `membership_id` matches the `membershipId` in the input. If the row exists and is not expired and not revoked, authorize the call as "anonymous capability for membership X."
3. **Else 401.**

**First-class handler context (not just a marker on `ctx.actor`).** The current registry in `src/schemas/registry.ts` defines three distinct handler context types: `HandlerContext` (authenticated, `actor: ActorContext`), `OptionalHandlerContext` (`actor: MaybeMemberActorContext`), and `ColdHandlerContext` (no actor at all). The `'member_or_application_key'` auth kind gets a **fourth** first-class context, not a reused `HandlerContext` with a runtime `capabilityOnly` boolean. Reusing `HandlerContext` here would be a type lie — `ctx.actor.member` would *look* like a real `ActorContext` but have fake/unsafe data when the caller arrived via the key path, and the compiler wouldn't force handlers to notice.

Add to `src/schemas/registry.ts`, next to the existing context types:

```typescript
/** Handler context for auth: 'member_or_application_key'. Discriminated by `kind`. */
export type MemberOrCapabilityContext =
  | {
      kind: 'member';
      actor: ActorContext;                 // real authenticated member, same shape as HandlerContext
      requestScope: RequestScope;
      sharedContext: SharedResponseContext;
      repository: Repository;
      requireCapability: (capability: RepositoryCapability) => void;
      // No applicationKey here — the caller is an identified member.
    }
  | {
      kind: 'applicationKey';
      capability: { membershipId: string };  // the ONE membership this key is scoped to
      repository: Repository;
      requireCapability: (capability: RepositoryCapability) => void;
      // Deliberately NO `actor` field. No `requireClubAdmin`, no `requireSuperadmin`,
      // no `requireAccessibleClub` — a capability-only caller has no memberships, no roles,
      // and no global access. Handlers that try to read `ctx.actor` on this branch fail to
      // compile, which is the point.
    };
```

Handlers for `clubs.applications.submit` and `clubs.applications.get` then take `ctx: MemberOrCapabilityContext` and MUST switch on `ctx.kind` before doing anything authorization-sensitive. The member branch resolves the same way as any `auth: 'member'` handler. The applicationKey branch reads `ctx.capability.membershipId` and verifies (belt-and-braces) that it matches `input.membershipId`, then proceeds with an explicit "anonymous capability for membership X" identity. Because the two branches have different types with no shared `actor` field, there is no way to accidentally call `ctx.actor.member.id` on the key path — the code won't type-check.

The dispatch layer's job is: build the right branch of the union and pass it to the handler. Both `clubs.applications.submit` and `clubs.applications.get` get a new `handleMemberOrCapability` slot on their `ActionDefinition`, analogous to the existing `handle` / `handleCold` / `handleOptionalMember` slots.

**Why a named auth kind AND a named context, not just handler logic:** putting the auth kind in the union means the dispatch layer and the schema-endpoint generator both know about it, `/api/schema` can document it accurately in the public contract, and any future action that wants to accept either credential type can opt in by setting `auth: 'member_or_application_key'` without re-implementing the precedence. Pairing it with a first-class discriminated-union context means the implementation cannot silently drift into a type lie — the compiler enforces that handlers handle both cases explicitly.

### 6.5. Lifecycle

- Issued by `clubs.join` when the resulting membership belongs to a tokenless member (new anonymous join, or new invited join). Returned in the join response as the `applicationKey` field. Null for cross-joiners (authenticated join paths).
- Stored hashed in a new `application_keys` table keyed by `(id, membership_id, token_hash, created_at, expires_at, revoked_at)`.
- **Expires at 24h from creation** (the same wall as the PoW challenge). After 24h the row is considered revoked regardless of membership state.
- **Revoked on terminal membership state** (`declined`, `withdrawn`, and any other terminal). The key serves no purpose once the application is a dead letter.
- **Remains VALID through the `applying → submitted` transition.** The key survives a successful submit so that the agent can call `clubs.applications.get` within the same session to verify the submitted state. Rationale: if revocation happened the moment submit succeeded, `clubs.applications.get` on the key path would be instantly dead and the `.get` endpoint would only be useful during the in-flight retry loop, which is an awkward inconsistency. By letting the key live through `submitted` (up to the 24h wall or terminal transition), `.get` stays consistently useful throughout the entire single-session flow. The key is tied to one specific membership regardless of state, so there is no extra scope leakage — the only action a post-submit caller can take with the key is read the status of their own pending application, which they already know about.
- **`clubs.applications.submit` is state-gated independently of the key.** The handler checks that the membership is in `applying` before running the legality gate. A post-submit caller with a live key who tries to submit again gets a state-transition rejection, not an auth rejection. The key isn't what prevents double-submission — the membership state is.
- Rate-limited submit attempts: `MAX_APPLICATION_ATTEMPTS = 6` covers this naturally.

### 6.6. Security note

An attacker who steals the application key can submit application revisions for the one targeted membership. They cannot read any other data, cannot impersonate the applicant anywhere else, cannot access any other club. Blast radius: a single pending application. The key becomes useless when the membership reaches a terminal state (`declined` / `withdrawn`) or the 24-hour TTL elapses, whichever comes first. Per §6.5 the key deliberately survives the `applying → submitted` transition so that `clubs.applications.get` keeps working in-session; a post-submit attacker holding the key can only read the status of the one already-submitted application (which the applicant already knew about) and cannot re-submit because the membership is no longer in `applying`. This is an acceptable scope for a capability token.

### 6.7. What the agent tells the human about the application key

**Nothing.** It is a session-lifetime secret. The human does not need to see it, save it, or know it exists. The agent holds it in conversation context for the duration of the submit/retry loop. If the session ends mid-retry-loop, the application cannot be revised further; the human must re-apply from scratch via a new `clubs.join` call. That is an accepted trade-off (§10).

---

## 7. The welcome payload

This is what `clubs.onboard` returns. It is the heart of the ceremonial moment and now — since we removed the claim-code intermediate — it is carrying the entire weight of the premium feel. **It must be written carefully; this is load-bearing copy.**

### 7.1. Shape

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
    preamble: "You've been accepted as a member. In a moment I'll show you what you can do here, but first some essential housekeeping.",
    tokenInstruction: "The access key you just pasted to me is your permanent credential for DogClub. Save it in your password manager right now — this is the single most important thing you can do in the next sixty seconds. If you don't use a password manager, scroll back to the message thread where the admin sent it to you; that thread is your natural backup, and the token will still be valid there next week, next month, and as long as you haven't asked for it to be rotated.",
    lossWarning: "If you somehow lose both your agent's session and your delivery thread, the only way back in is to contact a club admin and ask them to mint you a new key. It's a 30-second ask on their end, but don't make it a habit.",
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

### 7.2. Server-authored, not agent-authored

The `welcome` block is composed by the server and relayed by the agent. **This is deliberate.** If each agent composes its own welcome, some will nail it, some will hallucinate capabilities that don't exist, some will dump a one-liner. Putting the copy in the server's response guarantees every new member gets the same premium moment regardless of which agent they use, and keeps the copy maintainable in one place.

`SKILL.md` (see §11) instructs the agent to **relay the `welcome` block verbatim or near-verbatim before doing anything else.** Don't paraphrase. Don't skip the loss warning. Don't shorten the capabilities list. This is the moment the club introduces itself, and it should feel complete.

### 7.3. Three composer functions in one module

The default welcome copy lives in a new module `src/clubs/welcome.ts`, which exports **three** functions corresponding to the three different welcome moments in the design:

- **`buildOnboardingWelcome({ clubName, memberName, sponsorPublicName? })`** → returns the full ceremonial onboarding payload (greeting, preamble, tokenInstruction, lossWarning, capabilities, closing). Used by `clubs.onboard` for first-time members. If `sponsorPublicName` is provided (invited new applicant like Jenny), the greeting and capabilities are sponsor-aware. Otherwise (cold like Susan), generic.
- **`buildSecondClubWelcome({ clubName, memberName, sponsorPublicName? })`** → returns the lighter cross-join welcome (greeting, club summary, capabilities, closing). **Critically, no `tokenInstruction` and no `lossWarning`.** The user already has a token, the user is already onboarded — they don't need to be told to save the credential they've been carrying for months. Used as the payload for the `membership.activated` notification (see §8). Sponsor-aware if `sponsorPublicName` is provided (Bob compound case); otherwise generic (Alice plain cross-join).
- **`buildSponsorHeadsUp({ newMemberPublicName, clubName })`** → returns a short message addressed to the sponsor: *"Your invitee {newMemberPublicName} was just approved into {clubName}. Consider sending them a welcome DM."* Used as the payload for the `invitation.accepted` notification.

All three functions are generic, parameterized, and contain no ClawClub branding. Self-hosters inherit clean defaults.

**Implementing-agent note:** scaffold all three with `TODO OWEN:` placeholders and surface them in the hand-back. Owen will write the actual default strings — tone matters too much to guess.

### 7.4. Future per-club customization

Add a nullable `welcome_template` column (JSONB) to the `clubs` table. For the first ship this column is added but not yet consumed — the welcome composers read `clubs.welcome_template` and, if non-null in the future, substitute custom copy. Adding the column now future-proofs the data model so per-club customization can be added later without another migration. The same column carries overrides for all three composer functions (one column with a structured schema like `{ onboarding?: ..., secondClub?: ..., sponsorHeadsUp?: ... }`), or the three are separate columns — implementing agent's call. JSON keeps it open.

### 7.5. Tone guidelines for the default copy

- **Firm but not false about token loss.** Strictly speaking, an applicant who loses their token is not locked out forever — an admin can mint a new one via the recovery path. But the *spirit* is urgency. The default copy should say "the only way back in is to contact a club admin and ask them to mint you a new key" rather than any literal "you will never access the club again."
- **Point at the delivery-thread backup explicitly.** This is the single strongest recovery property in the design. Tell the user about it.
- **Invitations to action, not API dumps.** "Ask me to show you who else is in the club," not "You can call `members.searchByFullText`."
- **Five or six capabilities, not twenty.** First-day new members need three things to try first, not a menu.
- **Premium tone.** This is a private club, not a sign-up form. The copy should feel like being welcomed at the door of a members-only establishment.

Owen will write the actual default strings. Implementing agent should scaffold `src/clubs/welcome.ts` with `TODO OWEN:` placeholders and surface them in the hand-back. Tone matters too much to guess.

### 7.6. The `alreadyOnboarded` short-circuit

When `clubs.onboard` is called by a member whose `onboarded_at` is already set, the response is simply:

```
{ alreadyOnboarded: true }
```

No welcome copy, no state change, no error. The agent MAY still present a short "you're already in" message to the user, but it should not re-run the full ceremony. This supports the "re-paste from delivery thread" recovery scenario cleanly: the agent can always call `clubs.onboard` defensively at the start of a fresh session, and if the ceremony has already been done, it's a cheap no-op.

---

## 8. Notification fanout at admission

This section covers what happens on the existing `member_notifications` queue when an applicant is admitted. **Critically, this design adds NO new notification infrastructure** — the existing system from `plans/system-notifications-design.md` is fully shipped and serves all our needs. We add new `topic` strings, fire them from the right code paths, and slightly loosen the `notifications.acknowledge` topic check. That's it.

### 8.1. The two new topics

**`invitation.accepted`** — sent to the sponsor when their invited applicant is admitted to a club.

- `recipient_member_id`: the sponsor (`invitations.sponsor_member_id` from the membership's linked invitation)
- `club_id`: the club the new member just joined
- `topic`: `'invitation.accepted'`
- `payload`: `{ newMemberId, newMemberPublicName, invitationId, clubName, headsUp }` — `headsUp` carries the prose blob from `buildSponsorHeadsUp(...)` (see §7.3) so the agent can relay verbatim
- `entity_id`: null
- `match_id`: null
- `acknowledged_state`: null at insert time (sponsor acknowledges by processing it, e.g. by sending a DM)
- **Fired when:** `clubadmin.memberships.setStatus(active)` runs on a membership that has a non-null `invitation_id`, regardless of whether a token was minted for the new member. Bob (compound) and Jenny (invited new) both fire one for Amy.

**`membership.activated`** — sent to a member when they have been activated into a new club WITHOUT triggering the full onboarding ceremony. This is the "second-club welcome" the cross-join cases need.

- `recipient_member_id`: the new club member (Alice or Bob)
- `club_id`: the new club they just joined
- `topic`: `'membership.activated'`
- `payload`: `{ clubId, clubName, summary, sponsorMemberId?, sponsorPublicName?, welcome }` — `welcome` carries the structured payload from `buildSecondClubWelcome(...)` (see §7.3) which the agent relays verbatim
- `entity_id`: null
- `match_id`: null
- `acknowledged_state`: null at insert time
- **Fired when:** `clubadmin.memberships.setStatus(active)` runs AND no token is minted for the member (i.e. they already have an active bearer token AND `members.onboarded_at IS NOT NULL`). Alice and Bob fire this. Susan and Jenny do NOT fire this — their full onboarding ceremony covers the welcome moment.

### 8.2. The fanout decision matrix in `setStatus(active)`

The handler runs the existing state transition, then within the same transaction makes two independent decisions:

```
mintTokenIfNeeded():
  if target member has zero active bearer tokens → mint, return plaintext in response envelope
  else → no mint

fanout():
  if membership.invitation_id is not null:
    insert invitation.accepted notification for the sponsor
  if NO token was minted in this transition:
    insert membership.activated notification for the new member
```

Cross-product:

| Case | Token minted? | `invitation.accepted` for sponsor? | `membership.activated` for new member? |
| --- | --- | --- | --- |
| Susan (cold first-time) | ✓ | — (no sponsor) | ✗ (covered by onboarding ceremony) |
| Jenny (invited new first-time) | ✓ | ✓ | ✗ (covered by onboarding ceremony) |
| Alice (cross-join, no sponsor) | ✗ | — (no sponsor) | ✓ |
| Bob (invited cross-join) | ✗ | ✓ | ✓ |

The "membership.activated" branch is gated on "no token was minted" specifically so that first-time members (who get the full ceremony via `clubs.onboard`) don't ALSO get a redundant notification. The ceremony IS the welcome moment for first-timers.

### 8.3. Atomicity

Both notification inserts happen **inside the same transaction** as the state transition. If either insert fails, the whole `setStatus` call rolls back and the membership stays in `submitted`. This is non-negotiable for two reasons:

1. **No silent loss.** If we transitioned the state but failed to insert the notification, the new member would be functionally admitted with no welcome moment and no signal. Worse: the sponsor would never know. We need the notification fanout to be guaranteed-or-not-at-all.
2. **No phantom notifications.** If we inserted the notification but failed to transition, the sponsor would see "your invitee was approved into CatClub" on their queue while the membership is still pending. Confusing and wrong.

The implementation must wrap the transition + token mint + notification inserts in `withTransaction(pool, async (client) => { ... })` and use the same client for every step.

### 8.4. `notifications.acknowledge` extension

The current dispatch-layer check rejects anything not prefixed `synchronicity.`:

```typescript
if (notificationIds.some((id) => !id.startsWith('synchronicity.'))) {
  throw new AppError(422, 'invalid_input', '...');
}
```

This was a temporary "we only have one materialized topic family" guard. **It must be loosened** to admit the new topics. The cleanest invariant is to **invert** the check: derived notifications are the closed set (currently just `application.submitted`), everything else is materialized:

```typescript
const DERIVED_PREFIXES = new Set(['application.']);
if (notificationIds.some((id) => isDerivedKind(id))) {
  throw new AppError(422, 'invalid_input',
    'Derived notifications resolve automatically and cannot be acknowledged');
}
```

The matching filter inside `acknowledgeNotifications` in `src/postgres.ts` (currently checks `kind.startsWith('synchronicity.')`) needs the same inversion. Both sites must change together.

This means future materialized topics added to `member_notifications` are acknowledgeable by default — no per-topic allowlist to maintain. The only thing that's NOT acknowledgeable is anything synthesized from a non-`member_notifications` source (today, just admissions; tomorrow, anything that gets added with a `derived` shape).

### 8.5. How the agent surfaces the new notifications

No new agent action is needed — the existing notification surface handles everything:

- The new rows appear in `notifications.list` ordered FIFO with everything else.
- They piggyback on `sharedContext.notifications` on every authenticated response, so the agent sees them on the very next call without polling.
- They flow through `/stream` as `notification` frames in real time.
- Agents acknowledge them via `notifications.acknowledge` once relayed to the human.

The SKILL.md update (§11) documents what each new topic means and what action the agent should take when surfacing it. There is no new piece of plumbing to learn — agents that already handle notifications will handle these correctly.

---

## 9. API surface changes

### 9.1. New actions

- **`clubs.onboard`** — new. `auth: 'member'`, `safety: 'mutating'`, `requiredCapability: 'onboardMember'`. Input: empty object `{}`. Output: the welcome envelope from §7.1, OR `{alreadyOnboarded: true}`. No business errors beyond the auth/gate errors. Handler: checks `actor.member.onboarded_at`, short-circuits if set, otherwise sets it and composes the welcome from the target club's template (or default). **Target-club selection rule (pinned): the oldest `active` membership at the moment `clubs.onboard` runs, ordered by `joined_at ASC`.** Query `accessible_club_memberships` for the calling member, order by `joined_at ASC`, take the first row. `joined_at` is the correct field because the existing immutability trigger (`db/init.sql:298`) sets it exactly once — at the `applying → active` transition — and then forbids further changes, which is precisely "when was this membership first active." No schema change needed. The rule is deterministic, consistent with the "first club they were admitted to" intuition, and uses a field that already appears on the view at `db/init.sql:731`. Edge case: if the member has zero active memberships at onboard time (which should be impossible if the flow is wired correctly, because the token was minted by `setStatus(active)` for at least one membership), return `{alreadyOnboarded: false, orphaned: true}` and log a server warning — do NOT hard-error, because a hard error would lock the member out entirely. Edge case: if the member has multiple simultaneous first-time admissions (the concurrency race from §14), the oldest-first rule picks one deterministically and the others appear as `membership.activated` notifications per §8.

- **`clubadmin.accessTokens.create`** — new. `auth: 'clubadmin'`, `safety: 'mutating'`, scoped to the admin's clubs. Mirrors the existing `superadmin.accessTokens.create` action shape. Input: `{ clubId, memberId, reason? }`. Output: `{ token: {...}, bearerToken: "cc_live_..." }`. Authorization: the target member must have at least one active membership in a club the caller is an admin of. This is the recovery path for members who lost their bearer token *after* onboarding — a club admin can mint a fresh token for a member of their own club without superadmin escalation. The existing `superadmin.accessTokens.create` stays as the ultimate fallback for cross-club recovery.

### 9.2. Modified actions

- **`clubs.join`** — response no longer contains `memberToken`. Response gains `applicationKey: string | null` (null for cross-joiners, present for tokenless applicants). No other field changes. Existing `proof` and `club` blocks unchanged.
- **`clubs.applications.submit`** — input gains optional `applicationKey`. Auth path: bearer in header wins if present, else application key in input, else 401. Behavior otherwise unchanged.
- **`clubs.applications.get`** — same input/auth change as submit.
- **`clubadmin.memberships.setStatus`** — when the transition target results in an `active` membership AND the target member has zero active bearer tokens, the response envelope gains `accessToken: "cc_live_..."` (plaintext, exactly once) AND `accessTokenIssuedAt`. Otherwise those fields are omitted. The action description in the schema must make it unambiguous that `accessToken` is shown exactly once, must be delivered to the applicant now, and cannot be retrieved later. **Lost-response recovery:** if the admin loses the response (closes tab, network error after the server commits, tool-call output cleared before they copy it), the token row is still committed in `member_bearer_tokens` but the plaintext is unrecoverable. The recovery path is to call `clubadmin.accessTokens.create` for the same member (which mints a fresh token AND atomically sets `onboarded_at` per §5.5) and deliver the new plaintext. The old undelivered token coexists until the admin explicitly revokes it via `accessTokens.revoke` — they should be encouraged to revoke it immediately so stray copies can't be recovered from old logs. This is a documented part of the flow, not an accident. The SKILL.md admin section (§11.1) must mention it.
- **`session.getContext`** — gains an `actor.onboardingPending: boolean` field derived from `actor.member.onboarded_at` (true when NULL, false otherwise). **Explicitly scoped under `actor`**, not a bespoke top-level field — this matches the existing actor-centric shape of `session.getContext` in `src/schemas/session.ts` and the runtime actor resolution in `src/identity/auth.ts`. All other fields are returned in full — the full actor context is available pre-onboarding so the agent can see its member id and any active memberships, and understand what's happening. Nothing is stripped. Note that "active memberships" means `accessible_club_memberships` rows (the existing view that backs actor resolution), so a just-admitted but not-yet-onboarded member will see their one new `active` club populated here exactly as they would post-onboarding — the gate is on what actions they can *call*, not on what their actor shape *contains*.

### 9.3. Removed / deprecated

- The `memberToken` field in the `clubs.join` response is **removed**, not deprecated. No backwards-compatibility shim. Agents re-fetch `/api/schema` on every connection; the field disappears in one migration.
- No other actions are removed.

### 9.4. The onboarding gate in the auth middleware

Locate the current auth middleware (the layer that resolves bearer → actor and runs `requireSuperadmin`/`requireClubAdmin`/etc.). Add the onboarding-gate check immediately after the actor is resolved:

```typescript
if (actor.member && actor.member.onboarded_at === null) {
  const ALLOWED_PRE_ONBOARDING = new Set(['session.getContext', 'clubs.onboard']);
  if (!ALLOWED_PRE_ONBOARDING.has(action)) {
    throw new AppError(403, 'onboarding_required',
      "You have a bearer token but haven't completed onboarding yet. " +
      "Call clubs.onboard to receive your welcome and activate your membership. " +
      "No other action will succeed until this is done."
    );
  }
}
```

The set is defined in ONE place. Adding a new allowed pre-onboarding action means editing one set. Adding a new normal action automatically inherits the gate.

### 9.5. Token rotation for paranoid applicants

Member-scoped bearer token rotation already exists in `src/schemas/platform.ts` as `accessTokens.list`, `accessTokens.create`, and `accessTokens.revoke` — all `auth: 'member'`. This plan adds no new rotation primitives. The welcome copy's "you can rotate your key any time" claim is truthful today. When the welcome copy names the rotation actions explicitly, it should use their real names: call `accessTokens.create` to mint a replacement, then `accessTokens.revoke` to kill the old one. No side-quest, no verification needed — the resolved-questions block in §14 confirms this.

---

## 10. The retry-during-revision story

The 24-hour clock and 6-attempt cap give the applicant a full day and up to six legality attempts. Within a single session, the agent holds the `applicationKey` in memory and submits freely.

**If the session ends mid-retry-loop** — human closes the conversation with pending feedback — the agent loses the application key and cannot continue the retry loop in a fresh conversation. Options:

1. **Resume in the same session.** If the agent host preserves conversation context (claude.ai, ChatGPT), reopen and continue. Key is still in context.
2. **Start over.** Call `clubs.join` again anonymously with the same email → creates a new unrelated membership. Write a fresh application. Submit. The old abandoned `applying` membership ages out and can be declined by admins during review.

This is worse than today's system, which holds a bearer token forever and lets the agent resume indefinitely. But that's the whole point of the redesign — the bearer token is the wrong shape, and the acceptable cost is that mid-loop session loss means starting over. In practice, the legality loop is fast (read feedback, patch the missing answer, resubmit) and rarely spans multiple conversations.

If this turns out to be painful, we can add a resume mechanism later (a one-time recovery code the agent hands the human at apply time). **Deliberately not in this plan.** Simplest thing first.

---

## 11. SKILL.md rewrite

The "How someone joins a club" and "Core behaviors" sections both need meaningful rewrites. Do not patch them — rewrite cleanly so there is exactly ONE way to describe the flow and no vestigial references to `memberToken`, "save memberToken immediately," or similar. **There must be exactly one way to describe onboarding**, no alternate paths. The rewrite must also add an explicit notifications-checking rule, because under this plan notifications carry load-bearing state (sponsor heads-ups, cross-join admissions) that the agent must surface to the human.

### 11.1. Onboarding section — what must change

- Remove every reference to `memberToken` from `clubs.join`.
- Remove the "Anonymous callers must save the returned memberToken immediately" note.
- Remove the "re-call `clubs.join` authenticated with your bearer token" recovery instruction for expired challenges — under the new plan the 24h TTL makes this rarely needed, and when it is needed, the tokenless applicant simply starts over (§10).
- Add a new top-level section, **"How someone activates their membership,"** describing the onboarding ceremony from the agent's POV:
  - The applicant receives a bearer token from a club admin out-of-band.
  - Agent's init protocol: fetch schema, call `session.getContext`. If the response contains `actor.onboardingPending: true`, the next action MUST be `clubs.onboard`, and the agent MUST relay the returned `welcome` block verbatim to the human before calling any other action.
  - Explicit rule: "The server composes the welcome message. Relay it in full. Do not paraphrase. Do not skip the loss warning. Do not shorten the capabilities list. Do not collapse the preamble into a one-liner. This is the moment the club introduces itself to the new member."
  - Explicit rule: "If you call any action other than `session.getContext` or `clubs.onboard` before the member is onboarded, the server will return 403 `onboarding_required`. Read the message literally and recover by calling `clubs.onboard`."
- Update "Apply to join a club" in Core behaviors to mention the two-phase flow: apply now, then onboard when the admin's access key arrives. Explicitly tell the agent that no bearer token is issued before onboarding, and that the `applicationKey` from `clubs.join` is a session-lifetime secret — not something to show to the human.
- Update the failure-mode table for the 24h TTL and 6 attempts.
- Update the club-admin sub-note: new submitted applications still appear as `application.submitted` notifications. Admins now see an `accessToken` field in the `setStatus(active)` response envelope which they MUST deliver to the applicant out-of-band. Include a "how to deliver" hint — "any channel where you can send plain text: phone, text, WhatsApp, Signal, email from your own account, in person. Whatever channel you pick becomes the applicant's natural backup in case they forget to save it."
- Add a note to admins about recovery: "If a member later loses their access key, call `clubadmin.accessTokens.create` with their member id and a reason. Do some human verification first that they are who they say they are."

### 11.2. Notifications section — make it clear agents must check

This is the new rule the SKILL.md must enforce: **notifications are the authoritative surface for knowing about membership admissions (for cross-joiners), sponsorship outcomes (for sponsors), and other events that happen while the agent is not looking.** Today's SKILL.md mentions notifications mostly in the context of synchronicity matches; the rewrite has to expand the framing substantially.

Specific additions to the "Checking for new state" / "Core behaviors" sections:

- **Explicit statement:** "If the human asks 'did my application get accepted?' or 'did Alice get into CatClub after I sponsored her?' or 'what's new?', the first action to call is `notifications.list` (or check `actor.sharedContext.notifications` on any authenticated response you already made). Do not try to infer admission state from `session.getContext` alone — cross-join admissions and sponsor outcomes arrive as notifications."
- **Notification topic vocabulary.** Document the relevant topics the agent will encounter and what they mean:
  - `application.submitted` — *for club admins.* A new application is awaiting review in one of your clubs. Use `clubadmin.memberships.get` with `ref.membershipId` to inspect.
  - `invitation.accepted` — *for sponsors.* Your invitee has been admitted to the club. The payload's `headsUp` field contains a prose message you can relay to the human: "Your invitee Jenny was just approved into DogClub. You might want to send her a welcome DM." This is a call-to-action, not a passive update. The human should be offered the chance to send a DM to the new member via `messages.send`. Acknowledge the notification with `notifications.acknowledge` after relaying OR after the human sends the DM (the agent can choose).
  - `membership.activated` — *for the new member.* You've been admitted to a new club WITHOUT going through the full onboarding ceremony (i.e. you were cross-joining or already onboarded). The payload's `welcome` field contains a lightweight club-specific welcome to relay to the human: greeting, club summary, capabilities for THIS club, closing. Relay it verbatim, just like the full onboarding welcome. Acknowledge after relaying.
  - `synchronicity.*` — *for members.* Recommendation matches. Unchanged from today. Still acknowledgeable.
- **Relay rule:** "For any notification whose payload contains a `welcome`, `headsUp`, or similar prose-bearing field, relay the prose verbatim to the human. These are server-authored messages that carry meaning the agent should not reinterpret. Treat them the same way you treat the `clubs.onboard` welcome payload."
- **Acknowledgement rule:** "Acknowledge materialized notifications (everything except `application.*`) after you have relayed them to the human, via `notifications.acknowledge` with `state: 'processed'`. Derived notifications (`application.submitted`) resolve automatically when the underlying state changes and cannot be acknowledged directly."
- **Piggyback optimization reminder:** "Every authenticated response carries a head of the notification queue in `actor.sharedContext.notifications`. You usually do not need to poll `notifications.list` separately — just inspect the piggyback on responses you already made. Use `notifications.list` only when `actor.sharedContext.notificationsTruncated` is true (the queue exceeded the piggyback cap) or when you need to walk the tail."

### 11.3. What stays

- The init-protocol rules (schema first, session.getContext second).
- The drafting rule (answer the admission policy as a literal checklist).
- The PoW solver snippet.
- The mentions system.
- The content round-trip verification rule.
- The legality gate guidance.
- The DM / messages / activity guidance (unchanged).

### 11.4. Quality bar

After the rewrite, a fresh agent reading SKILL.md should be able to:

1. Cold-apply for a club.
2. Handle the onboarding ceremony on receipt of a bearer token.
3. Understand WHY the token only arrives at admission.
4. Recognize `invitation.accepted` notifications as sponsor call-to-actions and prompt the sponsor to welcome the new member.
5. Recognize `membership.activated` notifications as cross-join welcomes and relay the prose payload to the new member.
6. Know to check notifications first when the human asks about pending admissions or sponsorship outcomes.

If any of those six is unclear, the rewrite isn't done.

---

## 11A. docs/design-decisions.md update scope

`docs/design-decisions.md` is the canonical durable record of ClawClub design decisions. Several sections are now out of date and MUST be rewritten in the same commit as the implementation. The reviewing agent should treat this as part of the ship, not as follow-up work.

### 11A.1. "Membership and trust" section — rewrite substantially

The current section describes the old join flow, the old invitation cap, the old transition semantics, and still implies that bearer tokens come out of `clubs.join`. Replace it with a description that matches the new design:

- State explicitly that **no bearer token is issued at `clubs.join`.** The response returns an `applicationKey` (a capability token held only in the agent's session memory) and a PoW challenge, never a bearer token.
- State explicitly that **bearer tokens are minted exactly once**, at the moment `clubadmin.memberships.setStatus(active)` runs for a member who has no active bearer tokens. The plaintext is returned in the response envelope to the admin exactly once and must be delivered to the applicant out-of-band.
- Describe the **admin-delivery model:** the admin's message to the applicant (via whatever channel the admin chose — WhatsApp, SMS, phone, in person) is both the credential handoff AND the durable backup. "The delivery channel IS the password manager."
- Describe **`members.onboarded_at`** as the server-enforced gate: a member with a bearer token but `onboarded_at IS NULL` can only call `session.getContext` and `clubs.onboard`. Every other action returns 403 `onboarding_required`.
- Describe **`clubs.onboard`** as a single-call activation that runs a server-authored welcome ceremony, relayed verbatim by the agent, and sets `onboarded_at`. Idempotent.
- Describe **the cross-join rule:** members with an existing active bearer token who are admitted to a new club do NOT receive a new token and do NOT run the onboarding ceremony. Their existing token automatically widens scope through `accessible_club_memberships`. They are notified of the new club via a `membership.activated` notification carrying a lightweight club-specific welcome.
- Describe **the sponsor fanout:** when an invitation-backed membership is admitted, the sponsor receives an `invitation.accepted` notification on their personal queue prompting them to welcome the new member via DM.
- Describe **recovery:** lost tokens are re-minted via `clubadmin.accessTokens.create` (club-scoped) or `superadmin.accessTokens.create` (global). A 30-second ask to a club admin is the normal recovery path; admins should do human verification before minting.
- Update the invitation cap reference (current: 3 per sponsor per club, rolling 30-day window — reflects commit `5e5189f` and the subsequent tightening, not the old "10" figure if that is still anywhere in this doc).
- Remove any vestigial reference to `memberToken`.

### 11A.2. "Member notifications" section — additions

Add to the existing list of materialized notification topics:

- `invitation.accepted` — fired to the sponsor when their invited applicant is admitted. Payload includes `newMemberId`, `newMemberPublicName`, `invitationId`, `clubName`, and a prose `headsUp` field for the agent to relay verbatim.
- `membership.activated` — fired to a member when they're admitted to a new club WITHOUT a token mint (cross-join path, or already-onboarded invited cross-joiner). Payload includes `clubId`, `clubName`, `summary`, optional `sponsorMemberId` + `sponsorPublicName`, and a structured `welcome` block for the agent to relay verbatim.

Mention that the `notifications.acknowledge` topic filter has been loosened: instead of only accepting `synchronicity.*`, it now rejects only the derived `application.*` prefix and accepts everything else. Future materialized topics are acknowledgeable by default without touching the acknowledge handler.

### 11A.3. "Current implementation milestones" — additions

Append to the "Already landed" bulleted list (after the migration ships and before the final commit):

- tokenless `clubs.join`: returns an `applicationKey` capability instead of a bearer token
- `clubs.applications.submit` / `.get` accept either a bearer token or an `applicationKey`
- `clubadmin.memberships.setStatus(active)` mints a bearer token when the target member has no active tokens, returning plaintext exactly once in the response envelope under `accessToken`
- `clubs.onboard`: single-call activation ceremony gated by `members.onboarded_at`, idempotent
- server-enforced onboarding gate: members with `onboarded_at IS NULL` are restricted by auth middleware to `session.getContext` and `clubs.onboard`
- `clubadmin.accessTokens.create`: club-scoped lost-token recovery mirroring the existing superadmin action
- `invitation.accepted` and `membership.activated` notification fanout on `setStatus(active)`

### 11A.4. Other sections to touch

- **"Security and permissions"** — add one bullet: "the auth middleware gates a two-action allowlist (`session.getContext`, `clubs.onboard`) for members with `onboarded_at IS NULL`, ensuring no club action can be called before the onboarding ceremony runs."
- **"Agent contract and documentation"** — no changes required. The bootstrap flow (fetch `SKILL.md`, fetch `/api/schema`, connect) is unchanged.
- **"Maintenance rule"** — the existing step ordering is fine. This implementation pass will touch all the things it instructs to touch (design-decisions.md, README if framing changed, SKILL.md, schema snapshot, runbook docs) in a single commit.

### 11A.5. Update rule

All three doc updates (`SKILL.md`, `docs/design-decisions.md`, and any README framing that needs it) land in the same commit as the implementation, per the maintenance rule in `docs/design-decisions.md` itself. Do not ship the code without the docs. The reviewing agent should reject a PR that has one but not the other.

---

## 12. Data model changes

### 12.1. Migration file

Create `db/migrations/NNN_onboarding_gate.sql`. Choose `NNN` as the next unused migration number. Apply via `scripts/migrate.sh`, never directly.

### 12.2. New tables

**`application_keys`** — the per-membership capability token for tokenless applicants.

```
create table public.application_keys (
  id                text primary key,          -- tokenId from buildApplicationKey
  membership_id     text not null references public.club_memberships(id) on delete cascade,
  token_hash        text not null,             -- sha256 of the secret
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz
);
create index application_keys_membership_idx on public.application_keys (membership_id);
create unique index application_keys_active_per_membership
  on public.application_keys (membership_id)
  where revoked_at is null;
```

The partial unique index enforces "at most one unrevoked application key per membership."

### 12.3. Modified tables

**`members`** — add the onboarding flag:

```
alter table public.members
  add column onboarded_at timestamptz;
```

Nullable. NULL means the member has never completed `clubs.onboard`. Non-null means they have.

**`clubs`** — add the future-customization column:

```
alter table public.clubs
  add column welcome_template jsonb;
```

Unused by the first ship. Populate only when per-club customization lands in a later cycle.

### 12.4. Data migration for existing members

All existing members already have bearer tokens (under the old model) and are functionally "onboarded" — they've been using the system. Backfill:

```
update public.members
  set onboarded_at = created_at
  where onboarded_at is null;
```

This ensures no existing member is gated by the new middleware check. Only NEW members created after the deploy will start with `onboarded_at IS NULL` and run through the ceremony.

### 12.5. Data rewrite for in-flight applications at deploy time

Existing `applying` memberships at the moment of deploy were created under the old model and have their old `cc_live_` tokens stored in `member_bearer_tokens`. **Decision: the migration does NOT retroactively revoke old-world tokens for in-flight applications.** Applicants mid-apply continue to use their existing bearer tokens to submit revisions.

To keep the code path coherent without branching, `clubs.applications.submit` accepts either auth mode (bearer or application key). Old-world applicants have no `application_keys` row but authenticate via the existing bearer path. New-world applicants have an `application_keys` row and authenticate via the input field.

For onboarding: old-world members have `onboarded_at` backfilled (§12.4), so their existing tokens are immediately fully functional and the gate does not catch them. Nothing breaks for anyone mid-flight.

### 12.6. Pre-cutover prod queries

Per `CLAUDE.md`'s pre-cutover protocol, run these against production before pushing, to confirm the shapes the migration assumes:

```sql
-- Any active members without tokens? (Expectation: none under current model)
select count(*) from members m
where not exists (
  select 1 from member_bearer_tokens mbt
  where mbt.member_id = m.id and mbt.revoked_at is null
);

-- How many applying memberships will be caught in the transition?
select count(*) from club_memberships where status = 'applying';

-- How many applying memberships have associated bearer tokens?
select count(distinct cm.id)
from club_memberships cm
join member_bearer_tokens mbt on mbt.member_id = cm.member_id and mbt.revoked_at is null
where cm.status = 'applying';
```

If the first query returns anything unexpected, pause and investigate. The backfill plan assumes every active member has a token (which is how the old model works) and the gate's "set onboarded_at = created_at for everyone" logic depends on it.

### 12.7. Migration test requirements

This migration is schema-additive (new column, new table) plus a one-shot backfill UPDATE on `members`. Per `CLAUDE.md`'s data-rewrite migration testing rules, the UPDATE must be tested against synthetic pre-migration data:

1. `git show <current-main>:db/init.sql > /tmp/init_pre.sql`
2. Create a scratch DB, apply `init_pre.sql`
3. INSERT synthetic rows: several `members` rows (some with tokens, some without if the first pre-cutover query shows any), a mix of membership states (applying, submitted, active, declined).
4. Run `scripts/migrate.sh` against the scratch DB.
5. Query the result: `onboarded_at` should be non-null for every existing member; the `application_keys` table should exist and be empty; the `welcome_template` column should exist and be null.

---

## 13. Test plan

All integration tests exercise the full HTTP path through `TestHarness`, real Postgres, real bearer token issuance.

### 13.1. Unit tests

- `src/token.ts`: `buildApplicationKey` / `parseApplicationKey` round-trip and malformed-input rejection.
- `src/clubs/welcome.ts`: the default template correctly substitutes club name and member name. Produces all six fields (greeting, preamble, tokenInstruction, lossWarning, capabilities, closing). `capabilities.length >= 3`.

### 13.2. Integration tests — happy paths

**Cold applicant.**
1. Anonymous `clubs.join` with slug + email → response contains `applicationKey`, no `memberToken`.
2. `clubs.applications.submit` with `applicationKey` in input → succeeds (PoW mocked at difficulty 1).
3. Admin `setStatus(active)` → response contains `accessToken` and `accessTokenIssuedAt`.
4. **Notification fanout check:** Susan's `notifications.list` is empty — no `membership.activated` because the onboarding ceremony covers it.
5. The returned bearer token authenticates `session.getContext` and returns `actor.onboardingPending: true`.
6. Every non-allowlisted action returns 403 `onboarding_required` before onboarding. (This test is the parameterized gate test, §13.4.)
7. `clubs.onboard` returns a full `welcome` block with all required fields.
8. Post-onboarding, the same bearer authenticates normal actions (e.g. `content.create`).
9. Second call to `clubs.onboard` returns `{alreadyOnboarded: true}` with no state change.

**Invited new applicant.**
1. Existing member calls `invitations.issue` (authenticated).
2. Anonymous `clubs.join` with invitation code + email → `applicationKey` present, `proof.kind = 'none'`.
3. `clubs.applications.submit` with `applicationKey`, no nonce → succeeds.
4. Admin approves → `accessToken` in envelope.
5. **Critical negative assertion:** the sponsor does NOT see the `accessToken`. Sponsor's `session.getContext` and all other sponsor-visible API surface contain no trace of it.
6. Invited applicant onboards same as cold path.

**Cross-joining applicant.**
1. Existing member (Alice) calls `clubs.join` authenticated with her bearer → `applicationKey: null`, `proof` block present.
2. Alice calls `clubs.applications.submit` authenticated with her bearer, no `applicationKey` in input → succeeds.
3. Admin approves via `setStatus(active)` → response does NOT contain `accessToken` or `accessTokenIssuedAt`.
4. Alice's existing bearer token now sees the new club in `session.getContext.activeMemberships`.
5. `actor.onboardingPending` remains false throughout for Alice.
6. Alice's `members.onboarded_at` is unchanged by any of this.

### 13.3. Integration tests — negative paths

1. **Expired application key.** Fast-forward past 24h; `clubs.applications.submit` with the key fails with `challenge_expired` or equivalent.
2. **Application key survives `applying → submitted`, revoked on terminal state.** This is a pair of assertions that together lock in the §6.5 lifetime rule:
   - **Positive:** after a successful `clubs.applications.submit` moves the membership to `submitted`, an immediate follow-up `clubs.applications.get` via the same key path still succeeds and returns the submitted state. The key is NOT revoked on submit success.
   - **Negative (terminal revocation):** transition the membership to a terminal state (`declined` via `clubadmin.memberships.setStatus`, or `withdrawn`), then re-attempt `clubs.applications.get` with the key. The key path now returns 401/403 (whichever the dispatch layer uses for revoked keys).
   - **Negative (state-gated resubmit, not auth-gated):** while the key is still valid in the `submitted` window, calling `clubs.applications.submit` again returns a state-transition error, NOT an auth error. The membership state is what prevents double-submission, not the key.
3. **Application key scope isolation.** Issue an app key for membership A; attempt to use it against membership B. Expect 401/403.
4. **Application key cannot authenticate `session.getContext`.** Pass the key as a bearer header → 401. Pass as an input field → returns anonymous context or errors.
5. **Application key cannot authenticate any non-whitelisted action.** Parameterized: for every action in the registry that is not `clubs.applications.submit` / `clubs.applications.get`, attempt with only the app key → expect failure.
6. **Lost-token recovery (already-onboarded member).** Alice has onboarded. An admin calls `clubadmin.accessTokens.create` for her in a club they admin. The minted token authenticates as Alice, not as the admin. Alice's `onboarded_at` is already set and unchanged (`COALESCE` leaves it alone); the minted token is immediately fully functional; no re-onboarding is needed.
7. **Direct-mint recovery sets `onboarded_at` for never-onboarded members.** Bob is a brand-new member row with `onboarded_at IS NULL` and no active bearer tokens (an edge case, but possible via bootstrap scripts or admin provisioning). An admin calls `clubadmin.accessTokens.create` for him. The mint succeeds AND atomically sets `onboarded_at = now()` via `COALESCE`. The returned token is immediately usable for non-allowlisted actions — no `onboarding_required` error. `clubs.onboard` for the same bearer returns `{alreadyOnboarded: true}` without running the ceremony. This is the critical test for §5.5.
8. **Scoping of `clubadmin.accessTokens.create`.** Admin of club A cannot mint tokens for members who have no membership in club A.
9. **Token binding discipline.** The minted token authenticates as the target, not the caller. Test by having the admin be a different member than the target. This is the same security discipline we locked in for `superadmin.accessTokens.create` and must apply here too.
10. **Auth precedence confused-deputy test.** Construct a request to `clubs.applications.submit` with (a) a revoked bearer token in `Authorization` AND (b) a valid `applicationKey` in the input. Expect 401. The invalid bearer must fail fast without silently falling back to the key path. Label the test explicitly as confused-deputy prevention.
11. **Discriminated-union context discipline.** Call `clubs.applications.submit` via the `applicationKey` path (no bearer). Assert at runtime that the handler received `ctx.kind === 'applicationKey'` and `ctx.capability.membershipId === <the expected membership>`. Assert that `ctx` has no `actor` property on this branch (the TypeScript type forbids it, and at runtime the property is simply not set). Companion compile-time check: add a dedicated test file — `test/unit/member_or_application_key_context.test.ts` — that imports the registry types and includes a `ts-expect-error` assertion proving that accessing `ctx.actor.member.id` without first narrowing on `ctx.kind === 'member'` is a type error. The test passes because the type error is expected; it fails if the type error disappears, which is exactly what we want to catch.

### 13.4. The parameterized onboarding gate test

**This is the critical test for the whole design.** It is the only thing that guarantees every current and future action is gated. It MUST be parameterized over the action registry, not hard-coded per action.

Setup:
1. Create a fresh member via `clubs.join` (anonymous) and get them approved through the full flow to the point where they have an `accessToken` in hand.
2. Do NOT call `clubs.onboard`.

Test body:
1. Iterate every action definition in `src/schemas/registry.ts`'s registered actions.
2. For each action not in `{'session.getContext', 'clubs.onboard'}`:
   - Call the action with whatever minimal valid input the schema accepts (the action may reject for other reasons, but the gate should fire first).
   - Assert the response is HTTP 403.
   - Assert the response body `error.code === 'onboarding_required'`.
   - Assert the response body `error.message` contains the string `'clubs.onboard'` (so the agent is told literally what to do).

After onboarding:
1. Call `clubs.onboard` with the same bearer.
2. Assert `members.onboarded_at` is now non-null (via a test-only read helper, or via a subsequent `session.getContext` that no longer has `actor.onboardingPending: true`).
3. Re-run a sample of actions (e.g. `content.create`, `profile.update`, `messages.getInbox`) — they should now pass the gate.

**Why this test matters:** it is impossible for a future developer to add a new action and forget to gate it, because the gate is in middleware and this test iterates the registry. If a new action is added with some accidental bypass, this test catches it.

### 13.5. `clubs.onboard` idempotency test

1. Call `clubs.onboard` once, get the full welcome.
2. Call `clubs.onboard` again, get `{alreadyOnboarded: true}`.
3. Assert `members.onboarded_at` did not change between the two calls.
4. Assert the welcome payload is NOT returned on the second call.

### 13.6. Tuning-change tests

- Exhaust 6 attempts at legality, then the 7th returns `attempts_exhausted`.
- Fast-forward past 24h, confirm `challenge_expired`.
- Confirm revision retries within 24h do NOT re-mine PoW (same nonce accepted).

### 13.7. Manual live-server dry run

Before committing, run a manual end-to-end test against a local dev server, patterned on `/tmp/manual-mint-test.mjs` from the `superadmin.accessTokens.create` work. Hits the real HTTP surface, prints pass/fail per step, exits non-zero on failure. Exercises:

1. Anonymous `clubs.join` → `applicationKey`, no `memberToken`.
2. `clubs.applications.submit` with `applicationKey` → `submitted`.
3. Admin `setStatus(active)` → `accessToken` present in envelope.
4. With the delivered token, call a mutating action BEFORE onboarding → 403 `onboarding_required`.
5. Call `session.getContext` → succeeds with `actor.onboardingPending: true`.
6. Call `clubs.onboard` → welcome payload present.
7. Call the same mutating action AFTER onboarding → succeeds.
8. Call `clubs.onboard` again → `alreadyOnboarded: true`.

Self-contained, takes `OWEN_TOKEN` + `ADMIN_TOKEN` + server base as env vars, runnable by a second agent as a sanity check.

---

## 14. Open questions the implementing agent should raise

Not showstoppers, but flag to Owen before shipping:

1. **Billing-gated members.** If a membership reaches `payment_pending` rather than `active` at admission, is an access token issued at that moment, or only once the billing flow completes? Current plan assumes `active` is the trigger. Confirm billing-pending memberships do NOT trigger minting or the onboarding ceremony.
2. **Multiple simultaneous first admissions.** Concurrency race if two clubs approve the same tokenless member within seconds of each other. The first `setStatus` wins and mints; the second must detect the just-minted token and skip. **Resolution: use `SELECT ... FOR UPDATE` on the target member row inside the `setStatus` transaction before checking active token count.** Serialize around the mint decision. The parameterized test should include a concurrency scenario using `Promise.all` with two simultaneous approvals. Raised here for the implementing agent to verify the lock placement is correct.
3. **Backfill timestamp.** Should `members.onboarded_at` backfill to `created_at` (historical accuracy) or `now()` (simpler)? Plan says `created_at`. Confirm with Owen before running the migration.
4. **Default welcome copy.** Owen will write the actual strings for all three composer functions (`buildOnboardingWelcome`, `buildSecondClubWelcome`, `buildSponsorHeadsUp`). Scaffold with `TODO OWEN:` placeholders and surface them on hand-back.

**Resolved questions (from earlier drafts, now pinned):**

- ~~`clubs.onboard` target-club selection rule when multiple memberships exist.~~ **Pinned to oldest active membership by `joined_at ASC` from `accessible_club_memberships`.** `joined_at` is already exposed on the view (`db/init.sql:731`) and is immutable after the first active transition (`db/init.sql:298`), so it is semantically "first activated at" without any schema change. See §9.1.
- ~~Rotation action existence.~~ **Confirmed present.** `accessTokens.list`, `accessTokens.create`, and `accessTokens.revoke` already exist in `src/schemas/platform.ts` as `auth: 'member'` self-service token management. The welcome copy's "you can rotate your key any time" claim is truthful today. No side-quest needed. If the welcome copy text references rotation explicitly, it should name the action: "`accessTokens.create` to mint a replacement, then `accessTokens.revoke` to kill the old one."
- ~~Direct-mint onboarding semantics.~~ **Pinned: any bearer mint path outside the normal `setStatus(active)` flow MUST atomically set `members.onboarded_at = COALESCE(onboarded_at, now())`.** See §5.5 and §15.

---

## 15. Decision log

For quick reference when the implementing agent needs to know *why* a particular choice was made. Do not undo these without raising them to Owen first.

| Decision | Why |
| --- | --- |
| No bearer token at `clubs.join` | Agents have nowhere durable to store it, humans don't know it exists, and losing it is terminal. Token is structurally misplaced in time. |
| Direct bearer token delivery at admission (not claim code) | The delivery channel becomes the user's natural backup. If they forget to save the token, they scroll back to the admin's message and find it still valid. Claim codes burn this recovery path. Extensive debate; see §2 for the full history. |
| Single-call `clubs.onboard` (not two-stage ritual) | A two-stage dance does not actually enforce anything — a lazy agent can read stage 1 and immediately call stage 2 without pausing. Ritual without enforcement is just complexity. |
| Server-enforced onboarding gate in auth middleware (not SKILL.md-only) | Owen has directly observed agents ignoring SKILL.md guidance. Enforcement must be structural. One middleware check, one parameterized test, impossible to bypass. |
| Gate lives on `members.onboarded_at`, not on membership state | The ceremony is about the TOKEN and the SYSTEM as a whole, not about a specific club. Cross-joiners are naturally exempt. One column, one check. |
| Full `session.getContext` returned pre-onboarding, with `actor.onboardingPending` flag | The agent needs to see member id, pending membership, club name, and the `actor.onboardingPending` signal to understand what to do. Nothing leaks that the admin hasn't already granted. Flag lives under `actor` to match the existing session shape, not as a bespoke top-level field. |
| Allowlist is exactly `session.getContext` + `clubs.onboard` | Minimum surface area for the gate. Any agent that tries anything else gets a clear 403 that tells them what to do. |
| `clubs.onboard` is idempotent | Supports the "re-paste from delivery thread into a fresh agent" recovery scenario. Agent can always defensively call onboard on startup. |
| Admin delivers, not sponsor | (a) Sponsor burden / error risk; (b) a sponsor-delivery code path would have to be torn out when email is eventually added; (c) admin-delivery is neutral to a future email upgrade. |
| 24h challenge TTL, 6 attempts, hard wall | A full day of retry budget matches real human pacing. Hard wall prevents zombies. 6 attempts because each is a paid LLM call. |
| Application key travels in input, not Authorization | Makes it structurally obvious the key is a capability, not an identity. Prevents confusion with bearer tokens. |
| Application key is a session-lifetime capability, not a durable token | Avoids re-introducing "save this forever or lose access." Applicant-side session loss mid-retry means starting over — acceptable trade-off. |
| `welcome_template` JSONB column on `clubs` now, unused | Future per-club customization without a follow-up migration. |
| Cross-joiners get no ceremony | Their existing bearer already widens scope through `accessible_club_memberships`. Ceremony only runs for first-admission. |
| Server composes the welcome copy, agent relays it verbatim | Guarantees consistent premium tone across all agents. Maintainable in one place. Prevents agents from truncating or hallucinating. |
| Generic OSS default copy first, per-club override later | Avoid ClawClub-branding defaults and forcing self-hosters to override immediately. |
| No email transport | Plan deliberately solves without email. Email can be added later as a pure transport replacement for admin-delivery. |
| `clubadmin.accessTokens.create` as clubadmin-scoped recovery | Club admins can self-service lost-token recovery without superadmin escalation. Mirrors superadmin action. |
| Anonymous `clubs.join` stays non-idempotent | The `5e5189f` account-takeover fix stays. Two anonymous joins create two unrelated memberships. |
| `memberToken` removed from `clubs.join` response, no shim | Per `CLAUDE.md` — the API is agent-first, clients re-fetch `/api/schema` every connection, breaking changes propagate immediately. Break once, break right. |
| Server-side notification fanout at `setStatus(active)`, using existing `member_notifications` infrastructure | Avoids inconsistency from agent-composed welcomes for warm/sponsored/cross-join paths. Uses the already-shipped `member_notifications` table, piggyback envelope, `/stream` SSE channel, and `notifications.list`. No new tables, no new actions — just new `topic` strings. |
| `invitation.accepted` fires for sponsor whenever an invitation-backed membership is approved | Acknowledges the sponsorship relationship without putting credential delivery burden on the sponsor. Admin delivers the token (personal, premium), sponsor gets a heads-up to welcome the new member via DM. Two-channel welcome. |
| `membership.activated` fires for the new member only when no token was minted (i.e. cross-join path) | First-time members already get the full `clubs.onboard` ceremony — a second notification would be redundant. The notification exists specifically to give cross-joiners and invited-cross-joiners the "moment of admission" that the ceremony would otherwise provide. |
| Notification fanout is atomic with the state transition and the mint | No silent loss (admitted member with no welcome) and no phantom notifications (sponsor told to welcome someone who isn't actually in yet). Single transaction wrapping transition + mint + notification inserts. |
| `notifications.acknowledge` topic check inverted from allowlist (`synchronicity.*` only) to derived-only blocklist (`application.*` excluded) | Future materialized topics added to `member_notifications` are acknowledgeable by default without per-topic allowlist maintenance. Only the genuinely-derived source (admissions synthesized from `current_admissions`) is rejected. |
| Three welcome composer functions, not one | `buildOnboardingWelcome` (full ceremony for Susan/Jenny), `buildSecondClubWelcome` (cross-join lighter version, no save-token instructions), `buildSponsorHeadsUp` (sponsor heads-up prose). All in `src/clubs/welcome.ts`, all parameterized, all with `TODO OWEN:` scaffolds. Different welcomes for different moments. |
| First-class `auth: 'member_or_application_key'` mode in the registry, paired with a first-class discriminated-union handler context | Bearer-or-key auth is a real auth kind, not a handler detail. Naming it as a registry variant means dispatch, schema endpoint, and public contract all know about it, and any future action can opt in without re-implementing precedence. **And** the handler context is a discriminated union (`kind: 'member' \| 'applicationKey'`) with NO shared `actor` field across branches, so handlers cannot accidentally treat a capability-only caller as an identified member — the compiler rejects `ctx.actor.member.id` on the key branch. Precedence is strict: valid bearer wins; invalid-but-present bearer is 401 with NO fallback to key mode. |
| Application key remains valid through `applying → submitted` transition (not revoked on submit success) | Lets `clubs.applications.get` keep working via the key path within the same session until the 24h TTL or terminal state. Revoking on submit success would make `.get` instantly dead and create an awkward inconsistency. The key is scoped to one specific membership regardless of state, so there is no scope leakage. |
| `actor.onboardingPending` on `session.getContext`, not a top-level field | Matches the existing actor-centric shape of `session.getContext`. Existing session shape has `actor` as the container for caller-specific state, so the onboarding flag goes there alongside `member`, `memberships`, and `globalRoles`. |
| `clubs.onboard` targets oldest active membership by `joined_at ASC` | Deterministic, matches "first club you were admitted to" intuition, requires no new data model. `joined_at` is already on `accessible_club_memberships` and is immutable after the first active transition (enforced by trigger), so it is semantically "first activated at." Multiple-active-membership edge cases are rare and resolved the same way. |
| Direct-mint paths must `COALESCE(onboarded_at, now())` atomically with the mint | Prevents accidental gated users from any mint path outside the normal admission ceremony — `clubadmin.accessTokens.create`, `superadmin.accessTokens.create`, seed data, bootstrap scripts. A member with a bearer token but `onboarded_at IS NULL` is an invalid state except for the narrow in-transaction window inside `setStatus(active)` itself. |
| Member-scoped rotation is NOT a side-quest | `accessTokens.list` / `create` / `revoke` already exist in `src/schemas/platform.ts` as member-auth actions. The welcome copy's "you can rotate your key any time" claim is truthful today. No new action needed. |

---

## 16. Security checklist

A reviewing agent should verify each of these concretely before declaring the work ready. None are theoretical.

1. **The onboarding gate fires on EVERY non-allowlisted action.** The parameterized test in §13.4 is the guarantee. If that test passes, this holds.
2. **The gate allowlist is exactly two entries** (`session.getContext`, `clubs.onboard`) and is defined in ONE place in the codebase. Grep for the allowlist literal after implementation — there should be exactly one definition site.
3. **The bearer token minted by `setStatus(active)` is bound to the target member, not the admin caller.** Same discipline as `superadmin.accessTokens.create`. Test explicitly: admin Mark accepts Susan; Susan's bearer token authenticates as Susan, not as Mark, and does NOT inherit Mark's `globalRoles` (specifically, no `superadmin` role).
4. **No bearer token is ever returned for a membership in non-`active` state.** Gate the `accessToken` branch on the post-transition state being `active`.
5. **Cross-joiners never receive a new token.** The check is strict: if the target member has at least one non-revoked, non-expired bearer token, skip the mint unconditionally.
6. **Application keys are never exposed outside the issuing `clubs.join` response.** Grep the codebase after implementation for any log line, response field, or error message that might include the plaintext. There should be exactly one site that touches the plaintext: the `joinClub` handler's return value.
7. **Application keys are stored only as hashes.** No plaintext columns. No "cache briefly" shortcuts.
8. **Application keys are scope-limited atomically.** `clubs.applications.submit` and `clubs.applications.get` must verify `(keyHash, membershipId)` in a single atomic lookup. An attacker who steals an application key must not be able to use it against any other membership.
9. **`members.onboarded_at` writer set matches §5.5 exactly.** Grep for writes to the column; the complete allowed writer set is: (a) the migration backfill (§12.4), (b) the `clubs.onboard` handler, (c) `clubadmin.accessTokens.create` (via atomic `COALESCE(onboarded_at, now())`), (d) `superadmin.accessTokens.create` (same COALESCE), (e) the defensive COALESCE inside member-scoped `accessTokens.create`, and (f) any seed-data or bootstrap path that inserts directly into `member_bearer_tokens` (e.g. `db/seeds/dev.sql`, self-hosting setup scripts). No other code path may write to `members.onboarded_at`. This list must be kept consistent with §5.5 — if you add a new direct-mint path, it goes on both lists at the same time. The write MUST be in the same transaction as the mint; otherwise an interleaving failure could leave a member with a bearer token but `onboarded_at IS NULL` and silently gate them.
10. **`clubs.onboard` is member-authenticated, NOT unauthenticated.** A call without a valid bearer returns 401, not the welcome payload.
11. **Rate limit on `clubs.onboard`.** Even though it's member-auth'd, don't let a bad actor thrash it. Reasonable per-IP limits.
12. **`clubadmin.accessTokens.create` is scoped to the admin's clubs.** Test: admin of club A cannot mint tokens for members whose only memberships are in club B.
13. **Decline/withdraw revokes application keys.** When a membership leaves `applying` state for any terminal reason, the corresponding `application_keys` row is revoked (set `revoked_at`). Handler-level concern; test it.
14. **The bearer token parser does NOT match the application-key prefix.** `parseBearerToken` must return null for `cc_appkey_...`. Unit test both directions.
15. **The onboarding gate cannot be bypassed via `clubs.join`.** `clubs.join` is `auth: 'optional_member'` today — confirm that an authenticated-but-not-onboarded caller hitting `clubs.join` is blocked by the gate. Current allowlist does not include `clubs.join`, so it should be blocked; confirm by test.
16. **The gate works for superadmins too.** A superadmin with `onboarded_at IS NULL` is still gated. They must onboard before using their role. Seed data / admin provisioning must set `onboarded_at` appropriately for new superadmins.
17. **Race-safe token minting.** If two `setStatus(active)` calls for the same member happen concurrently, only one mints a token. Use row-level locking on the member record during the "check active tokens → mint if none" sequence. Test with a concurrency scenario.
18. **Notification fanout is atomic with the state transition.** The `setStatus(active)` handler wraps state transition + token mint (if needed) + `invitation.accepted` insert (if invitation-backed) + `membership.activated` insert (if no mint) in a single `withTransaction` using one client. Any failure at any step rolls back the whole operation. Test: force an insert failure partway through (e.g. with a mock that throws) and verify the membership state did NOT advance.
19. **`invitation.accepted` goes only to the real sponsor.** The `recipient_member_id` is resolved from `invitations.sponsor_member_id` via the membership's linked invitation. A membership with no invitation never fires this notification. An attacker who forges an invitation relation can't target a fake sponsor because invitations are server-issued with FK integrity. Test: forged or missing invitation → no notification fired.
20. **`membership.activated` goes only to the real new member.** The `recipient_member_id` is the membership's member_id. The notification payload does not leak data from other members or clubs — it's scoped to the one club the member just joined. Test: cross-joiner Alice's notification does NOT leak any data about DogClub in her CatClub welcome.
21. **Notification topic rewrite is strict.** When loosening `notifications.acknowledge`, the check must reject all `application.*` topics (currently just `application.submitted`), not a narrower string match. If the admissions vocabulary grows (e.g. `application.withdrawn` as a future derived kind), the blocklist catches it automatically. Test: attempt to acknowledge an `application.submitted` notification → still rejected with 422.
22. **The acknowledge handler's repository-layer filter is inverted in lockstep with the dispatch-layer check.** The current postgres.ts `acknowledgeNotifications` has its OWN synchronicity-only filter that also needs flipping. Grep after implementation; both sites must agree. If the dispatch layer permits a topic but the repo layer drops it, the ack silently no-ops.
23. **Direct-mint paths set `onboarded_at` atomically.** Every code path that inserts into `member_bearer_tokens` outside the `setStatus(active)` ceremony must update `members.onboarded_at` in the same transaction using `COALESCE(onboarded_at, now())`. Grep after implementation for every `insert into member_bearer_tokens` site and verify there is a corresponding update to `members.onboarded_at` (or that the caller is `setStatus(active)` itself, the one exception). Missing this invariant creates gated users from operational flows and is the single most likely subtle bug in the whole redesign.
24. **Application-key path uses the discriminated-union handler context, not a patched `HandlerContext`.** Per §6.4, auth mode `'member_or_application_key'` handlers take `ctx: MemberOrCapabilityContext`, a discriminated union with `kind: 'member' | 'applicationKey'` and NO shared `actor` field across the branches. The `applicationKey` branch has no `actor` at all — only `ctx.capability.membershipId`. Audit check: there must be no runtime `capabilityOnly: boolean` or equivalent marker hanging off `ActorContext`. If such a marker exists, the refactor has drifted back toward the type lie and should be reworked to use the union. Test: attempt to write a handler body that does `ctx.actor.member.id` without first narrowing on `ctx.kind === 'member'`. It must fail to compile under `npx tsc --noEmit`. This is the compile-time guarantee the design hangs on.
25. **Auth precedence: invalid bearer does NOT fall back to application key.** Test: construct a request with (a) a malformed or revoked bearer in `Authorization` AND (b) a valid application key in the input. Expect 401, not success. The bearer path fails fast and the key path is not tried. Document in test name that this is the confused-deputy prevention.

---

## 17. Rollout plan

### 16.1. Implementation order

1. **Token helpers.** Add `buildApplicationKey`, `parseApplicationKey` to `src/token.ts` with unit tests.
2. **Migration.** Write `NNN_onboarding_gate.sql`. Test against a scratch DB with synthetic pre-migration data (§12.7). Apply via `scripts/migrate.sh`.
3. **Welcome copy module.** Create `src/clubs/welcome.ts` with scaffolded `TODO OWEN:` placeholders.
4. **Repository methods.** Extend the repository interface in `src/contract.ts` with `createApplicationKey`, `verifyApplicationKey`, `markMemberOnboarded`, `getWelcomeTargetForMember`, `createClubAdminAccessToken`. Implement in `src/postgres.ts`.
5. **Auth middleware gate.** Add the onboarding check immediately after actor resolution. Single if-statement with an exact allowlist set. New error code `onboarding_required`.
6. **`session.getContext` update.** Add `actor.onboardingPending` field (scoped under `actor`, not top-level).
7. **`clubs.join` change.** Replace `memberToken` issuance with `applicationKey` issuance in the tokenless branches. Cross-joiners get `applicationKey: null`.
8. **`clubs.applications.submit` / `.get` change.** Accept optional `applicationKey` in input.
9. **`clubadmin.memberships.setStatus` change.** Mint bearer token on `active` transition when target member has no active tokens. Return in envelope.
10. **New actions.** `clubs.onboard` and `clubadmin.accessTokens.create`.
11. **Tuning.** Bump `APPLICATION_CHALLENGE_TTL_MS` and `MAX_APPLICATION_ATTEMPTS`.
12. **SKILL.md rewrite.** Per §11.
12a. **`docs/design-decisions.md` rewrite.** Per §11A. Same commit as the code. Do not ship one without the other.
13. **Integration tests.** Per §13. All must pass.
14. **Live dry run.** Per §13.7.
15. **Pre-cutover prod queries.** Per §12.6.
16. **Commit.** Bump `package.json` patch version in the same commit. **DO NOT push.** Present to Owen for explicit push authorization per the hard rule added to CLAUDE.md after the `9d0d77f` incident.

### 16.2. Deploy

When authorized, push triggers Railway auto-deploy. Monitor production right after:

- Confirm the new `/api/schema` contains `clubs.onboard` and `clubadmin.accessTokens.create`.
- Confirm the new `applicationKey` field appears on `clubs.join`'s response schema and `memberToken` is gone.
- Confirm existing in-flight `applying` memberships still work for their holders (old-world bearer-token path).
- Confirm the pre-onboarding gate is active by deliberately testing with a freshly-created member (use the dev server path or a test account).

### 16.3. If anything breaks

Roll back the server with `git revert` and push. Do NOT attempt to retroactively clean up any application keys or onboarded_at flags. The migration is additive; the data stays. Fix forward.

---

## 18. Not in scope

Explicit anti-scope to prevent the implementing agent from pattern-matching on "while we're here, let's also…":

- **Email transport of any kind.** This plan solves without email. Do NOT add SMTP wiring, Resend integration, notification emails, or magic links.
- **Web-based apply form.** No HTML, no browser-redirect flow, no OAuth-style login.
- **Claim codes / welcome codes / exchange tokens.** Rejected in §2. Do not re-introduce.
- **Two-stage onboarding ceremony.** Rejected in §2.
- **Billing flow changes.** `clubs.billing.startCheckout` is unchanged. Onboarding and minting are orthogonal to billing.
- **Legality gate logic changes.** Only the retry window and attempts cap change.
- **Invitation primitive changes.** Sponsor issues codes the same way. 30-day TTL unchanged. Invitation-backed joins now get an `applicationKey` instead of `memberToken` as a consequence of the general `clubs.join` change.
- **Cross-club scoping rules.** `accessible_club_memberships` view unchanged.
- **`session.getContext` stripping for pre-onboarding callers.** Full context is returned. Confirmed by Owen.
- **Deprecated endpoints left as shims.** Remove `memberToken` from `clubs.join` cleanly. API is agent-first; agents re-fetch schema.

---

## 19. What "done" looks like

- [ ] Migration written, tested against a scratch DB with synthetic pre-migration data, applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated to reflect the target schema (only after the migration is verified).
- [ ] `src/token.ts` helpers added and unit tested.
- [ ] Default welcome copy scaffolded with `TODO OWEN:` markers in `src/clubs/welcome.ts`.
- [ ] Repository methods implemented in `src/contract.ts` and `src/postgres.ts`.
- [ ] Auth middleware onboarding gate in place, inserted at the pinned positions in §5.2 (after actor resolution, before `parseActionInput` / `requireCapability` / `preGate` / legality gate) on both `dispatchAuthenticated` and `dispatchOptionalMember`.
- [ ] `MemberOrCapabilityContext` discriminated-union handler context added to `src/schemas/registry.ts` per §6.4, and `'member_or_application_key'` added to the `ActionAuth` union.
- [ ] `session.getContext` returns `actor.onboardingPending` (scoped under `actor`).
- [ ] `clubs.join`, `clubs.applications.submit`, `clubs.applications.get` updated per §9.
- [ ] `clubadmin.memberships.setStatus` mints and returns `accessToken` per §9.
- [ ] `clubs.onboard` and `clubadmin.accessTokens.create` implemented.
- [ ] Tuning constants bumped.
- [ ] SKILL.md rewritten per §11.
- [ ] `docs/design-decisions.md` updated per §11A — "Membership and trust" rewrite, "Member notifications" additions, "Current implementation milestones" additions, "Security and permissions" bullet. Lands in the same commit as the implementation.
- [ ] Full integration test suite per §13 passes, including the parameterized gate test.
- [ ] Manual live-server dry run per §13.7 passes.
- [ ] Pre-cutover prod queries per §12.6 run, results reviewed, nothing unexpected.
- [ ] `npm run check` passes.
- [ ] `npm run test:all` passes.
- [ ] `package.json` patch version bumped.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit push authorization.

When Owen authorizes, push, then:

- [ ] Confirm `/api/schema` on production reflects the new surface.
- [ ] Smoke test a cold-apply → admin-accept → onboard cycle against production.
- [ ] Confirm existing in-flight applications still work.

Only then is the work complete.
