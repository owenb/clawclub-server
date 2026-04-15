# Agent-first onboarding ceremony

**Status:** planning
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-15

This plan replaces the current pre-approval token flow with a tokenless apply path and a deliberate onboarding ceremony. It is a first-principles redesign, not a patch. The current system is unfit for purpose for humans who are applying to a club — we've just had to manually recover two stuck applicants with emergency superadmin token minting — and this plan explains what to build instead, and why.

The redesign stays fully agent-first. **No email infrastructure is added.** The whole point is that a prestigious private-club UX is achievable with nothing but agents, HTTP, and an out-of-band channel controlled by the club admin. If we later add email as a delivery transport, nothing in this plan changes — email simply replaces "admin texts the bearer token" with "server emails the bearer token." The applicant-side flow is identical.

---

## 1. Background — why the current system is broken

### The bug, as lived by an applicant

An applicant Susan says to her agent: "get me into DogClub." Today the agent:

1. Calls `clubs.join` with her email and the club slug.
2. Receives `memberToken: "cc_live_..."` in the response, plus a PoW challenge, plus the admission policy.
3. Is instructed by `SKILL.md` to "save `memberToken` immediately. Losing it means losing access."
4. Has **nowhere durable to save it.** An agent is usually a conversation, not an application with persistent storage. Options are: ask Susan to paste a 32-character opaque string into a password manager at the very first interaction (jarring UX at a moment when she expected a conversation), or hold it in ephemeral context and lose it when the conversation rolls.
5. Drafts the application, solves the PoW, submits. Status becomes `submitted`.
6. Susan walks away satisfied.
7. A day later, DogClub's admin approves the application. **No signal is sent to Susan.**
8. Susan says to a fresh agent: "did I get into DogClub?" The agent has no token, cannot call `clubs.applications.get`, and there is no unauthenticated status endpoint (correctly — it would leak membership existence). **Dead end.**

The only recovery path is what we just shipped as an emergency: `superadmin.accessTokens.create`, which a superadmin has to manually invoke per lost applicant. This is not a scalable answer — it exists because the system had no better path when the fix was urgent.

### Root cause

The bearer token is issued at the moment it provides the *least* value and has the *highest* loss risk: first contact, pre-approval, when the human doesn't even know a token exists and the agent has no place to put it. It is then expected to survive a long waiting period during which *nobody is actively using it*, and only becomes essential after the human has walked away.

The token is **structurally misplaced in time.** The fix is to delay issuance until the moment the human is actually accepted into a club, and to make that moment a deliberate, ceremonial onboarding handoff rather than a byproduct of a join call.

### Design decisions rejected along the way

For the record, we considered and rejected:

- **Send the token by email at join time.** Rejected — email infrastructure is significant work, and more importantly, many stuck applicants never see the email because they're not expecting one. It also couples the OSS product to an email transport that self-hosters may not want to operate.
- **Send the token by email on approval.** Rejected *for now* — same reasons. The email transport is a feature we may add later, but this plan proves the design works without it first.
- **Short-lived claim link in email.** Rejected — introduces extra infrastructure (link redirection, HTTP-based claim) when the agent-first model only needs a code.
- **Sponsor delivers credentials for invited applicants.** Rejected. The admin always delivers, regardless of whether the applicant was cold or sponsored. Reasons: (a) it puts too much operational burden on sponsors who may get it wrong or simply forget; (b) it creates a dual-delivery code path that would have to be torn out or maintained alongside email when email is eventually added; (c) admin-delivery is *neutral* with respect to a future email upgrade — email simply replaces the admin's manual channel with a server-side channel, and the applicant-side flow is unchanged.
- **Passphrase-based login.** Rejected — relies on human memory, leaks membership existence on probe, and is weaker entropy than a server-generated code.
- **One-time claim code that is exchanged for a bearer token.** Considered and rejected. Earlier revisions of this plan called for a separate `cc_welcome_...` claim code that the admin would deliver and the agent would exchange for a bearer token via `clubs.onboard(claimCode)`. The decisive argument against: a lazy user told to claim-and-save still won't save. And if they lose track of the token after claiming, the claim code is already burned — it can't be redeemed again. Direct token delivery is strictly better because the user's delivery channel (WhatsApp, SMS, phone note, whatever the admin used) becomes their natural backup: if they forget to save the token, they can scroll back to the admin's message and find it again, still valid. The claim code intermediate was adding a footgun without adding real protection — a burned code is a dead end, while a resendable thread is a safety net. **The final design sends the bearer token directly and makes `clubs.onboard` an *activation* call rather than an *exchange* call.** See §3 and §4.

### What we are preserving

- **Agents as the primary API consumers.** This is non-negotiable.
- **No web form.** No browser-based apply flow.
- **No emails.** This plan solves the problem without any new transports.
- **Anonymous `clubs.join` remains non-idempotent.** The account-takeover fix from 5e5189f stays. Two anonymous joins for the same email create two unrelated memberships. This is a feature, not a bug, and this plan does not re-open that attack surface.
- **The agent-first init protocol.** Fetch `/api/schema` first, then `session.getContext`. Unchanged.
- **The legality gate and its retry semantics.** Unchanged except for the tuning in §2.
- **Cross-joining for existing members.** An already-authenticated member who joins another club continues to use their existing bearer token. No new token is issued for cross-joiners — their existing token's scope simply widens through `accessible_club_memberships` when the new membership becomes active. See §3.3.

---

## 2. Locked-in tuning decisions

These are small, pre-decided parameter changes that are part of this plan but separable from the structural redesign:

- `APPLICATION_CHALLENGE_TTL_MS`: **1 hour → 24 hours.** The applicant has a full day to submit and iterate within a single PoW challenge.
- `MAX_APPLICATION_ATTEMPTS`: **5 → 6.** One extra attempt. Not more, because each attempt costs a real LLM call against the legality gate.
- **The 24-hour clock is a hard wall from challenge creation, not a rolling window.** It does not reset on each revision. This prevents zombie applications that drift forever and gives a clear "you have until tomorrow" promise.
- **The PoW solution travels with the membership for the full 24-hour window.** Retries do not re-mine. Only `challenge_expired` (past the 24h wall) or `invalid_proof` (server rejects the nonce) force a re-solve.

---

## 3. The new flow, end-to-end, per applicant type

### 3.1. Cold applicant (Susan)

Susan has never used ClawClub. She says to her agent: "get me into DogClub at dogclub.example.com."

1. **Agent fetches `/api/schema`.** As always.
2. **Agent calls `clubs.join`** anonymously with `clubSlug` and `email`. Server:
   - Creates a new `members` row for Susan, with `onboarded_at` set to NULL.
   - Creates a new `club_memberships` row in state `applying` with `proof_kind = 'pow'`.
   - Creates a PoW challenge with 24h TTL and 6-attempt cap.
   - Generates a new secret: the **application key** (see §4). Stores its hash alongside the membership.
   - **Does NOT issue a bearer token.** This is the core structural change.
   - Returns `{ clubId, membershipId, applicationKey, proof: { kind: 'pow', challengeId, difficulty, expiresAt, maxAttempts }, club: { name, summary, ownerName, admissionPolicy, priceUsd } }`. `memberToken` is gone from the response.
3. **Agent drafts the application** from the admission policy, asks Susan for whatever is needed, solves the PoW.
4. **Agent calls `clubs.applications.submit`** with `membershipId`, `applicationKey`, `nonce`, `name`, `socials`, `application`. Server verifies the application key matches the membership, runs the PoW check, runs the legality gate, transitions to `submitted` (or returns `needs_revision` with feedback and attemptsRemaining).
5. **Agent tells Susan:** "Done. A DogClub admin will review your application and get in touch directly with your access key. When it arrives, paste it to me and I'll walk you through activation."
6. **Susan walks away.** Nothing is stored on her side — no token, no key, nothing. The application key dies with the session and does not need to be preserved.
7. **Admin reviews and approves** via `clubadmin.memberships.setStatus(active)`. Server, atomically within one transaction:
   - Transitions the membership from `submitted` to `active`.
   - Checks whether Susan has any active bearer tokens. **She does not** (this is her first club).
   - Mints a fresh bearer token bound to Susan's member row. `members.onboarded_at` stays NULL — Susan has a token but has not yet completed the ceremony.
   - Returns the plaintext bearer token in the `setStatus` response envelope under a clearly-named field like `accessToken`, exactly once, with an explicit note that it cannot be retrieved again and must be delivered to the applicant now.
8. **Admin delivers the bearer token** to Susan out-of-band: text, WhatsApp, Signal, phone call, in person, email from the admin's own account — any channel the admin prefers. Whatever channel the admin chooses *becomes Susan's natural backup* — if she forgets to save the token, she can scroll back to that thread and find it again, still valid.
9. **Susan pastes the token to her agent** (could be the same conversation from before, could be a fresh one — whatever is natural). Agent stores the token in its session context and treats it as its `Authorization: Bearer` credential going forward.
10. **Agent calls `session.getContext`** first, per the init protocol. Server resolves the token, sees that `actor.member.onboarded_at IS NULL`, and returns a context that includes an explicit `onboardingPending: true` signal alongside the member and membership info.
11. **Agent sees `onboardingPending: true`** and calls `clubs.onboard` (member-authenticated with Susan's new bearer token, no separate secret). Server, atomically within one transaction:
    - Verifies the caller's `member.onboarded_at IS NULL`.
    - Sets `members.onboarded_at = now()` for Susan.
    - Looks up Susan's newly-active membership to find which club she was just admitted to.
    - Returns the ceremonial welcome payload described in §5.
12. **Agent relays the welcome payload to Susan verbatim**, including the greeting, the token-save instruction, the loss warning, and the list of capabilities. Agent tells Susan: "This is the access key you pasted a moment ago — save it in your password manager right now. If you forget, you can always scroll back to the admin's message thread and find it there, still valid."
13. **From this point on, Susan has a normal, fully-activated bearer token.** Her member row has `onboarded_at` set. All subsequent club actions work without any further ceremony.

**Why this is better than the earlier claim-code design:** if Susan is lazy and fails to save the token to a password manager, she is NOT locked out. Her WhatsApp thread with Mark still contains the token. Any fresh agent she talks to in the future can be handed the same token from that thread and will work immediately — `clubs.onboard` is idempotent (second call returns `already_onboarded`), so re-pasting the token just works. Under the earlier claim-code design, the claim code would already be burned and re-using it would fail. **The delivery channel becomes the safety net.**

### 3.2. Invited new applicant (Jenny)

Jenny's friend Amy is already a DogClub member. Amy calls `invitations.issue` and texts Jenny the resulting `cc_inv_...` code.

1. Jenny's agent fetches the schema, calls `clubs.join` **anonymously** with `clubSlug`, `email`, and `invitationCode`. Server:
   - Validates the invitation code.
   - Creates a new `members` row for Jenny, `onboarded_at` NULL.
   - Creates a new `club_memberships` row in state `applying` with `proof_kind = 'invitation'` (no PoW).
   - Generates an application key, stores its hash.
   - Links the membership to the invitation (`invitation_id`) and marks the invitation as used.
   - Returns `{ clubId, membershipId, applicationKey, proof: { kind: 'none' }, club: {...} }`.
2. Agent drafts and submits the application via `clubs.applications.submit` with the application key (no nonce, because invitation-backed joins skip PoW but still go through the legality gate).
3. Jenny walks away.
4. Admin approves via `setStatus(active)`. Server follows the same atomic flow as §3.1: state transitions to `active`, a fresh bearer token is minted for Jenny (because she has no active tokens yet), the plaintext is returned in the `accessToken` field of the response envelope. **The token is returned to the reviewing admin, not the sponsor.** Amy, the sponsor, does not see or handle the token.
5. Admin delivers the bearer token to Jenny out-of-band via whatever channel they prefer.
6. Jenny pastes it to her agent. Agent calls `session.getContext` → sees `onboardingPending: true` → calls `clubs.onboard` → server sets Jenny's `onboarded_at` and returns the welcome payload. Agent relays it. Done.

### 3.3. Cross-joining applicant (Alice)

Alice is already a member of DogClub and wants to join CatClub too.

1. Alice's agent calls `clubs.join` **authenticated** with her existing bearer token, passing `clubSlug: "catclub"`. Server:
   - Recognizes the actor member ID from the Authorization header.
   - Creates a new `club_memberships` row for Alice in CatClub in state `applying`.
   - **Does NOT generate an application key.** Alice already has a real bearer token; the `applicationKey` mechanism exists only for tokenless applicants.
   - Returns `{ clubId, membershipId, applicationKey: null, proof: {...}, club: {...} }`.
2. Agent drafts and submits using Alice's existing bearer token for auth. `clubs.applications.submit` accepts either `applicationKey` in input OR a bearer token in the Authorization header; Alice's path uses the header.
3. Alice walks away.
4. CatClub admin approves via `clubadmin.memberships.setStatus(active)`. Server:
   - Transitions the CatClub membership from `submitted` to `active`.
   - Checks whether Alice has any active bearer tokens. **She does** — her existing DogClub-era token.
   - **Does NOT mint a new token.** There is no delivery needed.
   - Returns the normal response envelope with no `accessToken` field.
5. Alice's next call to `session.getContext` shows CatClub in her active memberships, because `accessible_club_memberships` is driven by membership state, not by a per-club token. Because `members.onboarded_at` is already set from her DogClub admission, no onboarding ceremony is triggered — CatClub simply appears in her club list.

**Rule:** a new bearer token is minted at `setStatus` time if and only if, at the moment the membership transitions into `active`, the target member has zero active (non-revoked, non-expired) bearer tokens. Otherwise the mint is skipped entirely and `setStatus` returns the normal envelope without an `accessToken` field.

---

## 4. Secrets and the onboarding gate

This design introduces **one new secret primitive** (the application key) and **one new per-member flag** (the onboarded-at timestamp). The bearer token itself is unchanged — it's issued the normal way, stored hashed in `member_bearer_tokens`, and delivered to the applicant through whatever out-of-band channel the admin prefers. There is **no separate welcome code / claim code / onboarding secret** — the bearer token *is* the welcome artifact, and onboarding is an activation step rather than a token-for-token exchange.

### 4.1. Application key (`cc_appkey_...`)

**Purpose.** Authenticate `clubs.applications.submit` and `clubs.applications.get` calls for a specific pending application, without issuing a real bearer token. This is the mechanism that lets the cold-applicant agent iterate through `needs_revision` retries within the 24-hour challenge window.

**Shape.** `cc_appkey_<12-char id>_<24-char secret>`, matching the existing `cc_live_` and `cc_inv_` conventions. Add `buildApplicationKey()` and `parseApplicationKey()` helpers in `src/token.ts` alongside the existing builders.

**Scope.** An application key authorizes exactly two actions, and only against the one membership it was bound to:

- `clubs.applications.submit` — only if the `membershipId` in the input matches the membership the key was issued for.
- `clubs.applications.get` — same.

It does **not** authenticate `session.getContext`, does not appear in `accessible_club_memberships`, does not grant any read of other members or content, and is not a bearer token. It is a capability token for one specific row.

**Passing convention.** The application key travels as a **field in the input**, not in the Authorization header. This is deliberate: it makes it structurally obvious that the key is a capability, not an identity. Both `clubs.applications.submit` and `clubs.applications.get` gain an optional `applicationKey` input field. The handler picks auth as follows:

1. If the Authorization header is present and resolves to a valid bearer token, use that identity. Ignore `applicationKey`.
2. Else if `applicationKey` is present in the input and hash-matches the membership, use that capability to authorize the call.
3. Else 401.

**Lifecycle.**

- Issued by `clubs.join` when the resulting membership belongs to a tokenless member (new anonymous join, or new invited join). Returned in the join response as the `applicationKey` field. Null for cross-joiners (authenticated join paths).
- Stored hashed on a new `application_keys` table keyed by (`id`, `membership_id`, `token_hash`, `created_at`, `expires_at`).
- Expires at the same moment the PoW challenge does — 24h from creation. Revoked when the membership leaves the `applying` state (by success, decline, withdraw, or any other terminal).
- Rate-limited submit attempts: the existing `MAX_APPLICATION_ATTEMPTS = 6` covers this naturally.

**Security note.** An attacker who steals the application key can submit application revisions for the one targeted membership. They cannot read any other data, cannot impersonate the applicant anywhere else, cannot access any other club. The blast radius is a single pending application. This is an acceptable scope for a capability token. After the application moves out of `applying` state the key is useless.

**What the agent tells the human about the application key.** Nothing. It is a session-lifetime secret. The human does not need to see it, save it, or know it exists. The agent holds it in conversation context for the duration of the submit/retry loop. If the session ends mid-retry-loop, the application cannot be revised further; that is an accepted trade-off (§7 discusses why).

### 4.2. The onboarding gate (`members.onboarded_at`)

Instead of a second secret primitive, the ceremonial onboarding moment is gated by a single boolean on the member record: `members.onboarded_at`. NULL until the member completes `clubs.onboard` for the first time, set to the current timestamp once they do.

**Why a member-level flag, not a membership-level state.** The ceremony is about the *token* and the *system as a whole*, not about a specific club. Once a member has been welcomed in — had the token-save instructions, the loss warning, and the capabilities explained — that work is done forever. Future club admissions for the same member don't need a second ceremony; their existing token just widens in scope. Putting the flag on the member means cross-joiners are naturally exempt and the check is trivially cheap: one column read during auth.

**Auth middleware effect.** The auth layer gains one new rule: if the bearer-token-holder's `member.onboarded_at IS NULL`, the only actions they are allowed to call are:

- `session.getContext` — so the agent can introspect state and see the pending onboarding.
- `clubs.onboard` — so the agent can complete the ceremony.

Every other action returns 403 `onboarding_required`. This is enforced centrally in the auth middleware, not scattered across individual handlers, so new actions added in the future get the gate automatically. The gate is a single `if` in the handler dispatch.

**What this gives us.** The minted bearer token is *structurally valid* from the moment `setStatus(active)` creates it — it can authenticate calls — but *functionally gated* until the ceremony runs. The human cannot skip the ceremony by pasting the token and immediately trying to post content: the server will respond with `onboarding_required` and the agent will be forced to run `clubs.onboard` first. Conversely, once the ceremony runs, the token becomes fully functional for every action the member is entitled to call.

**`clubs.onboard` idempotency.** Calling `clubs.onboard` when `members.onboarded_at` is already set returns a short `already_onboarded: true` envelope and is a no-op. It does NOT re-run the welcome copy or emit any side effects. This is deliberate: agents that pass the token between sessions can safely re-call `clubs.onboard` at the start of any session without worrying about duplicate welcomes. The welcome ceremony fires exactly once, on the first successful call.

**Delivery channel compromise note.** The bearer token is delivered in the clear through whatever channel the admin chose. Delivery channel compromise — the admin's WhatsApp history is read by an attacker — results in an attacker-controlled bearer token. Mitigation: the welcome copy explicitly tells the applicant that rotating their own key is fine and easy (see §6 for the rotation path), so a paranoid user can swap to a fresh token minutes after onboarding. The applicant's natural backup (the same delivery thread) is also their attack surface — this is a well-understood trade-off for any delivered credential and we accept it. The upside is that forgetting to save the token is now survivable; the downside is delivery-thread compromise. The upside dominates by far.

---

## 5. The welcome payload

This is what `clubs.onboard` returns. It is the heart of the ceremonial moment.

### 5.1. Shape

```
{
  bearerToken: "cc_live_...",
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
    tokenInstruction: "Save this access key in your password manager right now.",
    lossWarning: "If you lose it, the only way back in is to contact a club admin and ask them to mint you a new one — don't let it come to that. Rotating your own key anytime is fine; losing it is not.",
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

### 5.2. Server-authored, not agent-authored

The `welcome` block is composed by the server and relayed by the agent. **This is deliberate.** If each agent composes its own welcome, you get wildly inconsistent quality: some agents will nail it, some will hallucinate capabilities that don't exist, some will dump a one-liner. Putting the copy in the server's response guarantees every new member gets the same premium moment regardless of which agent they use, and makes the copy maintainable in one place.

The agent's instructions (from `SKILL.md`, see §8) are: **relay the `welcome` block verbatim or near-verbatim before doing anything else.** Don't paraphrase it to death. Don't skip the loss warning. Don't shorten the capabilities list. This is the moment the club introduces itself, and it should feel complete.

### 5.3. Generic default + future per-club customization

The default welcome copy lives in a new module `src/clubs/welcome.ts`. It is generic, parameterized by `{ clubName, memberName, admissionPolicyExcerpt? }`, and contains no ClawClub branding or copy that tries to sell the product. Self-hosters inherit clean defaults.

**Future customization.** Add a nullable `welcome_template` column to the `clubs` table (JSONB or TEXT — JSONB lets us carry structured field-level overrides; TEXT is simpler). For the first pass this column is added to the schema but is not yet consumed — `clubs.onboard` reads `clubs.welcome_template` and, if non-null in the future, substitutes custom copy. For the initial ship, every club uses the generic default. Adding the column now future-proofs the data model so the customization UX can be added later without a follow-up migration.

### 5.4. Tone guidelines for the default copy

- **Firm but not false about token loss.** An applicant who loses their token isn't literally locked out forever — an admin can mint a new one via the recovery path. But the *spirit* is urgency to save it, so the copy is written to say "the only way back in is to contact a club admin and ask them to mint you a new one — don't let it come to that" rather than a literal "you will never access the club again."
- **Invitations to action, not an API dump.** "Ask me to show you who else is in the club" not "You can call `members.searchByFullText`."
- **Five or six capabilities, not twenty.** First-day new members need to know three things to try first, not an exhaustive menu.
- **Premium tone.** This is a private club, not a social network sign-up. The copy should feel like being welcomed at the door of a members-only establishment.

Owen will write the actual default strings — tone matters enough that we'd rather get his voice on it than guess.

---

## 6. API surface changes

### 6.1. New or modified actions

- **`clubs.join`** — modified. Response no longer contains `memberToken`. Response gains `applicationKey` (string, nullable — null for cross-joiners, present for tokenless applicants). No other field changes. Existing `proof` and `club` blocks unchanged.
- **`clubs.applications.submit`** — modified. Input gains optional `applicationKey`. Auth path is: bearer token wins if present, else application key, else 401. Behavior is otherwise unchanged.
- **`clubs.applications.get`** — modified. Same input/auth change as submit.
- **`clubs.onboard`** — new. Input `{ welcomeCode }`. Auth: unauthenticated (the welcome code IS the authentication). Output: the welcome payload from §5.1. Response includes a freshly-minted bearer token as one of its fields. Business errors: `invalid_welcome_code` (400), `welcome_code_already_used` (409), `welcome_code_expired` (410), `welcome_code_revoked` (410). Rate limited.
- **`clubadmin.memberships.setStatus`** — modified. When the transition target is `accepted` AND the target member has no active bearer tokens, the response envelope gains a `welcomeCode` field containing the plaintext code plus `welcomeCodeExpiresAt`. Otherwise those fields are omitted. Description and docs in the schema must make it unambiguous that the code is shown exactly once.
- **`clubadmin.welcomeCodes.reissue`** — new. Input `{ clubId, membershipId }`. Auth: clubadmin for the club. Output: `{ welcomeCode, expiresAt }`. Atomically revokes any existing unused welcome code and issues a fresh one. Errors: `not_found` (membership not in this club, or not in `accepted` state), `already_onboarded` (409, the applicant already called `clubs.onboard`).
- **`clubadmin.accessTokens.create`** — new. Mirrors the existing `superadmin.accessTokens.create` action, but scoped to memberships in clubs the admin manages. Input `{ clubId, memberId, reason? }`. Auth: clubadmin for the club. Output: `{ bearerToken, token: {…} }`. This is the recovery path for members who lost their bearer token *after* onboarding — a club admin can mint a fresh token for a member of their own club without superadmin escalation. The existing `superadmin.accessTokens.create` remains as the ultimate fallback for cross-club recovery and emergency use.

### 6.2. Actions removed or deprecated

- The current `memberToken` field in the `clubs.join` response is **removed**, not deprecated. There are no backwards-compatibility shims. Agents re-fetch `/api/schema` on every connection; the field disappears in one migration.
- No other actions are removed.

### 6.3. The agent-held token rotation path

Bearer token rotation already exists via `identity.tokens.create` and `identity.tokens.revoke` (or whatever the existing action names are — the implementing agent should confirm). This plan does not add or change rotation; it just relies on it existing so the welcome copy's "rotating your own key anytime is fine" claim is truthful. Implementing agent: verify that rotation is exposed to members via a non-admin action, and if not, add it as a small side-quest. An applicant who suspects their welcome-code delivery channel was compromised must have a clean self-service path to rotate immediately after onboarding.

---

## 7. The retry-during-revision story, in plain English

The 24-hour clock and 6-attempt cap from §2 give the applicant one full day and up to six legality attempts to get their application right. Within a single session, the agent holds the `applicationKey` in memory and submits freely.

**If the session ends mid-retry-loop** — the human closes the conversation with pending feedback — the agent loses the application key and cannot continue the retry loop in a fresh conversation. The human's options are:

1. **Resume in the same session.** If their agent host preserves conversation context (e.g. claude.ai, ChatGPT), reopen it and continue. Agent still has the key in context.
2. **Start over.** Call `clubs.join` again anonymously with the same email → creates a NEW unrelated membership (remember: anonymous join is deliberately non-idempotent). Write a fresh application. Submit. The old abandoned membership will age out and be cleaned up by admin review — admins can see and decline orphaned `applying` memberships via their normal review flow.

This is worse than the current system, which holds a bearer token forever and lets the agent resume indefinitely. But that's the whole point of the redesign: the bearer token is the wrong shape, and the acceptable cost is that mid-loop session loss means starting over. In practice the legality loop is fast — read feedback, patch the missing answer, resubmit — and rarely spans multiple human-agent conversations.

If this turns out to be painful in practice, we can add a "resume" mechanism later (e.g. a one-time recovery code that the agent hands to the human at apply time and the human re-types to recover the application key). We are deliberately NOT building that in this plan. The simplest possible thing first.

---

## 8. SKILL.md rewrite

The "How someone joins a club" and "Core behaviors" sections both need meaningful rewrites. Do not patch them — rewrite them cleanly so there is exactly ONE way to describe the flow and no vestigial references to `memberToken`, `save memberToken immediately`, or similar. Remember the design principle: *so much is about making sure the agent understands the process. Not confusing it. Not having three ways to do the same thing.*

### 8.1. What has to change

- Remove every reference to `memberToken` from `clubs.join`.
- Remove the "Anonymous callers must save the returned memberToken immediately" note.
- Remove the "re-call `clubs.join` authenticated with your bearer token" recovery instruction for expired challenges — under the new plan the 24-hour TTL makes this recovery path rarely needed, and when it IS needed, the tokenless applicant simply starts over (see §7).
- Add a new top-level section, **"How someone activates their membership"** (or similar), describing the onboarding ceremony from the agent's point of view: the applicant receives a welcome code from a club admin out-of-band, pastes it into a conversation, the agent calls `clubs.onboard`, and the agent relays the `welcome` block to the human verbatim before doing anything else.
- Add an explicit rule in the onboarding section: **"The server composes the welcome message. Relay it in full. Do not paraphrase. Do not skip the loss warning. Do not shorten the capabilities list. This is the moment the club introduces itself to the new member."**
- Update the "Apply to join a club" section under "Core behaviors" to mention the two-phase flow: apply now, then onboard when the admin's welcome code arrives. Explicitly tell the agent that no bearer token is issued before onboarding, and that the `applicationKey` from `clubs.join` is a session-lifetime secret the agent holds internally — not something to show to the human.
- Update the failure mode table to reflect the 24h TTL and 6 attempts.
- Update the "Club admins" sub-note: new submitted applications still appear as `application.submitted` notifications, and admins now see a `welcomeCode` in the `setStatus(accepted)` response envelope which they must deliver to the applicant out-of-band. Include a brief "how to deliver" hint — "any channel where you can send plain text: phone, message, email, in person."

### 8.2. What stays

- The init-protocol rules (fetch schema first, then session.getContext).
- The drafting rule (answer the admission policy as a literal checklist).
- The PoW solver snippet.
- The mentions system.
- The content round-trip verification rule.
- The legality gate guidance.

### 8.3. Quality bar

After the rewrite, a fresh agent reading SKILL.md for the first time should be able to (a) cold-apply for a club, (b) do the onboarding ceremony on receipt of a welcome code, and (c) understand WHY the token only arrives at onboarding. If any of those three is unclear, the rewrite isn't done.

---

## 9. Data model changes

### 9.1. Migration file

Create `db/migrations/NNN_onboarding_ceremony.sql`. Choose `NNN` as the next unused migration number.

### 9.2. New tables

**`application_keys`** — the per-membership capability token for tokenless applicants.

```
create table public.application_keys (
  id                text primary key,          -- tokenId from buildApplicationKey
  membership_id     text not null references public.club_memberships(id) on delete cascade,
  token_hash        text not null,             -- sha256 of the secret
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz                -- set when the membership leaves applying
);
create index application_keys_membership_idx on public.application_keys (membership_id);
create unique index application_keys_active_per_membership
  on public.application_keys (membership_id)
  where revoked_at is null;
```

**`club_welcome_codes`** — the onboarding ceremony codes.

```
create table public.club_welcome_codes (
  id                text primary key,          -- tokenId from buildWelcomeCode
  membership_id     text not null references public.club_memberships(id) on delete cascade,
  member_id         text not null references public.members(id) on delete cascade,
  club_id           text not null references public.clubs(id) on delete cascade,
  token_hash        text not null,
  issued_by_member  text not null references public.members(id),  -- the admin who issued it
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  used_bearer_token text references public.member_bearer_tokens(id),
  revoked_at        timestamptz,
  revoke_reason     text
);
create index welcome_codes_membership_idx on public.club_welcome_codes (membership_id);
create unique index welcome_codes_active_per_membership
  on public.club_welcome_codes (membership_id)
  where used_at is null and revoked_at is null;
```

The partial unique index enforces "at most one unused, unrevoked welcome code per membership" — when an admin reissues, the old code must be marked revoked first, satisfying the uniqueness.

### 9.3. Modified tables

**`clubs`** — add the future-customization column:

```
alter table public.clubs
  add column welcome_template jsonb;
```

Unused by the first ship. Populate only when per-club customization lands in a later cycle.

### 9.4. Dropped columns

None. The existing `member_bearer_tokens` table, `club_memberships` table, `application_pow_challenges` table, and `invitations` table are all unchanged by this migration. The `memberToken` value just stops being generated by the `clubs.join` code path — no schema change is needed for that.

### 9.5. Tuning changes (code-only, not schema)

- `APPLICATION_CHALLENGE_TTL_MS`: 1h → 24h (src/clubs/unified.ts line 22)
- `MAX_APPLICATION_ATTEMPTS`: 5 → 6 (src/clubs/unified.ts line 23)

### 9.6. Data rewrite for in-flight applications at deploy time

Potentially hairy. At the moment the new server code ships to production, existing memberships in `applying` state:

- Were created under the old model and have `memberToken`s stored in `member_bearer_tokens`.
- The old-world tokens are how those applicants authenticate.

**Decision: the migration does NOT retroactively revoke old-world tokens for in-flight applications.** Applicants mid-apply under the old model continue to use their existing `cc_live_` tokens to submit revisions. The new `applicationKey` mechanism applies only to applications started *after* the deploy.

To keep the code path coherent without branching, the `clubs.applications.submit` handler accepts either a bearer token (old or new world) or an `applicationKey` (new world only). Old-world applications have no `applicationKey` row but authenticate via the existing bearer token path. New-world applications have an `applicationKey` row and authenticate via the input field.

For the onboarding ceremony: old-world accepted memberships already have bearer tokens, so the "target member has no active bearer tokens" check naturally skips the welcome-code path. Old-world admins never see a welcome code; everything behaves as before for the already-approved.

**Pre-cutover prod query** — before pushing, run these against production to confirm we understand the shape (see `CLAUDE.md` pre-cutover query protocol):

```sql
-- How many applying memberships will be caught in the transition?
select count(*) from club_memberships where status = 'applying';

-- How many of them have an associated bearer token?
select count(distinct cm.id)
from club_memberships cm
join member_bearer_tokens mbt on mbt.member_id = cm.member_id and mbt.revoked_at is null
where cm.status = 'applying';

-- How many accepted memberships are waiting for bearer-token-issuance?
-- (Expectation: zero under the old model, because accept always required a token existing already)
select count(*) from club_memberships where status = 'accepted';
```

If the third query returns anything unexpected, pause and investigate before cutover.

### 9.7. Migration test requirements

Per `CLAUDE.md`'s data-rewrite migration testing rules, this migration is schema-additive only (new tables + new column, no rewrites), so the standard empty-DB migration test suffices for the schema portion. However:

- Run the migration against a scratch DB that has been pre-seeded with synthetic pre-migration state including (a) applying memberships, (b) accepted memberships, (c) active memberships, (d) in-flight bearer tokens. Confirm the migration applies cleanly and all existing rows are untouched.
- Exercise the new `application_keys` and `club_welcome_codes` insert paths via the integration test suite (see §10), not via raw SQL.

---

## 10. Test plan

### 10.1. Unit tests (`test/unit/`)

- `token.ts`: `buildApplicationKey`, `parseApplicationKey`, `buildWelcomeCode`, `parseWelcomeCode` round-trip correctly. Reject malformed inputs. Produce the expected prefixes.
- `welcome.ts`: the default welcome template substitutes club name and member name correctly. Produces all six fields (greeting, tokenInstruction, lossWarning, capabilities, closing, and any others).

### 10.2. Integration tests (`test/integration/non-llm/`)

All tests exercise the full HTTP path through `TestHarness`.

**Cold applicant happy path.**
- Anonymous `clubs.join` with slug + email → returns `applicationKey`, no `memberToken`.
- `clubs.applications.submit` with `applicationKey` in input → succeeds (PoW mocked at difficulty 1).
- Admin `clubadmin.memberships.setStatus(accepted)` → returns `welcomeCode` and `welcomeCodeExpiresAt`.
- `clubs.onboard(welcomeCode)` → returns `bearerToken` + full `welcome` payload.
- The returned bearer token authenticates as the applicant: `session.getContext` returns the applicant's member and active clubs.
- The onboarded bearer token sees the new club in `activeMemberships`.

**Invited new applicant happy path.**
- Existing member calls `invitations.issue`.
- Anonymous `clubs.join` with invitation code + email → returns `applicationKey`, `proof.kind = 'none'`.
- `clubs.applications.submit` with `applicationKey` → succeeds, no nonce required.
- Admin approves → welcome code issued.
- `clubs.onboard` → bearer token + welcome.
- **Critical:** verify the sponsor does NOT see the welcome code. The sponsor's `session.getContext` and any other API surface expose no trace of the plaintext welcome code.

**Cross-joining applicant happy path.**
- Alice (existing member) calls `clubs.join` authenticated with her bearer → `applicationKey` is null.
- Alice calls `clubs.applications.submit` authenticated with her bearer (no applicationKey in input) → succeeds.
- Admin approves → response envelope does NOT contain `welcomeCode` or `welcomeCodeExpiresAt`.
- Alice's existing bearer token now sees the new club in `session.getContext.activeMemberships`.
- Attempting `clubs.onboard` with any code for Alice's new membership fails — there is no welcome code for cross-joins.

**Security-critical negative tests.**

1. **Application key scope isolation.** Issue an application key for membership A; attempt to use it to submit against membership B. Expect 401/403.
2. **Application key does not authenticate session.getContext.** Attempt `session.getContext` with the application key as a bearer header → 401. Attempt with the key as an input field to session.getContext → 400 (or the key is ignored and the call returns the anonymous shape).
3. **Application key does not authenticate any action other than submit/get.** Exhaustively try one action per domain — e.g. `content.create`, `messages.send`, `profile.update`, `clubs.billing.startCheckout` — with only the application key → all 401.
4. **Application key expiry.** Fast-forward the clock past 24h; submit fails with `challenge_expired` or equivalent and the key is rejected.
5. **Application key revocation on state transition.** After the application transitions to `submitted`, the key no longer authorizes submit (returns the appropriate state-transition error). After `accepted`, the key is gone.
6. **Welcome code one-time use.** Call `clubs.onboard(welcomeCode)` once → success. Call again with the same code → `welcome_code_already_used` (409). The second call does NOT mint a second token.
7. **Welcome code does not leak to non-admins.** Issue a welcome code via admin; attempt to read it from `clubadmin.memberships.get` as a different (non-admin) caller → 403, and the response contains no welcome code even in admin views after issuance (only the issuing `setStatus` response contains the plaintext, exactly once).
8. **Welcome code does not authenticate other actions.** Use the plaintext welcome code as a bearer header → 401. Use it as an `applicationKey` → 401. Use it anywhere but `clubs.onboard` → rejected.
9. **Welcome code expiry.** Issue a code, fast-forward 60 days, call `clubs.onboard` → `welcome_code_expired` (410).
10. **Welcome code revocation on reissue.** Issue code A, call `clubadmin.welcomeCodes.reissue`, verify: (a) old code A is rejected with `welcome_code_revoked`, (b) new code B is accepted on `clubs.onboard`.
11. **`setStatus(accepted)` is idempotent when the member already has a token.** Transition a cross-joiner's membership from applying → accepted → setStatus again → no new welcome code issued, no second token minted.
12. **Rate limiting on `clubs.onboard`.** Hammer the endpoint with invalid codes → after N failures in a short window, subsequent calls are rate limited with `429`.
13. **Cross-membership welcome code cannot onboard against a different member.** Take a valid welcome code for membership A (member A), construct a request that tries to bind the resulting token to member B → impossible by design because `clubs.onboard` takes only the welcome code and the server resolves the membership from it. But test anyway: attempt via every surface you can think of, confirm the token is always bound to the member the welcome code was issued against.
14. **Onboarding a declined membership fails.** Issue a welcome code on accept, then (before onboarding) transition the membership to `declined`. Call `clubs.onboard` → the server rejects because the membership is no longer in `accepted` state. Even though the code itself is valid, the onboarding cannot proceed.
15. **No bearer token is ever minted for an `applying` or `submitted` or `needs_revision` membership.** Explicitly assert this in each state transition test.
16. **The welcome payload is present on successful `clubs.onboard`.** Assert that `welcome.greeting`, `welcome.tokenInstruction`, `welcome.lossWarning`, `welcome.capabilities` (as a non-empty array), and `welcome.closing` are all non-empty strings, and that `capabilities.length >= 3`.
17. **Superadmin scoping is preserved.** A superadmin calling `clubs.onboard` with a valid welcome code receives the token bound to the target member, NOT to the superadmin. This is exactly the pattern we fixed in `superadmin.accessTokens.create`; the same discipline must apply to any token-minting primitive.

**Reissue tests.**

- Happy path reissue: accept → reissue → old code rejected, new code accepted on `clubs.onboard`.
- Reissue rejected for membership not in `accepted` state (still applying, or already active).
- Reissue rejected for membership outside the admin's club scope.
- Reissue after successful onboarding returns `already_onboarded`.

**Tuning-change tests.**

- Retry loop: exhaust 6 attempts at legality, then the 7th returns `attempts_exhausted`.
- Challenge TTL: fast-forward past 24h, confirm `challenge_expired`.
- Confirm that revision retries within the 24h window do NOT re-mine PoW (same nonce accepted through all 6 attempts).

### 10.3. Manual live-server dry run

Before pushing, run a manual end-to-end test against a local dev server covering the cold-applicant flow AND the invited-new-applicant flow. Pattern: like `/tmp/manual-mint-test.mjs` from the superadmin.accessTokens.create work — hit the real HTTP surface, print pass/fail per step, exit non-zero on failure. Exercises:

1. Anonymous `clubs.join` → `applicationKey`, no `memberToken`.
2. `clubs.applications.submit` with `applicationKey` → submitted.
3. Admin `setStatus(accepted)` → `welcomeCode` in envelope.
4. `clubs.onboard(welcomeCode)` → bearer token + welcome payload.
5. Bearer token authenticates as the applicant, sees the club.
6. Second `clubs.onboard` with the same code → 409.

The file should be self-contained, take OWEN_TOKEN + ADMIN_TOKEN + server BASE as env, and be runnable by a second agent as a sanity check.

---

## 11. Rollout plan

### 11.1. Implementation order

1. **Token helpers.** Add `buildApplicationKey`, `parseApplicationKey`, `buildWelcomeCode`, `parseWelcomeCode` to `src/token.ts` with matching unit tests.
2. **Migration.** Write and test the migration against a scratch DB as described in §9.7. Apply via `scripts/migrate.sh`, not directly.
3. **Welcome copy module.** Create `src/clubs/welcome.ts` with the default template and substitution function. Owen to provide the final string content — implementing agent should scaffold with placeholder strings that Owen will replace.
4. **Repository methods.** Extend the repository interface in `src/contract.ts` with `createApplicationKey`, `verifyApplicationKey`, `createWelcomeCode`, `onboardViaWelcomeCode`, `reissueWelcomeCode`, `createClubAdminAccessToken`. Implement in `src/postgres.ts` and wire the single-DB adapter.
5. **Auth path changes.** Extend `clubs.applications.submit` and `clubs.applications.get` handlers to accept either a bearer token or an `applicationKey` field. Ensure the application-key path does NOT leak any identity beyond the targeted membership.
6. **`clubs.join` change.** Replace `memberToken` issuance with `applicationKey` issuance in the tokenless branches. Authenticated cross-joiners get `applicationKey: null`.
7. **`clubadmin.memberships.setStatus` change.** Generate welcome code on `accepted` transition if and only if the target member has no active bearer tokens. Return it in the envelope.
8. **New actions.** Add `clubs.onboard`, `clubadmin.welcomeCodes.reissue`, `clubadmin.accessTokens.create`.
9. **Tuning.** Bump `APPLICATION_CHALLENGE_TTL_MS` and `MAX_APPLICATION_ATTEMPTS`.
10. **SKILL.md rewrite.** Per §8.
11. **Integration tests.** Per §10.2. All tests must pass before proceeding.
12. **Live dry run.** Per §10.3.
13. **Pre-cutover prod queries.** Per §9.6.
14. **Commit + bump `package.json` patch version + present to Owen for push authorization.**

### 11.2. Deploy

**The implementing agent does NOT push to `main`.** Under the hard rule added to `CLAUDE.md` after the 9d0d77f incident, every push requires explicit authorization from Owen for the specific change in front of him. This plan stops at "ready to push" and hands the decision back.

When authorized, push triggers a Railway auto-deploy. Monitor the production API right after deploy:

- Confirm the new `/api/schema` contains `clubs.onboard`.
- Confirm the new `applicationKey` field is in the `clubs.join` response schema.
- Verify existing in-flight `applying` memberships (old world with bearer tokens) still work for their holders.

### 11.3. If anything breaks

Roll back the server with `git revert` and push. Do NOT attempt to retroactively clean up any welcome codes or application keys that were issued under the broken deploy. The migration is additive; the data stays. Fix forward.

---

## 12. Security checklist

A second agent implementing this plan must verify each of these before declaring the work ready. None of them are theoretical — each corresponds to a concrete attack surface.

1. **Application keys are never exposed outside the issuing response.** Grep the codebase after implementation for any log line, response field, or error message that might include the plaintext application key. There should be exactly one site that touches the plaintext: the `clubs.join` handler's return value.
2. **Welcome codes are never exposed outside the issuing admin's `setStatus` response and the `welcomeCodes.reissue` response.** Same grep discipline. Exactly two sites.
3. **Both primitives are stored only as hashes in the database.** No plaintext columns. No "cache the plaintext briefly" shortcuts.
4. **Application keys are scope-limited at the handler level, not just via convention.** The repository methods for `clubs.applications.submit` and `clubs.applications.get` must verify that the application key hash matches BOTH the presented key AND the target membership ID in a single atomic lookup. An attacker who knows one application key must not be able to use it against any other membership.
5. **The `clubs.onboard` handler mints the bearer token atomically with marking the welcome code used.** If the mint fails after the code is marked used, the applicant is locked out. Use a single transaction: lookup welcome code → lock membership row → verify state → mint bearer token → update welcome code (set used_at, used_bearer_token) → commit. Any error anywhere in this sequence rolls back both operations.
6. **The minted bearer token binds to the target member, not to the caller.** This is the same discipline we fixed in `superadmin.accessTokens.create` — the response's bearer token must authenticate as the applicant, not as whoever happened to call `clubs.onboard`. Test #13 in §10.2 covers this.
7. **`clubs.onboard` is rate limited.** Per source IP, and per welcome-code prefix if the infrastructure allows. A naive brute force against the secret space is infeasible (~120 bits), but rate limiting is free insurance and catches mistaken repeated calls during development.
8. **The welcome code cannot be used as a bearer token.** Attempting to pass a `cc_welcome_...` string in the Authorization header must fail as cleanly as any other invalid bearer. The bearer token parser must not match the welcome-code prefix.
9. **The application key cannot be used as a bearer token.** Same as above for `cc_appkey_...`.
10. **Cross-join does not receive a welcome code.** The setStatus gate that checks "target member has no active bearer tokens" must be strict. A single active token — even one expiring later today — is enough to skip welcome code generation.
11. **Admin reissue is scoped to the admin's clubs.** `clubadmin.welcomeCodes.reissue` must reject if the target membership's club is not in the admin's managed set.
12. **No UI/API surface ever shows the plaintext welcome code after issuance.** `clubadmin.memberships.get`, `clubs.applications.get`, `notifications.list`, and every other read path should not contain the plaintext. Only the `setStatus(accepted)` response and the `welcomeCodes.reissue` response carry it.
13. **The onboarding path cannot be called by authenticated users who already have a bearer token.** Consider whether an authenticated member passing a welcome code belonging to someone else can somehow confuse the server. The safest design: `clubs.onboard` ignores the Authorization header entirely and authenticates solely via the welcome code. Decline any call with an Authorization header — return `already_authenticated` (400) or similar. This eliminates a whole class of confusion attacks.
14. **`session.getContext` with an application key in the body returns the anonymous context or rejects.** The application key is NOT an identity and must never be treated as one by any action other than submit/get on its target membership.
15. **Decline/withdraw clears application keys.** When a membership leaves `applying` state for any terminal reason, the corresponding application_key row must be revoked (set `revoked_at`). This is a trigger or a handler-level concern — pick one and test it.
16. **Accept → reissue → accept does not issue two welcome codes.** The partial unique index on `club_welcome_codes (membership_id) where used_at is null and revoked_at is null` enforces this at the database level.

---

## 13. Open questions the implementing agent should raise

Not showstoppers, but decisions worth surfacing to Owen before shipping:

1. **Should `clubs.onboard` accept a `pending` or `interview` transition state alongside `accepted`?** Currently the plan assumes only `accepted → active` runs onboarding. If the membership state machine has intermediate states (e.g. `payment_pending`), decide whether the welcome ceremony runs before or after billing checkout.
2. **Should `clubadmin.accessTokens.create` allow minting for members outside the admin's club?** No — it should be strictly scoped to members whose current memberships include one of the admin's clubs. A club admin should not be able to mint tokens for members of other clubs.
3. **Should the welcome payload include any activity preview?** E.g. "here's what the club has been up to in the last week." Owen mentioned "summary of all posts that you've missed so far" as a capability hint but did NOT say the server should compute it. Current plan: the capabilities list points the agent toward activity summarization, but the server does not compute it. Confirm this is right.
4. **What happens if the membership is `payment_pending` and the admin has already sent the welcome code?** The applicant onboards, gets a bearer token, but the club's payment wall blocks them from actual activity. Decide whether onboarding should refuse if payment is pending, or proceed with the token and let billing flow gate the real access.
5. **Default welcome copy.** Owen has said he'll write the actual strings. Implementing agent should scaffold with clear `TODO OWEN:` placeholders in `src/clubs/welcome.ts` and surface them in the hand-back.

---

## 14. Decision log summary

For quick reference when the implementing agent needs to know *why* a particular choice was made:

| Decision | Why |
| --- | --- |
| No bearer token at `clubs.join` | Agents have nowhere to store it, humans don't know it exists, and losing it is terminal. Structurally misplaced in time. |
| Welcome code, not direct token delivery | Creates a deliberate onboarding ceremony where the server can deliver a rich welcome message — it is an ONBOARDING primitive, not a security one. |
| Admin delivers the welcome code, not the sponsor | Sponsors might forget or get it wrong; sponsor-delivery also creates a code path that would shoot us in the foot if we later add email. Admin-delivery is neutral to a future email upgrade. |
| 24h challenge TTL, 6 attempts, hard wall | A full day of retry budget matches real human pacing; hard wall prevents zombie applications; 6 attempts because each one is a paid LLM call. |
| Application key is a session-lifetime capability, not a durable token | Avoids re-introducing the "save this forever or you lose access" bug. Applicant-side session loss means starting over; acceptable trade-off. |
| Application key travels in the input, not in Authorization | Makes it structurally obvious the key is a capability, not an identity. Prevents confusion with bearer tokens. |
| Welcome code TTL 60 days | Matches the invitation code lifecycle for consistency. |
| One welcome code per membership | Enforced by a partial unique index on the new table. Reissue revokes the old before issuing the new. |
| `welcome_template` JSONB column on `clubs` now, unused | Future per-club customization without a follow-up migration. |
| Cross-joiners get no welcome code | Their existing bearer already widens scope through `accessible_club_memberships`. The ceremony only runs for first-club admission. |
| Server composes the welcome copy, agent relays it | Guarantees consistent premium tone across all agents and keeps copy maintainable in one place. |
| Generic OSS copy first, per-club override later | Avoid ClawClub-branding the default and forcing self-hosters to override immediately. |
| No email transport | This plan proves the design works without email. Email can be added later as a pure transport replacement for admin-delivery. |
| Emergency recovery via `clubadmin.accessTokens.create` | Club admins can self-service lost-token recovery without superadmin escalation. |
| Anonymous `clubs.join` stays non-idempotent | The 5e5189f account-takeover fix stays. Two anonymous joins create two unrelated memberships. |
| No backwards-compatibility shim for `memberToken` | Per CLAUDE.md — the API is agent-first, clients re-fetch `/api/schema` every connection, and breaking changes propagate immediately. Break once, break right. |

---

## 15. Not in scope

Explicit anti-scope to prevent the second agent from pattern-matching on "while we're here, let's also…":

- **Email transport of any kind.** This plan deliberately solves the problem without email. Do not add SMTP wiring, Resend integration, notification emails, or magic links. Email is a future optional upgrade whose groundwork this plan leaves clean (by making admin-delivery the primary path).
- **Web-based apply form.** The whole redesign keeps agent-first as the first-contact protocol. Do not add any HTML form, any browser-redirect flow, any OAuth-style login.
- **Changes to the billing flow.** `clubs.billing.startCheckout` is unchanged. Onboarding at the `accepted` transition is orthogonal to billing; the existing state machine handles `payment_pending` the same way it did before.
- **Changes to the legality gate itself.** No changes to how the gate works, what it checks, or how it returns feedback. Only the retry window and attempts cap change, and those changes are tuning numbers.
- **Changes to the invitation primitive.** Sponsor issues codes the same way, invitation-backed joins still skip PoW, the 30-day invitation TTL is unchanged. The only invitation-related change is that invitation-backed joins now get an `applicationKey` instead of a `memberToken`, which is a consequence of the general `clubs.join` change, not an invitation-specific change.
- **Changes to cross-club scoping rules.** `accessible_club_memberships` view is unchanged. Cross-joiners automatically get scope expansion through the existing mechanism.
- **Changes to `session.getContext`.** The shape stays the same. A tokenless caller during the applying phase simply returns the anonymous context — no special "pending applicant" context is added.
- **Deprecated endpoints left as shims.** No. Remove `memberToken` from `clubs.join` cleanly. The API is agent-first and agents re-fetch the schema.

---

## 16. What "done" looks like

The implementing agent should regard this plan as complete when ALL of the following are true:

- [ ] Migration written, tested against a scratch DB with synthetic pre-migration data, applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated to reflect the target schema (only after the migration is verified).
- [ ] Token helpers implemented and unit tested.
- [ ] Default welcome copy scaffolded with `TODO OWEN:` markers.
- [ ] Repository methods implemented and wired through the single-DB adapter.
- [ ] `clubs.join`, `clubs.applications.submit`, `clubs.applications.get` modified per §6.1.
- [ ] `clubadmin.memberships.setStatus` modified per §6.1.
- [ ] `clubs.onboard`, `clubadmin.welcomeCodes.reissue`, `clubadmin.accessTokens.create` implemented.
- [ ] Tuning constants bumped (`APPLICATION_CHALLENGE_TTL_MS`, `MAX_APPLICATION_ATTEMPTS`).
- [ ] SKILL.md rewritten per §8.
- [ ] Full integration test suite per §10.2 passes.
- [ ] Manual live-server dry run per §10.3 passes.
- [ ] Pre-cutover prod queries per §9.6 run and nothing unexpected.
- [ ] `npm run check` passes (TypeScript).
- [ ] `npm run test:all` passes (unit + db + integration).
- [ ] `package.json` patch version bumped.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit push authorization.

When Owen authorizes, push, then:
- [ ] Confirm `/api/schema` on production reflects the new surface.
- [ ] Smoke test a cold-apply → admin-accept → onboard cycle against production.
- [ ] Confirm existing in-flight applications from before the deploy still work.

Only then is the work complete.
