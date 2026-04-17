# Credential redesign (Phase B) — Ed25519 public-key identity

**Status:** mechanism decided, ready for reviewer pass once pow-at-join has landed.
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-16
**Depends on:** Phase A (`plans/onboarding-ceremony.md`) AND the pow-at-join workstream (`plans/pow-at-join.md`) shipping first. Phase B builds on the two-call anonymous flow and the stateless HMAC challenge primitive that pow-at-join introduces — do not attempt to sequence this work before those land.

This plan replaces bearer-token authentication with Ed25519-based public-key identity. The applicant's agent generates a keypair locally at `clubs.prepareJoin` / `clubs.join`, the public key IS the identity, and admission is a server-side state change rather than a credential handoff. Nothing is ever delivered to the applicant at admission — their agent has had the private key since the moment they said hello.

**What pow-at-join simplifies.** The free-identity threat model is already closed by the time Phase B starts. Every server-side identity — today a bearer, tomorrow an authenticator row — already costs the caller a solved PoW challenge to create. That means Phase B is no longer about *whether* to gate identity creation; it is only about *what shape of identity* the server hands out once the gate has been passed. The two-call anonymous flow, the consumed-challenge replay prevention, the cross-join email cleanup, and the bootstrap-paradox fix are all already in production. Phase B is genuinely a credential-primitive swap, not a rearchitecture.

---

## 1. The problem this phase answers

Two separate issues with today's credential model:

**The delivery problem.** `clubs.join` issues a long-lived bearer token at first contact — before the human has been admitted to anything, before they know a token exists, and with no place for the agent to durably store it. This has caused real lock-outs; we have minted emergency tokens via `superadmin.accessTokens.create` for applicants who couldn't hold onto what they never understood they had. Even under pow-at-join, where the bearer is no longer free, the server still *issues a reusable secret* the client must remember. Lose it, lose access.

**The delivery-channel problem for paid-club activation.** Admin-delivered bearers work for free clubs because the admin is in the loop at `setStatus(active)`. Paid clubs go `submitted → payment_pending → active` with the `→ active` driven by a billing webhook — no admin is present at the moment a credential would be handed off.

The diagnosis: the credential is structurally misplaced in time AND in delivery channel. Solving only one half leaves the other half broken.

The fix: don't issue a reusable secret at all. Let the applicant's agent generate its own credential locally. The server only ever sees a public key. Admission becomes a state flip on a stored row — no delivery moment, no delivery channel, no loss scenario for secrets the server issued.

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

## 3. What Phase A and pow-at-join gave us

Phase A shipped the auth-invariant onboarding pieces. None of it needs to change for Phase B:

- `members.onboarded_at` column with two-condition gate.
- `clubs.onboard` ceremony and welcome composers.
- `invitation.accepted` and `membership.activated` notification fanout, hung off the shared transition-to-active seam.
- State-machine validation for `clubadmin.memberships.setStatus`.

Pow-at-join shipped the identity-creation gate and the anonymous two-call flow. Phase B inherits it whole:

- **`clubs.prepareJoin` already exists** and already issues a stateless HMAC-signed challenge. Phase B extends its output shape to also carry anything the client needs for Ed25519 enrollment; it does not invent the action.
- **`clubs.join` already verifies the challenge and the PoW solution BEFORE any server-side row is written.** Phase B adds one more write to that successful-verification path: `member_authenticators` row for the client's public key, alongside the existing `members` + `club_memberships` writes.
- **`consumed_pow_challenges` already enforces one-time challenge consumption.** Phase B does not add a parallel replay-prevention mechanism.
- **Anonymous rate-limit bucket already shared between `prepareJoin` and `join`.** Phase B does not re-key the limiter.
- **Cross-join already doesn't ask for email and doesn't re-do PoW.** Phase B does not touch that path's input shape.
- **The bootstrap contradiction between `GET /` and `/skill` is already resolved.** Phase B's SKILL updates layer onto the already-consistent ordered bootstrap.
- **`clubs.applications.submit` no longer carries PoW responsibility.** The bearer (soon to be an Ed25519 signature) is the receipt.

Phase B swaps credentials underneath all of this. The ceremony, the fanout, the gate, and the PoW flow all still apply. The only change they see is that `actor.member.id` now comes from a verified Ed25519 signature against a stored public key, not a resolved bearer token.

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

**Invariant, scoped precisely.** Every member must have at least one *usable credential* — not necessarily an authenticator row. During the migration window "usable credential" means EITHER (a) a non-revoked bearer in `member_bearer_tokens` OR (b) an `active`/`pending_admission` row in `member_authenticators`. Pre-cutover members satisfy (a); post-cutover members created via `clubs.join` signed-auth satisfy (b); members who enroll an authenticator against their bearer satisfy both. This is the invariant the dispatch layer actually enforces.

Once bearer deprecation lands (future workstream), the invariant narrows to (b) only and the `member_bearer_tokens` table goes away. Until then, keeping the invariant split between two tables is the correct and necessary shape — see §6.3.

The authenticator-row state transitions are:

- `clubs.join` (new applicant via signed auth) → insert `pending_admission`.
- `clubadmin.memberships.setStatus(active)` OR billing `payment_pending → active` → flip the applicant's `pending_admission` row to `active`. This is the Phase B analogue of the Phase-A token mint — except nothing is minted, just a state flip.
- Existing bearer-holding member enrolls their first authenticator → insert an `active` row via `members.enrollAuthenticator` (§4.6) under dual-auth.
- Existing member enrolls a new authenticator (fresh agent on a new device) → insert a new `active` row via `members.enrollAuthenticator` (§4.6).
- Admin-driven recovery for a member with no usable credentials → see §4.7.
- Admin creates a new member directly (no `clubs.join` path) → see §4.12.
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

1. Agent calls `clubs.prepareJoin({clubSlug})` (already exists from pow-at-join). Server returns an HMAC-signed challenge blob + difficulty.
2. Agent generates an Ed25519 keypair locally. Stores the private key via the SDK's durable storage layer (§4.10). Solves the PoW.
3. Agent calls `clubs.join({clubSlug, email, challengeBlob, nonce, publicKey: base64url(bytes)})`. The `publicKey` is the new Phase B field; everything else already flows through pow-at-join's two-call path.
4. Server verifies the challenge + PoW (already works under pow-at-join), consumes the challenge, then — as a single transaction — creates a `members` row, a `club_memberships` row in `applying`, AND a `member_authenticators` row with `status = 'pending_admission'` holding Susan's public key. Returns `{ clubId, membershipId, authenticatorId, club }`. **No credential in the response.** The applicant's agent already has its private key.
5. Agent drafts the application, calls `clubs.applications.submit` — signed with the private key, `X-Authenticator-Id` set to the returned id. The dispatch layer admits `pending_admission` authenticators for exactly three actions (see §4.3).
6. Susan walks away. Nothing stored on her side the human sees — no pasted secret, no bearer. The private key lives wherever the SDK's durable storage placed it (§4.10).
7. Admin approves via `clubadmin.memberships.setStatus(active)`. Server flips the authenticator from `pending_admission` to `active` atomically with the state transition. No notification, no delivery. Phase A's `invitation.accepted` fires if applicable.
8. **When Susan opens a new conversation** with the same agent host, the SDK retrieves the persisted private key and she is onboarded as normal. If she opens a new conversation with a DIFFERENT agent host that cannot access the first host's storage, she has no key — recovery is re-enrollment (§4.7). See §4.10 for why durable-storage-by-default keeps re-enrollment a rare recovery path, not a regular one.

**Jenny (invited new applicant).** Same as Susan, plus an `invitationCode` in the `clubs.join` request. Invited joins still skip `clubs.prepareJoin` and PoW — the invitation is the cost, same as under pow-at-join. The `publicKey` input is required regardless of path; server still stores it in `member_authenticators` at join time. Sponsor gets `invitation.accepted` notification on admission.

**Alice (cross-joining existing member).** Alice has already been onboarded; her agent already holds a private key for her existing authenticator. She calls `clubs.join` with her existing signed auth (no `publicKey` input — she already has authenticators) and the new `clubSlug`. No `clubs.prepareJoin`, no PoW, no email — same as under pow-at-join. Server creates a CatClub `club_memberships` row in `applying` bound to her existing member_id. The same authenticator authorizes the submit. Admission flips the membership to `active`; `membership.activated` notification fires for Alice.

**Bob (invited cross-joiner).** Same as Alice plus an invitation code. `invitation.accepted` fires for the sponsor; `membership.activated` fires for Bob.

### 4.6. Enrolling additional authenticators

Existing onboarded members adding a new agent / new device.

- **`members.enrollAuthenticator`** — new action. Input: `{ publicKey: base64url(bytes), label?: string }`. Output: `{ authenticatorId, status: 'active' }`. Handler: insert a new authenticator row with `status = 'active'`, `created_via = 'enroll_from_existing'`.

**Auth during the migration window: BOTH `signed_request` and `bearer_legacy` accepted.** Existing members today authenticate via bearer; they must be able to enroll their first Ed25519 authenticator using that bearer. Restricting this action to signed-request only from day one would create a bootstrap cycle — an existing member with a bearer and no authenticator would have no way to enroll one. The action therefore accepts both auth kinds during the migration window.

After the bearer-deprecation cycle lands (future workstream; see §6.3), `members.enrollAuthenticator` narrows to signed-request only. Until then, dual-auth is the correct and necessary shape.

The ergonomics: Alice opens a new agent on a different device. The new agent generates a keypair. Alice's old agent (still holding the previous private key, or a legacy bearer, during the migration window) calls `members.enrollAuthenticator` on behalf of the new agent, passing the new public key. The server records it. The new agent is now a fully independent authenticator for the same member.

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

### 4.8. `clubs.join` shape changes

- `memberToken` field **removed** from the response. No backwards-compatibility shim. (Phase B's irreversible break.)
- `publicKey` input field **added** on the anonymous and invitation-backed paths (but NOT cross-join, where the actor already has authenticators).
- Response shape: `{ clubId, membershipId, authenticatorId, club }`. The `authenticatorId` is informational — the agent already knows the public key it generated; the id is what gets put in `X-Authenticator-Id` headers on subsequent requests.
- The `proof` block in today's response (used by pow-at-join's `clubs.prepareJoin` / `clubs.join` flow) is unchanged by Phase B — Phase B's change is orthogonal to how PoW is communicated.
- Cross-join authenticated requests have no `publicKey` input (the actor already has authenticators) and no `authenticatorId` in the response (nothing new was created).

### 4.9. `setStatus(active)` — no mint, just state flip

The Phase A atomic transition now includes a fourth per-member step: flip `member_authenticators.status` from `pending_admission` to `active` for the admitted member's pending authenticator, inside the same transaction as the membership state change and the notification fanout.

If the member has multiple `pending_admission` authenticators (shouldn't happen in normal flow but possible via bugs or the race), flip all of them. An activated member with stuck pending authenticators is a worse state than a small over-promotion.

No credential is minted. No plaintext secret enters the response envelope. The response shape is unchanged from what it was before the abandoned §2.1 plan.

### 4.10. Durable private-key storage — SDK owns it

The single biggest risk in the §2.3 design is a naive implementation that keeps the private key in volatile agent-session memory. If the key dies when a conversation rolls, re-enrollment stops being a rare recovery flow and becomes the default return path — which is worse UX than today's lose-your-bearer scenario. The SDK MUST persist private keys durably by default, per host type. This is not an optional add-on; it is a first-class deliverable of the Phase B ship.

**Host-type strategy.**

- **Node / local CLI / server-side agents** (`claude-code`, self-hosters building agents with Node): persist to `$XDG_CONFIG_HOME/clawclub/keys/<memberId>.key` (or platform equivalent). Mode `0600`, owner-only. The SDK reads on start, writes on enrollment, refuses to run if the file permissions are wrong.
- **Browser-hosted agents** (anything running in a web worker or a browser tab): persist to `IndexedDB` with an origin-scoped database. The key never leaves the browser. Fall back to `localStorage` only if IndexedDB is unavailable.
- **Claude.ai / ChatGPT / hosted conversation contexts**: these platforms vary in what they expose. The SDK's strategy is (a) write the key's base64 representation into the conversation's Project-level persistent memory if available, (b) as a fallback, surface the key to the user ONCE with the same "save this in your password manager" guidance the legacy bearer flow used today. This fallback means the last-resort UX is no worse than today's bearer flow, but the primary path is Project-memory persistence where the platform supports it.
- **Other custom agents**: the SDK exposes a pluggable `KeyStore` interface. Self-hosters who can't use any of the defaults above MUST implement their own; the SDK refuses to operate without one.

**What the SDK delivers.**

- A reference client package (TypeScript/JavaScript first, Python follow-up) that includes: Ed25519 keypair generation, canonical-request signing, signature verification helpers, and a default `KeyStore` implementation per host type above.
- A compliance checklist for self-hosters who bring their own key storage: must survive process restart, must be readable only by the same member's agent, must not be logged, must be rotatable via `members.enrollAuthenticator`.
- Integration tests that exercise each default `KeyStore` end-to-end.

**What the SDK does NOT deliver.**

- Biometric / hardware-backed storage (that's passkeys, ruled out in §2).
- Cross-device key sync. Each device enrolls its own authenticator; the multi-authenticator model (§4.1) is the sync primitive.

**Cost of getting this wrong.** If the SDK does not make durable storage the default, every cold-applicant agent re-roll becomes an admin-drag re-enrollment. That would make §2.3 strictly worse than today's bearer-with-paste-backup flow on the "casual user loses their conversation" axis. This is THE make-or-break implementation detail of Phase B.

### 4.11. `/stream` — signed-auth handshake and passive revalidation

The existing `/stream` endpoint (SSE activity / notifications / invalidation) today hard-requires a bearer in the `Authorization` header and periodically revalidates it via `validateBearerTokenPassive`. Under Phase B, signed-request auth MUST have an equivalent story — otherwise signed-auth members lose first-party update streams or inherit weaker revocation semantics than bearer users.

**Signed-auth handshake on `GET /stream`.**

- The client opens the stream with the same three signing headers used on every other request: `X-Authenticator-Id`, `X-Timestamp`, `X-Signature`. The canonical string covers `method + path + timestamp + sha256(body_or_empty)` — same primitive as every authenticated action, so the server verifies the stream-open exactly the same way it verifies any POST.
- On successful verification the server resolves `authenticator → member`, opens the SSE connection, and stores the authenticator id alongside the connection in its per-process stream tracker.

**Passive revalidation during the stream's lifetime.**

- The server cannot replay the original signature forever — that would be a forgery. Instead, it periodically re-reads the authenticator row (already indexed by `authenticator_id`) on the same cadence `validateBearerTokenPassive` uses today. If the row is still `active` and not `revoked`, the stream continues. If the row is revoked or the member is banned/removed, the server closes the SSE connection with the same close frame it uses for revoked bearers today.
- The revalidation query is keyed by `authenticator_id`, which is cheap (single-row lookup on a primary key). Cost is the same order of magnitude as today's bearer passive revalidation.

**Bearer coexistence on `/stream`.**

- A bearer presented on `/stream` continues to go through `validateBearerTokenPassive` unchanged. A signed-auth request goes through the new path. Same conflicting-auth rule as §4.3: if both are present, 401 `conflicting_auth` immediately.

**What NOT to do.**

- Do not issue a short-lived "stream session token" minted from the signed handshake. That re-introduces a server-minted credential the client has to manage, which is exactly what Phase B is trying to eliminate. Passive revalidation against the authenticator row is sufficient.
- Do not skip the periodic revalidation. Without it, a revoked authenticator could keep its stream open indefinitely — which is strictly worse than bearer behavior today.

### 4.12. Admin-created members — `superadmin.members.create`

Today's `superadmin.members.createWithAccessToken` (`src/schemas/superadmin.ts`, backed by `createMemberDirect` at `src/identity/memberships.ts`) mints a bearer for a brand-new admin-created member and returns it in the response envelope. Under §2.3 the server no longer issues reusable secrets, so this action MUST change shape. The plan makes it explicit rather than leaving it to implementer interpretation.

**Rename and reshape** (not backwards-compatible — in line with the project's API-break freedom):

- **New action:** `superadmin.members.create`. Old `superadmin.members.createWithAccessToken` is removed; no shim.
- **Input:** `{ publicName, email?, publicKey? }`. The `publicKey` is a base64url-encoded 32-byte Ed25519 public key.
- **Output, two shapes, determined by whether `publicKey` was supplied:**
  - If `publicKey` WAS supplied: `{ member, authenticatorId }`. Server inserts an `active` `member_authenticators` row (`created_via = 'seed_bootstrap'`) atomically with the new `members` row. No credential is returned in the envelope — the admin already has the public key, and the private-key holder is whoever generated it (typically the member's own agent during onboarding).
  - If `publicKey` was omitted: `{ member, grantCode }` where `grantCode` is a one-shot re-enrollment grant (the same primitive as §4.7). The admin hands the `grantCode` to the new member out of band; their agent generates a keypair and calls `members.enrollAuthenticatorFromGrant` to bind it. The grant is consumed at that moment. Until enrollment, the member has no usable credential — this is fine because no action reads "admin has created this member but they have not enrolled yet" as a live-access state. It is a 24h window, same TTL as §4.7.
- **Repository path:** `createMemberDirect` is rewritten. Both output shapes happen inside one transaction (member row + authenticator row, OR member row + grant row). Never both simultaneously, never neither.
- **Bearer output removed unconditionally.** No code path in `superadmin.members.create` mints, hashes, or returns a bearer. During the migration window this is a one-off exception to "existing admin tooling keeps working via bearers" — because this specific tool was the way admins *created* bearers, and the whole point of Phase B is that new identities are not bearer-backed.

**Seed-data consequence.** `db/seeds/dev.sql` currently creates members and gives them bearer rows so the canned dev tokens in `CLAUDE.md` work. Under Phase B, seed members get an `active` `member_authenticators` row instead, with a deterministic public key derived from member id (see §13.2 pin). The seed-only bearer rows can be dropped in the same commit.

**Legacy bearer-holders are unaffected.** This change applies to new admin-created members only. Bearer holders created pre-cutover keep their bearer; bearer holders still pending their first authenticator enrollment use the dual-auth `members.enrollAuthenticator` path (§4.6).

---

## 5. The paid-club problem — dissolved

Under §2.1 this was an unresolved design hole: the admin drives `submitted → payment_pending` but the Stripe webhook drives `payment_pending → active`, and no admin is in the loop at the moment a credential would be minted and delivered.

Under §2.3 the problem doesn't exist. There is no credential to mint. The applicant's private key is the same from `clubs.join` through admission through activation. The billing webhook flips the authenticator's `status` from `pending_admission` to `active` (via the same shared transition-to-active seam Phase A established), and the applicant's agent, on its next authenticated call, is now admitted. `membership.activated` notification fanout fires normally if applicable.

The free-club path and the paid-club path converge at the repository-layer transition helper. Both are state flips; neither involves delivery.

---

## 6. Data model changes

### 6.1. Migration file

Create `db/migrations/NNN_pubkey_authenticators.sql` using the next unused migration number. Apply via `scripts/migrate.sh`.

**Note what this migration does NOT touch:** `consumed_pow_challenges` already exists from pow-at-join. The two-call anonymous flow already works. This migration is purely additive — two new tables for authenticator storage and re-enrollment grants, nothing else.

### 6.2. New tables

```sql
create table public.member_authenticators (
  id              text primary key,
  member_id       public.short_id not null references public.members(id) on delete cascade,
  alg             text not null check (alg = 'ed25519'),
  public_key      bytea not null check (octet_length(public_key) = 32),
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
  member_id       public.short_id not null references public.members(id) on delete cascade,
  code_hash       text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_by_member_id public.short_id not null references public.members(id),
  reason          text
);
create index re_enrollment_grants_member_idx on public.re_enrollment_grants (member_id);
create unique index re_enrollment_grants_code_hash_idx on public.re_enrollment_grants (code_hash);
```

Notes:

- `public_key` is constrained to exactly 32 bytes at the DB layer (raw Ed25519 public key). Any other length is a bug, caught by the check constraint rather than deferred to runtime validation.
- Short-id columns use `public.short_id` to match schema conventions across the repo (same discipline applied to `consumed_pow_challenges` under pow-at-join).
- A re-enrollment grant restores the member's **whole account**, not just one club. That is intentional: the grant issuer is a clubadmin of at least one of the member's clubs, and the remedy is "bind a fresh keypair to this member's identity," which is a member-level operation. Narrower scope would be possible (restrict new authenticator's acceptable actions to one club) but adds complexity for no real security benefit — a re-enrolled member could trivially cross-join anyway, so a per-club grant just defers the same outcome by a round trip. Pinned: grants are member-wide.

### 6.3. Bearer-token migration story

**Existing members keep their bearer tokens until they enroll.** The `member_bearer_tokens` table stays. The bearer auth path (§4.3 step 3) stays in the dispatch layer. An existing member uses their existing bearer to call `members.enrollAuthenticator` — which accepts dual-auth during the migration window per §4.6 — and binds their first Ed25519 authenticator. After that, they can use either credential.

**New members never receive bearers.** `clubs.join` inserts a `member_authenticators` row instead of a `member_bearer_tokens` row. The mint-at-admission code path from pow-at-join is replaced by the state-flip described in §4.9. Admin-created new members are handled by the reshaped `superadmin.members.create` — see §4.12 — which also does not issue bearers.

**Legacy bearer deprecation is a future workstream, not this one.** Keep the coexistence model for however long makes sense. The `clubadmin.authenticators.createReEnrollmentGrant` primitive is available throughout, so a member who loses their bearer (the old-world stranded-bearer problem) can be rescued by admin granting them a re-enrollment code — they then enroll an Ed25519 authenticator and never use bearers again.

The three pieces that together close the bootstrap:

1. **Dual-auth `members.enrollAuthenticator`** (§4.6) lets a legacy-bearer holder enroll their first Ed25519 key.
2. **`clubadmin.authenticators.createReEnrollmentGrant`** (§4.7) lets a member with no working credentials at all get back in.
3. **Signed-auth `/stream` handshake** (§4.11) ensures migrated members don't lose the realtime side-channel as they switch credential kinds.

All three must be live on day one of the Phase B deploy. Missing any one of them creates a stranded-member scenario.

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
- **Dual-auth `members.enrollAuthenticator`**: legacy-bearer-holding member enrolls their first Ed25519 authenticator using the bearer, not a signature. Succeeds. After enrollment, the same member can use either credential.
- Member revokes one of their authenticators. That authenticator's signatures now return 401; the other still works.
- Attempt to revoke the last active authenticator → 409 `would_lock_out_member`.
- Admin creates a re-enrollment grant for a member in their club. Returned code is plaintext.
- Same-club admin calls re-enrollment for a member in a DIFFERENT club → 403.
- Applicant uses grant code via `members.enrollAuthenticatorFromGrant`. New authenticator created; grant `used_at` set.
- Attempt to use grant code a second time → 409 `grant_used`.
- Grant expires (24h wall) → 410 `grant_expired`.
- Recovery across Susan's scenario: a cold applicant loses their agent mid-application; admin grants re-enrollment; applicant's new agent enrolls; the original `applying` membership survives and can be submitted.
- **Grant scope**: a re-enrollment grant issued by clubadmin-of-DogClub lets the member enroll an authenticator that works across ALL their clubs, not just DogClub. Assert the new authenticator authorizes actions in a second (unrelated) club the member was active in before re-enrollment.

### 10.4.1. Integration — `/stream` signed-auth

- Signed-auth handshake on `GET /stream` succeeds when headers are valid. Connection opens.
- Invalid signature on `/stream` → 401, no SSE frames sent.
- Expired timestamp on `/stream` → 401.
- Revocation while stream is open: revoke the authenticator mid-stream; assert the server closes the connection with the revoked-credential close frame within one passive revalidation interval.
- Conflicting-auth on `/stream`: present both `X-Signature` and `Authorization: Bearer` → 401 `conflicting_auth`, stream does not open.
- Bearer-coexistence on `/stream`: legacy-bearer request still works; signed-auth request still works; they're independent paths.

### 10.4.2. Integration — SDK durable-storage defaults

- Node/CLI default `KeyStore`: generate + persist + restart-simulation → key retrievable. File mode is 0600 on POSIX.
- Browser default `KeyStore`: generate + persist to IndexedDB + page-reload simulation → key retrievable.
- `KeyStore` compliance assertions: any `KeyStore` implementation must survive the full enroll → restart → sign cycle without human intervention. Parameterized test over the provided implementations.

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
5. **Public keys stored raw.** No plaintext private keys anywhere in the server code, logs, or DB. `public_key` is constrained to exactly 32 bytes at the DB layer.
6. **Re-enrollment grants are one-time, 24h TTL, hashed at rest.** Same discipline as bearer tokens today.
7. **Re-enrollment does not auto-revoke existing authenticators.** Suspected compromise requires explicit admin revocation.
8. **Re-enrollment grants restore member-wide identity, not a single club.** Documented behavior per §6.2.
9. **Conflicting-auth rejection is immediate.** A request with both signed and bearer headers returns 401 without trying either. Applies on every authenticated surface AND on `/stream`.
10. **`member_authenticators.public_key` has a unique index.** Same public key cannot bind to two members.
11. **`members.authenticators.revoke` prevents self-lockout.** Attempting to revoke the last `active` authenticator returns 409.
12. **Rate limit on `clubs.join` and `members.enrollAuthenticatorFromGrant`.** Both are anonymous entry points with DB writes. The shared anonymous bucket established by pow-at-join extends to `members.enrollAuthenticatorFromGrant`.
13. **`pending_admission` authenticators are allowlisted to exactly three actions.** `session.getContext`, `clubs.onboard`, `clubs.applications.submit/.get`. No other action accepts them.
14. **Dual-auth on `members.enrollAuthenticator` is time-bounded.** Bearer coexistence is a migration window, not a permanent feature. Once bearer deprecation lands, this action narrows to signed-request only.
15. **`/stream` passive revalidation works for signed auth.** Revoked authenticators close their streams within one revalidation interval. Test explicitly asserts this.
16. **Bearer deprecation boundary is explicit.** The dispatch layer logs every bearer-authenticated request so we can observe adoption. Future cycle decides when to kill the fallback.
17. **`createMemberDirect` and equivalent seed/bootstrap paths insert `member_authenticators` rows**, not `member_bearer_tokens`. Seed-data integrity is the regression net: after `reset-dev.sh`, every member has at least one `active` authenticator.
18. **SDK `KeyStore` refuses to operate without a storage backend.** The SDK MUST require the caller to either use one of the defaults or provide a `KeyStore` implementation. Running without persistent storage is rejected.
19. **SDK key-file permissions are enforced.** The Node/CLI default `KeyStore` refuses to read a key file whose permissions are not owner-only (0600 on POSIX).

---

## 12. Rollout plan

### 12.1. Implementation order

1. **Signing module.** `src/signed-request.ts` — canonical-string builder, Ed25519 verify helper. Unit tests.
2. **Migration.** `NNN_pubkey_authenticators.sql` — add `member_authenticators` and `re_enrollment_grants` only. No changes to `consumed_pow_challenges` (already exists from pow-at-join). Test on scratch DB. Apply via `scripts/migrate.sh`.
3. **Repository methods.** `createAuthenticator`, `findAuthenticatorById`, `activateAuthenticator`, `revokeAuthenticator`, `listAuthenticatorsForMember`, plus re-enrollment grant CRUD.
4. **Dispatch-layer signed-auth path.** Add to `src/dispatch.ts`. Conflicting-auth rejection (bearer + signed together → 401). Bearer fallback for legacy only.
5. **`/stream` signed-auth handshake and passive revalidation.** Per §4.11. Bearer coexistence on the same endpoint.
6. **`clubs.join`** shape change. `publicKey` input added to anonymous and invitation-backed paths; server stores it in `member_authenticators` atomically with `members` / `club_memberships` inside the existing pow-at-join verification path. `memberToken` removed from response.
7. **`clubs.applications.submit/.get`** — auth mode becomes `'member_pending_or_active'`. Input shape unchanged except legacy field removal.
8. **`setStatus` / billing shared seam** — authenticator state flip wired in atomically with Phase A's notification fanout.
9. **New actions.** `members.enrollAuthenticator` (dual-auth during migration window per §4.6), `members.enrollAuthenticatorFromGrant`, `members.authenticators.list`, `members.authenticators.revoke`, `clubadmin.authenticators.createReEnrollmentGrant`.
10. **Reference client SDK** with default `KeyStore` implementations per §4.10. TS/JS first; Python follow-up post-ship.
11. **SKILL.md and docs/design-decisions.md** updates. Same commit as code.
12. **Integration tests.** §10 — including `/stream` and SDK defaults.
13. **Manual live-server dry run.** §10.6.
14. **Pre-cutover prod queries.** §6.4.
15. **Commit.** Bump `package.json`. **DO NOT push.** Present to Owen.

### 12.2. Deploy

When authorized, push triggers Railway auto-deploy. Monitor:

- `/api/schema` contains the new actions and the `publicKey` input on `clubs.join`.
- Existing members continue to authenticate via bearer.
- First new applicant through signed-auth path works end-to-end.
- No `conflicting_auth` errors in real traffic (would indicate a client bug, not a server bug).

### 12.3. Rollback

**Forward-fix is the preferred path.** The Phase B migration is structurally additive at the DB layer (two new tables, no drops, no rewrites of existing rows). That does NOT make rollback behaviorally clean — the behavior gap is the important half of the story.

**The stranded-member problem.** Every member created after cutover joined via the signed-auth `clubs.join` path. By design, no bearer row was ever minted for them — their credential lives only in `member_authenticators`. Reverted code has no signed-auth support in `src/dispatch.ts`, `src/server.ts`, or `src/identity/auth.ts`, so those members cannot authenticate. They are stranded until an admin takes an explicit recovery action.

**Quantifying the gap before reverting.** The exact SQL to identify stranded members:

```sql
select m.id, m.public_name, m.state, m.onboarded_at
from members m
where not exists (
  select 1 from member_bearer_tokens t
  where t.member_id = m.id and t.revoked_at is null
)
order by m.created_at desc;
```

This is the count that defines the blast radius of a revert. If it is zero or near-zero (rollback within the first minutes of cutover, before any cold-joiner got in), revert is cheap. If it is non-trivial, a revert means manually reintroducing a bearer for every stranded member, with no way for the affected members themselves to self-serve recovery against the reverted server.

**Recovery path on a reverted server.**

1. Admin queries the SQL above to get the stranded list.
2. For each stranded member, admin calls `superadmin.members.createBearerForStrandedMember` — a one-shot recovery action that must be added to the reverted code path as part of the revert. This action: reads the member row, mints a bearer via `buildBearerToken`, inserts into `member_bearer_tokens`, and returns the plaintext bearer exactly once.
3. Admin delivers the bearer to the member out of band (email, whatever channel they have).
4. Stranded member's agent accepts the bearer and resumes operation.

This recovery path is NOT in the current reverted code. Whoever ships the revert must also ship this rescue action in the same revert commit. The plan flags this up front so the rescue action is not an afterthought improvised at 3am.

**The less-bad alternative: forward-fix.** The strong preference is to find and fix whatever drove the revert consideration in the forward direction — patch the bug, ship a new commit, keep post-cutover members on their Ed25519 credentials. The additive migration means forward-fix has no schema complications to work around.

**The subtler `/stream` concern remains:** a reverted server won't recognize `X-Signature` headers; clients already connected via signed auth will disconnect. If those clients are bearer-backed (legacy members), they reconnect cleanly. If they are post-cutover signed-auth-only members, they can't reconnect at all until the rescue action above runs.

**Pre-deploy ritual:** snapshot the prod DB before applying the migration, keep it 24 hours past deploy. Same discipline as pow-at-join. For Phase B specifically, also snapshot `member_authenticators` and `member_bearer_tokens` contents immediately before any revert so the stranded-member rescue can be audited afterward.

---

## 13. Open questions

1. **SDK languages beyond TS/Python.** Go, Rust, Ruby? Decide at ship time based on anticipated self-hoster adoption. Out of scope for this phase.
2. **Bearer deprecation timeline.** Not this phase. Flag for a future cycle — needs telemetry on bearer usage before we decide when to kill it.

**Resolved (pinned):**

- ~~SDK repository location.~~ TS/JS SDK lives in `src/sdk/` inside this repo, exposed as a subpath export (`clawclub/sdk`) via `package.json` exports, shipped on the same npm publish cycle as the server. No sibling repo, no monorepo split for day one. The rationale: server and SDK must stay in exact lockstep on canonical-string shape, timestamp-skew tolerance, and error-code names — splitting them into separate repos on day one is premature and creates version-drift risk for something that has one authoritative source. Python SDK is a follow-up workstream that can live in a sibling directory (`sdk-python/`) or a separate repo at that point. This pin lives at §4.10.
- ~~Seed-data bootstrap keys.~~ Dev-DB seeding produces Ed25519 keypairs deterministically from member id via `sha256("clawclub-dev-seed:" + memberId)` (first 32 bytes as the Ed25519 seed). `db/seeds/dev.sql` is rewritten to insert one `active` `member_authenticators` row per seeded member, with the derived public key. Legacy bearer rows for seeded members are dropped in the same commit. The `CLAUDE.md` "Test data" block is updated: instead of a `cc_live_*` bearer per seed member, it lists the member id and notes that the SDK's dev helper (e.g. `clawclubSdk.testKeypair(memberId)`) derives the private key on demand. A glaring comment in `db/seeds/dev.sql` marks these keys as DEV-ONLY and forbids reuse in any real deployment. Integration tests derive the same keys through the SDK, not by duplicating the derivation formula.
- ~~Integration harness shape.~~ The existing bearer-centric helpers in `test/integration/harness.ts` (around `seedMember`, `createToken`) gain sibling helpers: `seedMemberWithAuthenticator(publicName)` returns `{ memberId, privateKey }` seeded with the deterministic keypair above, and `signedRequest({ authenticatorId, privateKey, method, path, body })` wraps the canonical-string + signature shape for tests. The bearer helpers stay — they exercise the bearer path, which remains valid during the migration window and is itself a load-bearing invariant the tests must protect. Signed-auth tests use the new helpers; bearer tests use the existing ones; migration-window tests exercise both. The harness changes are additive; no existing test file changes unless it is the one being ported.
- ~~Re-enrollment grant TTL.~~ 24h.
- ~~Re-enrollment grant scope.~~ Member-wide, not per-club. See §6.2.
- ~~Bootstrap contradiction for `members.enrollAuthenticator`.~~ Dual-auth during migration window, signed-only after bearer deprecation. See §4.6.
- ~~`/stream` signed-auth design.~~ Signed handshake at connect; passive authenticator-row revalidation thereafter. See §4.11.
- ~~Durable key storage in the SDK.~~ First-class deliverable, host-type-specific defaults. See §4.10.
- ~~`public_key` length check.~~ DB-level constraint: exactly 32 bytes. See §6.2.
- ~~`superadmin.members.createWithAccessToken` fate.~~ Renamed to `superadmin.members.create`, reshaped to optionally accept a `publicKey` (inserts an active authenticator) OR issue a re-enrollment grant code for out-of-band delivery. No bearer is ever returned. See §4.12.
- ~~Credential invariant during migration.~~ Every member has at least one usable credential, where "usable" means non-revoked bearer OR active/pending_admission authenticator. Scoped to the migration window; narrows to authenticator-only once bearer deprecation lands. See §4.1.

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
| Re-enrollment grant scope is member-wide, not per-club | Narrower scope would defer the same outcome by a round trip (member can cross-join anyway). Keep the model simple. |
| Dual-auth `members.enrollAuthenticator` during migration window | Pure signed-request would create a bootstrap cycle for legacy-bearer-holding members with no authenticator. Dual-auth closes the cycle; narrowing to signed-only lands with bearer deprecation. |
| `/stream` signed handshake + passive authenticator revalidation | SSE needs the same revocation story bearers have today. Replaying the handshake signature forever is wrong; re-reading the authenticator row is right. |
| SDK is a first-class deliverable, not an afterthought | Without durable key storage in the default SDK, re-enrollment stops being a rare recovery flow and becomes the default cold-restart path. That would make §2.3 worse than today's bearer flow. |
| `public_key` = exactly 32 bytes at the DB layer | Check constraint catches malformed inserts at the lowest level. Cheaper than runtime validation in every repository method. |
| `superadmin.members.createWithAccessToken` replaced by `superadmin.members.create` | The old action literally mints a bearer in the response envelope; that contradicts §2.3's "no reusable secrets delivered." Renaming + reshaping makes the change explicit, aligned with project convention of API-break freedom, and removes the ambiguity of "does pow-at-join-era admin tooling still hand out bearers under Phase B." |
| SDK lives inside this repo at `src/sdk/` | Server and SDK must agree byte-for-byte on canonical-string shape, skew tolerance, and error-code names. Splitting into a separate repo for day one is premature. A monorepo split is an option later when/if the SDK grows non-trivial independent lifecycle. |
| Seed keys are deterministic from member id | Dev tests must be reproducible across DB resets; hardcoding random bearers in `CLAUDE.md` is already awkward and would be impossible to maintain for signed auth. Deterministic derivation is the obvious answer. |
| Credential invariant scoped to "usable credential" not "authenticator row" | Line 102's earlier wording contradicted §6.3's migration story. The scoped wording keeps both true during the migration window. |
| Rollback section names stranded-member rescue as its own deliverable | A revert is NOT behaviorally clean even though the migration is structurally additive. If the stranded-member rescue action isn't pre-written, a revert is a crisis. Better to name it in the plan. |

---

## 15. What "done" looks like

- [ ] Migration written, tested against scratch DB, applied via `scripts/migrate.sh`. Additive only — `member_authenticators` + `re_enrollment_grants` tables. No changes to `consumed_pow_challenges` (already exists from pow-at-join).
- [ ] `db/init.sql` updated. `public_key` check constraint enforces exactly 32 bytes.
- [ ] `src/signed-request.ts` module with unit tests (canonical string, timestamp skew, Ed25519 verify).
- [ ] Repository methods for authenticators and re-enrollment grants.
- [ ] Dispatch-layer signed-auth path with bearer coexistence and conflicting-auth rejection (both on action dispatch AND on `/stream`).
- [ ] `/stream` signed-auth handshake implemented; passive authenticator-row revalidation runs on the same cadence as today's bearer passive revalidation.
- [ ] `clubs.join` shape: `publicKey` input added to anonymous and invitation-backed paths; `memberToken` removed from response; server writes `member_authenticators` row atomically with `members`/`club_memberships`.
- [ ] `clubs.applications.submit/.get` accept signed auth including `pending_admission`.
- [ ] `setStatus(active)` / billing shared seam flips authenticator state atomically with Phase A's fanout.
- [ ] `members.enrollAuthenticator` (dual-auth during migration window), `members.enrollAuthenticatorFromGrant`, `members.authenticators.list`, `members.authenticators.revoke` implemented.
- [ ] `clubadmin.authenticators.createReEnrollmentGrant` implemented.
- [ ] Reference client SDK (TS/JS) published with default `KeyStore` implementations for Node/CLI and browser. Python follow-up queued.
- [ ] SDK compliance test: generate → persist → restart → sign → verify cycles for each default `KeyStore`.
- [ ] `superadmin.members.create` replaces `superadmin.members.createWithAccessToken` per §4.12 (optional `publicKey` input; returns `authenticatorId` OR `grantCode`, never a bearer).
- [ ] `createMemberDirect` rewritten to produce either an active authenticator (when `publicKey` supplied) or a re-enrollment grant (when omitted), never a bearer.
- [ ] `db/seeds/dev.sql` rewritten: seeded members get `active` `member_authenticators` rows with deterministic keys per §13.2, and `CLAUDE.md`'s "Test data" block is rewritten to match.
- [ ] `test/integration/harness.ts` gains `seedMemberWithAuthenticator` and `signedRequest` helpers; existing bearer helpers stay. Bearer-centric tests unchanged; new signed-auth tests use the new helpers.
- [ ] Stranded-member rescue action (`superadmin.members.createBearerForStrandedMember`) is pre-written and sitting in a revert-ready branch, per §12.3. Not deployed, not in the main code path, but written and committed somewhere an on-call person can find at 3am.
- [ ] SKILL.md and `docs/design-decisions.md` updated in the same commit.
- [ ] Integration tests pass, including bearer coexistence, `/stream` signed auth, re-enrollment flows, and SDK `KeyStore` defaults.
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
