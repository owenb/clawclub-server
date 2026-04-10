# Plan: Cold Admissions Applicant Tokens

## Context for the reviewing agent

This plan has already been design-reviewed with the owner.

- Breaking API changes are explicitly allowed and encouraged if they produce a cleaner design.
- Database migration is allowed and expected.
- The scope is the cold self-apply path only.
- Cross-applying is intentionally unchanged.
- Sponsorship is intentionally not solved in this pass, but the design should leave a clean extension point for it.
- Billing compatibility is required. The accepted design must fit the existing and planned `payment_pending -> active` flow in [docs/billing-sync-contract.md](/Users/owen/Work/ClawClub/clawclub-server/docs/billing-sync-contract.md) and [company/billing-design.md](/Users/owen/Work/ClawClub/clawclub-server/company/billing-design.md).

## What we're doing

Today, cold outsiders submit an application, then wait for a human to send them a real bearer token out of band after acceptance.

After this change:

1. A successful cold application submission returns an **applicant-scoped bearer token** immediately.
2. That token is bound to exactly one admission.
3. It can only:
   - read the status of that admission
   - exchange itself for a normal member bearer token once the admission is accepted
4. When the admission is accepted, the applicant exchanges the applicant token for a normal `cc_live_...` token.
5. If the club is free, the exchanged token immediately exposes the club.
6. If the club is paid, the exchanged token authenticates the newly admitted member, but the member may still have zero accessible clubs until billing activates the membership.

This removes the out-of-band handoff for cold applicants without weakening the current identity boundary.

## The core design principle

### Do not create member auth before there is a member

The current codebase treats `cc_live_...` tokens as member credentials. They resolve through [src/identity/auth.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/auth.ts), which assumes a real `members` row and returns the standard member actor envelope.

That contract is worth preserving.

Cold applicants are not members until acceptance. So we should not issue live member tokens to them before acceptance, and we should not create member rows at application submission time just to support polling.

### Applicant auth is a capability, not an account

The right abstraction is not "early account creation." It is "admission-scoped applicant auth."

That means:

- the applicant token is tied to one admission, not one person
- it does not create a reusable outsider identity surface
- it does not grant access to any member action
- it does not imply any club access
- it survives only to support the admission workflow

### Billing remains separate from admission

The existing paid-club design already separates:

- "the admission was accepted"
- "the member can access the club"

Accepted paid admissions create `payment_pending` memberships. That is already the planned product contract in [docs/billing-sync-contract.md](/Users/owen/Work/ClawClub/clawclub-server/docs/billing-sync-contract.md).

So exchange should happen on **acceptance**, not on **billing completion**.

The meaning of exchange is:

- "you are now an admitted member"

It does **not** mean:

- "you now have club access"

That keeps the admissions model and billing model orthogonal.

---

## The API design

## Terminology change

In product discussion, "provisional token" is fine.

In the API, call it an **applicant token**.

That is more precise:

- it is not a weaker form of member token
- it is a different credential class with different auth semantics

## Token formats

Keep existing member tokens:

- `cc_live_<tokenId>_<secret>`

Add applicant tokens:

- `cc_app_<tokenId>_<secret>`

Do not overload `cc_live_...`.

Applicant tokens must not be accepted by member-auth actions, and member tokens must not be accepted by applicant-auth actions.

## Auth model change

Extend the action auth union in [src/schemas/registry.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/registry.ts):

```ts
type ActionAuth =
  | 'none'
  | 'applicant'
  | 'member'
  | 'clubadmin'
  | 'clubowner'
  | 'superadmin';
```

This is cleaner than treating applicant tokens as a weird special case inside `auth: 'member'`.

## Keep `admissions.public.requestChallenge`

No semantic change is needed here.

It remains:

- unauthenticated
- PoW-gated
- responsible only for returning a challenge plus admission-policy snapshot

The output remains structurally the same.

## Change `admissions.public.submitApplication`

Keep the action name if you want minimal surface churn. The important change is the result shape.

The current success status `accepted` is misleading. It means "accepted by the admission-completeness gate," not "approved by the club."

That should change.

### New result shape

```ts
type ColdAdmissionSubmitResult =
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

### Why this is better

- `submitted` matches the actual admission state inserted into `admissions` / `admission_versions`
- the client immediately gets the capability it needs for follow-up
- the API stops pretending the club has approved anything at submission time

### Behavioral rule

Mint the applicant token only on `status: 'submitted'`.

Do not mint it on:

- `needs_revision`
- `attempts_exhausted`

Because in those cases no admission row is being created.

## New applicant-auth actions

Add a new action family:

- `admissions.applicant.getStatus`
- `admissions.applicant.exchange`

These are authenticated with `cc_app_...` tokens.

### `admissions.applicant.getStatus`

**Auth:** `applicant`

**Input:**

```ts
{}
```

The token already identifies the admission. No `admissionId` input should be required.

**Output:**

```ts
{
  application: {
    admissionId: string;
    clubId: string;
    clubSlug: string;
    clubName: string;
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

### Notes on this shape

- It is intentionally applicant-safe.
- It does **not** expose admin notes, intake notes, or arbitrary `admission_details`.
- It does expose enough to tell the applicant:
  - whether the application is still pending
  - whether they can exchange now
  - whether a paid-club acceptance has created a `payment_pending` membership

### `admissions.applicant.exchange`

**Auth:** `applicant`

**Input:**

```ts
{}
```

**Output:**

```ts
{
  bearerToken: string;
  application: {
    admissionId: string;
    clubId: string;
    clubSlug: string;
    clubName: string;
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

### Exchange semantics

- Allowed only when the admission status is `accepted`
- Requires `admissions.applicant_member_id` to be non-null
- Returns a normal `cc_live_...` token
- Is idempotent for a given applicant token

### Why exchange returns a status snapshot too

The follow-up step differs by free vs paid club:

- free club: the member can immediately call normal member actions and see the club in `session.getContext`
- paid club: the member can authenticate, but will often see zero accessible clubs until billing completes

Returning the membership snapshot in the exchange response makes that explicit without forcing the client to guess.

## Keep existing member and admin admissions actions

Do not change:

- `admissions.crossClub.requestChallenge`
- `admissions.crossClub.submitApplication`
- `admissions.getMine`

Cross-apply already has a live member token and already has a status path.

Also keep:

- `clubadmin.admissions.issueAccessToken`

But change its role in the product:

- it remains the manual/out-of-band path
- it remains useful for sponsored admissions
- it remains a fallback if staff need to mint a fresh live token for an admitted outsider

Cold self-apply should stop depending on it as the primary happy path.

---

## Transport and schema changes

## Add applicant-auth response envelope

The current transport model in [src/schemas/transport.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/transport.ts) assumes only two success shapes:

- unauthenticated
- member-authenticated

That is no longer enough.

Add a third envelope:

```ts
const applicantActorEnvelope = z.object({
  applicant: z.object({
    admissionId: z.string(),
    clubId: z.string(),
  }),
});

const applicantAuthenticatedSuccessEnvelope = z.object({
  ok: z.literal(true),
  action: z.string(),
  actor: applicantActorEnvelope,
  data: z.unknown(),
  notices: z.array(responseNotice).optional(),
});
```

This is better than pretending applicant tokens have `member`, `globalRoles`, `activeMemberships`, or `sharedContext`.

## Dispatcher changes

Update [src/dispatch.ts](/Users/owen/Work/ClawClub/clawclub-server/src/dispatch.ts):

1. Recognize `auth: 'applicant'`
2. Add a dedicated applicant-auth dispatch branch
3. Authenticate applicant tokens via a separate repository method
4. Assemble the applicant-auth response envelope

Do not merge applicant auth into the member-auth branch. That would produce confusing pseudo-member state and special cases everywhere.

## Schema endpoint changes

Update [src/schema-endpoint.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schema-endpoint.ts):

- auth header docs should stop saying only `cc_live_...`
- unauthenticated action list remains only the cold challenge/submit actions
- response envelope docs should list:
  - member-authenticated success
  - applicant-authenticated success
  - unauthenticated success

Suggested transport auth docs:

```json
{
  "type": "bearer",
  "headerFormat": "Authorization: Bearer <token>",
  "tokenKinds": [
    { "kind": "member", "prefix": "cc_live_" },
    { "kind": "applicant", "prefix": "cc_app_" }
  ]
}
```

## SSE and updates remain member-only

Do not let applicant tokens access:

- `GET /updates/stream`
- `updates.list`
- `updates.acknowledge`

Applicants poll their one admission directly. They do not become part of the member update feed.

---

## Database changes

## New table: `admission_applicant_tokens`

Add a dedicated table.

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

## Why a separate table

Do not reuse `member_bearer_tokens`.

That table means:

- token belongs to a member
- token authenticates through the member identity model

Applicant tokens are different in both ownership and semantics.

## No `admissions` table migration is required

The existing `admissions` table already contains everything we need:

- `id`
- `club_id`
- `applicant_member_id`
- `applicant_email`
- `applicant_name`
- current status via `current_admissions`

Do not add applicant-token fields to `admissions`. Keep credential lifecycle separate from admission lifecycle.

## No backfill

Do **not** backfill applicant tokens for existing pending cold admissions during migration.

Reason:

- there is no product channel today to deliver those tokens retroactively
- a backfill would create unusable credentials

This feature applies to newly submitted cold applications after deploy.

## Migration file

Create a single additive migration under [db/migrations](/Users/owen/Work/ClawClub/clawclub-server/db/migrations), likely:

- `004_admission_applicant_tokens.sql`

Update [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql) to include the new table and indexes.

This migration is additive and safe to run before code deploy.

---

## Token utility changes

## Generalize token parsing/building

Today [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts) only knows about `cc_live_...`.

Refactor it so token utilities are typed by token kind:

```ts
type TokenKind = 'member' | 'applicant';
```

Suggested helpers:

- `buildToken(kind, parts?)`
- `parseToken(value)`
- `hashTokenSecret(secret)` stays shared

Where `parseToken()` returns:

```ts
{ kind: 'member' | 'applicant'; tokenId: string; secret: string } | null
```

This lets the server continue using a single `Authorization: Bearer ...` header while differentiating token classes cleanly.

## Exchange idempotency

This is the subtle part, and it is worth solving properly.

### Requirement

`admissions.applicant.exchange` must be idempotent.

If the applicant retries because the HTTP response was lost, the API should return the same live member token, not mint a new one every time.

### Constraint

The product does not store live bearer token secrets in plaintext. It stores only `token_hash`.

That is correct and should not change.

### Clean solution

Persist the issued member token id on the applicant-token row:

- `exchanged_member_token_id`

Then deterministically derive the live token secret from:

- the applicant token secret from the current request
- the persisted issued member token id
- a domain-separated exchange constant

Example design, conceptually:

```txt
derivedSecret = KDF("applicant-exchange-v1", applicantSecret, issuedMemberTokenId)
```

Then:

- store `hashTokenSecret(derivedSecret)` in `member_bearer_tokens`
- return `cc_live_<issuedMemberTokenId>_<derivedSecret>`
- on retry, recompute the same `derivedSecret` and return the same token again

This gives us:

- idempotent exchange
- no plaintext secret storage
- no need to leave exchange behavior probabilistic

### Do not revoke applicant token on exchange

Leave the applicant token valid after exchange.

Reasons:

- it can still be used to re-read status
- it is needed for idempotent retry
- its scope remains extremely narrow

If we later want revocation, revoke it only after we have a separate, durable way to recover the same exchanged live token on retry.

---

## Repository and auth changes

## New repository method

Add to the repository contract in [src/contract.ts](/Users/owen/Work/ClawClub/clawclub-server/src/contract.ts):

```ts
authenticateApplicantToken(bearerToken: string): Promise<ApplicantAuthResult | null>;
```

Where:

```ts
type ApplicantAuthResult = {
  applicant: {
    admissionId: string;
    clubId: string;
  };
};
```

This should stay intentionally small. Applicant auth does not need full actor state.

## New repository/domain methods

Add:

- `getApplicantAdmissionStatus(input: { admissionId: string })`
- `exchangeApplicantAdmission(input: { admissionId: string; applicantTokenId: string; applicantTokenSecret: string })`

The implementation can live in the clubs/admissions domain, because the concept is admission-scoped.

## Member auth remains unchanged

Do not alter [src/identity/auth.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/auth.ts) semantics for member tokens.

The new feature should add a second auth path, not blur the first one.

---

## Domain behavior changes

## Cold submit path

Update the successful path in [src/clubs/admissions.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts):

After:

- inserting the `admissions` row
- inserting the `admission_versions` row

also:

- create an applicant token row
- return `status: 'submitted'`
- include `admissionId`
- include `applicantToken`

Everything else stays the same:

- PoW validation
- challenge consumption
- LLM admission gate
- admin activity insertion
- LLM usage logging

## Applicant status projection

Create a dedicated applicant-safe projection.

Suggested SQL inputs:

- `current_admissions`
- `clubs`
- `club_memberships`
- `accessible_club_memberships` or equivalent access calculation

The projection must intentionally exclude:

- admin notes
- intake fields
- arbitrary admission metadata
- applicant freeform details

This endpoint is for workflow status, not full dossier retrieval.

## Exchange path

The exchange path should:

1. authenticate the applicant token
2. load the current admission
3. require `status = 'accepted'`
4. require `applicant_member_id` to be non-null
5. create or reuse the live member token idempotently
6. return the live token plus the same applicant-safe status snapshot

### Important billing behavior

Do not check `accessible_club_memberships` before exchange.

The applicant may be:

- accepted
- linked to a member
- in `payment_pending`
- not yet granted club access

That is still a valid exchange state.

## Reuse the existing acceptance saga

Do not move member creation earlier.

The current acceptance path in [src/postgres.ts](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts) already:

- creates the member for outsider admissions
- creates the membership
- uses `payment_pending` for paid clubs
- links the admission to member + membership

That stays exactly where it is: at admission acceptance time.

The new exchange path consumes the results of that existing saga. It should not reimplement or relocate it.

## Manual issue action

Refactor the live-token minting code so both:

- `clubadmin.admissions.issueAccessToken`
- `admissions.applicant.exchange`

use a shared internal helper for "issue member token from accepted admission."

But keep their semantics different:

- admin manual issue may mint a fresh token each time
- applicant exchange must be idempotent per applicant token

---

## Billing interaction

## Accepted paid admissions

This is the key behavior:

- admission accepted
- member created
- membership created in `payment_pending`
- applicant exchanges and receives a live member token
- `session.getContext` authenticates them, but usually returns zero active memberships
- `billing.getMembershipStatus` shows `payment_pending`
- later billing activation makes the club appear in `session.getContext`

This is already compatible with the current system. The repo already supports members with live tokens and zero accessible clubs.

## Do not add billing URLs or checkout initiation to applicant auth

The product repo is intentionally billing-provider-agnostic. It should remain so.

Applicant auth is an admission concern.
Billing is a member concern after acceptance.

The future company billing layer can operate after exchange using the normal member token.

## Why not wait to exchange until payment succeeds

That would conflate two separate transitions:

- admitted by the club
- paid and activated by billing

The billing docs already reject that model. The product state machine wants admitted paid members to exist as `payment_pending` members before access is granted.

Exchange should align with that design, not fight it.

---

## Sponsorship: explicitly out of scope, but leave the hook

## What we are not doing now

We are **not** changing:

- `admissions.sponsorCandidate`
- the sponsored outsider acceptance flow
- how sponsored outsiders get tokens

That remains manual/out-of-band for now.

## The extension point this design leaves

By making the new credential class:

- admission-scoped
- not cold-specific
- not tied to early member creation

we leave a clean future move for sponsorship:

- prove control of the sponsored applicant's email
- mint the same `cc_app_...` applicant token
- reuse `admissions.applicant.getStatus`
- reuse `admissions.applicant.exchange`

No new auth model would be required later.

## Why not solve sponsorship in this pass

Because sponsorship has an unsolved claim problem:

- the sponsor, not the outsider, creates the admission
- the API has no current channel to hand the outsider a token at creation time
- multiple sponsorships for the same outsider are explicitly allowed and useful

That needs a separate claim design.

Do not block the cold-flow cleanup on it.

---

## Documentation changes

Update:

- [SKILL.md](/Users/owen/Work/ClawClub/clawclub-server/SKILL.md)
- [docs/design-decisions.md](/Users/owen/Work/ClawClub/clawclub-server/docs/design-decisions.md)
- [README.md](/Users/owen/Work/ClawClub/clawclub-server/README.md) if it references the old admissions flow
- schema snapshot tests

Key wording changes:

- cold submit success is `submitted`, not `accepted`
- cold self-apply now returns an applicant token
- applicant token can only poll status and exchange on acceptance
- paid-club exchange may still yield zero club access until billing activation

---

## Test plan

## Unit tests

Add focused unit coverage for:

1. token parsing/building across `cc_live_...` and `cc_app_...`
2. dispatcher routing for `auth: 'applicant'`
3. applicant token auth rejection on member-only actions
4. member token rejection on applicant-only actions
5. exchange idempotency helper
6. applicant status projection shape

## Integration tests: non-LLM

Add non-LLM tests that seed admissions directly where appropriate:

1. `admissions.applicant.getStatus` returns pending status for a submitted cold admission
2. `admissions.applicant.getStatus` exposes no admin-only fields
3. `admissions.applicant.exchange` rejects before acceptance
4. accepted free-club cold admission:
   - exchange returns `cc_live_...`
   - `session.getContext` shows the club
5. accepted paid-club cold admission:
   - exchange returns `cc_live_...`
   - `session.getContext` authenticates but shows no club
   - `billing.getMembershipStatus` returns `payment_pending`
6. repeated exchange with the same applicant token returns the same live member token
7. declined admission remains readable via applicant status but not exchangeable
8. `GET /updates/stream` rejects applicant tokens
9. `updates.list` rejects applicant tokens
10. `clubadmin.admissions.issueAccessToken` still works for sponsored outsider admissions

## Integration tests: with LLM

Update cold-apply integration tests so successful submit now asserts:

- `status === 'submitted'`
- `admissionId` present
- `applicantToken` present and prefixed `cc_app_`

Keep `needs_revision` and `attempts_exhausted` behavior tests.

## Schema snapshot

Update the schema snapshot to capture:

- new `auth: 'applicant'` actions
- new response envelope docs
- changed cold-submit success shape

---

## Implementation order

1. Add the new SQL migration for `admission_applicant_tokens`.
2. Update [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql).
3. Generalize token parsing/building in [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts).
4. Extend contract/registry types for applicant auth.
5. Add applicant-auth transport envelope and schema-endpoint docs.
6. Add repository methods for applicant auth, applicant status, and exchange.
7. Change cold submit success shape and mint applicant tokens.
8. Add applicant status and exchange actions.
9. Refactor shared live-token issuance helper for admin issue + applicant exchange.
10. Update docs and skill text.
11. Add and update integration tests.
12. Run:
    - `npm run check`
    - `npm run test:unit`
    - `npm run test:integration:non-llm`
    - relevant `test:integration:with-llm` admissions file(s)

---

## Deployment and migration notes

## Safe deploy order

Because the migration is additive:

1. run the database migration first
2. deploy application code second

Old code ignores the new table, so the additive migration is harmless before deploy.

## Existing pending admissions

There is no migration path for already-submitted cold outsiders to receive applicant tokens automatically.

That is acceptable.

Those existing admissions continue to rely on:

- current admin review
- current manual/out-of-band live token issue

The new behavior applies to new cold submissions after deploy.

## No rollback complexity in the data model

This change is low-risk at the schema level:

- one additive table
- no destructive table rewrite
- no admissions-table rewrite
- no member-table rewrite

The risk is in auth/transport behavior, not in migration mechanics.

---

## Final design summary

The clean version is:

- cold outsiders stay unauthenticated until they successfully submit
- successful cold submission returns an applicant token, not a member token
- applicant token is admission-scoped and narrowly privileged
- accepted outsider admissions continue to create the real member and membership at acceptance time
- exchange turns applicant auth into normal member auth
- paid clubs still use `payment_pending`; exchange does not bypass billing
- cross-apply remains untouched
- sponsorship remains untouched for now, but can later reuse the same applicant-auth model

That gives us the product win the owner wants without compromising the current identity model or the planned billing state machine.
