# Credential redesign (Phase B) — Ed25519 public-key identity

**Status:** mechanism decided, implementation-ready pending Phase A landing
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-16
**Depends on:** Phase A (`plans/onboarding-ceremony.md`) shipping first.

This plan replaces bearer-token authentication with Ed25519-based public-key identity. The applicant's agent generates a keypair locally at `clubs.join`, the public key IS the identity, and admission is a server-side state change rather than a credential handoff. Nothing is ever delivered to the applicant at admission — their agent has had the private key since the moment they said hello.

---

## 1. The problem this phase answers

Today's credential model issues a long-lived bearer token from `clubs.join` at first contact — before the human has been admitted to anything, before they know a token exists, and with no place for the agent to durably store it. This has caused real lock-outs; we have minted emergency tokens via `superadmin.accessTokens.create` for applicants who couldn't hold onto what they never understood they had.

The diagnosis: the credential is structurally misplaced in time. It is issued at the moment it provides least value and has highest loss risk, and becomes essential only after the human has walked away.

The fix: don't issue a reusable secret at all. Let the applicant's agent generate its own credential locally. The server only ever sees a public key.

---

## 2. Why Ed25519 public-key identity

We considered three options during planning: (a) keep bearer tokens and just delay issuance to admission, (b) HMAC-style signed requests, (c) public-key identity.

(a) keeps the worst property — the server still has to *issue a reusable secret* to the applicant somehow, and paid-club Stripe-drives-activation has no admin in the loop at the moment of mint. (b) keeps that same property AND requires the server to retain a recoverable shared secret (not just a hash), which is a security regression from bearer-token hashing. (c) is the only option that dissolves the delivery problem structurally: nothing is delivered because nothing has to be.

Specifically:

- **Delivery problem disappears.** The applicant's agent has the private key from `clubs.join` onward.
- **Paid-club activation works identically to free-club activation.** Billing flips `payment_pending → active` by updating a row; there is no credential to hand off.
- **Credential-at-rest risk goes down.** The server stores public keys only; a DB leak does not yield usable credentials.
- **Replay protection is free.** Every request carries a timestamp in its signed canonical form.

Ed25519 is the right primitive. It is:

- Native in Node (`node:crypto`, `generateKeyPairSync('ed25519')`).
- Native in WebCrypto / SubtleCrypto in browsers, Workers, Deno, Bun.
- Available as a pure-JS fallback via `@noble/ed25519`, so no runtime is blocked.
- Simple, fast, and well-understood — no curve-selection arguments, no RSA key-size hand-wringing.

**Deliberately NOT in scope:**

- **SIWE (Sign-In with Ethereum).** Carries wallet semantics, requires applicants or their agents to hold an on-chain address, overkill for a private club.
- **Full RFC 9421 (HTTP Message Signatures).** The spec is fine; implementing its full surface area is overkill for day one. We use an Ed25519-signed canonical request string instead (§4.2).
- **Passkeys / WebAuthn.** Assume browser runtime with TouchID/YubiKey. Agents are not browsers. Dead end.

---

## 3. What Phase A gave us

Phase A shipped the auth-invariant pieces. None of it needs to change for Phase B:

- `members.onboarded_at` column with two-condition gate.
- `clubs.onboard` ceremony and welcome composers.
- `invitation.accepted` and `membership.activated` notification fanout, hung off the shared transition-to-active seam.
- State-machine validation for `clubadmin.memberships.setStatus`.

Phase B swaps credentials underneath all of that. The ceremony, the fanout, and the gate all still apply. The only change they see is that `actor.member.id` now comes from a verified signature against a stored public key, not a resolved bearer token.

---

## 4. The §2.3 design

### 4.1. `member_authenticators` — multi-authenticator model from day one

One table, one row per (member, credential). A member has at least one authenticator, and can have many — different agents on different devices, a re-enrollment after key loss, or explicit rotation.

```sql
create table public.member_authenticators (
  id              text primary key,               -- `cc_auth_<12-char id>`
  member_id       text not null references public.members(id) on delete cascade,
  alg             text not null check (alg = 'ed25519'),  -- future-proof, single value today
  public_key      bytea not null,                 -- raw 32-byte Ed25519 pubkey
  status          text not null check (status in ('pending_admission', 'active', 'revoked')),
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  label           text,                           -- optional user-facing label, e.g. "claude-web-2026-04"
  created_via     text not null check (created_via in ('clubs.join', 'enroll_from_existing', 're_enrollment_grant', 'seed_bootstrap'))
);
create index member_authenticators_member_idx on public.member_authenticators (member_id);
create unique index member_authenticators_pubkey_idx on public.member_authenticators (public_key);
```

A member row requires at least one authenticator that is either `active` or `pending_admission`. The state transitions are:

- `clubs.join` (new applicant) → insert `pending_admission`.
- `clubadmin.memberships.setStatus(active)` OR billing `payment_pending → active` → flip the applicant's `pending_admission` row to `active`. This is the Phase B analogue of the Phase-A token mint — except nothing is minted, just a state flip.
- Existing member enrolls a new authenticator (a fresh agent on a new device) → insert a new `active` row via `members.enrollAuthenticator` (§4.6).
- Admin-driven recovery for a member with no usable keys → see §4.7.
- Member-initiated revoke → set `revoked_at`, move to `revoked`.

**Why multi-authenticator from day one**: single-pubkey-per-member regresses from today's multi-bearer-token ergonomics. Cheap to design in now, painful to retrofit.

**Key storage detail**: raw 32-byte public keys in `bytea`. Not JWK, not PEM — just the bytes. All encoding happens at the edges.

### 4.2. Canonical request signing

Every authenticated request includes three headers:

- `X-Authenticator-Id: cc_auth_<id>` — tells the server which public key to look up.
- `X-Timestamp: <unix-ms>` — the current time at the client. Server accepts ±5 minutes of clock skew.
- `X-Signature: <base64url(ed25519_signature)>` — the signature itself.

The signed canonical string is the concatenation:

```
{method}\n{path_with_query}\n{timestamp_ms}\n{sha256_hex(body_or_empty_string)}
```

No headers beyond these three are part of the canonical form. The body is hashed once; any intermediary that mutates the body breaks the signature. This is deliberate — request integrity must not depend on trusted proxies.

The server, on a signed-auth request:

1. Parse `X-Authenticator-Id`, `X-Timestamp`, `X-Signature`.
2. Reject if the timestamp is >5 min from server clock.
3. Look up the authenticator row. Reject if missing, `revoked`, or `pending_admission` for an action that requires `active`.
4. Reconstruct the canonical string from the incoming request.
5. Verify the Ed25519 signature against the stored public key.
6. On success, resolve the actor from `member_authenticators.member_id` and update `last_used_at`.

A helper module `src/signed-request.ts` centralizes canonical-string construction and signature verification. A matching client helper in a separate reference package (TS/JS initially, Python to follow) lets self-hosters build compliant agents without reading prose.

### 4.3. Auth modes and precedence

Replace the current auth mode set with:

- `'none'` — unchanged.
- `'optional_member'` — unchanged; signed auth resolves member if present, anonymous if absent.
- `'member'` — requires valid signed auth against an `active` (or, for the two-action allowlist, `pending_admission`) authenticator.
- `'member_pending_or_active'` — new; admits `pending_admission` authenticators. Exactly three actions use it: `session.getContext`, `clubs.onboard`, `clubs.applications.submit` / `.get`.

**Bearer tokens coexist during migration.** A request may present EITHER `X-Signature` headers OR `Authorization: Bearer`, never both. If both are presented, return 401 immediately — no precedence guessing. This is the confused-deputy prevention that matters: a stolen bearer cannot be combined with a stolen-but-revoked signing key to silently become a different caller.

Specifically, the dispatch resolver runs:

1. **If `X-Signature` headers are present AND `Authorization` is present** → 401 `conflicting_auth`. Pick one.
2. **If `X-Signature` headers are present** → verify signature; resolve member from authenticator row. No fallback.
3. **Else if `Authorization: Bearer` is present** → legacy bearer path. Resolve via existing token table. Existing members only — new members never receive bearers.
4. **Else** → anonymous.

### 4.4. Handler context — discriminated union

The handler context for authenticated actions becomes:

```typescript
export type AuthenticatedActorContext = {
  actor: ActorContext;
  authKind: 'signed_request' | 'bearer_legacy';
  authenticatorId?: string;   // present when authKind === 'signed_request'
  bearerTokenId?: string;     // present when authKind === 'bearer_legacy'
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  requireCapability: (capability: RepositoryCapability) => void;
};
```

Handlers usually don't care which auth kind was used. Some will: e.g. `clubadmin.authenticators.createReEnrollmentGrant` (§4.7) should probably not be callable via a legacy bearer if we later deprecate bearers. Handlers that care branch on `ctx.authKind`.

No discriminated union on `actor` itself — under §2.3 the actor is a real member whichever credential they used. The discrimination is on *how* they authenticated.

### 4.5. Per-applicant flows

**Susan (cold applicant).**

1. Agent generates an Ed25519 keypair locally. Stores the private key in session memory.
2. Agent calls `clubs.join` anonymously, passing `clubSlug`, `email`, AND `publicKey: base64url(bytes)`.
3. Server creates a `members` row, a `club_memberships` row in `applying`, a `member_authenticators` row with `status = 'pending_admission'`, and a PoW challenge. Returns `{ clubId, membershipId, authenticatorId, proof, club }`. **No credential in the response.** The applicant's agent already has its private key.
4. Agent drafts the application, solves the PoW, calls `clubs.applications.submit` — signed with the private key, `X-Authenticator-Id` set. The dispatch layer admits `pending_admission` authenticators for this specific action.
5. Susan walks away. Nothing stored on her side — no secret, no key, because she never sees the key. The private key dies with the agent session.
6. Admin approves via `clubadmin.memberships.setStatus(active)`. Server flips the authenticator from `pending_admission` to `active` atomically with the state transition. No notification, no delivery. Phase A's `invitation.accepted` fires if applicable.
7. **When Susan opens a new conversation**, she has no private key — the old agent's session context is gone. The recovery path is re-enrollment (§4.7): admin delivers a one-time re-enrollment grant, Susan's new agent generates a fresh keypair and enrolls it. Susan is now fully active with the new keypair.

This is the single real UX difference from §2.1. Under §2.1 the admin delivers a bearer that Susan can paste into any future agent. Under §2.3 the applicant's agent session itself is the credential holder; re-opening the application in a different agent on a different device requires re-enrollment. **This is acceptable.** See §4.7 for why the re-enrollment path is not a regression.

**Jenny (invited new applicant).** Identical to Susan, plus an `invitationCode` in the `clubs.join` request. Sponsor gets `invitation.accepted` notification on admission.

**Alice (cross-joining existing member).** Alice has already been onboarded; her agent already holds a private key for her existing authenticator. She calls `clubs.join` with her existing signed auth (no `publicKey` needed — she already has authenticators) and the new `clubSlug`. Server creates a CatClub `club_memberships` row in `applying` bound to her existing member_id. The same authenticator authorizes the submit. Admission flips the membership to `active`; `membership.activated` notification fires for Alice.

**Bob (invited cross-joiner).** Same as Alice plus an invitation code. `invitation.accepted` fires for the sponsor; `membership.activated` fires for Bob.

### 4.6. Enrolling additional authenticators

Existing onboarded members adding a new agent / new device.

- **`members.enrollAuthenticator`** — new action. `auth: 'member'`, signed-request only (no bearer, to avoid weird bootstrap cycles). Input: `{ publicKey: base64url(bytes), label?: string }`. Output: `{ authenticatorId, status: 'active' }`. Handler: insert a new authenticator row with `status = 'active'`, `created_via = 'enroll_from_existing'`.

The ergonomics: Alice opens a new agent on a different device. The new agent generates a keypair. Alice's old agent (still holding the previous private key) calls `members.enrollAuthenticator` on behalf of the new agent, passing the new public key. The server records it. The new agent is now a fully independent authenticator for the same member.

**No authentication is delivered between agents.** The new agent has had its private key from birth; all that moves is the public key.

### 4.7. Lost-all-keys recovery — re-enrollment grant

When a member has no private keys accessible to any of their agents. This happens when Susan opens a new agent after admission but has no existing agent to enroll from. It also handles classic lost-device scenarios for onboarded members.

**`clubadmin.authenticators.createReEnrollmentGrant`** — new action. `auth: 'clubadmin'`, `safety: 'mutating'`, scoped to the admin's clubs. Input: `{ memberId, reason? }`. Output: `{ grant: { id, expiresAt, ... }, grantCode: "cc_regrant_..." }`. Server:

1. Verifies the target member has at least one membership in a club the caller administers.
2. Inserts a row in `re_enrollment_grants(id, member_id, code_hash, created_at, expires_at, used_at)` with a 24h TTL and a one-time code.
3. Returns the plaintext code to the admin exactly once. Admin delivers out-of-band.

**`members.enrollAuthenticatorFromGrant`** — new action. `auth: 'none'` (anonymous), takes `{ reEnrollmentCode, publicKey: base64url(bytes), label? }`. Server:

1. Parses the code, looks up the grant by hash. Rejects if expired, used, or missing.
2. Creates a new authenticator row with `status = 'active'`, `created_via = 're_enrollment_grant'`.
3. Marks the grant `used_at = now()`.

Re-enrollment does NOT revoke existing authenticators. That is an independent admin action if compromise is suspected. This matters for the Susan case: if she lost her private key from her old agent because the conversation rolled, her old authenticator is still valid in that agent if it ever reconnects — but no third party has it because no one ever received the private key over the wire.

**Delivery reappears ONLY for recovery**, and the delivery channel is the same out-of-band channel we already accept. This is bounded: an applicant who never loses their private-key agent session never needs any delivery.

**`clubadmin.accessTokens.create` is deprecated by this primitive.** Under §2.3 there are no access tokens to re-mint. Recovery is authenticator re-enrollment, not token re-minting. The action can be removed or aliased to `createReEnrollmentGrant` during the deprecation cycle.

### 4.8. `clubs.join` response change

- `memberToken` field **removed.** No backwards-compatibility shim.
- Response shape: `{ clubId, membershipId, authenticatorId, proof, club }`. The `authenticatorId` is informational (the agent already knows the public key it generated; the id is what gets put in `X-Authenticator-Id` headers).
- Cross-join authenticated requests have no `publicKey` input (the actor already has authenticators) and no `authenticatorId` in the response (nothing new was created).

### 4.9. `setStatus(active)` — no mint, just state flip

The Phase A atomic transition now includes a fourth per-member step: flip `member_authenticators.status` from `pending_admission` to `active` for the admitted member's pending authenticator, inside the same transaction as the membership state change and the notification fanout.

If the member has multiple `pending_admission` authenticators (shouldn't happen in normal flow but possible via bugs or the race), flip all of them. An activated member with stuck pending authenticators is a worse state than a small over-promotion.

No credential is minted. No plaintext secret enters the response envelope. The response shape is unchanged from what it was before the abandoned §2.1 plan.

---

## 5. The paid-club problem — dissolved

Under §2.1 this was an unresolved design hole: the admin drives `submitted → payment_pending` but the Stripe webhook drives `payment_pending → active`, and no admin is in the loop at the moment a credential would be minted and delivered.

Under §2.3 the problem doesn't exist. There is no credential to mint. The applicant's private key is the same from `clubs.join` through admission through activation. The billing webhook flips the authenticator's `status` from `pending_admission` to `active` (via the same shared transition-to-active seam Phase A established), and the applicant's agent, on its next authenticated call, is now admitted. `membership.activated` notification fanout fires normally if applicable.

The free-club path and the paid-club path converge at the repository-layer transition helper. Both are state flips; neither involves delivery.

---

## 6. Data model changes

### 6.1. Migration file

Create `db/migrations/NNN_pubkey_authenticators.sql` using the next unused migration number. Apply via `scripts/migrate.sh`.

### 6.2. New tables

```sql
create table public.member_authenticators (
  id              text primary key,
  member_id       text not null references public.members(id) on delete cascade,
  alg             text not null check (alg = 'ed25519'),
  public_key      bytea not null,
  status          text not null check (status in ('pending_admission', 'active', 'revoked')),
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  label           text,
  created_via     text not null check (created_via in ('clubs.join', 'enroll_from_existing', 're_enrollment_grant', 'seed_bootstrap', 'legacy_bearer_migration'))
);
create index member_authenticators_member_idx on public.member_authenticators (member_id);
create unique index member_authenticators_pubkey_idx on public.member_authenticators (public_key);

create table public.re_enrollment_grants (
  id              text primary key,
  member_id       text not null references public.members(id) on delete cascade,
  code_hash       text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_by_member_id text not null references public.members(id),
  reason          text
);
create index re_enrollment_grants_member_idx on public.re_enrollment_grants (member_id);
create unique index re_enrollment_grants_code_hash_idx on public.re_enrollment_grants (code_hash);
```

### 6.3. Bearer-token migration story

**Existing members keep their bearer tokens until they enroll.** The `member_bearer_tokens` table stays. The bearer auth path (§4.3 step 3) stays in the dispatch layer. An existing member can call `members.enrollAuthenticator` via their existing bearer to enroll their first Ed25519 authenticator; after enrollment, they can use either credential.

**New members never receive bearers.** `clubs.join` inserts a `member_authenticators` row instead of a `member_bearer_tokens` row. The mint-at-admission code path in Phase A is replaced by the state-flip described in §4.9.

**Legacy bearer deprecation is a future workstream, not this one.** Keep the coexistence model for however long makes sense. The `authenticator.createReEnrollmentGrant` primitive is available throughout, so a member who loses their bearer (the old-world stranded-bearer problem) can be rescued by admin granting them a re-enrollment code — they then enroll an Ed25519 authenticator and never use bearers again.

### 6.4. Pre-cutover prod queries

```sql
-- How many existing members? (Every one of them keeps their bearer.)
select count(*) from members;

-- How many bearer rows exist? (The migration does not touch them.)
select count(*) from member_bearer_tokens where revoked_at is null;

-- Any in-flight applying memberships that will be caught mid-flight?
select count(*) from club_memberships where status = 'applying';

-- Any applying memberships where the member has no bearer? (Should be zero under the old model.)
select count(distinct cm.id)
from club_memberships cm
left join member_bearer_tokens mbt on mbt.member_id = cm.member_id and mbt.revoked_at is null
where cm.status = 'applying' and mbt.id is null;
```

The migration is additive — no existing rows are rewritten. Zero data-rewrite risk.

### 6.5. Migration test

Test the new tables against synthetic pre-migration data:

1. `git show main:db/init.sql > /tmp/init_pre.sql`.
2. Create scratch DB, apply.
3. Insert members, bearers, memberships in various states.
4. Run `scripts/migrate.sh`.
5. Verify `member_authenticators` and `re_enrollment_grants` tables exist and are empty. Existing data is unchanged.

---

## 7. API surface changes

### 7.1. New actions

- **`members.enrollAuthenticator`** — per §4.6.
- **`clubadmin.authenticators.createReEnrollmentGrant`** — per §4.7.
- **`members.enrollAuthenticatorFromGrant`** — per §4.7.
- **`members.authenticators.list`** — list the calling member's authenticators (informational). Output: array of `{ id, alg, status, createdAt, lastUsedAt, label, createdVia }`. No public keys.
- **`members.authenticators.revoke`** — revoke one of the calling member's authenticators. Auth: signed-request only. Server prevents a member from revoking their last `active` authenticator (would lock themselves out).

### 7.2. Modified actions

- **`clubs.join`** — per §4.8. Adds `publicKey` input for anonymous joins. Returns `authenticatorId`, no `memberToken`.
- **`clubs.applications.submit`** / **`.get`** — auth becomes `'member_pending_or_active'`. No input change other than the removal of any `applicationKey` / `memberToken` field.
- **`clubadmin.memberships.setStatus`** — atomic authenticator state flip added to the shared transition-to-active seam. No response envelope change.
- **Every other `auth: 'member'` action** — automatically works under signed auth with no per-handler change.

### 7.3. Removed / deprecated

- **`memberToken` field on `clubs.join`** — removed.
- **`clubadmin.accessTokens.create` and `superadmin.accessTokens.create`** — marked deprecated; their responsibility moves to the re-enrollment grant path. Actual removal is a follow-up cycle.

---

## 8. Retry during revision

Simpler than under §2.1. The applicant's agent holds the private key in session memory and signs every request. Within a single session the retry loop is free. If the session ends mid-retry-loop:

1. **Resume in the same session.** If the agent host preserves conversation context, reopen and continue — key still in memory.
2. **Start over.** Call `clubs.join` again with a fresh keypair. New membership, new authenticator.
3. **Admin-assisted recovery.** Admin issues a re-enrollment grant; the applicant's new agent enrolls a fresh authenticator bound to the *original* member and membership. The in-flight application survives the session boundary.

Option 3 is the new safety net. Under §2.1 there was no way to recover an in-flight application across sessions without starting over. Under §2.3, admin re-enrollment is the escape hatch.

---

## 9. SKILL.md updates

Phase A has already rewritten the onboarding section. Phase B additionally:

- Remove every reference to `memberToken` from `clubs.join`.
- Remove the "save the returned memberToken immediately" note.
- Add a new "Credentials" section describing the signed-request protocol, with a concrete canonical-string example and a pointer to the client SDK.
- Describe re-enrollment: when an agent has no private key and the human wants to resume membership, ask the human to request a re-enrollment grant from a club admin, then paste the grant code to the agent, which uses `members.enrollAuthenticatorFromGrant` to bind a fresh keypair.
- Admin sub-note: `clubadmin.authenticators.createReEnrollmentGrant` is the recovery primitive. `clubadmin.accessTokens.create` is deprecated; use re-enrollment.
- Welcome copy's `tokenInstruction` and `lossWarning` fields are NOT added (unlike the abandoned §2.1 plan). Under §2.3 there is no reusable secret to instruct the user to save. The welcome copy composed in Phase A stays as-is.

---

## 10. Tests

### 10.1. Unit

- `src/signed-request.ts`: canonical-string construction is deterministic across equivalent inputs. Timestamp skew rejection at ±5 min.
- Ed25519 keypair round-trip: sign + verify succeeds; sign with wrong key + verify fails.

### 10.2. Integration — signed-request auth

- Cold applicant: agent generates keypair; `clubs.join` accepts pubkey; `member_authenticators` row created with `pending_admission`.
- `clubs.applications.submit` via signed request against a `pending_admission` authenticator → accepted.
- Non-allowlisted action (e.g. `content.create`) via `pending_admission` authenticator → 403 `onboarding_required` after admission flips `pending_admission → active` but before `clubs.onboard` runs; 401 before admission (since it's not in the pre-admission allowlist either).
- Expired timestamp (>5 min skew) → 401.
- Tampered body (hash mismatch) → 401.
- Revoked authenticator → 401.
- Pending-admission authenticator calling a regular `auth: 'member'` action → 401 (the `_pending_or_active` mode is opt-in per action).

### 10.3. Integration — bearer coexistence

- Existing member with a legacy bearer calls `session.getContext` → succeeds.
- Same member enrolls an Ed25519 authenticator via `members.enrollAuthenticator` → succeeds; now has both.
- Same member calls the same action via signed request → succeeds.
- Request with BOTH `X-Signature` AND `Authorization: Bearer` → 401 `conflicting_auth`.
- Request with invalid signed auth AND no bearer → 401, no fallback attempted.

### 10.4. Integration — enrollment and recovery

- Member enrolls a second authenticator from an existing signed session. Both authenticators are valid for that member.
- Member revokes one of their authenticators. That authenticator's signatures now return 401; the other still works.
- Attempt to revoke the last active authenticator → 409 `would_lock_out_member`.
- Admin creates a re-enrollment grant for a member in their club. Returned code is plaintext.
- Same-club admin calls re-enrollment for a member in a DIFFERENT club → 403.
- Applicant uses grant code via `members.enrollAuthenticatorFromGrant`. New authenticator created; grant `used_at` set.
- Attempt to use grant code a second time → 409 `grant_used`.
- Grant expires (24h wall) → 410 `grant_expired`.
- Recovery across Susan's scenario: a cold applicant loses their agent mid-application; admin grants re-enrollment; applicant's new agent enrolls; the original `applying` membership survives and can be submitted.

### 10.5. Integration — activation

- Admin approves a `pending_admission`-authenticator member via `setStatus(active)`. Authenticator flips to `active` atomically; the same key now authorizes non-allowlisted actions (subject to the Phase A gate until `clubs.onboard`).
- Billing flips `payment_pending → active` for a paid-club applicant. Same authenticator flip, same behavior as the admin path. `membership.activated` notification fanout fires correctly.
- Atomic rollback: force a failure inside the shared transition-to-active helper and assert the authenticator state did NOT advance and no notification fanout fired.

### 10.6. Manual live-server dry run

1. Anonymous `clubs.join` with a freshly-generated keypair → `authenticatorId`, no `memberToken`.
2. Signed `clubs.applications.submit` → `submitted`.
3. Admin `setStatus(active)` → no plaintext in response envelope; authenticator flipped.
4. Mutating action BEFORE `clubs.onboard` → 403 `onboarding_required`.
5. `session.getContext` → `actor.onboardingPending: true`.
6. `clubs.onboard` → welcome payload.
7. Mutating action AFTER → succeeds.
8. Simulate session loss: drop the private key, start fresh agent. Request re-enrollment grant from admin. Use grant code to enroll new authenticator. Verify continuity of member identity and membership.

---

## 11. Security checklist

1. **Canonical string is signed over method, path, timestamp, and body hash.** Not over mutable headers beyond the three signing headers.
2. **Timestamp skew window is 5 min.** Replay outside window rejected.
3. **No replay protection via nonce table on day one.** The 5-min window is the bound. If replay becomes a concern, add a short-TTL seen-timestamps cache keyed by `authenticator_id`.
4. **Ed25519 only; no curve negotiation.** Single `alg` value in the table. Future algs require a schema change and an explicit migration, not a feature flag.
5. **Public keys stored raw.** No plaintext private keys anywhere in the server code, logs, or DB.
6. **Re-enrollment grants are one-time, 24h TTL, hashed at rest.** Same discipline as bearer tokens today.
7. **Re-enrollment does not auto-revoke existing authenticators.** Suspected compromise requires explicit admin revocation.
8. **Conflicting-auth rejection is immediate.** A request with both signed and bearer headers returns 401 without trying either.
9. **`member_authenticators.public_key` has a unique index.** Same public key cannot bind to two members.
10. **`members.authenticators.revoke` prevents self-lockout.** Attempting to revoke the last `active` authenticator returns 409.
11. **Rate limit on `clubs.join` and `members.enrollAuthenticatorFromGrant`.** Both are anonymous entry points with DB writes.
12. **`pending_admission` authenticators are allowlisted to exactly three actions.** `session.getContext`, `clubs.onboard`, `clubs.applications.submit/.get`. No other action accepts them.
13. **Bearer deprecation boundary is explicit.** The dispatch layer logs every bearer-authenticated request so we can observe adoption. Future cycle decides when to kill the fallback.
14. **`createMemberDirect` and equivalent seed/bootstrap paths insert `member_authenticators` rows**, not `member_bearer_tokens`. Seed-data integrity is the regression net: after `reset-dev.sh`, every member has at least one `active` authenticator.

---

## 12. Rollout plan

### 12.1. Implementation order

1. **Signing module.** `src/signed-request.ts` — canonical-string builder, Ed25519 verify helper. Unit tests.
2. **Migration.** `NNN_pubkey_authenticators.sql`. Test on scratch DB. Apply via `scripts/migrate.sh`.
3. **Repository methods.** `createAuthenticator`, `findAuthenticatorById`, `activateAuthenticator`, `revokeAuthenticator`, `listAuthenticatorsForMember`, plus re-enrollment grant CRUD.
4. **Dispatch-layer signed-auth path.** Add to `src/dispatch.ts`. Conflicting-auth rejection. Bearer fallback for legacy only.
5. **`clubs.join`** response change. Pubkey in input for anonymous joins.
6. **`clubs.applications.submit/.get`** — auth mode becomes `'member_pending_or_active'`. Input shape unchanged except legacy field removal.
7. **`setStatus` / billing shared seam** — authenticator state flip wired in atomically with Phase A's notification fanout.
8. **New actions.** `members.enrollAuthenticator`, `members.enrollAuthenticatorFromGrant`, `members.authenticators.list`, `members.authenticators.revoke`, `clubadmin.authenticators.createReEnrollmentGrant`.
9. **SKILL.md and docs/design-decisions.md** updates. Same commit as code.
10. **Reference client SDK.** Minimal TS/JS package for self-hosters. Python follow-up.
11. **Integration tests.** §10.
12. **Manual live-server dry run.** §10.6.
13. **Pre-cutover prod queries.** §6.4.
14. **Commit.** Bump `package.json`. **DO NOT push.** Present to Owen.

### 12.2. Deploy

When authorized, push triggers Railway auto-deploy. Monitor:

- `/api/schema` contains the new actions and the `publicKey` input on `clubs.join`.
- Existing members continue to authenticate via bearer.
- First new applicant through signed-auth path works end-to-end.
- No `conflicting_auth` errors in real traffic (would indicate a client bug, not a server bug).

### 12.3. Rollback

`git revert` + push. Migration is additive; new tables stay but are unused. Legacy bearers unaffected.

---

## 13. Open questions

1. **SDK languages beyond TS/Python.** Go, Rust, Ruby? Decide at ship time based on anticipated self-hoster adoption.
2. **Re-enrollment grant TTL.** 24h matches the PoW challenge wall. Flag to Owen if a different window is preferred.
3. **Seed-data bootstrap keys.** Dev-DB seeding needs to produce valid Ed25519 keypairs for the canned test members. Use deterministic keys per member-id so tests are reproducible; document in `db/seeds/dev.sql` that these are test-only keys and should never be used for real members.
4. **Bearer deprecation timeline.** Not this phase. Flag for a future cycle — needs telemetry on bearer usage before we decide when to kill it.

---

## 14. Decision log

| Decision | Why |
| --- | --- |
| Ed25519 public-key identity | Delivery is the actual bug. §2.3 removes delivery from the design entirely. Paid-club activation works identically to free-club activation because nothing is minted. |
| Not SIWE, not full RFC 9421 | SIWE carries wallet semantics; RFC 9421 is full-spec heavyweight. Ed25519 + canonical-string is sufficient for day one. |
| Multi-authenticator from day one | Single-pubkey-per-member regresses from today's multi-bearer ergonomics. Cheap to design in; painful to retrofit. |
| Raw `bytea` pubkey storage | No JWK, no PEM. Encoding happens at the edges. DB stays small. |
| Canonical string = method + path + timestamp + body-hash | Minimum-viable and spec-able. No trusted-proxy assumptions. |
| 5-min skew window, no nonce table on day one | Simplest viable replay protection. Nonce table can be added later if needed. |
| Conflicting-auth (both signed and bearer) is immediate 401 | No precedence guessing. Prevents confused-deputy attacks across auth modes. |
| Bearer coexistence during migration, no hard cutover | Existing members cannot be locked out by Phase B. Legacy bearers deprecate in a future cycle. |
| Re-enrollment grant is the recovery primitive | Delivery reappears only for recovery. Bounded and admin-controlled. Deprecates `clubadmin.accessTokens.create` and `superadmin.accessTokens.create`. |
| Re-enrollment does NOT auto-revoke existing authenticators | Revocation is an independent compromise-response action. |
| `pending_admission` authenticators allowlisted to three actions | `session.getContext`, `clubs.onboard`, `clubs.applications.submit/.get`. Everything else requires `active`. |
| No `tokenInstruction` / `lossWarning` in welcome copy | Under §2.3 there is no reusable secret to instruct the user to save. Phase A's welcome copy stays clean. |
| SDK-first for self-hosters | Ship TS/JS + Python reference implementations. Don't make adopters implement from prose. |
| `clubadmin.accessTokens.create` deprecated, not immediately removed | Phase B supersedes its purpose. Deletion follows bearer deprecation. |

---

## 15. What "done" looks like

- [ ] Migration written, tested against scratch DB, applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated.
- [ ] `src/signed-request.ts` module with unit tests.
- [ ] Repository methods for authenticators and re-enrollment grants.
- [ ] Dispatch-layer signed-auth path with bearer coexistence and conflicting-auth rejection.
- [ ] `clubs.join` input/output updated; `memberToken` removed.
- [ ] `clubs.applications.submit/.get` accept signed auth including `pending_admission`.
- [ ] `setStatus(active)` / billing shared seam flips authenticator state atomically with Phase A's fanout.
- [ ] `members.enrollAuthenticator`, `members.enrollAuthenticatorFromGrant`, `members.authenticators.list`, `members.authenticators.revoke` implemented.
- [ ] `clubadmin.authenticators.createReEnrollmentGrant` implemented.
- [ ] SKILL.md and `docs/design-decisions.md` updated in the same commit.
- [ ] Reference client SDK (TS/JS) published alongside.
- [ ] Integration tests pass, including bearer coexistence and re-enrollment flows.
- [ ] Manual live-server dry run passes.
- [ ] Pre-cutover prod queries reviewed.
- [ ] `npm run check` and `npm run test:all` pass.
- [ ] `package.json` patch version bumped.
- [ ] Local commit. **No push.** Owen authorizes.

When Owen authorizes, push, then:

- [ ] `/api/schema` reflects new actions.
- [ ] A fresh cold-apply via signed-auth works end-to-end.
- [ ] Existing bearer-authenticated members are unaffected.
- [ ] A recovery cycle (admin grant → new-agent enroll) works end-to-end.

Only then is Phase B complete.
