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
8. **Admin delivers the bearer token out-of-band** via whatever channel they prefer — text, WhatsApp, Signal, phone, in person, email from the admin's own account. **The delivery channel becomes Susan's natural backup:** if she forgets to save the token, she can scroll back to that thread and find it again, still valid. This is the key property that made direct delivery win over claim codes (see §2 and §14).
9. **Susan pastes the token to her agent.** Agent stores it in session context and uses it as its `Authorization: Bearer` credential.
10. **Agent fetches schema and calls `session.getContext`**, per the init protocol. Server resolves the token, sees `actor.member.onboarded_at IS NULL`, and returns the full actor context with an explicit `onboardingPending: true` signal alongside the member and membership info. Full context (id, memberships, club names) is returned pre-onboarding — nothing is stripped.
11. **Agent sees `onboardingPending: true`** and calls `clubs.onboard` (member-authenticated with Susan's new bearer token, no input payload). Server, atomically within one transaction:
    - Verifies `actor.member.onboarded_at IS NULL`.
    - Looks up Susan's active memberships — there is exactly one, DogClub. That is the club being welcomed.
    - Sets `members.onboarded_at = now()` for Susan.
    - Returns the ceremonial welcome payload described in §7.
12. **Agent relays the welcome payload to Susan verbatim**, including the greeting, the token-save instructions, the loss warning, and the list of capabilities.
13. **From this point on, Susan has a normal, fully-activated bearer token.** Her member row has `onboarded_at` set. All subsequent actions work without any further ceremony.

**Why this flow is bulletproof against the lazy-user failure mode.** If Susan ignores the save instructions and later loses her agent's session context, she does **not** need to contact the admin. She goes back to whatever messaging thread the admin used to deliver the token, pastes it to a new agent, the agent calls `session.getContext` → sees `onboarded_at` is already set → proceeds normally. The welcome ceremony does not re-run (idempotent), but she is instantly back in. The delivery thread is the backup.

If she loses BOTH the agent context AND the delivery thread, the recovery path is a 30-second ask to the club admin via `clubadmin.accessTokens.create` (see §8). Even this worst-case is bounded.

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
6. Jenny pastes the token to her agent, runs the same init protocol, sees `onboardingPending: true`, calls `clubs.onboard`, receives the welcome payload. Done.

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
5. Alice's next call to `session.getContext` shows CatClub in her active memberships, because `accessible_club_memberships` is driven by membership state, not by per-club tokens. Her `onboarded_at` is already set from her DogClub admission, so no ceremony triggers — CatClub simply appears in her club list. Clean.

**Rule for minting at `setStatus`:** a new bearer token is minted if and only if the target member has zero active bearer tokens at the moment the membership transitions into `active`. Otherwise the mint is skipped and the response envelope contains no `accessToken` field.

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

**One place: auth middleware.** The check runs in the same dispatch layer that today resolves the bearer, loads the actor, and enforces role gates (`requireSuperadmin`, `requireClubAdmin`, etc.). It is a single conditional:

```typescript
if (actor.member && actor.member.onboarded_at === null) {
  if (action !== 'session.getContext' && action !== 'clubs.onboard') {
    throw new AppError(403, 'onboarding_required', '...');
  }
}
```

No handler changes. Future actions added to the registry inherit the gate automatically. If a developer forgets to gate their new action, the gate is still there because the gate does not live in handlers at all.

### 5.3. Idempotency of `clubs.onboard`

Calling `clubs.onboard` when `members.onboarded_at` is already set is a no-op that returns `{ alreadyOnboarded: true }`. It does NOT re-run the welcome copy. This matters for the "re-paste from delivery thread into a fresh agent" recovery scenario: the agent can safely call `clubs.onboard` as part of an init flow without worrying about duplicate ceremonies.

### 5.4. Why this is simpler than it looks

The earlier claim-code alternative (rejected in §2) enforced the gate structurally — no credential, no actions — but required a whole second secret primitive with its own table, lifecycle, reissue action, and ~200 lines of tests. The onboarding gate replaces all of that with **one column, one middleware check, and one parameterized test.** Net code reduction despite adding a new concept.

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

The application key travels as a **field in the input payload**, not in the Authorization header. This is deliberate: it makes it structurally obvious that the key is a capability, not an identity. Both `clubs.applications.submit` and `clubs.applications.get` gain an optional `applicationKey` input field. The handler picks auth as follows:

1. If the Authorization header is present and resolves to a valid bearer token, use that identity. Ignore `applicationKey` if also present.
2. Else if `applicationKey` is present in the input and hash-matches the target membership, use that capability to authorize the call.
3. Else 401.

### 6.5. Lifecycle

- Issued by `clubs.join` when the resulting membership belongs to a tokenless member (new anonymous join, or new invited join). Returned in the join response as the `applicationKey` field. Null for cross-joiners (authenticated join paths).
- Stored hashed in a new `application_keys` table keyed by `(id, membership_id, token_hash, created_at, expires_at, revoked_at)`.
- Expires at the same moment the PoW challenge does — 24h from creation.
- Revoked when the membership leaves the `applying` state for any reason (success, decline, withdraw, timeout).
- Rate-limited submit attempts: `MAX_APPLICATION_ATTEMPTS = 6` covers this naturally.

### 6.6. Security note

An attacker who steals the application key can submit application revisions for the one targeted membership. They cannot read any other data, cannot impersonate the applicant anywhere else, cannot access any other club. Blast radius: a single pending application. After the application moves out of `applying`, the key is useless. This is an acceptable scope for a capability token.

### 6.7. What the agent tells the human about the application key

**Nothing.** It is a session-lifetime secret. The human does not need to see it, save it, or know it exists. The agent holds it in conversation context for the duration of the submit/retry loop. If the session ends mid-retry-loop, the application cannot be revised further; the human must re-apply from scratch via a new `clubs.join` call. That is an accepted trade-off (§9).

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

`SKILL.md` (see §10) instructs the agent to **relay the `welcome` block verbatim or near-verbatim before doing anything else.** Don't paraphrase. Don't skip the loss warning. Don't shorten the capabilities list. This is the moment the club introduces itself, and it should feel complete.

### 7.3. Generic default + future per-club customization

The default welcome copy lives in a new module `src/clubs/welcome.ts`. It is generic, parameterized by `{ clubName, memberName, admissionPolicyExcerpt? }`, and contains no ClawClub branding or product-marketing copy. Self-hosters inherit clean defaults.

**Future customization.** Add a nullable `welcome_template` column (JSONB) to the `clubs` table. For the first ship this column is added but not yet consumed — `clubs.onboard` reads `clubs.welcome_template` and, if non-null in the future, substitutes custom copy. Adding the column now future-proofs the data model so per-club customization can be added later without another migration.

### 7.4. Tone guidelines for the default copy

- **Firm but not false about token loss.** Strictly speaking, an applicant who loses their token is not locked out forever — an admin can mint a new one via the recovery path. But the *spirit* is urgency. The default copy should say "the only way back in is to contact a club admin and ask them to mint you a new key" rather than any literal "you will never access the club again."
- **Point at the delivery-thread backup explicitly.** This is the single strongest recovery property in the design. Tell the user about it.
- **Invitations to action, not API dumps.** "Ask me to show you who else is in the club," not "You can call `members.searchByFullText`."
- **Five or six capabilities, not twenty.** First-day new members need three things to try first, not a menu.
- **Premium tone.** This is a private club, not a sign-up form. The copy should feel like being welcomed at the door of a members-only establishment.

Owen will write the actual default strings. Implementing agent should scaffold `src/clubs/welcome.ts` with `TODO OWEN:` placeholders and surface them in the hand-back. Tone matters too much to guess.

### 7.5. The `alreadyOnboarded` short-circuit

When `clubs.onboard` is called by a member whose `onboarded_at` is already set, the response is simply:

```
{ alreadyOnboarded: true }
```

No welcome copy, no state change, no error. The agent MAY still present a short "you're already in" message to the user, but it should not re-run the full ceremony. This supports the "re-paste from delivery thread" recovery scenario cleanly: the agent can always call `clubs.onboard` defensively at the start of a fresh session, and if the ceremony has already been done, it's a cheap no-op.

---

## 8. API surface changes

### 8.1. New actions

- **`clubs.onboard`** — new. `auth: 'member'`, `safety: 'mutating'`, `requiredCapability: 'onboardMember'`. Input: empty object `{}`. Output: the welcome envelope from §7.1, OR `{alreadyOnboarded: true}`. No business errors beyond the auth/gate errors. Handler: checks `actor.member.onboarded_at`, short-circuits if set, otherwise sets it and composes the welcome from the target club's template (or default). The target club is inferred from the member's active memberships — if the member has exactly one active membership, that is the welcomed club; if zero or more than one (edge cases), see §13 for how to handle.

- **`clubadmin.accessTokens.create`** — new. `auth: 'clubadmin'`, `safety: 'mutating'`, scoped to the admin's clubs. Mirrors the existing `superadmin.accessTokens.create` action shape. Input: `{ clubId, memberId, reason? }`. Output: `{ token: {...}, bearerToken: "cc_live_..." }`. Authorization: the target member must have at least one active membership in a club the caller is an admin of. This is the recovery path for members who lost their bearer token *after* onboarding — a club admin can mint a fresh token for a member of their own club without superadmin escalation. The existing `superadmin.accessTokens.create` stays as the ultimate fallback for cross-club recovery.

### 8.2. Modified actions

- **`clubs.join`** — response no longer contains `memberToken`. Response gains `applicationKey: string | null` (null for cross-joiners, present for tokenless applicants). No other field changes. Existing `proof` and `club` blocks unchanged.
- **`clubs.applications.submit`** — input gains optional `applicationKey`. Auth path: bearer in header wins if present, else application key in input, else 401. Behavior otherwise unchanged.
- **`clubs.applications.get`** — same input/auth change as submit.
- **`clubadmin.memberships.setStatus`** — when the transition target results in an `active` membership AND the target member has zero active bearer tokens, the response envelope gains `accessToken: "cc_live_..."` (plaintext, exactly once) AND `accessTokenIssuedAt`. Otherwise those fields are omitted. The action description in the schema must make it unambiguous that `accessToken` is shown exactly once, must be delivered to the applicant now, and cannot be retrieved later.
- **`session.getContext`** — gains a top-level `onboardingPending: boolean` field derived from `actor.member.onboarded_at`. All other fields are returned in full — the full actor context is available pre-onboarding so the agent can see the pending membership, the club, and understand what's happening. Nothing is stripped.

### 8.3. Removed / deprecated

- The `memberToken` field in the `clubs.join` response is **removed**, not deprecated. No backwards-compatibility shim. Agents re-fetch `/api/schema` on every connection; the field disappears in one migration.
- No other actions are removed.

### 8.4. The onboarding gate in the auth middleware

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

### 8.5. Token rotation for paranoid applicants

Bearer token rotation via `identity.tokens.create` / `identity.tokens.revoke` already exists (implementing agent should verify the exact action names in the current schema). This plan does not add rotation; it just relies on it existing so the welcome copy's reference to rotation is truthful. If the current schema exposes rotation only to admins and not to members, the implementing agent should add a member-scoped rotation action as a small side-quest — the welcome copy's "you can rotate your key any time" claim must be true.

---

## 9. The retry-during-revision story

The 24-hour clock and 6-attempt cap give the applicant a full day and up to six legality attempts. Within a single session, the agent holds the `applicationKey` in memory and submits freely.

**If the session ends mid-retry-loop** — human closes the conversation with pending feedback — the agent loses the application key and cannot continue the retry loop in a fresh conversation. Options:

1. **Resume in the same session.** If the agent host preserves conversation context (claude.ai, ChatGPT), reopen and continue. Key is still in context.
2. **Start over.** Call `clubs.join` again anonymously with the same email → creates a new unrelated membership. Write a fresh application. Submit. The old abandoned `applying` membership ages out and can be declined by admins during review.

This is worse than today's system, which holds a bearer token forever and lets the agent resume indefinitely. But that's the whole point of the redesign — the bearer token is the wrong shape, and the acceptable cost is that mid-loop session loss means starting over. In practice, the legality loop is fast (read feedback, patch the missing answer, resubmit) and rarely spans multiple conversations.

If this turns out to be painful, we can add a resume mechanism later (a one-time recovery code the agent hands the human at apply time). **Deliberately not in this plan.** Simplest thing first.

---

## 10. SKILL.md rewrite

The "How someone joins a club" and "Core behaviors" sections both need meaningful rewrites. Do not patch them — rewrite cleanly so there is exactly ONE way to describe the flow and no vestigial references to `memberToken`, "save memberToken immediately," or similar. **There must be exactly one way to describe onboarding**, no alternate paths.

### 10.1. What must change

- Remove every reference to `memberToken` from `clubs.join`.
- Remove the "Anonymous callers must save the returned memberToken immediately" note.
- Remove the "re-call `clubs.join` authenticated with your bearer token" recovery instruction for expired challenges — under the new plan the 24h TTL makes this rarely needed, and when it is needed, the tokenless applicant simply starts over (§9).
- Add a new top-level section, **"How someone activates their membership,"** describing the onboarding ceremony from the agent's POV:
  - The applicant receives a bearer token from a club admin out-of-band.
  - Agent's init protocol: fetch schema, call `session.getContext`. If the response contains `onboardingPending: true`, the next action MUST be `clubs.onboard`, and the agent MUST relay the returned `welcome` block verbatim to the human before calling any other action.
  - Explicit rule: "The server composes the welcome message. Relay it in full. Do not paraphrase. Do not skip the loss warning. Do not shorten the capabilities list. Do not collapse the preamble into a one-liner. This is the moment the club introduces itself to the new member."
  - Explicit rule: "If you call any action other than `session.getContext` or `clubs.onboard` before the member is onboarded, the server will return 403 `onboarding_required`. Read the message literally and recover by calling `clubs.onboard`."
- Update "Apply to join a club" in Core behaviors to mention the two-phase flow: apply now, then onboard when the admin's access key arrives. Explicitly tell the agent that no bearer token is issued before onboarding, and that the `applicationKey` from `clubs.join` is a session-lifetime secret — not something to show to the human.
- Update the failure-mode table for the 24h TTL and 6 attempts.
- Update the club-admin sub-note: new submitted applications still appear as `application.submitted` notifications. Admins now see an `accessToken` field in the `setStatus(active)` response envelope which they MUST deliver to the applicant out-of-band. Include a "how to deliver" hint — "any channel where you can send plain text: phone, text, WhatsApp, Signal, email from your own account, in person. Whatever channel you pick becomes the applicant's natural backup in case they forget to save it."
- Add a note to admins about recovery: "If a member later loses their access key, call `clubadmin.accessTokens.create` with their member id and a reason. Do some human verification first that they are who they say they are."

### 10.2. What stays

- The init-protocol rules (schema first, session.getContext second).
- The drafting rule (answer the admission policy as a literal checklist).
- The PoW solver snippet.
- The mentions system.
- The content round-trip verification rule.
- The legality gate guidance.

### 10.3. Quality bar

After the rewrite, a fresh agent reading SKILL.md should be able to (a) cold-apply for a club, (b) handle the onboarding ceremony on receipt of a bearer token, and (c) understand WHY the token only arrives at admission. If any of those three is unclear, the rewrite isn't done.

---

## 11. Data model changes

### 11.1. Migration file

Create `db/migrations/NNN_onboarding_gate.sql`. Choose `NNN` as the next unused migration number. Apply via `scripts/migrate.sh`, never directly.

### 11.2. New tables

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

### 11.3. Modified tables

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

### 11.4. Data migration for existing members

All existing members already have bearer tokens (under the old model) and are functionally "onboarded" — they've been using the system. Backfill:

```
update public.members
  set onboarded_at = created_at
  where onboarded_at is null;
```

This ensures no existing member is gated by the new middleware check. Only NEW members created after the deploy will start with `onboarded_at IS NULL` and run through the ceremony.

### 11.5. Data rewrite for in-flight applications at deploy time

Existing `applying` memberships at the moment of deploy were created under the old model and have their old `cc_live_` tokens stored in `member_bearer_tokens`. **Decision: the migration does NOT retroactively revoke old-world tokens for in-flight applications.** Applicants mid-apply continue to use their existing bearer tokens to submit revisions.

To keep the code path coherent without branching, `clubs.applications.submit` accepts either auth mode (bearer or application key). Old-world applicants have no `application_keys` row but authenticate via the existing bearer path. New-world applicants have an `application_keys` row and authenticate via the input field.

For onboarding: old-world members have `onboarded_at` backfilled (§11.4), so their existing tokens are immediately fully functional and the gate does not catch them. Nothing breaks for anyone mid-flight.

### 11.6. Pre-cutover prod queries

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

### 11.7. Migration test requirements

This migration is schema-additive (new column, new table) plus a one-shot backfill UPDATE on `members`. Per `CLAUDE.md`'s data-rewrite migration testing rules, the UPDATE must be tested against synthetic pre-migration data:

1. `git show <current-main>:db/init.sql > /tmp/init_pre.sql`
2. Create a scratch DB, apply `init_pre.sql`
3. INSERT synthetic rows: several `members` rows (some with tokens, some without if the first pre-cutover query shows any), a mix of membership states (applying, submitted, active, declined).
4. Run `scripts/migrate.sh` against the scratch DB.
5. Query the result: `onboarded_at` should be non-null for every existing member; the `application_keys` table should exist and be empty; the `welcome_template` column should exist and be null.

---

## 12. Test plan

All integration tests exercise the full HTTP path through `TestHarness`, real Postgres, real bearer token issuance.

### 12.1. Unit tests

- `src/token.ts`: `buildApplicationKey` / `parseApplicationKey` round-trip and malformed-input rejection.
- `src/clubs/welcome.ts`: the default template correctly substitutes club name and member name. Produces all six fields (greeting, preamble, tokenInstruction, lossWarning, capabilities, closing). `capabilities.length >= 3`.

### 12.2. Integration tests — happy paths

**Cold applicant.**
1. Anonymous `clubs.join` with slug + email → response contains `applicationKey`, no `memberToken`.
2. `clubs.applications.submit` with `applicationKey` in input → succeeds (PoW mocked at difficulty 1).
3. Admin `setStatus(active)` → response contains `accessToken` and `accessTokenIssuedAt`.
4. The returned bearer token authenticates `session.getContext` and returns `onboardingPending: true`.
5. Every non-allowlisted action returns 403 `onboarding_required` before onboarding. (This test is the parameterized gate test, §12.4.)
6. `clubs.onboard` returns a full `welcome` block with all required fields.
7. Post-onboarding, the same bearer authenticates normal actions (e.g. `content.create`).
8. Second call to `clubs.onboard` returns `{alreadyOnboarded: true}` with no state change.

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
5. `onboardingPending` remains false throughout for Alice.
6. Alice's `members.onboarded_at` is unchanged by any of this.

### 12.3. Integration tests — negative paths

1. **Expired application key.** Fast-forward past 24h; `clubs.applications.submit` with the key fails with `challenge_expired` or equivalent.
2. **Revoked application key.** After application transitions to `submitted`, the key is rejected.
3. **Application key scope isolation.** Issue an app key for membership A; attempt to use it against membership B. Expect 401/403.
4. **Application key cannot authenticate `session.getContext`.** Pass the key as a bearer header → 401. Pass as an input field → returns anonymous context or errors.
5. **Application key cannot authenticate any non-whitelisted action.** Parameterized: for every action in the registry that is not `clubs.applications.submit` / `clubs.applications.get`, attempt with only the app key → expect failure.
6. **Lost-token recovery.** Alice has onboarded. An admin calls `clubadmin.accessTokens.create` for her in a club they admin. The minted token authenticates as Alice, not as the admin. Alice's `onboarded_at` is already set; the minted token is immediately fully functional; no re-onboarding is needed.
7. **Scoping of `clubadmin.accessTokens.create`.** Admin of club A cannot mint tokens for members who have no membership in club A.
8. **Token binding discipline.** The minted token authenticates as the target, not the caller. Test by having the admin be a different member than the target. This is the same security discipline we locked in for `superadmin.accessTokens.create` and must apply here too.

### 12.4. The parameterized onboarding gate test

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
2. Assert `members.onboarded_at` is now non-null (via a test-only read helper, or via a subsequent `session.getContext` that no longer has `onboardingPending: true`).
3. Re-run a sample of actions (e.g. `content.create`, `profile.update`, `messages.getInbox`) — they should now pass the gate.

**Why this test matters:** it is impossible for a future developer to add a new action and forget to gate it, because the gate is in middleware and this test iterates the registry. If a new action is added with some accidental bypass, this test catches it.

### 12.5. `clubs.onboard` idempotency test

1. Call `clubs.onboard` once, get the full welcome.
2. Call `clubs.onboard` again, get `{alreadyOnboarded: true}`.
3. Assert `members.onboarded_at` did not change between the two calls.
4. Assert the welcome payload is NOT returned on the second call.

### 12.6. Tuning-change tests

- Exhaust 6 attempts at legality, then the 7th returns `attempts_exhausted`.
- Fast-forward past 24h, confirm `challenge_expired`.
- Confirm revision retries within 24h do NOT re-mine PoW (same nonce accepted).

### 12.7. Manual live-server dry run

Before committing, run a manual end-to-end test against a local dev server, patterned on `/tmp/manual-mint-test.mjs` from the `superadmin.accessTokens.create` work. Hits the real HTTP surface, prints pass/fail per step, exits non-zero on failure. Exercises:

1. Anonymous `clubs.join` → `applicationKey`, no `memberToken`.
2. `clubs.applications.submit` with `applicationKey` → `submitted`.
3. Admin `setStatus(active)` → `accessToken` present in envelope.
4. With the delivered token, call a mutating action BEFORE onboarding → 403 `onboarding_required`.
5. Call `session.getContext` → succeeds with `onboardingPending: true`.
6. Call `clubs.onboard` → welcome payload present.
7. Call the same mutating action AFTER onboarding → succeeds.
8. Call `clubs.onboard` again → `alreadyOnboarded: true`.

Self-contained, takes `OWEN_TOKEN` + `ADMIN_TOKEN` + server base as env vars, runnable by a second agent as a sanity check.

---

## 13. Open questions the implementing agent should raise

Not showstoppers, but flag to Owen before shipping:

1. **Billing-gated members.** If a membership reaches `payment_pending` rather than `active` at admission, is an access token issued at that moment, or only once the billing flow completes? Current plan assumes `active` is the trigger. Confirm billing-pending memberships do NOT trigger minting or the onboarding ceremony.
2. **Multiple simultaneous first admissions.** What happens if two clubs approve the same tokenless member within seconds of each other? Both `setStatus` calls check "zero active bearer tokens" in a race. The first wins and mints; the second must detect the just-minted token and skip. Handle this with a `SELECT ... FOR UPDATE` on the member row, or equivalent transactional protection. The parameterized test should include a concurrency case.
3. **`clubs.onboard` target club when member has multiple memberships.** If a member somehow arrives at `clubs.onboard` with multiple active memberships (e.g. because of the race in #2, or because an admin manually populated memberships outside the normal flow), which club's welcome do they see? Current plan: the oldest `active` membership. Confirm this is the right choice, or alternative: return all of them in a summary block.
4. **Should `members.onboarded_at` backfill to `created_at` or to `now()`?** Backfill to `created_at` preserves historical accuracy; `now()` is simpler. Plan says `created_at`. Confirm.
5. **Rotation action name.** The welcome copy promises "you can rotate your key any time." Verify the member-scoped rotation action exists. If it does not, add one as a small side-quest.
6. **Default welcome copy.** Owen will write the actual strings. Scaffold with `TODO OWEN:` placeholders and surface them on hand-back.

---

## 14. Decision log

For quick reference when the implementing agent needs to know *why* a particular choice was made. Do not undo these without raising them to Owen first.

| Decision | Why |
| --- | --- |
| No bearer token at `clubs.join` | Agents have nowhere durable to store it, humans don't know it exists, and losing it is terminal. Token is structurally misplaced in time. |
| Direct bearer token delivery at admission (not claim code) | The delivery channel becomes the user's natural backup. If they forget to save the token, they scroll back to the admin's message and find it still valid. Claim codes burn this recovery path. Extensive debate; see §2 for the full history. |
| Single-call `clubs.onboard` (not two-stage ritual) | A two-stage dance does not actually enforce anything — a lazy agent can read stage 1 and immediately call stage 2 without pausing. Ritual without enforcement is just complexity. |
| Server-enforced onboarding gate in auth middleware (not SKILL.md-only) | Owen has directly observed agents ignoring SKILL.md guidance. Enforcement must be structural. One middleware check, one parameterized test, impossible to bypass. |
| Gate lives on `members.onboarded_at`, not on membership state | The ceremony is about the TOKEN and the SYSTEM as a whole, not about a specific club. Cross-joiners are naturally exempt. One column, one check. |
| Full `session.getContext` returned pre-onboarding | The agent needs to see member id, pending membership, club name, and the `onboardingPending` signal to understand what to do. Nothing leaks that the admin hasn't already granted. |
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

---

## 15. Security checklist

A reviewing agent should verify each of these concretely before declaring the work ready. None are theoretical.

1. **The onboarding gate fires on EVERY non-allowlisted action.** The parameterized test in §12.4 is the guarantee. If that test passes, this holds.
2. **The gate allowlist is exactly two entries** (`session.getContext`, `clubs.onboard`) and is defined in ONE place in the codebase. Grep for the allowlist literal after implementation — there should be exactly one definition site.
3. **The bearer token minted by `setStatus(active)` is bound to the target member, not the admin caller.** Same discipline as `superadmin.accessTokens.create`. Test explicitly: admin Mark accepts Susan; Susan's bearer token authenticates as Susan, not as Mark, and does NOT inherit Mark's `globalRoles` (specifically, no `superadmin` role).
4. **No bearer token is ever returned for a membership in non-`active` state.** Gate the `accessToken` branch on the post-transition state being `active`.
5. **Cross-joiners never receive a new token.** The check is strict: if the target member has at least one non-revoked, non-expired bearer token, skip the mint unconditionally.
6. **Application keys are never exposed outside the issuing `clubs.join` response.** Grep the codebase after implementation for any log line, response field, or error message that might include the plaintext. There should be exactly one site that touches the plaintext: the `joinClub` handler's return value.
7. **Application keys are stored only as hashes.** No plaintext columns. No "cache briefly" shortcuts.
8. **Application keys are scope-limited atomically.** `clubs.applications.submit` and `clubs.applications.get` must verify `(keyHash, membershipId)` in a single atomic lookup. An attacker who steals an application key must not be able to use it against any other membership.
9. **`members.onboarded_at` is writable only by `clubs.onboard`.** Grep for writes to the column; there should be exactly two: the migration backfill (§11.4) and the `clubs.onboard` handler.
10. **`clubs.onboard` is member-authenticated, NOT unauthenticated.** A call without a valid bearer returns 401, not the welcome payload.
11. **Rate limit on `clubs.onboard`.** Even though it's member-auth'd, don't let a bad actor thrash it. Reasonable per-IP limits.
12. **`clubadmin.accessTokens.create` is scoped to the admin's clubs.** Test: admin of club A cannot mint tokens for members whose only memberships are in club B.
13. **Decline/withdraw revokes application keys.** When a membership leaves `applying` state for any terminal reason, the corresponding `application_keys` row is revoked (set `revoked_at`). Handler-level concern; test it.
14. **The bearer token parser does NOT match the application-key prefix.** `parseBearerToken` must return null for `cc_appkey_...`. Unit test both directions.
15. **The onboarding gate cannot be bypassed via `clubs.join`.** `clubs.join` is `auth: 'optional_member'` today — confirm that an authenticated-but-not-onboarded caller hitting `clubs.join` is blocked by the gate. Current allowlist does not include `clubs.join`, so it should be blocked; confirm by test.
16. **The gate works for superadmins too.** A superadmin with `onboarded_at IS NULL` is still gated. They must onboard before using their role. Seed data / admin provisioning must set `onboarded_at` appropriately for new superadmins.
17. **Race-safe token minting.** If two `setStatus(active)` calls for the same member happen concurrently, only one mints a token. Use row-level locking on the member record during the "check active tokens → mint if none" sequence. Test with a concurrency scenario.

---

## 16. Rollout plan

### 16.1. Implementation order

1. **Token helpers.** Add `buildApplicationKey`, `parseApplicationKey` to `src/token.ts` with unit tests.
2. **Migration.** Write `NNN_onboarding_gate.sql`. Test against a scratch DB with synthetic pre-migration data (§11.7). Apply via `scripts/migrate.sh`.
3. **Welcome copy module.** Create `src/clubs/welcome.ts` with scaffolded `TODO OWEN:` placeholders.
4. **Repository methods.** Extend the repository interface in `src/contract.ts` with `createApplicationKey`, `verifyApplicationKey`, `markMemberOnboarded`, `getWelcomeTargetForMember`, `createClubAdminAccessToken`. Implement in `src/postgres.ts`.
5. **Auth middleware gate.** Add the onboarding check immediately after actor resolution. Single if-statement with an exact allowlist set. New error code `onboarding_required`.
6. **`session.getContext` update.** Add `onboardingPending` field.
7. **`clubs.join` change.** Replace `memberToken` issuance with `applicationKey` issuance in the tokenless branches. Cross-joiners get `applicationKey: null`.
8. **`clubs.applications.submit` / `.get` change.** Accept optional `applicationKey` in input.
9. **`clubadmin.memberships.setStatus` change.** Mint bearer token on `active` transition when target member has no active tokens. Return in envelope.
10. **New actions.** `clubs.onboard` and `clubadmin.accessTokens.create`.
11. **Tuning.** Bump `APPLICATION_CHALLENGE_TTL_MS` and `MAX_APPLICATION_ATTEMPTS`.
12. **SKILL.md rewrite.** Per §10.
13. **Integration tests.** Per §12. All must pass.
14. **Live dry run.** Per §12.7.
15. **Pre-cutover prod queries.** Per §11.6.
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

## 17. Not in scope

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

## 18. What "done" looks like

- [ ] Migration written, tested against a scratch DB with synthetic pre-migration data, applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated to reflect the target schema (only after the migration is verified).
- [ ] `src/token.ts` helpers added and unit tested.
- [ ] Default welcome copy scaffolded with `TODO OWEN:` markers in `src/clubs/welcome.ts`.
- [ ] Repository methods implemented in `src/contract.ts` and `src/postgres.ts`.
- [ ] Auth middleware onboarding gate in place.
- [ ] `session.getContext` returns `onboardingPending`.
- [ ] `clubs.join`, `clubs.applications.submit`, `clubs.applications.get` updated per §8.
- [ ] `clubadmin.memberships.setStatus` mints and returns `accessToken` per §8.
- [ ] `clubs.onboard` and `clubadmin.accessTokens.create` implemented.
- [ ] Tuning constants bumped.
- [ ] SKILL.md rewritten per §10.
- [ ] Full integration test suite per §12 passes, including the parameterized gate test.
- [ ] Manual live-server dry run per §12.7 passes.
- [ ] Pre-cutover prod queries per §11.6 run, results reviewed, nothing unexpected.
- [ ] `npm run check` passes.
- [ ] `npm run test:all` passes.
- [ ] `package.json` patch version bumped.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit push authorization.

When Owen authorizes, push, then:

- [ ] Confirm `/api/schema` on production reflects the new surface.
- [ ] Smoke test a cold-apply → admin-accept → onboard cycle against production.
- [ ] Confirm existing in-flight applications still work.

Only then is the work complete.
