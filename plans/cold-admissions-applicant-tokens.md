# Plan: Outsider Admissions Redesign

## Context for the reviewing agent

This plan has already been discussed with the owner.

- Breaking API changes are explicitly allowed.
- Database migration is explicitly allowed.
- The goal is the cleanest design from first principles, not compatibility with the current API.
- The main product scope is outsider admissions:
  - cold self-apply
  - member sponsorship of outsiders
  - applicant status polling
  - applicant token exchange after acceptance
- Cross-applying should stay behaviorally the same, but API naming may be cleaned up if that makes the overall surface more coherent.
- Billing compatibility is mandatory. This design must fit the existing and planned `payment_pending -> active` membership lifecycle in [docs/billing-sync-contract.md](/Users/owen/Work/ClawClub/clawclub-server/docs/billing-sync-contract.md) and [company/billing-design.md](/Users/owen/Work/ClawClub/clawclub-server/company/billing-design.md).

## Executive recommendation

The right design is:

1. Sponsorship becomes a first-class record in its own table.
2. Sponsorship does **not** create an admission.
3. There is exactly one outsider admission path:
   - begin application
   - submit application
   - poll applicant status
   - exchange applicant token after acceptance
4. A valid sponsorship code lets the outsider skip PoW during that normal outsider application flow.
5. The resulting admission is still a normal self-application, with one or more attached sponsorship signals.
6. On acceptance, the outsider gets a normal member token by exchanging their applicant token.
7. Billing remains separate. Accepted paid admissions still become `payment_pending` before they become accessible.

This is cleaner than bolting sponsorship onto the old model, and much cleaner than creating a separate sponsored-admission record and trying to merge it later.

---

## Design goals

## 1. One outsider join attempt = one admission

The current `member_sponsored` admission model is structurally awkward because it creates an admission before the outsider has actually applied.

That makes it hard to answer basic questions cleanly:

- Which application text is the real one?
- Which record gets accepted?
- What if the outsider was sponsored by multiple members?
- What happens when billing later needs the accepted admission to map to one membership?

The clean model is:

- one outsider application -> one admission
- zero or more sponsorships -> signals attached to that admission

## 2. Sponsorship is a trust signal, not a path

Sponsorship should not be a parallel admissions path.

It should do one thing:

- reduce friction for a specific outsider by replacing PoW with sponsor-backed trust

That preserves a single outsider application workflow while still rewarding real-world trust.

## 3. Agents should never have to guess which API to call

The current public outsider flow is:

- request challenge
- solve PoW
- submit application

As soon as sponsorship can skip PoW, `requestChallenge` becomes the wrong abstraction.

The agent should not have to infer:

- "Am I in a challenge flow?"
- "Am I in a sponsorship flow?"
- "Should I call a different submit endpoint?"

The API should make the next step explicit in the response.

## 4. The auth boundary should stay sharp

Cold outsiders are not members before acceptance.

So they should not receive normal member tokens before acceptance, and they should not get early member rows just to support status polling.

Applicant auth should remain:

- admission-scoped
- narrow
- non-member

## 5. Billing remains downstream of admission

Admission acceptance and club access are not the same thing for paid clubs.

The design must preserve:

- accepted outsider -> member exists
- paid club -> membership may still be `payment_pending`
- access appears only after billing activation

---

## The core model

## Sponsorships become a separate primitive

A sponsorship is:

- a member in a club saying "this outsider should be able to apply without PoW"
- addressed to a specific outsider email
- represented by a shareable sponsorship code
- redeemable into the outsider's one real admission

It is **not**:

- itself an admission
- itself an account
- itself a membership

## Outsider applications become session-based

Replace the public "request challenge" abstraction with a broader "begin application" abstraction.

Why:

- an outsider may need PoW
- an outsider may have a sponsorship code and need no PoW
- the agent should always start in the same place

So the flow becomes:

1. `beginApplication`
2. inspect returned `proof.kind`
3. `submitApplication`

That is explicit and simple.

## Applicant tokens remain the post-submit credential

Once the outsider successfully submits an application, they receive an applicant token.

That token can:

- read status of that one admission
- exchange into a normal member token after acceptance

It cannot:

- call member actions
- access club data
- access updates or SSE

---

## Recommended API surface

## Remove or replace the current outsider/sponsorship actions

Replace:

- `admissions.public.requestChallenge`
- `admissions.public.submitApplication` result semantics
- `admissions.sponsorCandidate`

Recommended forward API:

- `admissions.public.beginApplication`
- `admissions.public.submitApplication`
- `admissions.applicant.getStatus`
- `admissions.applicant.exchange`
- `admissions.sponsorships.issue`
- `admissions.sponsorships.listMine`
- `admissions.sponsorships.revoke`

Recommended consistency rename:

- `admissions.crossClub.requestChallenge` -> `admissions.crossClub.beginApplication`

Cross-applying does not need new behavior, but the begin/submit naming pattern is clearer and more consistent for agents.

---

## Agent call sequences

This section is the most important one for API ergonomics.

If the agent can follow these flows without guesswork, the API is doing its job.

## Flow A: outsider with no sponsorship

1. Agent calls `admissions.public.beginApplication` with:
   - `clubSlug`
2. Server returns:
   - `sessionId`
   - `club`
   - `proof.kind = 'pow'`
   - PoW parameters
3. Agent solves PoW.
4. Agent calls `admissions.public.submitApplication` with:
   - `sessionId`
   - `email`
   - `nonce`
   - `nonce`
   - `name`
   - `socials`
   - `application`
5. If accepted by the admission gate, server returns:
   - `status = 'submitted'`
   - `admissionId`
   - `applicantToken`
6. Agent stores the applicant token.
7. Agent polls `admissions.applicant.getStatus`.
8. Once accepted, agent calls `admissions.applicant.exchange`.

## Flow B: outsider with sponsorship code

1. Agent asks the human for:
   - `clubSlug`
   - `email`
   - `sponsorshipCode`
2. Agent calls `admissions.public.beginApplication`.
3. Server returns:
   - `sessionId`
   - `club`
   - `proof.kind = 'sponsorship'`
4. Agent calls `admissions.public.submitApplication` with:
   - `sessionId`
   - `email`
   - `name`
   - `socials`
   - `application`
5. The rest is identical to Flow A.

There is no separate "sponsored outsider admissions" path after that point.

## Flow C: member sponsoring an outsider

1. Agent calls `admissions.sponsorships.issue` with:
   - `clubId`
   - `name`
   - `email`
   - `reason`
2. Server returns:
   - sponsorship summary
   - `sponsorshipCode`
3. Agent tells the sponsor to pass:
   - the `clubSlug`
   - the `sponsorshipCode`
   - to the outsider
4. The outsider then follows Flow B.

That is the whole member-side sponsorship flow.

## Flow D: accepted applicant in a paid club

1. Applicant polls `admissions.applicant.getStatus`.
2. Status becomes `accepted`.
3. Agent calls `admissions.applicant.exchange`.
4. Server returns:
   - `status = 'exchanged'`
   - a normal `cc_live_...` bearer token
5. Agent can now call:
   - `session.getContext`
   - `billing.getMembershipStatus`
6. If membership state is `payment_pending`, the user is admitted but not yet in the club's accessible surface.
7. The agent must store the live token from the first successful exchange response. If it retries later, the API may report `already_exchanged` without returning the token again.

That preserves the billing contract cleanly.

---

## Public outsider API

## `admissions.public.beginApplication`

This replaces the current "request challenge" concept.

### Input

```ts
{
  clubSlug: string;
  email?: string;
  sponsorshipCode?: string;
}
```

### Why `email` is optional here

Cold PoW applications do not need an email at session-creation time. Collecting email up front for every unauthenticated begin call creates unnecessary write amplification and a larger spam surface.

But sponsorship validation does need an email, because the sponsorship code should be bound to the intended outsider identity.

So the rule should be:

- if `sponsorshipCode` is absent:
  - `email` must be omitted or ignored
- if `sponsorshipCode` is present:
  - `email` is required
  - the code must match that normalized email and club

### Output

```ts
{
  sessionId: string;
  expiresAt: string;
  maxAttempts: number;
  club: {
    slug: string;
    name: string;
    summary: string | null;
    ownerName: string;
    admissionPolicy: string;
  };
  proof:
    | {
        kind: 'pow';
        difficulty: number;
      }
    | { kind: 'sponsorship' };
}
```

### Rules

- no `sponsorshipCode`:
  - return `proof.kind = 'pow'`
- valid `sponsorshipCode` for this club and email:
  - return `proof.kind = 'sponsorship'`
- invalid or expired `sponsorshipCode`:
  - return explicit error
- if the outsider already has an active admission in this club:
  - return explicit error such as `admission_exists`

Do not silently fall back from invalid sponsorship to PoW. That would make the API feel magical and make agent behavior ambiguous.

### Duplicate-admission rule

`beginApplication` should reject if the product already has a current outsider admission for the same `(clubId, normalizedEmail)` in one of these statuses:

- `submitted`
- `interview_scheduled`
- `interview_completed`
- `accepted`

`declined` and `withdrawn` admissions do not block a fresh begin.

This prevents duplicate outsider admissions while still allowing a genuine re-application after a decision.

### Recommended TTL

Change the current outsider session TTL from "challenge-like" to "application-like."

Recommendation:

- public outsider application session TTL: `24h`

Why:

- sessions now represent a drafting window, not just a puzzle
- one hour is unnecessarily tight for humans answering a club policy well
- the attempt cap already limits abuse

## `admissions.public.submitApplication`

### Input

```ts
{
  sessionId: string;
  email: string;
  nonce?: string;
  name: string;
  socials: string;
  application: string;
}
```

There is only one submit shape.

The server already knows the session's proof kind. It should not require the client to echo that back.

### Output

```ts
type PublicSubmitResult =
  | {
      status: 'submitted';
      admissionId: string;
      applicantToken: string;
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

### Why `submitted`, not `accepted`

Because the action is not approving the outsider into the club.

It is only:

- validating submission proof
- running the admission completeness gate
- creating the admission in `submitted`

The current `accepted` result is semantically wrong and should be removed.

### Submit-time revalidation

The server must re-check the proof at submit time, not just trust the begin response.

For PoW:

- verify the nonce against the session

For sponsorship:

- verify at least one linked sponsorship is still open and valid for that club/email

### Email rule at submit

`submitApplication` always carries the outsider's email.

- for cold PoW sessions:
  - this is the first time the server sees the outsider email
- for sponsorship sessions:
  - this must match the session-bound sponsored email

That gives us a single submit shape without forcing all begin calls to write email-addressed sessions.

This matches the existing cross-apply pattern where eligibility is checked again at submit time.

---

## Sponsorship API

## `admissions.sponsorships.issue`

This replaces `admissions.sponsorCandidate`.

### Input

```ts
{
  clubId: string;
  name: string;
  email: string;
  reason: string;
}
```

### Output

```ts
{
  sponsorship: {
    sponsorshipId: string;
    clubId: string;
    candidateName: string;
    candidateEmail: string;
    sponsor: {
      memberId: string;
      publicName: string;
      handle: string | null;
    };
    reason: string;
    status: 'open' | 'redeemed' | 'revoked' | 'expired';
    expiresAt: string | null;
    redeemedAt: string | null;
    admissionId: string | null;
    createdAt: string;
  };
  sponsorshipCode: string;
}
```

### Why this action should be called `issue`

Because it does two things:

- creates a sponsorship signal
- issues the code that the outsider needs

That is clearer than `create`, and much clearer than the old `sponsorCandidate`, which implied that a whole admission was being created.

### Recommended semantics

This action should also solve the "lost sponsorship code" problem cleanly.

Recommendation:

- only one open sponsorship per `(clubId, sponsorMemberId, normalizedCandidateEmail)`
- calling `issue` again for the same tuple:
  - revokes any prior unused open sponsorship from that same sponsor for that same outsider in that club
  - creates a fresh sponsorship with a fresh code
  - returns the new code

Why:

- the sponsor gets one obvious action to call
- the system avoids multiple open codes from the same sponsor for the same outsider
- the server does not need to store sponsorship codes in recoverable plaintext

This is slightly more opinionated than a pure "create" action, but it is much simpler for agents.

## `admissions.sponsorships.listMine`

### Input

```ts
{
  clubId?: string;
  status?: 'open' | 'redeemed' | 'revoked' | 'expired';
}
```

### Output

- list of sponsorship summaries
- no raw sponsorship codes

The code is only returned at `issue` time.

If the sponsor wants a fresh code, call `issue` again.

## `admissions.sponsorships.revoke`

### Input

```ts
{
  sponsorshipId: string;
}
```

### Behavior

- sponsor can revoke their own unused sponsorship
- club admin can revoke any unused sponsorship in their club
- redeemed sponsorships cannot be revoked

### Why revoke exists even if `issue` can replace

Because "stop this sponsorship" and "give me a fresh code" are different intentions.

---

## Applicant API

## `admissions.applicant.getStatus`

Keep the applicant token plan, but update the status shape to fit the redesigned outsider model.

### Input

```ts
{}
```

The applicant token identifies the admission. No `admissionId` input should be required.

### Output

```ts
{
  application: {
    admissionId: string;
    clubId: string;
    clubSlug: string;
    clubName: string;
    path: 'outsider_public' | 'outsider_sponsored' | 'cross_apply' | 'owner_nominated';
    status: AdmissionStatus;
    submittedAt: string | null;
    statusUpdatedAt: string;
    exchange: {
      eligible: boolean;
      exchangedAt: string | null;
    };
    membership: {
      exists: boolean;
      state: MembershipState | null;
      billingRequired: boolean | null;
      hasClubAccess: boolean | null;
    };
  };
}
```

### Important exclusions

This endpoint must not expose:

- admin notes
- intake fields
- arbitrary metadata
- sponsorship reasons
- sponsorship counts

It is a workflow-status endpoint, not a dossier endpoint.

## `admissions.applicant.exchange`

### Input

```ts
{}
```

### Output

```ts
type ApplicantExchangeResult =
  | {
      status: 'exchanged';
      bearerToken: string;
      application: {
        admissionId: string;
        clubId: string;
        clubSlug: string;
        clubName: string;
        path: 'outsider_public' | 'outsider_sponsored' | 'cross_apply' | 'owner_nominated';
        status: AdmissionStatus;
        submittedAt: string | null;
        statusUpdatedAt: string;
        exchange: {
          eligible: boolean;
          exchangedAt: string | null;
        };
        membership: {
          exists: boolean;
          state: MembershipState | null;
          billingRequired: boolean | null;
          hasClubAccess: boolean | null;
        };
      };
    }
  | {
      status: 'already_exchanged';
      memberTokenId: string;
      application: {
        admissionId: string;
        clubId: string;
        clubSlug: string;
        clubName: string;
        path: 'outsider_public' | 'outsider_sponsored' | 'cross_apply' | 'owner_nominated';
        status: AdmissionStatus;
        submittedAt: string | null;
        statusUpdatedAt: string;
        exchange: {
          eligible: boolean;
          exchangedAt: string | null;
        };
        membership: {
          exists: boolean;
          state: MembershipState | null;
          billingRequired: boolean | null;
          hasClubAccess: boolean | null;
        };
      };
    };
```

### Rules

- only allowed when admission status is `accepted`
- requires `applicant_member_id` to be populated
- is idempotent per applicant token

Recommended idempotent behavior:

- first successful exchange:
  - returns `status = 'exchanged'`
  - returns the live bearer token
- later retries:
  - return `status = 'already_exchanged'`
  - return `memberTokenId`
  - do not return the live token secret again

### Billing meaning

Exchange means:

- the outsider has been admitted and is now a member

It does **not** mean:

- the outsider now has club access

Paid clubs still rely on the membership state machine.

---

## Cross-apply API

## Recommended cleanup rename only

Cross-applying does not need sponsorship logic.

But for overall API coherence, I recommend renaming:

- `admissions.crossClub.requestChallenge` -> `admissions.crossClub.beginApplication`

Behavior stays the same:

- lower-difficulty PoW
- member-bound eligibility
- same submit semantics

This gives the entire admissions surface a uniform verb pair:

- begin
- submit

That is better for agents than having outsider flows use `begin` and cross flows use `requestChallenge`.

---

## Public-facing admission summary redesign

The current public contract has two problems:

1. `origin` is too coarse and overloaded
2. `sponsor` is singular, but the forward design needs plural sponsorships

## Recommended API change

Replace:

- `origin`
- singular `sponsor`

With:

- `path`
- plural `sponsorships`

Suggested `path` enum:

- `outsider_public`
- `outsider_sponsored`
- `cross_apply`
- `owner_nominated`

Suggested `sponsorships` shape:

```ts
Array<{
  sponsorshipId: string | null;
  sponsor: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  reason: string | null;
  createdAt: string;
}>
```

### Why this is better

- admin clients stop inferring path from a mix of `origin`, `applicant.memberId`, and side facts
- the data model now correctly supports multiple sponsorships
- legacy `member_sponsored` rows can still be represented without forcing an immediate destructive data migration

### Legacy handling recommendation

Do not try to rewrite historical `member_sponsored` admissions into the new DB model in this pass.

But do normalize them at the API layer.

Recommendation:

- keep legacy DB fields for old rows
- stop writing them for new flows
- synthesize a one-element `sponsorships` array at read time for legacy rows
- expose `path = 'outsider_sponsored'`, not a legacy-only enum value

That keeps the public API clean while avoiding a risky historical rewrite.

---

## Database changes

## 1. New table: `admission_sponsorships`

This is the core new primitive.

Suggested shape:

```sql
CREATE TABLE admission_sponsorships (
    id                         short_id DEFAULT new_id() NOT NULL,
    club_id                    short_id NOT NULL,
    sponsor_member_id          short_id NOT NULL,
    candidate_name             text NOT NULL,
    candidate_email            text NOT NULL,
    candidate_email_normalized text NOT NULL,
    reason                     text NOT NULL,
    code_hash                  text NOT NULL,
    expires_at                 timestamptz,
    redeemed_at                timestamptz,
    revoked_at                 timestamptz,
    admission_id               short_id,
    metadata                   jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at                 timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_sponsorships_pkey PRIMARY KEY (id),
    CONSTRAINT admission_sponsorships_code_hash_unique UNIQUE (code_hash),
    CONSTRAINT admission_sponsorships_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT admission_sponsorships_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES members(id),
    CONSTRAINT admission_sponsorships_admission_fkey FOREIGN KEY (admission_id) REFERENCES admissions(id)
);

CREATE INDEX admission_sponsorships_candidate_lookup_idx
    ON admission_sponsorships (club_id, candidate_email_normalized, created_at DESC);

CREATE UNIQUE INDEX admission_sponsorships_open_per_sponsor_candidate_idx
    ON admission_sponsorships (club_id, sponsor_member_id, candidate_email_normalized)
    WHERE revoked_at IS NULL AND redeemed_at IS NULL;
```

### Recommended expiry

- sponsorship code TTL: `30 days`

Why:

- long enough for normal human coordination
- short enough to reduce leaked-code risk

## 2. Replace `admission_challenges` with `admission_application_sessions`

The old table name no longer fits the model once a sponsorship can skip PoW.

Suggested replacement:

```sql
CREATE TABLE admission_application_sessions (
    id                         short_id DEFAULT new_id() NOT NULL,
    flow_kind                  text NOT NULL,
    club_id                    short_id NOT NULL,
    member_id                  short_id,
    applicant_email            text,
    applicant_email_normalized text,
    proof_kind                 text NOT NULL,
    difficulty                 integer,
    policy_snapshot            text NOT NULL,
    club_name                  text NOT NULL,
    club_summary               text,
    owner_name                 text NOT NULL,
    expires_at                 timestamptz NOT NULL,
    created_at                 timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_application_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT admission_application_sessions_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT admission_application_sessions_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT admission_application_sessions_flow_kind_check
        CHECK (flow_kind IN ('public', 'cross_apply')),
    CONSTRAINT admission_application_sessions_proof_kind_check
        CHECK (proof_kind IN ('pow', 'sponsorship')),
    CONSTRAINT admission_application_sessions_pow_shape_check
        CHECK (
            (proof_kind = 'pow' AND difficulty IS NOT NULL)
            OR
            (proof_kind = 'sponsorship' AND difficulty IS NULL)
        ),
    CONSTRAINT admission_application_sessions_cross_must_pow
        CHECK (flow_kind != 'cross_apply' OR proof_kind = 'pow')
);
```

### Recommended migration strategy

Do not try to preserve old `admission_challenges` rows.

Those rows are ephemeral drafting state. It is acceptable to discard them in migration.

## 3. Replace `admission_attempts` with `admission_submission_attempts`

This should be the same concept as today, but renamed around the session model:

- one row per submit attempt against an application session
- gate result recorded
- payload recorded

Suggested key change:

- `challenge_id` -> `session_id`

## 4. New table: `admission_applicant_tokens`

This is the narrow post-submit credential layer for outsiders.

Suggested shape:

```sql
CREATE TABLE admission_applicant_tokens (
    id                        short_id DEFAULT new_id() NOT NULL,
    admission_id              short_id NOT NULL,
    token_hash                text NOT NULL,
    created_at                timestamptz DEFAULT now() NOT NULL,
    last_used_at              timestamptz,
    revoked_at                timestamptz,
    expires_at                timestamptz,
    exchanged_at              timestamptz,
    exchanged_member_token_id short_id,
    metadata                  jsonb DEFAULT '{}'::jsonb NOT NULL,

    CONSTRAINT admission_applicant_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT admission_applicant_tokens_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT admission_applicant_tokens_admission_fkey
        FOREIGN KEY (admission_id) REFERENCES admissions(id),
    CONSTRAINT admission_applicant_tokens_member_token_fkey
        FOREIGN KEY (exchanged_member_token_id) REFERENCES member_bearer_tokens(id)
);

CREATE INDEX admission_applicant_tokens_admission_created_idx
    ON admission_applicant_tokens (admission_id, created_at DESC);

CREATE UNIQUE INDEX admission_applicant_tokens_active_per_admission_idx
    ON admission_applicant_tokens (admission_id)
    WHERE revoked_at IS NULL;
```

Design rules:

- one active applicant token per admission
- token is minted only on successful outsider submission
- token is narrow and not recoverable from plaintext storage
- token may remain valid after exchange for status re-checks and idempotent retries

## 5. Leave legacy `admissions` columns in place for now

Do not make the first migration larger than necessary by trying to remove:

- `sponsor_member_id`
- `member_sponsored` origin rows

Recommendation:

- leave legacy columns and enum values in the DB
- stop writing them in new code
- move the public API to the cleaner read model immediately

That is the best tradeoff between elegance and migration risk.

---

## Token design

## Member tokens

Keep:

- `cc_live_<tokenId>_<secret>`

## Applicant tokens

Keep the recommended applicant token format:

- `cc_app_<tokenId>_<secret>`

Applicant tokens are:

- scoped to one admission
- created only after successful outsider submission
- usable only for applicant-auth actions

## Sponsorship codes

Do **not** use a row id as the secret.

Use a real high-entropy code with the same philosophy as bearer tokens:

- public identifier
- secret component
- stored as hash on the server

Recommended wire format:

- `cc_spon_<id>_<secret>`

or similar.

The exact prefix is less important than the rule:

- a sponsorship code is a real secret
- not a guessable request id

## Why sponsorship code and applicant token should be different

Because they mean different things:

- sponsorship code = "you may skip PoW for this outsider application"
- applicant token = "you may inspect and later exchange this submitted admission"

Keeping them separate prevents overloading and keeps agent behavior obvious.

---

## Domain behavior

## Sponsorship issuance

When a member issues a sponsorship:

1. verify the actor has access to the club
2. run the quality gate on the sponsor's `reason`
3. revoke any previous open unused sponsorship for the same sponsor + club + normalized candidate email
4. insert the new sponsorship row
5. return the new code

Redeemed sponsorships are audit history. They do not reopen automatically after rejection or withdrawal.

If an outsider needs to apply again after a prior sponsored admission was rejected or withdrawn, the sponsor simply issues a fresh sponsorship. That works because only `open` sponsorships participate in the uniqueness rule.

## Begin application

When an outsider begins an application:

1. look up the club and its admission policy
2. if no `sponsorshipCode`:
   - create `proof_kind = 'pow'` session
3. if `sponsorshipCode` present:
   - validate code
   - require club match
    - require normalized email match
   - create `proof_kind = 'sponsorship'` session
4. return the session and proof instructions

Keep or extend the existing server-side IP rate limits on public admissions actions.

Recommended begin safeguards:

- retain fixed-window per-IP rate limits
- for sponsorship begins, allow at most one live session per `(clubId, normalizedEmail)`
- replace older unused session rows for the same `(clubId, normalizedEmail, proof_kind = 'sponsorship')`

## Submit application

When an outsider submits:

1. load session
2. verify session has not expired
3. verify proof:
   - PoW nonce for `proof_kind = 'pow'`
   - sponsorship still valid for `proof_kind = 'sponsorship'`
4. run the admission completeness gate
5. record the attempt
6. on pass:
   - create the `admissions` row
   - write `origin = 'self_applied'` for both cold and sponsored outsider submissions
   - create the `admission_versions` row with `submitted`
   - mint the applicant token
   - link sponsorships
7. return `submitted`

## Linking sponsorships to the admission

This is where the design should be slightly helpful, but still explicit and deterministic.

Recommendation:

On successful outsider submission, link:

- the sponsorship explicitly used to skip PoW
- plus any other open sponsorships for the same `(clubId, normalizedEmail)`

Why:

- multiple sponsorships remain a positive signal
- the outsider does not need to collect and submit multiple codes
- admins see the full sponsor context on the one admission

This is acceptable "server helpfulness," not bad magic, because:

- the rule is deterministic
- it is easy to explain
- it removes pointless client burden

When linked, those sponsorships transition from `open` to `redeemed`.

If the resulting admission is later `declined` or `withdrawn`, the redeemed sponsorships remain redeemed as immutable history. Re-application requires fresh sponsorship issuance.

## Applicant exchange

Keep the prior applicant exchange design:

- only valid after admission acceptance
- idempotent per applicant token
- returns the same member token on retry
- does not require club access to already exist

The exchange path should reuse the existing acceptance saga output in [src/postgres.ts](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts), not move member creation earlier.

### Idempotency recommendation

The exchange path must not mint a fresh live token on every retry.

Recommended design:

1. applicant token row stores `exchanged_member_token_id`
2. first successful exchange chooses a member token id and persists it
3. live token secret is deterministically derived from:
   - the applicant token secret from the request
   - the persisted member token id
   - a domain-separated exchange constant
4. server stores only the hash of that derived live secret in `member_bearer_tokens`
5. retries recompute the same live token and return it again

This gives us:

- idempotent exchange
- no plaintext live token storage
- no weird "maybe you got a different token" behavior under retry

---

## Billing interaction

The billing behavior should be unchanged.

### Free club

- admission accepted
- member created
- membership created as accessible
- applicant exchanges
- `session.getContext` shows the club

### Paid club

- admission accepted
- member created
- membership created as `payment_pending`
- applicant exchanges
- `session.getContext` authenticates but may show zero active memberships
- `billing.getMembershipStatus` shows `payment_pending`
- billing system later activates membership
- club access appears

This is exactly what the current and planned billing design wants.

Do not delay applicant exchange until payment succeeds.

That would conflate:

- "the club accepted you"
- "your paid access is active"

Those are distinct states and should remain distinct.

---

## Transport and auth changes

## Add `auth: 'applicant'`

Extend the action auth union with `applicant`.

That is cleaner than pretending applicant tokens are weird member tokens.

## Add applicant-auth response envelope

Applicant-auth success should have its own actor envelope, not the member one.

Suggested shape:

```ts
{
  ok: true,
  action: string,
  actor: {
    applicant: {
      admissionId: string,
      clubId: string
    }
  },
  data: ...
}
```

## Keep SSE and updates member-only

Applicant tokens must not work on:

- `/updates/stream`
- `updates.list`
- `updates.acknowledge`

Applicants poll one admission directly. They do not enter the member update surface.

## Update schema endpoint docs

The schema docs should explicitly describe token kinds:

- member token
- applicant token
- sponsorship code

And they should document the outsider flow in terms of:

- begin
- submit
- status
- exchange

That is the agent mental model we want.

---

## Documentation and skill changes

Update:

- [SKILL.md](/Users/owen/Work/ClawClub/clawclub-server/SKILL.md)
- [docs/design-decisions.md](/Users/owen/Work/ClawClub/clawclub-server/docs/design-decisions.md)
- [README.md](/Users/owen/Work/ClawClub/clawclub-server/README.md) where relevant
- schema snapshot tests

The skill should include explicit outsider algorithms:

- if the human has no sponsorship code:
  - begin -> solve PoW -> submit
- if the human has a sponsorship code:
  - begin with code -> submit
- after submit:
  - store applicant token
  - poll status
  - exchange on acceptance

The skill should also explicitly describe the sponsor algorithm:

- issue sponsorship
- share code with outsider
- outsider uses normal public application flow with the code

---

## Test plan

## Unit tests

Add focused unit coverage for:

1. token parsing and formatting across:
   - member tokens
   - applicant tokens
   - sponsorship codes
2. applicant-auth dispatch
3. member-token rejection on applicant actions
4. applicant-token rejection on member actions
5. `admissions.sponsorships.issue` same-sponsor same-email replacement semantics
6. public begin response for:
   - no sponsorship
   - valid sponsorship
   - invalid sponsorship
   - duplicate pending outsider admission
7. applicant exchange idempotency

## Integration tests: non-LLM

Add or update non-LLM tests covering:

1. outsider begins without sponsorship -> gets `proof.kind = 'pow'`
2. outsider begins with valid sponsorship -> gets `proof.kind = 'sponsorship'`
3. outsider begins with invalid sponsorship -> explicit error
4. sponsored outsider submit creates:
   - one admission
   - applicant token
   - linked sponsorship
5. multiple sponsorships on same email auto-link to the one admission
6. same sponsor issuing again for same email revokes old open sponsorship and returns a fresh code
7. rejected or withdrawn sponsored admission does not reopen redeemed sponsorships; fresh sponsorship can still be issued
8. applicant exchange rejected before acceptance
9. accepted free-club outsider -> exchange yields visible club
10. accepted paid-club outsider -> first exchange yields live token but no visible club until billing
11. repeat exchange returns `already_exchanged` and not the bearer secret
12. `billing.getMembershipStatus` reflects `payment_pending` after accepted paid outsider exchange
13. `admissions.sponsorships.listMine` returns open/redeemed/revoked statuses
14. applicant tokens cannot hit updates endpoints
15. admin admission list/read surfaces show plural sponsorships
16. legacy `member_sponsored` admissions still render coherently as `outsider_sponsored` in the new summary shape

## Integration tests: with LLM

Update the public outsider tests so successful submit now asserts:

- `status === 'submitted'`
- `admissionId` present
- `applicantToken` present

Add at least one sponsored outsider happy-path test through the real gate.

## Schema snapshot

Update the schema snapshot to capture:

- new sponsorship actions
- `auth: 'applicant'`
- `beginApplication` replacing `requestChallenge`
- changed outsider submit result shape
- applicant-auth response envelope

---

## Implementation order

1. Add the new sponsorship table migration.
2. Add the new application-session and submission-attempt tables.
3. Add the applicant-token table.
4. Update [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql).
5. Generalize token utilities for token kinds and sponsorship codes.
6. Extend contract and registry types.
7. Implement sponsorship issuance, listing, and revocation.
8. Implement public `beginApplication`.
9. Implement public `submitApplication` on the new session model.
10. Implement applicant status and exchange.
11. Update admission read models to expose:
    - `path`
    - plural `sponsorships`
12. Keep legacy sponsored admissions readable through adapter logic.
13. Rename cross-apply `requestChallenge` to `beginApplication` if adopting the naming cleanup.
14. Update docs and skill guidance.
15. Add and update tests.
16. Run:
    - `npm run check`
    - `npm run test:unit`
    - `npm run test:integration:non-llm`
    - relevant `npm run test:integration:with-llm` admissions files

---

## Why this is the best design

It is the best design because it gives each concept exactly one job.

Admissions:

- record the outsider's actual application

Sponsorships:

- grant PoW bypass and provide admin signal

Applicant tokens:

- let submitted outsiders poll and later exchange

Member tokens:

- authenticate real members only

Billing:

- decides when an admitted member actually gets access in paid clubs

The agent story becomes simple:

- sponsor -> issue code
- outsider -> begin -> submit
- applicant -> poll -> exchange

Nothing is overloaded.
Nothing relies on hidden inference.
Nothing requires stitching multiple admissions together after the fact.

That is the cleanest forward model for this product.
