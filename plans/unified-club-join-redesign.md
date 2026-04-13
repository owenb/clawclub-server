# Plan: Unified Club Join Redesign

This replaces the abandoned applicant-token plan.

The system should stop modeling "outsiders" as a separate kind of actor. There are only members, bearer tokens, and club memberships in different states.

## Core decision

- Every human who touches the system gets a normal `members` row and a normal `cc_live_<id>_<secret>` bearer token.
- A bearer token grants identity, not club access.
- Club access remains resource-scoped through `accessible_club_memberships` and equivalent checks.
- Applying to a club is a state on `club_memberships`, not a separate `admissions` record.
- Invitations replace sponsorships.
- Cold apply, invitation-backed apply, and cross-apply all collapse into one membership-centric model.

## Important corrections

- Email is a contact channel, not an identity key.
- Anonymous join must never "find an existing member by email" and attach to it.
- Replay of `clubs.join` for anonymous callers must be idempotent by `(clubId, application_email_normalized)`, not by global email identity.
- Reuse the existing `active` and `payment_pending` membership states.
- Reuse the existing `club_membership_state_versions` audit table.
- Do not create `member_club_profile_versions` before acceptance. Keep only a draft on the membership row until acceptance.
- `accessTokens.create` must require at least one non-applying membership.
- This ships as a maintenance-window cutover, not a rolling deploy.

## User flow

For the human and the agent, the flow is:

1. `clubs.join`
2. Solve PoW if required
3. `clubs.applications.submit`
4. Poll `clubs.applications.get` or `clubs.applications.list`
5. If state becomes:
   - `active`: done
   - `payment_pending`: start checkout, then poll until `active`
   - `declined` or `withdrawn`: done

There is no applicant token, no exchange step, and no separate cold vs cross vs sponsored API surface.

## API surface

### `clubs.join`

Auth: optional bearer

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

- Authenticated caller:
  - reuse the caller's `member_id`
  - if the caller has no stored contact email and `email` is provided, persist it
  - if a non-terminal membership already exists for `(memberId, clubId)`, return that membership and current proof state
  - if a valid invitation is supplied for the caller's contact email and this club, skip PoW
  - otherwise create or return a PoW challenge
- Anonymous caller with invitation:
  - require `email`
  - never search for an existing member by email
  - under the join replay lock, look for an existing non-terminal membership for `(clubId, application_email_normalized)`
  - if found, mint a fresh token for that membership's member and return the existing membership
  - otherwise create a new member, mint a token, create the membership, and mark the invitation used
- Anonymous caller without invitation:
  - require `email`
  - under the same replay lock, look for an existing non-terminal membership for `(clubId, application_email_normalized)`
  - if found, mint a fresh token for that membership's member and return the existing membership and current PoW state
  - otherwise create a new member, mint a token, create the membership, and create a PoW challenge

### `clubs.applications.submit`

Auth: bearer

Input:

```ts
{
  membershipId: string;
  nonce?: string;
  name: string;
  socials: string;
  application: string;
}
```

Phasing must mirror the current three-phase admissions submit pattern in [src/clubs/admissions.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L342):

1. Phase 1, transaction:
   - verify membership belongs to caller
   - verify membership state is `applying`
   - verify proof requirements
   - count attempts
2. Phase 2, no transaction:
   - run the legality/completeness gate
   - generate and persist `generated_profile_draft` on the membership row
3. Phase 3, transaction:
   - re-verify membership still belongs to caller
   - re-verify state is `applying`
   - re-verify proof and attempts
   - persist application fields
   - transition membership to `submitted`
   - record the attempt

No LLM call may happen while holding advisory locks or an open DB transaction.

### `clubs.applications.get`

Auth: bearer

Input:

```ts
{ membershipId: string }
```

Returns the full application/membership record for the caller.

### `clubs.applications.list`

Auth: bearer

Input:

```ts
{ status?: string; clubId?: string }
```

Returns all memberships/applications for the caller.

### `clubs.billing.startCheckout`

Auth: bearer

Input:

```ts
{ clubId: string }
```

Returns a Stripe checkout URL for a membership in `payment_pending`.

### Invitations

- `invitations.issue`
- `invitations.listMine`
- `invitations.revoke`

Invitation codes use the same hashing pattern as bearer tokens via `hashTokenSecret` in [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts#L40).

## Membership state machine

Use one unified machine on `club_memberships.status`:

- `applying`
- `submitted`
- `interview_scheduled`
- `interview_completed`
- `payment_pending`
- `active`
- `renewal_pending`
- `cancelled`
- `expired`
- `removed`
- `banned`
- `declined`
- `withdrawn`

### Legal transitions

- `applying -> submitted`
- `applying -> withdrawn`
- `submitted -> interview_scheduled`
- `submitted -> active`
- `submitted -> payment_pending`
- `submitted -> declined`
- `submitted -> withdrawn`
- `interview_scheduled -> interview_completed`
- `interview_scheduled -> declined`
- `interview_scheduled -> withdrawn`
- `interview_completed -> active`
- `interview_completed -> payment_pending`
- `interview_completed -> declined`
- `interview_completed -> withdrawn`
- `payment_pending -> active` via billing activation
- `payment_pending -> expired` via billing expiry
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

### Illegal transitions

- No `active` or `payment_pending` back to any application state
- No `declined` or `withdrawn` back to an in-flight state
- No `accepted -> non-accepted` equivalent; once access is granted or payment is pending, the application path is over
- No duplicate non-terminal membership for the same `(clubId, memberId)`

## Access model

- Bearer token validity only proves member identity.
- Club-scoped resources must continue to gate on `accessible_club_memberships` or an equivalent access view.
- Memberships in `applying`, `submitted`, `interview_*`, `declined`, and `withdrawn` do not grant club access.

Targeted tightening:

- `accessTokens.create` requires at least one membership in `active`, `payment_pending`, `renewal_pending`, or `cancelled`
- `accessTokens.list` and `accessTokens.revoke` remain identity-level
- `member_club_profile_versions` are created only on acceptance, so `profile.list` and `profile.update` do not expose pre-acceptance club profiles

## Schema changes

### Extend `club_memberships`

Add:

- `application_name text`
- `application_email text`
- `application_email_normalized text GENERATED ALWAYS AS (lower(btrim(application_email))) STORED`
- `application_socials text`
- `application_text text`
- `applied_at timestamptz`
- `application_submitted_at timestamptz`
- `proof_kind text`
- `invitation_id short_id`
- `generated_profile_draft jsonb`

Notes:

- `application_email` is a snapshot taken for this application flow; it is not the member's global identity.
- Keep `member_private_contacts.email` as the mutable contact channel.
- Relax the `club_memberships_sponsor_check` so unsponsored `applying` rows are legal.
- Keep `club_memberships_club_member_unique`.

### Reuse `club_membership_state_versions`

Do not create a replacement table. Extend the existing `membership_state` enum/checks and keep this table as the authoritative audit log.

### `invitations`

Create:

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
    used_at                    timestamptz,
    used_membership_id         short_id,
    revoked_at                 timestamptz,
    created_at                 timestamptz DEFAULT now() NOT NULL
);
```

Rules:

- unused invitations may be revoked
- invitation validation requires:
  - `revoked_at IS NULL`
  - `expires_at > now()`
  - email match
  - club match
  - `hashTokenSecret(secret) = code_hash`
  - sponsor still has a live membership in the club
- replay against the same already-created membership is allowed:
  - valid if `used_at IS NULL`
  - or if `used_membership_id = <replayed membership id>`

### `application_pow_challenges`

Create one active unsolved challenge per membership:

```sql
CREATE TABLE application_pow_challenges (
    id              short_id DEFAULT new_id() NOT NULL,
    membership_id   short_id NOT NULL,
    difficulty      integer NOT NULL,
    expires_at      timestamptz NOT NULL,
    solved_at       timestamptz,
    attempts        integer DEFAULT 0 NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL
);
```

## Join replay and locking

`clubs.join` for anonymous callers must serialize on:

- advisory lock key: `application_join:<clubId>:<application_email_normalized>`

Inside that lock:

1. look for an existing non-terminal membership for that club and application email
2. if found:
   - mint a fresh bearer token for that membership's member
   - return the existing membership and its proof state
3. otherwise:
   - create new member
   - optionally persist contact email
   - create membership in `applying`
   - create or validate PoW/invitation state
   - mint bearer token

Invitation-backed joins also lock the invitation row with `FOR UPDATE`.

## Billing integration

Billing should keep using the existing sync contract in [docs/billing-sync-contract.md](/Users/owen/Work/ClawClub/clawclub-server/docs/billing-sync-contract.md).

Rules:

- free club acceptance: `submitted` or `interview_completed` to `active`
- paid club acceptance: `submitted` or `interview_completed` to `payment_pending`
- `superadmin.billing.activateMembership` continues to do `payment_pending -> active`
- `renewal_pending`, `cancelled`, and `expired` semantics stay unchanged

This is why the design reuses `active` and `payment_pending` instead of introducing new accepted-state names.

## Migration

One destructive migration file, executed via `scripts/migrate.sh`.

### Step 1: schema changes

- extend `club_memberships`
- extend the membership state enum/check
- relax the sponsor constraint for unsponsored applying rows
- create `invitations`
- create `application_pow_challenges`

### Step 2: data migration

#### Accepted admissions already linked to memberships

- map current admission status into membership status
- prefer existing `club_memberships` rows
- copy application fields onto the membership row
- move `generated_profile_draft` onto the membership row if present
- backfill membership-state history where admission history is needed for the new UI

#### In-flight outsider admissions not linked to memberships

- create a fresh member per admission
- do not merge by email
- create a membership in the corresponding in-flight state
- copy application fields
- do not mint tokens for these legacy rows
- admin-side out-of-band token issuance remains available for these historical cases after acceptance

#### Legacy sponsored admissions

- if sponsor exists, create an invitation row
- if the admission already resulted in a membership or is currently in flight, mark the invitation as already used by that membership
- if `sponsor_member_id` is null, do not synthesize an invitation; preserve the history on the membership metadata

#### Historical anomalies

Migration must explicitly validate and handle:

- accepted admissions with missing `membership_id`
- accepted admissions with missing `applicant_member_id`
- `source_admission_id` mismatches between admissions and memberships
- `owner_nominated` rows with no email
- malformed `admission_details` or `generated_profile_draft`

If a row cannot be repaired deterministically, the migration should fail with a clear error rather than silently inventing state.

#### Ephemeral state

- discard old admission challenges
- discard old admission attempts
- in-flight cold applicants will need to call `clubs.join` again

### Step 3: destructive drop

Drop:

- `admissions`
- `admission_versions`
- `admission_challenges`
- `admission_attempts`

### Step 4: refresh `db/init.sql`

Only after the migration has been tested through:

1. `./scripts/reset-dev.sh`
2. `./scripts/migrate.sh`
3. manual verification

## Maintenance-window rollout

This is not a rolling deploy.

Order:

1. put the API into a maintenance window and drain traffic
2. run the destructive migration through `scripts/migrate.sh`
3. deploy the new server code
4. verify schema and smoke-test the new join flow
5. reopen traffic

Rationale:

- old containers still import and expose `admissions.*` actions
- once old tables are dropped, old code cannot keep serving safely while draining

## Implementation checklist

1. Add optional-auth support for `clubs.join` in the dispatcher and schema registry.
2. Extend `club_memberships` and the membership state machine.
3. Relax the sponsor constraint for unsponsored applying rows.
4. Add `invitations`.
5. Add `application_pow_challenges`.
6. Implement `clubs.join` with:
   - anonymous replay by `(clubId, application_email_normalized)`
   - invitation row locking
   - no email-based identity reuse
7. Implement `clubs.applications.submit` with the current three-phase submit pattern.
8. Implement `clubs.applications.get` and `clubs.applications.list`.
9. Implement `clubs.billing.startCheckout`.
10. Delay creation of `member_club_profile_versions` until acceptance.
11. Tighten `accessTokens.create`.
12. Implement the destructive migration and test it through the real migration path.
13. Update `db/init.sql`.
14. Remove old `admissions.*` actions.
15. Cut over in a maintenance window.

## Tests

Integration coverage must include:

- cold anonymous join, lost first response, replay returns same membership with a fresh token
- anonymous invitation join, lost first response, replay succeeds against the same used invitation and same membership
- authenticated join reuses identity and honors provided email when no contact email exists
- free-club flow: `clubs.join -> submit -> poll -> active`
- paid-club flow: `clubs.join -> submit -> poll -> payment_pending -> billing activation -> active`
- invitation flow skips PoW
- `accessTokens.create` rejected for a member with only `applying` memberships
- `profile.update` not available for pre-acceptance application drafts
- billing sync flows still work with the new membership states
- migration fixtures covering malformed legacy admissions and null sponsor cases

## Final note

This design intentionally replaces, rather than evolves, the old admissions model.

The system should now answer one question directly:

"Who is this human, and what state is their membership in for this club?"

Everything else is a consequence of that.
