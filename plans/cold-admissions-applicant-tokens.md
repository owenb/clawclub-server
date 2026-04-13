# Plan: Outsider Admissions Redesign

## Context

This plan is for the outsider admissions redesign in [clawclub-server](/Users/owen/Work/ClawClub/clawclub-server).

Constraints and decisions:

- breaking API changes are allowed
- database migration is allowed
- the goal is the cleanest design from first principles, not compatibility
- the main scope is:
  - cold outsider self-apply
  - outsider sponsorship
  - applicant status polling
  - applicant token exchange after acceptance
- cross-apply should stay behaviorally unchanged for agents
- billing compatibility is mandatory:
  - accepted paid admissions still become `payment_pending`
  - exchange should not wait for billing activation

Relevant current code and docs:

- [src/clubs/admissions.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts)
- [src/postgres.ts](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts)
- [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts)
- [docs/billing-sync-contract.md](/Users/owen/Work/ClawClub/clawclub-server/docs/billing-sync-contract.md)
- [company/billing-design.md](/Users/owen/Work/ClawClub/clawclub-server/company/billing-design.md)

## Executive decision

The clean model is:

1. Sponsorship becomes a first-class record in a new table.
2. Sponsorship does not create an admission.
3. There is exactly one outsider application path:
   - begin application
   - submit application
   - poll applicant status
   - exchange applicant token after acceptance
4. A valid sponsorship code skips PoW inside that one outsider path.
5. Successful outsider submit returns an applicant-scoped token.
6. Applicant exchange happens after acceptance, not after billing activation.
7. Cross-apply keeps its current API for agents, but moves onto the same session/attempt storage under the hood.

This keeps the model sharp:

- admission = the real join attempt
- sponsorship = a trust signal and PoW bypass
- applicant token = narrow post-submit workflow credential
- member token = normal member auth only

## Design goals

### 1. One outsider join attempt equals one admission

Do not create a second admission for sponsorship. That creates ambiguity around status, acceptance, billing, and reporting.

### 2. Sponsorship is a signal, not a parallel path

Sponsorship should do one thing:

- let a specific outsider skip PoW and give admins a sponsor signal

### 3. Agents should never have to guess the next method

The API must make the next step explicit:

- begin
- submit
- poll
- exchange

### 4. Cold outsiders are not members before acceptance

Do not create normal member tokens or early member accounts just to support polling.

### 5. Billing remains downstream of admission

Acceptance and club access are distinct states for paid clubs.

## Recommended API surface

### Outsider public flow

- `admissions.public.beginApplication`
- `admissions.public.submitApplication`
- `admissions.applicant.getStatus`
- `admissions.applicant.exchange`

### Sponsorship flow

- `admissions.sponsorships.issue`
- `admissions.sponsorships.listMine`
- `admissions.sponsorships.revoke`

### Cross-apply

Keep the current agent-facing API unchanged:

- `admissions.crossClub.requestChallenge`
- `admissions.crossClub.submitApplication`

Under the hood, cross-apply storage moves to the same session and attempt tables as the outsider flow.

## Agent call sequences

### Flow A: outsider with no sponsorship

1. Call `admissions.public.beginApplication` with `clubSlug`.
2. Server returns:
   - `sessionId`
   - `expiresAt`
   - `proof.kind = 'pow'`
   - PoW parameters
3. Solve PoW.
4. Call `admissions.public.submitApplication` with:
   - `sessionId`
   - `email`
   - `nonce`
   - `name`
   - `socials`
   - `application`
5. On success, server returns:
   - `status = 'submitted'`
   - `admissionId`
   - `applicantToken`
6. Store the applicant token.
7. Poll `admissions.applicant.getStatus`.
8. When `exchange.eligible = true`, call `admissions.applicant.exchange`.

### Flow B: outsider with sponsorship

1. Ask the human for:
   - `clubSlug`
   - `email`
   - `sponsorshipCode`
2. Call `admissions.public.beginApplication` with:
   - `clubSlug`
   - `email`
   - `sponsorshipCode`
3. Server returns:
   - `sessionId`
   - `expiresAt`
   - `proof.kind = 'sponsorship'`
4. Call `admissions.public.submitApplication` with:
   - `sessionId`
   - `email`
   - `name`
   - `socials`
   - `application`
5. The rest is identical to Flow A.

### Flow C: sponsor issues a code

1. Call `admissions.sponsorships.issue` with:
   - `clubId`
   - `name`
   - `email`
   - `reason`
2. Server returns:
   - sponsorship summary
   - `sponsorshipCode`
3. Sponsor shares the code with the outsider.
4. Outsider follows Flow B.

### Flow D: accepted outsider in a paid club

1. Applicant polls `admissions.applicant.getStatus`.
2. Once status is `accepted` and `exchange.eligible = true`, call `admissions.applicant.exchange`.
3. Server returns:
   - `status = 'exchanged'`
   - a normal `cc_live_...` bearer token
4. Agent can then call:
   - `session.getContext`
   - `billing.getMembershipStatus`
5. If membership is `payment_pending`, the user is admitted but still has zero accessible clubs.

## Public outsider API

### `admissions.public.beginApplication`

#### Input

```ts
{
  clubSlug: string;
  email?: string;
  sponsorshipCode?: string;
}
```

#### Rules

- if `sponsorshipCode` is absent:
  - `email` should be omitted or ignored
  - return `proof.kind = 'pow'`
- if `sponsorshipCode` is present:
  - `email` is required
  - parse code as `cc_spon_<sponsorshipId>_<secret>`
  - load the exact sponsorship row by `sponsorshipId`
  - require:
    - `revoked_at IS NULL`
    - `redeemed_at IS NULL`
    - `expired_at IS NULL`
    - `(expires_at IS NULL OR expires_at > now())`
    - club match
    - normalized email match
    - `hashTokenSecret(secret) = code_hash`
  - create a sponsorship-backed session with:
    - `proof.kind = 'sponsorship'`
    - persisted `sponsorship_id`
- invalid sponsorship must return an explicit error
- do not silently fall back from invalid sponsorship to PoW

#### Output

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
    | {
        kind: 'sponsorship';
      };
}
```

#### Duplicate-admission rule

`beginApplication` should reject when the product already has a current outsider admission for the same `(clubId, normalizedEmail)` in one of:

- `submitted`
- `interview_scheduled`
- `interview_completed`
- `accepted`

`declined` and `withdrawn` do not block a fresh begin.

#### Session TTL

- public outsider application session TTL: `24h`

Keep per-IP rate limits on public begin calls.

### `admissions.public.submitApplication`

#### Input

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

There is one submit shape. The server already knows the session proof kind.

#### Output

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

#### Phasing

Mirror the existing cold-submit structure in [src/clubs/admissions.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts). The legality/completeness gate must not run inside a DB transaction or while holding the dedupe advisory lock.

##### Phase 1: proof and attempt count

Run inside a short transaction:

1. load the session
2. verify the session has not expired
3. verify the proof
4. count prior attempts
5. reject if attempts are exhausted
6. commit

Proof rules:

- if `session.proof_kind = 'pow'`:
  - `nonce` is required
  - reject missing nonce with `missing_nonce`
  - verify nonce against the session
- if `session.proof_kind = 'sponsorship'`:
  - ignore any supplied nonce
  - re-load `session.sponsorship_id`
  - require:
    - `revoked_at IS NULL`
    - `redeemed_at IS NULL`
    - `expired_at IS NULL`
    - `(expires_at IS NULL OR expires_at > now())`
    - club match
    - normalized email match

##### Phase 2: completeness gate

Run the admission completeness / legality gate with no DB transaction and no advisory lock held.

##### Phase 3: record and create

Run inside a second transaction:

1. reload the session and verify it is still valid
2. re-verify the proof
3. acquire the canonical advisory lock:
   - `admission_dedupe:<clubId>:<normalizedEmail>`
4. query `current_admissions` for blocking statuses on the same `(clubId, normalizedEmail)`
5. enforce the duplicate-admission rule again
6. record the submission attempt
7. on gate pass:
   - create the `admissions` row
   - write `origin = 'self_applied'`
   - write immutable `submission_path`
   - create the `admission_versions` row with `submitted`
   - mint the applicant token
   - if `session.sponsorship_id` exists, link exactly that sponsorship row and mark it `redeemed`
8. commit

Do not hold the advisory lock or any row locks across the gate call.

#### Duplicate-admission enforcement

The duplicate rule cannot be implemented as a partial unique index because status lives in `admission_versions` / `current_admissions`, not directly on `admissions`.

Implementation rule:

- outsider submit serializes on `admission_dedupe:<clubId>:<normalizedEmail>`
- inside that transaction, re-check `current_admissions`

## Sponsorship API

### `admissions.sponsorships.issue`

#### Input

```ts
{
  clubId: string;
  name: string;
  email: string;
  reason: string;
}
```

#### Output

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

#### Semantics

- sponsor must be a member of the club with access to sponsor
- run the quality gate on `reason`
- sponsorship code format:
  - `cc_spon_<sponsorshipId>_<secret>`
- compute `code_hash` with the existing `hashTokenSecret` helper from [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts)
- allow only one open sponsorship per `(clubId, sponsorMemberId, normalizedEmail)`
- serialize revoke-plus-insert on:
  - `sponsorship_issue:<clubId>:<sponsorMemberId>:<normalizedEmail>`
- calling `issue` again for the same tuple:
  - revokes any prior open unused sponsorship from the same sponsor for the same outsider in the same club
  - creates a fresh sponsorship and code
  - returns the fresh code
- open sponsorship quota:
  - `10` open sponsorships per sponsor per club per rolling `30 days`
- if a sponsor loses membership access in the club, auto-revoke their open sponsorships in that club

### `admissions.sponsorships.listMine`

Input:

```ts
{
  clubId?: string;
  status?: 'open' | 'redeemed' | 'revoked' | 'expired';
}
```

Behavior:

- returns sponsorship summaries only
- never returns the raw code
- status is derived as:
  - `revoked` if `revoked_at IS NOT NULL`
  - `redeemed` if `redeemed_at IS NOT NULL`
  - `expired` if `expired_at IS NOT NULL OR expires_at < now()`
  - otherwise `open`

### `admissions.sponsorships.revoke`

Input:

```ts
{
  sponsorshipId: string;
}
```

Behavior:

- sponsor may revoke their own unused sponsorship
- club admin may revoke any unused sponsorship in their club
- redeemed sponsorships remain immutable history and cannot be revoked

## Applicant API

### `admissions.applicant.getStatus`

Input:

```ts
{}
```

The applicant token identifies the admission.

Output:

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

Rules:

- `exchange.eligible` is true only when:
  - status is `accepted`
  - `applicant_member_id IS NOT NULL`
- do not expose:
  - admin notes
  - intake fields
  - sponsorship reasons
  - sponsorship counts

### `admissions.applicant.exchange`

Input:

```ts
{}
```

Output:

```ts
type ApplicantExchangeResult =
  | {
      status: 'exchanged';
      bearerToken: string;
      application: ApplicationStatus;
    }
  | {
      status: 'already_exchanged';
      memberTokenId: string;
      application: ApplicationStatus;
    };
```

Rules:

- only allowed when the admission is accepted
- requires `applicant_member_id IS NOT NULL`
- if status is `accepted` but provisioning is not complete yet, do not expose that state:
  - the acceptance path must be atomic so this mid-state does not leak
- exchange means:
  - the outsider is now a member
- exchange does not mean:
  - club access is already active

#### Idempotency and recovery

- first successful exchange:
  - creates a normal member bearer token
  - returns `status = 'exchanged'`
  - stores:
    - `exchanged_at`
    - `exchanged_member_token_id`
    - encrypted recovery copy of the live bearer token for a short retry window
- retry during the recovery window:
  - returns the same bearer token again
- retry after the recovery window:
  - returns `status = 'already_exchanged'`
  - returns `memberTokenId`
  - does not return the live secret again

Recovery-secret construction:

- encrypt the recovery secret with AES-256-GCM
- use a per-row random 12-byte IV
- derive the encryption key with HKDF-SHA256
- HKDF input key material is the full applicant token string as presented in `Authorization: Bearer ...`
- HKDF salt is `APPLICANT_EXCHANGE_RECOVERY_PEPPER`
- HKDF info is `applicant-exchange-recovery-v1`

`APPLICANT_EXCHANGE_RECOVERY_PEPPER` contract:

- base64-encoded environment variable
- at least 32 bytes after decode
- separate value per environment
- server startup fails if missing or too short
- rotation is out of scope for v1

If the previously issued live token is later revoked, exchange does not re-mint. The member must obtain a fresh live token through the normal member-token path.

## Cross-apply

### API surface

Keep the current agent-facing methods unchanged:

- `admissions.crossClub.requestChallenge`
- `admissions.crossClub.submitApplication`

Do not redesign cross-apply for agents in this pass.

### Storage and locking

Under the hood, cross-apply moves to:

- `admission_application_sessions`
- `admission_submission_attempts`

Cross-apply submit must acquire locks in this order:

1. `admission_dedupe:<clubId>:<normalizedEmail>`
2. `cross_apply:<memberId>`

This prevents cross-flow duplicates between:

- outsider submit for `foo@example.com`
- cross-apply submit by a member whose profile email is `foo@example.com`

## Public admission read model

### Replace overloaded fields

Expose:

- `path`
- `sponsorships`

Instead of:

- overloaded `origin`
- singular `sponsor`

Recommended `path` values:

- `outsider_public`
- `outsider_sponsored`
- `cross_apply`
- `owner_nominated`

Persist `path` as immutable `admissions.submission_path`. Do not derive it from mutable state.

Write rules:

- outsider submit without sponsorship -> `outsider_public`
- outsider submit with sponsorship -> `outsider_sponsored`
- cross-apply submit -> `cross_apply`
- owner nomination -> `owner_nominated`

Legacy handling:

- keep old DB columns for old rows in this pass
- synthesize plural `sponsorships` at the read layer for legacy `member_sponsored` rows
- expose legacy sponsored rows as `path = 'outsider_sponsored'`

Pre-existing accepted admissions do not gain applicant tokens retroactively. They remain on their existing out-of-band token path.

## Database changes

### 1. `admissions` table additions

Add:

- `submission_path text`
- `applicant_email_normalized text GENERATED ALWAYS AS (lower(btrim(applicant_email))) STORED`

`submission_path` values:

- `outsider_public`
- `outsider_sponsored`
- `cross_apply`
- `owner_nominated`

Rollout:

- migration 1:
  - add `submission_path` as nullable
  - backfill existing rows
- migration 2 after at least one full deploy cycle:
  - set `submission_path NOT NULL`

Backfill rule:

- legacy `origin = 'owner_nominated'` -> `owner_nominated`
- legacy `origin = 'member_sponsored'` -> `outsider_sponsored`
- legacy `origin = 'self_applied'` and `admission_versions.version_no = 1` created by member -> `cross_apply`
- remaining `origin = 'self_applied'` -> `outsider_public`

### 2. New table: `admission_sponsorships`

```sql
CREATE TABLE admission_sponsorships (
    id                         short_id DEFAULT new_id() NOT NULL,
    club_id                    short_id NOT NULL,
    sponsor_member_id          short_id NOT NULL,
    candidate_name             text NOT NULL,
    candidate_email            text NOT NULL,
    candidate_email_normalized text GENERATED ALWAYS AS (lower(btrim(candidate_email))) STORED,
    reason                     text NOT NULL,
    code_hash                  text NOT NULL,
    expires_at                 timestamptz,
    expired_at                 timestamptz,
    redeemed_at                timestamptz,
    revoked_at                 timestamptz,
    admission_id               short_id,
    created_at                 timestamptz DEFAULT now() NOT NULL,
    metadata                   jsonb DEFAULT '{}'::jsonb NOT NULL,

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
    WHERE revoked_at IS NULL AND redeemed_at IS NULL AND expired_at IS NULL;
```

Why both `expires_at` and `expired_at`:

- `expires_at` is the policy TTL
- `expired_at` is the materialized state used by partial indexes because Postgres partial indexes cannot reference `now()`

### 3. New table: `admission_application_sessions`

```sql
CREATE TABLE admission_application_sessions (
    id                         short_id DEFAULT new_id() NOT NULL,
    flow_kind                  text NOT NULL,
    club_id                    short_id NOT NULL,
    member_id                  short_id,
    applicant_email            text,
    applicant_email_normalized text GENERATED ALWAYS AS (
        CASE
            WHEN applicant_email IS NULL THEN NULL
            ELSE lower(btrim(applicant_email))
        END
    ) STORED,
    proof_kind                 text NOT NULL,
    sponsorship_id             short_id,
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
    CONSTRAINT admission_application_sessions_sponsorship_fkey FOREIGN KEY (sponsorship_id) REFERENCES admission_sponsorships(id),
    CONSTRAINT admission_application_sessions_flow_kind_check
        CHECK (flow_kind IN ('public', 'cross_apply')),
    CONSTRAINT admission_application_sessions_proof_kind_check
        CHECK (proof_kind IN ('pow', 'sponsorship')),
    CONSTRAINT admission_application_sessions_member_shape_check
        CHECK (
            (flow_kind = 'cross_apply' AND member_id IS NOT NULL)
            OR
            (flow_kind = 'public' AND member_id IS NULL)
        ),
    CONSTRAINT admission_application_sessions_pow_shape_check
        CHECK (
            (proof_kind = 'pow' AND difficulty IS NOT NULL AND sponsorship_id IS NULL)
            OR
            (proof_kind = 'sponsorship' AND difficulty IS NULL AND sponsorship_id IS NOT NULL)
        ),
    CONSTRAINT admission_application_sessions_cross_must_pow
        CHECK (flow_kind != 'cross_apply' OR proof_kind = 'pow')
);
```

### 4. New table: `admission_submission_attempts`

```sql
CREATE TABLE admission_submission_attempts (
    id              short_id DEFAULT new_id() NOT NULL,
    session_id      short_id NOT NULL,
    club_id         short_id NOT NULL,
    attempt_no      integer NOT NULL,
    applicant_name  text NOT NULL,
    applicant_email text NOT NULL,
    payload         jsonb NOT NULL,
    gate_status     text NOT NULL,
    gate_feedback   text,
    policy_snapshot text NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_submission_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT admission_submission_attempts_session_fkey
        FOREIGN KEY (session_id) REFERENCES admission_application_sessions(id) ON DELETE CASCADE,
    CONSTRAINT admission_submission_attempts_club_fkey
        FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT admission_submission_attempts_gate_status_check
        CHECK (gate_status IN ('passed', 'skipped', 'rejected', 'rejected_illegal'))
);

CREATE UNIQUE INDEX admission_submission_attempts_session_attempt_idx
    ON admission_submission_attempts (session_id, attempt_no);
```

### 5. New table: `admission_applicant_tokens`

```sql
CREATE TABLE admission_applicant_tokens (
    id                           short_id DEFAULT new_id() NOT NULL,
    admission_id                 short_id NOT NULL,
    token_hash                   text NOT NULL,
    created_at                   timestamptz DEFAULT now() NOT NULL,
    last_used_at                 timestamptz,
    revoked_at                   timestamptz,
    expires_at                   timestamptz,
    exchanged_at                 timestamptz,
    exchanged_member_token_id    short_id,
    exchange_secret_ciphertext   bytea,
    exchange_secret_expires_at   timestamptz,
    metadata                     jsonb DEFAULT '{}'::jsonb NOT NULL,

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

Applicant token lifecycle:

- hard cap: `90 days`
- on decline or withdrawal:
  - keep valid for `7 days` so the applicant can read the final state
- on acceptance:
  - keep valid through exchange and for `7 days` after exchange

### 6. Legacy tables and columns

Keep legacy `admissions` sponsorship-related columns for read compatibility in PR 1.

Do not try to clean historical rows in this redesign beyond the `submission_path` backfill.

## Acceptance must be atomic

The new applicant API cannot expose `accepted` before member provisioning is ready. The acceptance saga in [src/postgres.ts](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts) must be refactored so acceptance is a single shared transaction.

Constraints:

1. Any LLM-generated profile draft must be computed and persisted before the acceptance transaction starts. No LLM call belongs inside the transaction.
2. `identity.createMemberFromAdmission` gains an optional shared `client` parameter.
3. `identity.createMembership` gains an optional shared `client` parameter.
4. `admissionsModule.transitionAdmission` gains an optional shared `client` parameter.
5. `admissionsModule.linkAdmissionToMember` gains an optional shared `client` parameter.
6. The acceptance transaction uses one shared client for all of:
   - `transitionAdmission(client, ...)`
   - `createMemberFromAdmission(client, ...)`
   - `linkAdmissionToMember(client, ...)`
   - `createMembership(client, ...)`
   - final admission link updates
7. Delete the old retry-safety lookup that existed only because the saga was non-atomic.
8. Simplify `skipTransition` so "already accepted" means "already fully provisioned" for post-redesign rows.
9. If the accepted version-row insert fails on `(admission_id, version_no)` uniqueness, roll back and return `concurrent_modification` (`409`).

Accepted is terminal for this redesign. Do not support accepted-to-non-accepted reversals here. Removing a member after acceptance is a membership-management concern, not an admissions-state rollback.

Legacy pre-redesign accepted rows are not retroactively repaired and are not callers of the new applicant API.

## Auth and transport changes

### Add `auth: 'applicant'`

Applicant auth should be its own auth kind, not a special case of member auth.

### Applicant actor envelope

Suggested response envelope:

```ts
{
  ok: true,
  action: string,
  actor: {
    applicant: {
      admissionId: string;
      clubId: string;
    }
  },
  data: ...
}
```

### Member-only surfaces

Applicant tokens must not work on:

- `/updates/stream`
- `updates.list`
- `updates.acknowledge`

Applicants poll one admission directly.

## Billing interaction

Billing behavior stays unchanged.

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
- member auth succeeds
- `session.getContext` may show zero accessible clubs
- `billing.getMembershipStatus` shows `payment_pending`
- billing later activates the membership

Do not delay exchange until payment succeeds. Acceptance and access are distinct states.

## Documentation changes

Update:

- [SKILL.md](/Users/owen/Work/ClawClub/clawclub-server/SKILL.md)
- [docs/design-decisions.md](/Users/owen/Work/ClawClub/clawclub-server/docs/design-decisions.md)
- [README.md](/Users/owen/Work/ClawClub/clawclub-server/README.md)
- schema snapshot tests

Skill guidance should explicitly say:

- no sponsorship code:
  - begin
  - solve PoW
  - submit
- sponsorship code present:
  - begin with code
  - submit
- after submit:
  - store applicant token
  - poll status
  - exchange on acceptance

## Test plan

### Unit tests

Add focused coverage for:

1. token parsing and formatting for:
   - member tokens
   - applicant tokens
   - sponsorship codes
2. applicant-auth dispatch
3. member-token rejection on applicant actions
4. applicant-token rejection on member actions
5. sponsorship issue replacement semantics
6. public begin responses:
   - no sponsorship
   - valid sponsorship
   - invalid sponsorship
7. exchange recovery-window behavior
8. ASCII email validation at the action schema boundary

### Integration tests: non-LLM

Add or update tests covering:

1. outsider begins without sponsorship -> `proof.kind = 'pow'`
2. outsider begins with valid sponsorship -> `proof.kind = 'sponsorship'`
3. outsider begins with invalid sponsorship -> explicit error
4. outsider begins with sponsorship past TTL but before cleanup -> explicit error
5. sponsored outsider submit creates:
   - one admission
   - one applicant token
   - one linked sponsorship
6. revoke-and-reissue between begin and submit does not silently switch to a different sponsorship; submit revalidates `session.sponsorship_id`
7. same sponsor issuing again for same email revokes old open sponsorship and returns a fresh code
8. rejected or withdrawn sponsored admission does not reopen redeemed sponsorships; fresh sponsorship can still be issued
9. applicant exchange rejected before acceptance
10. accepted free-club outsider -> exchange yields visible club
11. accepted paid-club outsider -> first exchange yields live token but no visible club until billing
12. repeat exchange during recovery window re-delivers the same bearer token
13. repeat exchange after recovery window returns `already_exchanged`
14. `billing.getMembershipStatus` reflects `payment_pending` after paid outsider exchange
15. applicant tokens cannot hit member update endpoints
16. admin read models expose plural sponsorships and immutable `path`
17. legacy `member_sponsored` rows still render as `outsider_sponsored`
18. concurrent outsider submits for the same `(clubId, normalizedEmail)` serialize
19. cross-apply submit and outsider submit for the same `(clubId, normalizedEmail)` serialize on the shared dedupe lock
20. accepted version-row uniqueness conflict returns `concurrent_modification`

### Integration tests: with LLM

Update outsider submit tests so successful submit asserts:

- `status === 'submitted'`
- `admissionId` present
- `applicantToken` present

Add at least one sponsored outsider happy-path test through the real gate.

### Structural / harness tests

1. Add `withInstrumentedPool(...)` or equivalent to [test/integration/harness.ts](/Users/owen/Work/ClawClub/clawclub-server/test/integration/harness.ts) so tests can count `BEGIN` / `COMMIT` / `ROLLBACK`.
2. Wrapped acceptance-pool test:
   - reset counters immediately before the acceptance request
   - assert exactly one transaction is opened for the acceptance request
   - assert no nested helper-owned transaction begins are observed
3. Failure-injection test:
   - throw after member creation or admission link update
   - assert the whole acceptance transaction rolls back cleanly
4. Hammer test:
   - run repeated concurrent acceptance and read requests
   - assert no caller observes `accepted` while `applicant_member_id` is still null

## Cleanup and retention

Add or extend an admissions cleanup worker to:

- delete expired application sessions
- materialize sponsorship expiry by setting `expired_at`
- expire or revoke applicant tokens after their retention windows
- clean expired exchange recovery secrets

This can live in the existing worker area; do not invent a separate subsystem for it.

## Implementation order

This redesign rolls out in two PRs.

- PR 1:
  - steps 1 through 16
  - tests and docs
- PR 2 after at least one full deploy cycle:
  - steps 17 and 18

### PR 1

1. Add `admission_sponsorships`.
2. Add `admission_application_sessions`.
3. Add `admission_submission_attempts`.
4. Add `admission_applicant_tokens`.
5. Add nullable `admissions.submission_path` and generated `admissions.applicant_email_normalized`.
6. Backfill `submission_path`.
7. Update [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql).
8. Generalize token parsing and hashing utilities for applicant tokens and sponsorship codes.
9. Migrate cross-apply storage to `admission_application_sessions` and `admission_submission_attempts`. Cross-apply API stays unchanged. Cross-apply submit takes:
   - `admission_dedupe:<clubId>:<normalizedEmail>` first
   - `cross_apply:<memberId>` second
10. Implement sponsorship issue, list, and revoke.
11. Implement public `beginApplication` and `submitApplication` on the new session model, including three-phase submit handling.
12. Implement applicant status and exchange.
13. Refactor acceptance to one shared transaction:
   - profile draft before transaction
   - shared client threaded through admissions and identity helpers
   - delete the old non-atomic retry logic
14. Update admission read models to expose immutable `path` and plural `sponsorships`.
15. Update docs, skill guidance, and schema snapshots.
16. Run:
   - `npm run check`
   - `npm run test:unit`
   - `npm run test:integration:non-llm`
   - relevant `npm run test:integration:with-llm` admissions files

### PR 2 after one deploy cycle

17. Drop legacy `admission_challenges` and `admission_attempts` after confirming both public and cross-apply writers have been deployed on the new storage for at least one full cycle.
18. Set `admissions.submission_path NOT NULL` after confirming all writers populate it.

## Deliberate non-goals

- Do not issue normal member tokens before acceptance.
- Do not create sponsorship-backed admissions.
- Do not redesign cross-apply from the agent's point of view.
- Do not add DB-level ASCII CHECK constraints to legacy tables in this migration.
  - ASCII email is enforced at the action schema boundary for new writes.
  - Adding DB-level ASCII checks here would turn this into legacy data cleanup, which is out of scope.

## Why this design is the right one

It gives each concept exactly one job:

- admission:
  - the real join attempt
- sponsorship:
  - PoW bypass and sponsor signal
- applicant token:
  - post-submit polling and exchange
- member token:
  - normal member auth
- billing:
  - access control after acceptance

That is the simplest model that remains correct under sponsorship, billing, and cross-apply.
