# PoW-at-join: move proof-of-work before identity creation

**Status:** ready for review
**Author:** Owen + Claude Opus 4.6
**Date:** 2026-04-16
**Depends on:** `plans/onboarding-ceremony.md` (Phase A) shipping first. No code overlap, but plan-text and SKILL.md wording assume Phase A is live.
**Sequencing:** ship this BEFORE `plans/credential-redesign.md` (Phase B). Phase B replaces bearer tokens with Ed25519 public-key identity; it inherits this workstream's PoW-at-join flow verbatim, just against a different credential primitive. Doing this first means Phase B does not have to re-argue the threat model.

This plan closes a real security hole: today, `clubs.join` mints a bearer token against a fresh member record before ANY proof of cost has been provided. The attacker never has to own the email, never has to solve proof-of-work, never has to finish an application. They just call `clubs.join`, collect a valid authenticated identity, and walk away. Every downstream per-token, per-member, per-day rate limit assumes getting an identity costs something — and right now it does not.

The fix is architectural: move PoW BEFORE any server-side identity exists. A caller who wants a bearer must first prove work against a server-issued challenge; only then does the server create a `members` row, a `club_memberships` row, and a `member_bearer_tokens` row.

This is not about making PoW harder. The existing difficulty constants stay. What changes is the timing: the cost is paid BEFORE the server writes anything.

---

## 1. The threat

Today's anonymous cold-join flow:

1. `clubs.join({clubSlug, email})` → server creates `members` row, `club_memberships` row in `applying`, `member_bearer_tokens` row, and a PoW challenge. Returns the plaintext bearer.
2. The caller solves PoW offline.
3. `clubs.applications.submit` → server verifies PoW, runs the legality gate, advances state to `submitted`.

Step 1 is free. A caller holding the returned bearer:

- Counts as a real authenticated identity in every per-token rate limit, audit log, and abuse counter.
- Occupies one member row, one token row, one membership row, and one PoW challenge row per call.
- Can probe any `auth: 'member'` action. Most currently reject because of club-scope checks, but future actions could forget the scope check and inherit a spam hole.
- Can rotate their own bearer via `accessTokens.create` (up to 10 active per member), buying themselves additional tokens for zero additional cost.
- Can call `accessTokens.list/revoke`, `session.getContext`, and any future non-club-scoped member-auth action.

An attacker with a botnet or residential proxy pool can mint tens of thousands of these identities in minutes. Every downstream authenticated-surface defense assumes getting past the anonymous-to-authenticated wall costs something. Right now the wall is decorative.

**Email verification does not fix this.** Determined attackers can automate email mailboxes at roughly cents per mailbox. Email verification raises the attacker's cost from zero to cents; it does not change the architectural fact that server-side identity is granted before any proof of cost.

**PoW-at-join does fix this.** A caller must expend CPU work before the server writes a single row or mints a single credential. The existing per-token, per-member rate limits then start doing the work they were designed to do.

---

## 2. Scope

In this plan:

- New action `clubs.prepareJoin` (anonymous) issues an HMAC-signed PoW challenge. No DB writes.
- `clubs.join` anonymous path requires a solved challenge before creating `members`/`club_memberships`/`member_bearer_tokens`.
- `clubs.applications.submit` drops its PoW verification entirely. The bearer is proof that PoW was paid at join.
- One-time-use enforcement: a `consumed_pow_challenges` table prevents replay of solved challenges.
- SKILL.md and docs/design-decisions.md updates.
- Tests, including the migration story for in-flight `applying` memberships created before cutover.

Not in this plan:

- **Difficulty changes.** `COLD_APPLICATION_DIFFICULTY = 7` stays as-is. The architectural timing shift is the point; re-tuning the magnitude is a separate question that can be revisited later if real data says so. `CROSS_APPLICATION_DIFFICULTY` goes away entirely because cross-join PoW goes away entirely (§4.3) — that is a structural change, not a difficulty change.
- **Email verification.** Deliberately rejected; email mailboxes are automatable at scale and do not add a meaningful security property over PoW-at-join.
- **Credential mechanism change.** Bearer tokens stay. Phase B (`plans/credential-redesign.md`) replaces them with Ed25519 public-key identity; that workstream will inherit this one's PoW-at-join structure unchanged.
- **Invitation flow changes.** Invited joins continue to skip PoW — the invitation code IS the proof that a real member paid a scarce open-invitation slot.
- **Cross-join flow changes.** Two changes, both corrections of design faults rather than expansions of scope: authenticated callers joining additional clubs no longer do PoW (their existing bearer IS the receipt), AND no longer have to re-supply `email` (they already have one on file from their original identity creation; see §4.3).
- **Rate limit changes.** The anonymous IP bucket keying in `src/server.ts` must change, not just the action set. Current code keys buckets as `${action}:${ip}`, so merely adding `clubs.prepareJoin` to the `AnonymousJoinAction` set would silently create a second bucket per IP — defeating the point. The implementer MUST replace the action-in-key scheme with a shared key for both anonymous join entry points (e.g. `anon_join:${ip}`), so a single caller calling prepareJoin once and join once consumes TWO tokens from ONE bucket. This is the load-bearing change; adding actions to a set without this is a bug, not a fix.
- **PoW algorithm change.** The primitive is preserved verbatim: `sha256(challengeId + ":" + nonce)` interpreted as a hex string, with difficulty = number of trailing `0` hex nibbles required. This is the exact shape in `src/clubs/unified.ts` today. We are moving the call site and the source of `challengeId`, not rewriting the primitive. The existing `CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY` env override continues to work.

---

## 3. What Phase A gave us

Phase A shipped the onboarding gate, the activation fanout, and the state-machine validator. Nothing in this plan disturbs any of that:

- The onboarding gate still fires when `onboarded_at IS NULL AND memberships.length > 0`. Bearers minted by the new flow go through it exactly like bearers minted by the old flow.
- `invitation.accepted` and `membership.activated` notification fanout is unaffected.
- `clubadmin.memberships.setStatus` validation is unaffected.

The tactical onboarding-gate-tightening improvement discussed separately (narrowing the allowlist for pre-admission bearers) is independent of this plan and can land in either order, though shipping both before public launch is the prudent move.

---

## 4. Design

### 4.1. Two-call cold join

The anonymous cold-applicant flow becomes two network calls instead of one:

1. **`clubs.prepareJoin`** (anonymous) — issues a PoW challenge bound to a specific club. No DB writes. Returns a signed, short-lived challenge blob the client must solve.
2. **`clubs.join`** (anonymous, now requires challenge inputs) — verifies the solved challenge, consumes it, and THEN creates `members`, `club_memberships`, and `member_bearer_tokens`.

On an attacker's side:

- Spamming `clubs.prepareJoin` a million times costs the server microseconds of HMAC work per request and zero DB writes.
- Every bearer the attacker actually obtains requires solving a distinct challenge. The existing difficulty means every bearer is a real cost they have already paid.
- Downstream per-token, per-member, per-day rate limits now apply to a bounded number of identities instead of an unbounded stream.

### 4.2. Invited joins stay single-call

The invitation primitive already gates supply. A sponsor issues an invitation using their open-invitation slot (capped per sponsor per club); that is the cost of being invited. An invitee presenting a valid code does not also pay PoW.

Flow is unchanged from today: `clubs.join({clubSlug, email, invitationCode})`, no `prepareJoin`, no nonce. Server validates the code, creates everything, returns bearer. Same single call.

### 4.3. Authenticated cross-joins stay single-call, drop PoW, and drop the email prompt

A caller presenting a valid Authorization: Bearer already owns an authenticated identity that was minted by paying PoW once. They do not re-pay per additional club.

Flow: `clubs.join({clubSlug})` with Authorization: Bearer. No `prepareJoin`, no nonce, **no `email` input**. The server reuses the member, creates the new membership, and returns `memberToken: null` (unchanged from current code — authenticated cross-join has always returned null here and must keep returning null).

**The email input is eliminated for authenticated callers.** Today the server throws `contact_email_required` on cross-join if no contact email is on file for the actor; that is a design fault, not a feature. An authenticated member by definition already supplied an email at some point in their identity history — if none is on file it is a data-integrity bug on a prior write path, not something the caller should be asked to re-supply at cross-join time.

Specifically:

- The anonymous-path email requirement stays (§4.1) — that is the whole point of clubs.join creating a member row.
- The authenticated-path email read is removed from the cross-join branch. Because `clubs.join` is one `auth: 'optional_member'` action with a single wire schema shared across anonymous and authenticated callers, `email` has to remain a valid wire-level input — transport strictness cannot reject it selectively. The rejection is therefore **semantic, on the authenticated branch AFTER auth resolution**: if the caller is authenticated AND `email` is present, return 422 with a clear message explaining that authenticated callers do not supply email. The anonymous branch continues to read `email` normally.
- The `contact_email_required` business error is removed from the authenticated-path contract; it still applies only to anonymous joins where the caller forgets to pass `email`. `src/schemas/clubs.ts`'s `businessErrors` entry stays but its `meaning` text narrows to "Anonymous caller did not supply email."
- Member-creation paths that currently leave contact email unset — notably `createMemberDirect` (backing `superadmin.members.createWithAccessToken`) and `db/seeds/dev.sql` — are audited and fixed to always set a contact email. Dev-seed members get deterministic test emails (e.g. `alice.hound.dev@clawclub.local`).
- A one-shot backfill in the same migration as §6 sets a placeholder `contact_email` for any existing member row without one, so cross-join never hits the "no email on file" path after cutover. Placeholder shape: `<memberId>@backfill.clawclub.local`. This is logged at backfill time so operators can identify backfilled rows and ask the humans for their real email out-of-band when convenient.

The existing `CROSS_APPLICATION_DIFFICULTY = 5` constant is removed along with PoW from the cross-join path, since authenticated cross-joiners no longer do PoW at all.

### 4.4. Challenge format — HMAC-signed blob

A challenge is a base64url-encoded message authentication code over a canonical payload. Stateless issuance: no DB write when a challenge is created. Replay prevention: one-time consumption enforced at solve time (§4.5).

Payload structure:

```
challenge = base64url(payload) + "." + base64url(hmac_sha256(HMAC_KEY, payload))

payload = {
  v: 1,                   // version, so we can evolve format later
  id: <20-char string>,   // challenge id; both the consumption key AND the material hashed against
  clubId: <club_id>,      // binds challenge to one specific club
  difficulty: <int>,      // COLD_APPLICATION_DIFFICULTY at issuance time
  expiresAt: <unix-ms>    // TTL wall, default 10 minutes
}
```

`HMAC_KEY` lives in the server's environment (`CLAWCLUB_POW_HMAC_KEY`), is rotatable, and has one authoritative active value plus one optional previous value during rotation windows. Issuance always uses the active key. Verification accepts either active or previous, so a rotation does not invalidate in-flight challenges.

Client solves PoW by finding a `nonce` such that `sha256(id + ":" + nonce)` (interpreted as a hex string) ends in at least `difficulty` zero nibbles. This is the **exact** primitive in `src/clubs/unified.ts` today — same hash function, same canonical form, same trailing-zero-nibble counting rule. The only change is that `id` is now the `id` field from the HMAC-signed challenge payload rather than a row id from `application_pow_challenges`.

### 4.5. Consumption enforcement

A successful `clubs.join` verifies the challenge signature, then attempts to insert the challenge id into a one-time-use table:

```sql
create table public.consumed_pow_challenges (
  challenge_id text primary key,
  consumed_at  timestamptz not null default now(),
  club_id      public.short_id not null references public.clubs(id) on delete cascade
);
create index consumed_pow_challenges_consumed_idx on public.consumed_pow_challenges (consumed_at);
```

The `PRIMARY KEY` on `challenge_id` enforces at-most-once use. A second `clubs.join` attempt replaying the same challenge fails with a unique-violation, translated to a clear error. The row exists only long enough to prevent replay within the challenge's TTL window; a cleanup job removes rows older than 24 hours. The row's existence is proof-of-consumption, nothing else.

No rate limit on inserts — the only way to write a row is to solve the PoW first, which is itself the cost.

### 4.6. `clubs.applications.submit` drops PoW; submit budget relocates to `club_memberships`

The bearer is now proof that PoW was paid at join time. Submit no longer needs to verify PoW; it just runs the legality gate and advances state.

Specifically:

- The `nonce` input field on `clubs.applications.submit` is removed from the action schema.
- The server-side PoW verification path in the submit handler is deleted.
- The `application_pow_challenges` table (per-membership, used today to carry both the PoW verdict AND the attempt budget + 24h wall) is dropped entirely.

**The submit attempt budget and 24h wall move to `club_memberships`.** Two new columns:

```sql
alter table public.club_memberships
  add column submit_attempt_count integer not null default 0,
  add column submit_window_expires_at timestamptz;
```

- `submit_attempt_count` is incremented on every call to `clubs.applications.submit` that reaches the gate and receives a real verdict — `passed` and `needs_revision` count. `unavailable` (infra outage; surfaces as `gate_unavailable`) does NOT count. These are the only verdicts the application gate returns today (`src/admissions-gate.ts`); if a future gate status is added, the plan must be updated to specify whether it counts.
- `submit_window_expires_at` is set to `now() + interval '24 hours'` on the FIRST successful `clubs.join` that creates the membership (both anonymous cold and authenticated cross paths). The wall is fixed from membership creation; it does not reset on revision, matching Phase A's hard-wall semantics.
- The existing `MAX_APPLICATION_ATTEMPTS = 6` constant stays, read and enforced against `submit_attempt_count`.
- Business error codes stay as they are today: `attempts_exhausted` when `submit_attempt_count >= 6`, `challenge_expired` when `now() > submit_window_expires_at`.

On a successful `submit` that transitions the membership to `submitted`, both columns are preserved on the row; this lets admins see "this membership was submitted 3 times within the window" as a signal. They are not reset on later state transitions.

Cross-join PoW-less joins still set `submit_window_expires_at` at creation time, so cross-joiners also have a 24h wall for their submission attempt budget. This matches current behavior — cross-join memberships already sit on a 24h `application_pow_challenges.expires_at` today (Phase A's tuning already landed this). We are relocating that window onto `club_memberships`, not changing its magnitude.

### 4.7. Error shapes

New anonymous-path errors on `clubs.join`:

- `challenge_required` (422) — `challengeBlob` and `nonce` inputs were not provided on the anonymous path. Recovery: call `clubs.prepareJoin` first.
- `invalid_challenge` (422) — the challenge blob failed HMAC verification, is malformed, or has a mismatched `clubId`. Recovery: call `clubs.prepareJoin` again and solve the new challenge.
- `challenge_expired` (422) — the challenge's `expiresAt` has passed. Recovery: call `clubs.prepareJoin` again.
- `challenge_already_used` (409) — the challenge id was already consumed. Recovery: call `clubs.prepareJoin` again and solve the new challenge.
- `invalid_proof` (422) — existing error code, reused. The submitted `nonce` does not satisfy the challenge's difficulty. Recovery: solve the challenge and retry.

The existing `challenge_expired` / `invalid_proof` / `attempts_exhausted` codes on `clubs.applications.submit` are adjusted:

- `invalid_proof` is removed entirely from submit's business-error declarations — PoW is no longer verified there.
- `challenge_expired` stays on submit, but its declared meaning changes from "PoW challenge TTL elapsed" to "application submission window elapsed," enforced against `club_memberships.submit_window_expires_at`.
- `attempts_exhausted` stays, enforced against `club_memberships.submit_attempt_count`.

### 4.8. In-flight migration

At deploy time there may be memberships in `applying` that were created under the old flow. Their bearers are already minted. Under the new flow, submit does not verify PoW — so those memberships can submit successfully without needing to re-solve their original challenge. No special migration code needed on the happy path.

One subtlety: old-flow in-flight memberships may have already paid PoW once via the `application_pow_challenges` row that was created at join time. The migration's backfill UPDATE (§6.3) preserves their attempt count and remaining 24h window by copying those values onto `club_memberships` before dropping the source table.

---

## 5. API surface changes

### 5.1. New action

- **`clubs.prepareJoin`** — `auth: 'none'`, `safety: 'read_only'`. Input: `{ clubSlug: string }`. Output: `{ clubId, challengeBlob, challengeId, difficulty, expiresAt }`. `challengeId` is the `id` field extracted from the HMAC payload and surfaced to the client because the client needs it to compute `sha256(challengeId + ":" + nonce)` — it is NOT a separate piece of material, just a convenient read of the same value without forcing the client to parse the challenge blob. The challenge blob is still what the server verifies; `challengeId` is a client-side ergonomic. No DB writes. Shares the anonymous IP rate-limit bucket with `clubs.join` — see the rate-limit bullet in §2 (Scope) and §4.4.

### 5.2. Modified actions

- **`clubs.join`** — anonymous path gains two required inputs: `challengeBlob` (the signed challenge from `prepareJoin`) and `nonce` (the client's PoW solution). Anonymous-path behavior: verify signature → check expiry → verify PoW against the difficulty baked into the challenge → insert into `consumed_pow_challenges` → create member, membership, bearer. The `clubId` inside the challenge must match the resolved `clubId` from `clubSlug`; mismatches produce `invalid_challenge`. Invitation-backed paths are unchanged. **Authenticated cross-join path behavior changes: the `email` input is no longer accepted or required, and the response's `memberToken` continues to be `null` (this is unchanged from current code and must stay that way — the caller uses their existing bearer).**
- **`clubs.applications.submit`** — the `nonce` input field is removed. The handler drops PoW verification. Attempt budget and 24h wall move to `club_memberships` columns per §4.6. `invalid_proof` is removed from its business-error list. `attempts_exhausted` stays (now enforced against `submit_attempt_count`). `challenge_expired` stays (now enforced against `submit_window_expires_at`).

### 5.3. Removed

- Input field `nonce` on `clubs.applications.submit`.
- Business error code `invalid_proof` on `clubs.applications.submit` (moved to `clubs.join` anonymous path).
- Constant `CROSS_APPLICATION_DIFFICULTY` in `src/clubs/unified.ts` (cross-joins no longer do PoW).
- The `proof` block returned by today's `clubs.join`. Anonymous callers receive PoW details on `prepareJoin` instead; authenticated and invitation-backed callers never needed it. `clubs.join`'s response shape simplifies to `{ clubId, membershipId, memberToken, club }`, where `memberToken` is non-null only on anonymous-after-PoW and invitation-backed paths.
- The `contact_email_required` error path on authenticated calls. The error code stays on the anonymous path only (caller forgot `email`); it is never raised for authenticated callers. This closes the design fault where a seeded or superadmin-created member could be asked to re-supply an email they had never explicitly provided but should be inferable from their identity record (§4.3).
- Reading of `application_pow_challenges` anywhere in the codebase. The table is dropped.

---

## 6. Data model changes

### 6.1. Migration file

Create `db/migrations/NNN_pow_at_join.sql` using the next unused migration number. Apply via `scripts/migrate.sh`.

### 6.2. Schema changes

```sql
-- One-time consumption enforcement for solved PoW challenges.
create table public.consumed_pow_challenges (
  challenge_id text primary key,
  consumed_at  timestamptz not null default now(),
  club_id      public.short_id not null references public.clubs(id) on delete cascade
);
create index consumed_pow_challenges_consumed_idx on public.consumed_pow_challenges (consumed_at);

-- Relocate the submit attempt budget and 24h wall out of application_pow_challenges.
-- See §4.6 for semantics.
alter table public.club_memberships
  add column submit_attempt_count integer not null default 0,
  add column submit_window_expires_at timestamptz;

-- Backfill the submit budget for in-flight memberships before dropping the source table.
update public.club_memberships cm
set submit_attempt_count = coalesce(pow.attempts, 0),
    submit_window_expires_at = pow.expires_at
from public.application_pow_challenges pow
where pow.membership_id = cm.id
  and cm.status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending');

drop table if exists public.application_pow_challenges;
```

### 6.2.1. Contact-email data-integrity backfill

§4.3 eliminates the authenticated-path `contact_email_required` error. That only works cleanly if every member in the database has a usable email on file. The current schema (`db/init.sql`) allows BOTH "no row in `member_private_contacts` for this member" AND "row exists but `email IS NULL`" to mean "no email on file," and runtime code in `src/clubs/unified.ts` treats both as equivalent for the join flow. The migration must backfill both cases:

```sql
-- Case 1: member has no row at all → insert a placeholder row.
insert into public.member_private_contacts (member_id, email, created_at)
select m.id, m.id || '@backfill.clawclub.local', now()
from public.members m
where not exists (
  select 1 from public.member_private_contacts pc where pc.member_id = m.id
);

-- Case 2: member has a row but email IS NULL → fill in the placeholder.
update public.member_private_contacts
set email = member_id || '@backfill.clawclub.local'
where email is null;
```

This ensures every member ends up with a usable email on file. The placeholder domain `backfill.clawclub.local` is never routable, so no real email could ever collide with it. Operators can identify backfilled rows later by the suffix, reach out to the humans out-of-band for their real address, and update the row with a normal `UPDATE`. Path-forward: `createMemberDirect` and every future member-creation code path MUST set a contact email (non-null), so this backfill is a one-time fix and no new email-less rows enter the table.

The table name is `member_private_contacts`, confirmed against current `db/init.sql`.

### 6.3. Dropping `application_pow_challenges`, adding submit-budget columns

The existing `application_pow_challenges` table (keyed by membership, populated at `clubs.join` time, carrying `attempts`, `expires_at`, `solved_at`, verified at `clubs.applications.submit` time) is fully replaced. The migration:

```sql
alter table public.club_memberships
  add column submit_attempt_count integer not null default 0,
  add column submit_window_expires_at timestamptz;

-- Backfill in-flight memberships: preserve their remaining window.
update public.club_memberships cm
set submit_attempt_count = coalesce(pow.attempts, 0),
    submit_window_expires_at = pow.expires_at
from public.application_pow_challenges pow
where pow.membership_id = cm.id
  and cm.status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending');

drop table if exists public.application_pow_challenges;
```

The backfill UPDATE means in-flight pre-cutover memberships keep their original attempt count and 24h wall (from the old table's `expires_at` column, which Phase A's tuning bumped to 24h). Memberships in terminal states (`active`, `banned`, `declined`, etc.) do not need the backfill because they will never call `submit` again; `submit_window_expires_at` stays NULL for them, which is fine — the submit handler only reads it while the membership is still pre-`submitted`.

Any references to `application_pow_challenges` in application code are removed in the same commit.

Pre-cutover check: confirm no in-flight memberships need the table to persist beyond cutover. They do not — the new submit path reads from `club_memberships` only.

### 6.4. HMAC key provisioning

`CLAWCLUB_POW_HMAC_KEY` is a required env var. The server fails to boot if it is missing in production. In development and tests, the server generates a stable per-process random key if the env var is absent and logs a warning. Deploy configuration adds the key to Railway's env.

A second env var `CLAWCLUB_POW_HMAC_KEY_PREVIOUS` is optional and accepted-only-for-verification during a rotation window.

### 6.5. Migration test

This is a **data-rewrite migration**, not schema-only. It performs two backfills:

- The submit-budget backfill copies `attempts` and `expires_at` from `application_pow_challenges` onto the matching `club_memberships` rows before dropping the source table (§6.3).
- The contact-email backfill inserts placeholder rows into `member_private_contacts` for every member missing one (§6.2.1).

Both must be tested against synthetic pre-migration data per CLAUDE.md's data-rewrite migration rules. The discipline is the same as other data-rewrite migrations we've shipped — empty-DB tests would silently skip both code paths.

1. `git show main:db/init.sql > /tmp/init_pre.sql`.
2. Create a scratch DB, apply pre-migration schema.
3. Insert synthetic data covering every shape the backfills touch:
   - `application_pow_challenges` rows with varied `attempts` (0, 3, 6) and `expires_at` (future, past) tied to memberships in every non-terminal state.
   - Memberships in terminal states (`active`, `declined`, `banned`) whose `application_pow_challenges` rows should NOT be backfilled.
   - Members WITH a `member_private_contacts` row AND a non-null email (should be left alone).
   - Members WITH a `member_private_contacts` row but `email IS NULL` (should have the placeholder UPDATE'd in).
   - Members WITHOUT any `member_private_contacts` row (should receive a fresh placeholder INSERT).
4. Run `scripts/migrate.sh`.
5. Verify: `application_pow_challenges` is gone, `consumed_pow_challenges` exists, `club_memberships.submit_attempt_count` and `submit_window_expires_at` match the backfill for non-terminal rows and remain at defaults for terminal rows, every member has a `member_private_contacts` row, pre-existing emails are preserved.

### 6.6. Pre-cutover prod queries

```sql
-- How many in-flight applying memberships will be caught by the backfill UPDATE?
select count(*) from club_memberships where status = 'applying';

-- Any application_pow_challenges rows tied to terminal memberships? (Informational; backfill excludes them.)
select cm.status, count(*)
from application_pow_challenges pow
join club_memberships cm on cm.id = pow.membership_id
group by cm.status
order by 2 desc;

-- Any applying/submitted memberships missing an application_pow_challenges row? (Expected: zero.)
select count(*)
from club_memberships cm
left join application_pow_challenges pow on pow.membership_id = cm.id
where cm.status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending')
  and pow.membership_id is null;
```

---

## 7. SKILL.md updates

Phase A already rewrote the onboarding section. This plan changes the cold-apply section — cold joins become a two-call flow.

### 7.1. Rewrite the cold-apply sequence

Replace the current single `clubs.join` step with:

1. Call `clubs.prepareJoin({clubSlug})`. You get back `{ clubId, challengeBlob, challengeId, difficulty, expiresAt }`.
2. Solve the PoW — find a `nonce` such that `sha256(challengeId + ":" + nonce)` (interpreted as a hex string) ends in at least `difficulty` trailing zero nibbles. Same primitive as today's submit-time PoW; only the call site moved.
3. Call `clubs.join({clubSlug, email, challengeBlob, nonce})`. The server verifies the solution against the blob and mints a bearer only on success. This is the call that creates your identity.
4. Save `memberToken` immediately. Losing it means losing access to that membership.
5. Call `clubs.applications.submit({membershipId, applicationName, applicationText, applicationSocials})`. No nonce. The bearer is proof that you paid PoW at join time.
6. Rest of the flow (payment_pending, activation, ceremony) is unchanged from Phase A.

**Invited callers.** Skip step 1 and step 2. Call `clubs.join({clubSlug, email, invitationCode})` directly. No PoW, no `prepareJoin`. The invitation code is your proof of cost.

**Authenticated cross-joiners.** Skip step 1 and step 2. Call `clubs.join({clubSlug})` with your existing Authorization: Bearer. No PoW, no `prepareJoin`.

### 7.2. Error-recovery additions

Extend the cold-apply failure table:

- `challenge_required` (422 on `clubs.join`) → "You forgot to call `clubs.prepareJoin` first on the anonymous path. Call it, solve the PoW, and retry."
- `invalid_challenge` (422 on `clubs.join`) → "The challenge blob was not issued by this server, was malformed, or targets a different club. Call `clubs.prepareJoin` again."
- `challenge_expired` (422 on `clubs.join`) → "The 10-minute challenge TTL elapsed. Call `clubs.prepareJoin` again."
- `challenge_already_used` (409 on `clubs.join`) → "The challenge you solved was already consumed by a previous `clubs.join`. Call `clubs.prepareJoin` again."
- `invalid_proof` (422 on `clubs.join`) → "Your `nonce` does not satisfy the challenge's difficulty. Re-solve with the same challenge and retry — but only if the challenge has not expired."

Remove from the table:

- `invalid_proof` on `clubs.applications.submit` — PoW is no longer verified here.
- (`challenge_expired` stays on `clubs.applications.submit` but its meaning narrows to "submission window elapsed." Call out the meaning change in the action description.)

### 7.3. Copy tone and wall-clock expectation

SKILL.md's existing guidance about warning the user that PoW may take time moves from the submit section to the prepareJoin/join section. The PoW happens earlier in the flow now; the warning needs to appear earlier.

**Wall-clock language must be concrete.** Replace "may take time" with a real ballpark. Use **"expect this to take 2-3 minutes on a typical machine"**. True wall-clock depends on the caller's CPU clock speed, which the server cannot know, so we cannot give a precise number — but "may take time" is too vague and an external agent test already surfaced this as a gap. Include a note that longer is possible on slower hardware and that the agent should tell the human up front rather than letting them wonder if the conversation has stalled.

### 7.4. Cross-join clarification

Add explicit SKILL.md text: authenticated cross-join callers do NOT need to pass `email` (the server has one on file) and do NOT need to solve PoW (their bearer is the receipt). Both of these are simplifications vs today's behavior; the text should name them as changes rather than as edge cases that happen to work.

### 7.5. Bootstrap paradox

`GET /` currently directs agents to `/skill`, and `/skill` directs agents to `GET /api/schema` before any action call. An external agent reviewer flagged this as sloppy because the ordering between `/skill` and `/api/schema` isn't explicit — a literal reader has to decide whether "read /skill first" supersedes or precedes "read schema first."

Fix: align both endpoints on a single explicit ordering. `GET /` returns a one-line ordered bootstrap: (1) fetch `/skill`, (2) fetch `/api/schema`, (3) call actions. `/skill`'s opening line matches — "you are reading step 1; step 2 is `GET /api/schema`". This is a tiny wording change, not a new endpoint, and it removes the ambiguity without adding surface area.

---

## 8. docs/design-decisions.md updates

Add to "Security and permissions":

- Anonymous `clubs.join` requires a solved proof-of-work challenge from `clubs.prepareJoin` before creating a `members` row or minting a bearer. This moves the cost of obtaining an authenticated identity from "free" to "one successful PoW solve per identity," which is what every downstream per-token rate limit depends on.

Add to "Membership and trust":

- Cold applicants pay proof-of-work at `clubs.join`, not at `clubs.applications.submit`. The bearer is proof-of-work receipt.
- Invited applicants skip PoW — the invitation slot is the proof of cost.
- Authenticated cross-joiners skip PoW — their existing bearer is the proof of cost.

Add to "Current implementation milestones" (at ship time):

- `clubs.prepareJoin` issues HMAC-signed PoW challenges without DB writes; `clubs.join` anonymous path requires a solved challenge before creating a member and bearer.

Update the "How someone joins a club" wording anywhere it still implies single-call anonymous join.

---

## 9. Test plan

All integration tests exercise the full HTTP path through `TestHarness`.

### 9.1. Unit tests

- `src/pow-challenge.ts` module (or wherever the HMAC helpers live): round-trip issue → verify for a valid challenge; reject tampered payload; reject wrong HMAC key; reject expired challenge; honor the optional previous-key slot during rotation.

### 9.2. Integration — cold flow happy path

- `clubs.prepareJoin` returns a challenge with all expected fields.
- Solving the PoW at the returned difficulty is tractable (use `CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY` override for fast tests — same mechanism already used today).
- `clubs.join` with the challenge, nonce, and email creates a member, membership, and bearer. Response shape matches the new schema (no `proof` block).
- Follow-up `clubs.applications.submit` with no `nonce` advances the membership to `submitted`.

### 9.3. Integration — cold flow negative paths

- `clubs.join` anonymous path with no challenge → 422 `challenge_required`.
- `clubs.join` with a challenge blob whose `clubId` does not match `clubSlug` → 422 `invalid_challenge`.
- `clubs.join` with a challenge blob whose signature is invalid → 422 `invalid_challenge`.
- `clubs.join` with an expired challenge → 422 `challenge_expired`.
- `clubs.join` with a nonce that does not meet the difficulty → 422 `invalid_proof`.
- `clubs.join` with a valid challenge but reused (second call with same `challenge_id`) → 409 `challenge_already_used`, no second member created, no second bearer issued.

### 9.4. Integration — other paths

- Invited cold flow: anonymous `clubs.join` with `invitationCode` AND `email`, no `prepareJoin`, no nonce → succeeds as today. `contact_email_required` still applies if `email` is absent on the anonymous path.
- Authenticated cross-join: `clubs.join` with Authorization: Bearer, no `prepareJoin`, no nonce, NO `email` → succeeds. Response `memberToken` is null. Assert that passing `email` on this path is rejected semantically (422 with a clear message) by the authenticated-branch handler AFTER auth resolution — NOT by transport/wire strictness (which cannot reject a field that is valid for the anonymous branch of the same action).
- Authenticated cross-join for a member whose contact-email row was backfilled with a `@backfill.clawclub.local` placeholder → still succeeds (the server does not read the stored email on this path anymore).
- Regression: authenticated cross-join used to return `contact_email_required` when no email was on file; assert it now succeeds with no email on file.

### 9.5. Integration — submit no longer verifies PoW, budget lives on club_memberships

- Create a membership via the new flow. Call `clubs.applications.submit` without a nonce → succeeds (gate runs, state advances). Assert `club_memberships.submit_attempt_count` incremented by 1.
- Call `clubs.applications.submit` with a nonce included in input → 422 `invalid_input` (unknown field rejected by transport validator, per existing wire-strictness rule).
- Attempt budget: make 6 consecutive `needs_revision` calls → 7th returns `attempts_exhausted`. Assert the count on `club_memberships` matches.
- 24h wall: create a membership, manually set `submit_window_expires_at` to a past timestamp via test harness → next submit returns `challenge_expired`. Assert the error message refers to the submission window, not a PoW challenge.
- Verify `gate_unavailable` (infra outage) does NOT increment `submit_attempt_count`. Only real gate verdicts — `passed` and `needs_revision` — count against the budget.

### 9.6. Integration — in-flight migration

- Prior to migration, seed a membership in `applying` with an `application_pow_challenges` row pointing at it (attempts=2, expires_at=now+12h).
- Run the migration per §6.5.
- Verify the membership still exists.
- Assert `club_memberships.submit_attempt_count = 2` and `submit_window_expires_at = now+12h` (preserved from the old table).
- Call `clubs.applications.submit` for that membership → succeeds without a nonce. `submit_attempt_count` becomes 3.
- `application_pow_challenges` table is gone.

### 9.6.1. Integration — contact-email backfill

Two cases must be tested independently:

Case A — member with no contacts row at all:
- Prior to migration, seed a member with NO `member_private_contacts` row (simulating a seed/superadmin-created member).
- Run the migration per §6.2.1.
- Verify a placeholder row exists for that member with `email = <memberId>@backfill.clawclub.local`.
- Authenticate as that member, call `clubs.join` on a new club with NO `email` input → succeeds. No `contact_email_required` error.

Case B — member with a contacts row but null email:
- Prior to migration, seed a member WITH a `member_private_contacts` row whose `email IS NULL`.
- Run the migration per §6.2.1.
- Verify the existing row was UPDATE'd so `email = <memberId>@backfill.clawclub.local`. Assert the row was not duplicated.
- Authenticate as that member, call `clubs.join` on a new club with NO `email` input → succeeds.

Case C (regression) — member with an existing real email:
- Seed a member with a `member_private_contacts` row whose `email` is a real address.
- Run the migration.
- Verify the existing email is preserved (neither overwritten nor duplicated).

### 9.7. Integration — HMAC key rotation

- Issue a challenge with key A.
- Rotate: set A as `_PREVIOUS`, B as active.
- Call `clubs.join` with the old challenge → succeeds (previous-key slot accepted).
- Issue a new challenge (now signed by B), call `clubs.join` → succeeds.
- Remove the previous-key slot. Old challenge now fails with `invalid_challenge`.

### 9.8. Manual live-server dry run

1. `clubs.prepareJoin` → challenge blob.
2. Solve PoW (test difficulty).
3. `clubs.join` with challenge + nonce + email → member + membership + bearer.
4. `clubs.applications.submit` → advances to `submitted`.
5. Confirm Phase-A onboarding gate fires for the fresh bearer (`onboarded_at IS NULL AND memberships.length > 0`).
6. Admin approves, bearer onboards, ceremony runs.
7. Attempt to replay the same challenge blob via a second `clubs.join` → 409 `challenge_already_used`.

---

## 10. Security checklist

1. **Identity creation is gated by PoW.** No `members`/`club_memberships`/`member_bearer_tokens` row is written on the anonymous cold path until a valid, non-expired, unreplayed challenge has been solved. Parameterized test covers every negative path (§9.3).
2. **Challenge replay is structurally impossible.** The `consumed_pow_challenges` primary key enforces at-most-once consumption; a duplicate insert fails atomically inside the join transaction.
3. **Challenge integrity is HMAC-signed.** An attacker cannot forge a challenge, downgrade difficulty, or extend expiry without the server's `CLAWCLUB_POW_HMAC_KEY`.
4. **Challenges are bound to a specific club.** A challenge issued for club A cannot be presented in a `clubs.join` for club B — the embedded `clubId` is part of the signed payload and cross-checked against the resolved slug.
5. **HMAC key is rotatable.** A compromised key can be replaced without invalidating in-flight challenges, via the one-slot previous-key window.
6. **`clubs.prepareJoin` is stateless.** An attacker spamming prepareJoin causes zero DB writes. Existing IP-based rate limit extends to this action to prevent CPU-burn attacks against the HMAC signer.
7. **Invited and cross-join paths are unchanged.** Adding the PoW-at-join step does not introduce new entry points for those flows; they retain their existing single-call shape and their existing proof-of-cost (invitation slot or existing bearer).
8. **Submit is simpler and no longer carries PoW responsibility.** Dropping the submit-time verification removes a code path that no longer has a job; the bearer's existence is sufficient proof.
9. **Test-mode difficulty override is confined to env vars.** `CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY` continues to exist; its production default is ignored when the env var is unset. Ship-time check: ensure no production deployment sets it.
10. **In-flight memberships at cutover are not locked out.** The new submit path works for them without PoW; their old-world bearers are accepted unchanged.
11. **Phase A onboarding gate fires on the new bearers exactly like old ones.** `onboarded_at IS NULL` is set on the new `members` row; the gate's two-condition check is unaffected by where PoW happened.

---

## 11. Open questions

Not showstoppers — flag to Owen before shipping.

1. **Cleanup cadence for `consumed_pow_challenges`.** 24h retention is the plan default. A simple DB-side cleanup job (hourly DELETE where `consumed_at < now() - 24 hours`) is sufficient. Flag if a different retention is preferred.
3. **HMAC key rotation cadence.** Plan assumes manual rotation with the previous-key slot as a rolling overlap. Flag if we want scheduled rotation.
4. **Difficulty re-tuning.** Explicitly out of scope for this plan. If real-world data after launch shows the existing difficulty is too easy, it can be re-tuned in a follow-up without touching the architecture.

**Resolved (pinned):**

- ~~Challenge TTL.~~ Pinned to 10 minutes. Long enough for a slow client to call prepareJoin, warn the human, solve PoW, and call join; short enough that a stolen in-flight challenge cannot be hoarded.
- ~~Stateless vs DB-backed challenges.~~ Stateless issuance via HMAC; one-time consumption enforced by a single small table. See §4.4 and §4.5.
- ~~PoW on authenticated cross-joins.~~ Dropped. The existing bearer is receipt. See §4.3 and §5.3.
- ~~PoW on `clubs.applications.submit`.~~ Dropped. The bearer is receipt. See §4.6.
- ~~Invitation path.~~ Unchanged; invitation slot is receipt. See §4.2.
- ~~Difficulty change.~~ None. Existing constants preserved. See §2 and §11.4.

---

## 12. Decision log

| Decision | Why |
| --- | --- |
| Move PoW before any server-side identity is created | Today's free-bearer problem undermines every downstream per-token rate limit, per-member budget, and abuse signal. Moving PoW earlier is the single architectural fix that makes every other defense start to mean something. |
| Two-call anonymous flow (prepareJoin → join) | Single-call would require the client to know challenge parameters before the server assigns them. Two-call is the minimum viable shape for "server issues challenge, client solves, server verifies." |
| HMAC-signed challenge blob, not DB-backed | Stateless issuance means `prepareJoin` costs zero DB writes; attackers can only cause CPU load. DB-backed issuance would invert the cost asymmetry. |
| One-time consumption via a small table | Replay prevention is the only thing a DB row is needed for. The `PRIMARY KEY` on `challenge_id` is the enforcement. |
| Difficulty unchanged | This plan fixes timing, not magnitude. Re-tuning difficulty is a separate question and not load-bearing for the threat model. |
| Invited joins keep the single-call shape | The invitation slot is the sponsor's paid cost; re-requiring PoW would be double-charging. |
| Authenticated cross-joins drop PoW entirely | Existing bearer is the receipt. Keeping the today's `CROSS_APPLICATION_DIFFICULTY = 5` would be theater. |
| `clubs.applications.submit` drops PoW | The bearer's existence is the proof. Two separate PoW verifications would be incoherent. |
| HMAC key rotatable via optional previous-key slot | Key compromise is a real operational concern; no-rotation-ever is an antipattern. |
| Email verification explicitly rejected | Automatable at scale; does not change the cost structure in a meaningful way. Discussed and decided with Owen. |
| PoW primitive preserved verbatim (`sha256(id + ":" + nonce)`, trailing-zero-nibble rule) | The current difficulty (7) is calibrated to the current counting scheme. Changing the primitive would invalidate that calibration and require re-tuning. The plan is about timing, not magnitude. |
| Submit attempt budget moves from `application_pow_challenges` to columns on `club_memberships` | Dropping the PoW table leaves the attempt budget and 24h wall homeless; two new columns on `club_memberships` carry them forward with no semantic change. |
| Authenticated cross-join drops the `email` input entirely | Asking authenticated members to re-supply their email is a design fault, not a feature. If a member exists, they have an identity on file. Data-integrity backfill ensures email rows exist for every member after cutover. |
| Authenticated cross-join response `memberToken` stays `null` | Current behavior, must be preserved. The caller authenticates with their existing bearer; no new token is issued. |
| Contact-email data-integrity backfill lands in the same migration | The cross-join email removal only works cleanly if every member has an email on file. Backfilling placeholders in the same commit avoids a cross-migration coupling. |
| Bootstrap paradox fixed by wording alignment, not a new endpoint | `GET /` and `/skill` agree on ordered bootstrap steps. No new endpoint surface. |
| Ship before Phase B (credential redesign) | Phase B replaces bearers with Ed25519 authenticators. That workstream inherits this one's flow unchanged, just against a different credential primitive. Doing PoW-at-join first means Phase B does not re-argue the threat model. |

---

## 13. Rollout plan

### 13.1. Implementation order

1. **PoW helper module.** `src/pow-challenge.ts` (or extend an existing module). HMAC sign/verify, difficulty check, expiry check. Unit tests.
2. **Migration.** Write `NNN_pow_at_join.sql`. Create `consumed_pow_challenges`, add `submit_attempt_count`/`submit_window_expires_at` to `club_memberships`, run the submit-budget backfill, drop `application_pow_challenges`, run the `member_private_contacts` backfill. Test against synthetic data per §6.5. Apply via `scripts/migrate.sh`.
3. **`clubs.prepareJoin`.** New action per §5.1.
4. **`clubs.join`** anonymous-path rewrite per §4.1 and §5.2. Authenticated and invitation paths untouched.
5. **`clubs.applications.submit`** — drop the `nonce` field, drop the PoW check, drop the two PoW-flavored business errors.
6. **Env var wiring.** `CLAWCLUB_POW_HMAC_KEY` required in prod; `_PREVIOUS` optional. Dev/test fallback with warning.
7. **Rate limit key restructure.** In `src/server.ts`, change the anonymous-join rate-limit key from `${action}:${ip}` to a shared-bucket key like `anon_join:${ip}` that covers both `clubs.join` AND `clubs.prepareJoin`. Verify by test: one caller doing prepareJoin + join consumes two tokens from the same bucket.
8. **SKILL.md and docs/design-decisions.md** updates. Same commit as code.
9. **Integration tests** per §9.
10. **Manual live-server dry run** per §9.8.
11. **Pre-cutover prod queries** per §6.6.
12. **Commit.** Bump `package.json` patch version. **DO NOT push.** Present to Owen.

### 13.2. Deploy

When authorized, push triggers Railway auto-deploy. Monitor:

- `/api/schema` contains `clubs.prepareJoin` and the updated `clubs.join` shape.
- `clubs.applications.submit`'s schema no longer contains `nonce`.
- First cold applicant through the new path works end-to-end.
- No `challenge_required` errors for invitation or cross-join flows.
- In-flight `applying` memberships created before cutover can still submit without `nonce`.

### 13.3. Rollback

`git revert` + push is **not sufficient by itself** because the migration dropped `application_pow_challenges` and the reverted code expects to read from it. A revert followed by a real application join or submit would hit "relation does not exist."

Actual rollback path, in order of preference:

1. **Forward-fix.** If the break is recoverable by patching code (bug in the new submit handler, wrong field name, etc.), fix forward — write the patch, bump the version, commit, push. This is almost always the right answer.
2. **Compensating migration + revert.** If the break is unrecoverable by code changes (architectural mistake, missed edge case, downstream data corruption), write a NEW migration that recreates `application_pow_challenges` from scratch with the columns the old code expects, then git-revert the code commit. The recreated table starts empty, which is fine — in-flight applying memberships continue via the new `club_memberships` columns which the reverted code doesn't read, so those get stuck until the forward-fix lands. Revert is a circuit breaker, not a data restoration.
3. **DB restore from the pre-deploy snapshot.** Last resort. Any writes accepted between deploy and restore are lost. Only use if the break is data corruption that's actively compounding.

Pre-deploy ritual: snapshot the **prod** DB immediately before applying the migration in prod, and keep the snapshot for 24 hours past the deploy. The snapshot is the fallback for option 3 only; forward-fix is overwhelmingly more likely to be the right path.

The additive migration pieces (`consumed_pow_challenges`, `club_memberships` new columns, `member_private_contacts` placeholder rows) stay regardless; they're inert for a reverted server.

---

## 14. What "done" looks like

- [ ] Migration written, tested against scratch DB with synthetic data (both in-flight memberships AND email-less members), applied via `scripts/migrate.sh`.
- [ ] `db/init.sql` updated — `consumed_pow_challenges` present, `application_pow_challenges` removed, `club_memberships` has `submit_attempt_count` and `submit_window_expires_at`.
- [ ] Contact-email backfill executed in the migration; every member in `members` has a row in the contact-email table after cutover.
- [ ] `createMemberDirect` (and any other member-creation code path) updated to always write a contact-email row at member creation; `db/seeds/dev.sql` updated to emit emails for seeded members.
- [ ] PoW helper module with unit tests. Primitive preserved: `sha256(id + ":" + nonce)`, trailing-zero-nibble rule.
- [ ] `clubs.prepareJoin` implemented per §5.1.
- [ ] `clubs.join` anonymous path rewritten; invitation path unchanged; **authenticated path updated to reject `email` as unknown input and keep returning `memberToken: null`**.
- [ ] `clubs.applications.submit` drops `nonce` and PoW verification; attempt budget reads/writes `club_memberships` columns.
- [ ] `CLAWCLUB_POW_HMAC_KEY` wired through env; dev fallback with warning.
- [ ] Rate-limit key in `src/server.ts` restructured to share a single bucket across `clubs.join` and `clubs.prepareJoin` (NOT just action-set expansion — keying must change from `${action}:${ip}` to a shared anonymous-join key). Test proves prepareJoin+join consumes two tokens from the same bucket.
- [ ] SKILL.md rewritten per §7, including the "2-3 minutes on a typical machine" PoW wall-clock language, the explicit cross-join-no-email statement, and the bootstrap-paradox fix.
- [ ] `GET /` response aligned with `/skill` on ordered bootstrap steps.
- [ ] `docs/design-decisions.md` updated per §8.
- [ ] Integration tests per §9 pass.
- [ ] Manual live-server dry run passes.
- [ ] Pre-cutover prod queries reviewed.
- [ ] `npm run check` and `npm run test:all` pass.
- [ ] `package.json` patch version bumped.
- [ ] Local commit created. **No push.** Implementing agent presents to Owen for explicit authorization.

When Owen authorizes, push, then:

- [ ] Fresh cold-apply via the two-call flow works end-to-end in production.
- [ ] Invited cold-apply still works as today.
- [ ] Authenticated cross-join still works as today.
- [ ] In-flight pre-cutover `applying` memberships can still submit.
- [ ] No spike in `challenge_*` errors in the first 24h (would indicate a client-side shape bug or a wrong error code mapping).

Only then is this workstream complete. Next: `plans/credential-redesign.md` (Phase B).
