# Identity / Messaging / Club Database Split

Physical separation of the single ClawClub Postgres database into three logical Postgres databases:

1. **Identity DB**: platform control plane
2. **Messaging DB**: person-to-person and support messaging
3. **Club DB**: first club-content shard

All three can live on the same physical server at launch. Later they can move independently.

This is a greenfield design. There is no legacy migration constraint. Build the target shape directly.

## Committed decisions

- RLS is removed from all databases
- polling is the only delivery mechanism at launch
- `/updates` is the authoritative catch-up path
- messaging threads are not club-scoped
- the messaging plane is generic, not DM-only
- club notifications live in `club_activity`, not in a separate per-recipient club inbox
- no backwards-compatibility shims are required
- idempotency keys are supported on all retry-sensitive mutation actions

---

## For the Reviewing Agent

Read these files before reviewing:

- `src/postgres.ts`
- `src/contract.ts`
- `src/dispatch.ts`
- `src/postgres/messages.ts`
- `src/postgres/updates.ts`
- `src/server.ts`
- `db/migrations/0001_init.sql`
- `db/migrations/0062_rename_transcripts_to_dm_and_add_redactions.sql`
- `db/migrations/0074_club_activity.sql`

`docs/horizontal-scaling-plan.md` is superseded by this document for the relevant tiers.

Focus the review on:

- table ownership
- cross-plane authorization
- polling updates fan-in
- replication scope
- whether any remaining contract still incorrectly assumes messaging threads are club-scoped

---

## Architecture

### Identity DB

The identity DB is the control plane. It owns:

- members
- auth tokens
- clubs
- memberships
- subscriptions
- club routing
- member profiles and member search

It never shards.

### Messaging DB

The messaging DB is a separate messaging plane. It owns conversation threads, messages, inbox state, receipts, and redactions.

Day one it supports direct member-to-member threads. The schema must also support future support conversations with multiple operators. That is why this is the **messaging** plane, not a DM-specific plane.

It is not keyed by club.

### Club DB

The club DB is the first content shard. It owns:

- entities
- events and RSVPs
- admissions
- vouches and other club graph edges
- club activity
- quotas
- entity embeddings

When shard 1 fills up, clone the schema and route some clubs to shard 2.

### Clean boundary

- Identity owns people, clubs, memberships, and routing
- Messaging owns conversation threads and personal inbox state
- Club shards own club content and club activity

That is the hard boundary worth getting right now.

---

## Relationship to `horizontal-scaling-plan.md`

This document replaces `docs/horizontal-scaling-plan.md` for the architecture described here.

The old plan kept direct messaging and canonical club truth together on the club data plane. This plan makes a different choice:

- identity keeps canonical club and membership truth
- messaging moves to its own plane
- club shards become pure club-content storage

That is not a refinement. It is a replacement.

---

## Why Split This Way

1. Three connection pools make cross-plane joins impossible by accident.
2. Messaging consistency gets simpler because direct-thread creation no longer depends on replicated club membership checks inside club storage.
3. Club shards stay about club activity, not conversations.
4. Identity remains the place where shared-club authorization is checked.
5. Polling updates can still present one unified feed without collapsing storage boundaries.

---

## Why Remove RLS

1. We want one authorization model.
2. RLS multiplies complexity across multiple databases and future shards.
3. Without RLS, each plane can evolve independently.
4. Mixed mode is worse than either all-RLS or no-RLS.

This requires explicit app-layer authorization helpers before implementation.

---

## Current Auth Model

The role system to preserve:

- membership roles: `'clubadmin' | 'member'`
- owner is `isOwner: boolean`, not a role
- dispatch helpers: `requireAccessibleClub`, `requireClubAdmin`, `requireClubOwner`, `requireSuperadmin`
- action auth levels: `'none' | 'member' | 'clubadmin' | 'superadmin'`
- `accessible_club_memberships` includes clubadmins without subscriptions

This role model carries through to the split unchanged.

---

## Authorization Helpers To Build

New functions in `src/authorization.ts`:

| Function | Purpose | Database |
|----------|---------|----------|
| `canAccessMember(actor, targetMemberId)` | Self, superadmin, shared club, clubadmin/owner visibility into pending members, admissions-related access | Identity |
| `canAccessPrivateContacts(actor, targetMemberId)` | Self or superadmin only | Identity |
| `canStartDirectThread(actor, recipientMemberId)` | Shared-club or superadmin check for creating a new direct thread | Identity |
| `canAccessMessagingThread(actor, threadId)` | Actor is a participant in the thread | Messaging |
| `listCurrentSharedClubs(actor, counterpartMemberIds[])` | Read-time enrichment for direct threads only | Identity |

Policy choice:

- starting a new direct thread is membership-aware
- reading and replying to an existing thread is participant-only

That matches the product model: conversations are person-to-person once created.

---

## Backwards Compatibility

None required. There are no production users. No legacy contract preservation, no migration-compatibility work, no backwards-compatible cursor formats.

---

## Table Assignments

### Identity DB

Canonical control-plane tables:

| Table | Purpose |
|-------|---------|
| `members` | Core identity |
| `member_bearer_tokens` | API auth tokens |
| `member_global_role_versions` | Superadmin roles |
| `member_private_contacts` | Private emails |
| `member_profile_versions` | Member profiles and search vector |
| `clubs` | Club definitions and settings |
| `club_versions` | Club metadata + ownership history |
| `club_memberships` | Member-to-club relationships |
| `club_membership_state_versions` | Membership state history |
| `subscriptions` | Billing/subscription records |
| `club_routing` | `club_id -> shard_id` |
| `embeddings_member_profile_artifacts` | Profile vectors |
| `embeddings_jobs` | Profile embedding job queue |

Required addition:

- `club_memberships.source_admission_id` nullable with `UNIQUE (source_admission_id) WHERE source_admission_id IS NOT NULL`

Views:

- `current_member_profiles`
- `current_member_global_roles`
- `current_club_memberships`
- `active_club_memberships`
- `accessible_club_memberships`
- `current_club_versions`
- `current_club_membership_states`

### Messaging DB

Canonical messaging tables:

| Table | Purpose |
|-------|---------|
| `messaging_threads` | Conversation threads |
| `messaging_thread_participants` | Participants in each thread |
| `messaging_messages` | Messages inside threads |
| `messaging_inbox_entries` | Per-recipient messaging inbox items |
| `messaging_inbox_receipts` | Messaging receipt / ack state |
| `messaging_redactions` | Messaging moderation records |

Replicated from identity:

| Table | Why replicated |
|-------|---------------|
| `members` | Counterpart display names and `state = 'active'` checks |

### Club DB

Canonical club-content tables:

| Table | Purpose |
|-------|---------|
| `entities` + `entity_versions` | Posts, asks, services, opportunities, events, comments |
| `event_rsvps` | Attendance |
| `edges` | Vouches and relationship graph |
| `admissions` + `admission_versions` | Application workflow |
| `admission_challenges` + `admission_attempts` | Cold application gate |
| `club_activity` + `club_activity_cursors` | Club-wide activity stream |
| `redactions` | Club/entity moderation records |
| `club_quota_policies` | Per-club quotas |
| `embeddings_entity_artifacts` | Entity vectors |
| `embeddings_jobs` | Entity embedding queue |
| `llm_usage_log` | Audit trail |

Replicated from identity:

| Table | Why replicated |
|-------|---------------|
| `members` | Author/attendee display names and active-state checks |
| `clubs` | Club metadata |
| `club_memberships` | Membership-based content rules |
| `club_membership_state_versions` | Membership state views |
| `subscriptions` | Access views |
| `club_versions` | Owner checks + club metadata |

### Explicit non-goal

There is **no** club-side per-recipient inbox at launch.

Club notifications are modeled as `club_activity` rows with audience filtering, not as per-recipient fanout rows.

### Foreign keys across boundaries

One rule everywhere:

**No FK constraints from plane-owned tables to replicated tables or to another plane’s canonical tables.**

Cross-plane references are soft references. Local FKs inside one database remain normal.

---

## Messaging Model

### Messaging is generic

This plane is not “DM-only”.

Launch thread kind:

- `direct`

Planned future thread kind:

- `support`

The schema must support both without redesigning the plane.

### Direct thread identity

For `kind = 'direct'`, enforce one active thread per normalized member pair:

```sql
unique (
  kind,
  least(member_a_id, member_b_id),
  greatest(member_a_id, member_b_id)
)
where kind = 'direct' and archived_at is null
```

Implementation detail: the normalized pair can live directly on `messaging_threads`, while the full participant set lives in `messaging_thread_participants`.

### Support threads

Support threads are not pair-unique and can have multiple operator participants. They are a future use case, but the primitive should not rule them out.

### No club scope in messaging

- no `club_id` on messaging threads
- no `club_id` on messaging messages
- `messages.send` stops accepting `clubId`

If two members share multiple clubs, that does not create multiple direct threads.

### Direct thread authorization

To create a new direct thread:

- actor and recipient must currently share at least one accessible club, or
- actor is superadmin

Checked in Identity DB.

To read or reply in an existing messaging thread:

- actor must be a participant

Checked in Messaging DB.

### Shared clubs on read

For direct threads only, current shared clubs are calculated on read from Identity DB and returned as enrichment. They are not part of thread identity or routing.

### Send semantics

Messaging send must be idempotent from the client’s perspective.

- `messages.send` accepts `clientMessageId`
- uniqueness is enforced in Messaging DB
- retry returns the existing message instead of creating a duplicate

---

## Idempotency

Each retry-sensitive mutation has one canonical anchor row. Downstream side effects are derived idempotently from that anchor.

| Action | Anchor table | Downstream rows |
|--------|-------------|-----------------|
| `messages.send` | `messaging_messages` | messaging inbox entry |
| `entities.create` | `entities` | `entity_versions`, `club_activity`, `embeddings_jobs` |
| `events.create` | `entities` | `entity_versions`, `club_activity`, `embeddings_jobs` |
| `events.rsvp` | `event_rsvps` | `club_activity` |
| `vouches.create` | `edges` | — |
| `admissions.apply` | `admissions` | `admission_versions`, `admission_attempts` |
| `admissions.sponsor` | `admissions` | `admission_versions` |
| admission acceptance | `club_memberships` | `club_membership_state_versions`, `subscriptions`, club-side admission update |

Natural actor-scoped unique indexes:

| Anchor table | Unique index |
|-------------|-------------|
| `messaging_messages` | `UNIQUE (sender_member_id, client_key) WHERE client_key IS NOT NULL` |
| `entities` | `UNIQUE (author_member_id, client_key) WHERE client_key IS NOT NULL` |
| `event_rsvps` | `UNIQUE (created_by_member_id, client_key) WHERE client_key IS NOT NULL` |
| `edges` | `UNIQUE (created_by_member_id, client_key) WHERE client_key IS NOT NULL` |
| `admissions` apply | `UNIQUE (applicant_email, client_key) WHERE client_key IS NOT NULL` |
| `admissions` sponsor | `UNIQUE (sponsor_member_id, client_key) WHERE client_key IS NOT NULL` |

Admission acceptance saga:

- anchor is `club_memberships`
- `source_admission_id` is the durable cross-plane lookup key
- retry checks `SELECT id FROM club_memberships WHERE source_admission_id = $1`
- if found, skip step 1 and retry only the club-side admission update

---

## Logical Replication

### Topology

```text
Identity DB (publisher) ──replication──▶ Messaging DB (subscriber)
Identity DB (publisher) ──replication──▶ Club DB shard N (subscriber)
```

Identity publishes. Other planes subscribe.

### What Messaging DB replicates

- `members` only

### What Club DB replicates

- `members`
- `clubs`
- `club_memberships`
- `club_membership_state_versions`
- `subscriptions`
- `club_versions`

### What is never replicated

- `member_private_contacts`
- `member_bearer_tokens`
- `member_global_role_versions`
- `member_profile_versions`
- `embeddings_member_profile_artifacts`
- `club_routing`

### Lag and correctness

Not affected:

- auth
- member visibility checks
- direct-thread creation
- reading or replying in existing messaging threads

Affected:

- display freshness on replicated `members`
- some club-side reads over replicated membership state

That is acceptable eventual consistency.

### Migration ordering

For replicated tables:

1. migrate subscriber first
2. migrate publisher second

That rule applies to both identity -> messaging and identity -> club replication.

---

## Authentication and Routing

Identity DB remains the one-hop auth query:

```text
Bearer token
  -> authenticate member token
  -> read actor, roles, memberships, subscriptions, club routing
  -> AuthResult
```

Routing rules:

- club-scoped actions route by `club_routing`
- messaging actions route to Messaging DB
- identity actions stay on Identity DB

If messaging shards later, messaging routes by a messaging-specific directory, not by `club_routing`.

---

## Updates: Polling-Only Launch Design

### Core decision

**Polling is the only delivery mechanism at launch.**

- no SSE
- no WebSocket
- no Centrifugo
- no LISTEN/NOTIFY

Clients poll `GET /updates?after=<cursor>` at adaptive intervals.

### What `/updates` contains

`/updates` merges two source types:

1. **Messaging inbox** from Messaging DB
2. **Club activity** from relevant club shard(s)

There is no third club-private inbox source.

### Club activity audiences

`club_activity` needs an audience field. Use something like:

- `members`
- `clubadmins`
- `owners`

Examples:

- `entity.version.published` -> `members`
- `admission.submitted` -> `clubadmins`
- `membership.activated` -> `clubadmins` or `members`, depending product choice

So yes: new admissions submitted are visible through `/updates`, but only to clubadmins/owners.

### Adaptive polling intervals

| Context | Interval |
|---------|----------|
| active direct conversation | 5-10 seconds |
| browsing a club | 15-30 seconds |
| idle / background | 60 seconds |
| immediately after own action | immediate poll |

### Fast-path for “nothing new”

The vast majority of polls return empty. This should be near-free.

Conservative fast-path checks:

```sql
-- Any new club activity since cursor?
SELECT EXISTS (
  SELECT 1
  FROM club_activity
  WHERE club_id = ANY($1)
    AND seq > $2
) AS has_new_activity;

-- Any unread messaging inbox items?
SELECT EXISTS (
  SELECT 1
  FROM messaging_inbox_entries
  WHERE recipient_member_id = $1
    AND acknowledged = false
) AS has_new_messages;
```

If both are false, return empty immediately.

This fast-path can produce false positives for admin-only club activity rows a non-admin cannot see. That is acceptable. It must not produce false negatives.

### Indexes

Required indexes:

| Table | Index | Purpose |
|-------|-------|---------|
| `club_activity` | `(club_id, seq)` | “anything new since seq X in clubs Y?” |
| `messaging_inbox_entries` | `(recipient_member_id) WHERE acknowledged = false` | unread messaging inbox check |
| `club_activity_cursors` | `(member_id, club_id)` PK | activity seed lookup |

### Cursor design

The cursor is per-source and opaque:

```json
{
  "v": 2,
  "messaging": { "inbox": 88 },
  "clubs": {
    "1": { "activity": 1204 },
    "2": { "activity": 77 }
  }
}
```

The client carries the cursor.

### Cursor storage

Server-side persistence is only needed for seeding club activity when there is no client cursor:

| Table | Database | Purpose |
|-------|----------|---------|
| `club_activity_cursors(member_id, club_id, last_seq)` | Club DB | seed position for club activity |

Messaging inbox does **not** use a server-side seed cursor. It is receipt-driven: return all pending unacknowledged inbox entries.

### Update payload shape

`PendingUpdate` should change to:

- `plane: 'messaging' | 'club' | 'identity'`
- `sourceKey` or equivalent routing metadata
- nullable `clubId`

Messaging updates have no `clubId`. Club activity does.

### Acknowledgements

At launch, acknowledgements matter only for messaging inbox items.

Club activity is cursor-driven, not receipt-driven.

So `updates.acknowledge` either:

- only acknowledges `plane = 'messaging'`, or
- remains source-aware but only messaging items currently use it

### Ordering policy

Do not promise a global total order across databases.

Promise only:

- each source is internally ordered
- cursors are monotonic per source
- reconnects do not lose items
- merged order is stable with deterministic tie-breaks

### Future option: Centrifugo

If polling latency later becomes unacceptable for human chat, Centrifugo is the recommended transport-layer upgrade.

That does not change database ownership, thread identity, or `/updates` semantics. It only changes freshness delivery.

---

## Cross-Plane Operations

### Single-database operations

| Operation | Database |
|-----------|----------|
| Auth | Identity |
| Profile read/update | Identity |
| Token CRUD | Identity |
| Membership transitions | Identity |
| Club creation | Identity |
| Club owner assignment | Identity |
| Member listing and search | Identity |
| Entity CRUD | Club |
| Event CRUD / RSVP | Club |
| Messaging read/list | Messaging + identity enrichment |
| Messaging send | Identity auth + Messaging write |

### Multi-database operations

| Operation | Databases |
|-----------|-----------|
| `updates.list` | Messaging + club shard(s) |
| admission acceptance | Identity + club shard |
| admin overview | Identity + club shard(s) + Messaging |

### Admission acceptance

This remains the main saga:

1. identity transaction creates member if needed, membership, state version, subscription
2. club transaction marks admission accepted

That is acceptable because it is low-frequency and owner-initiated.

---

## Operational Concerns

- monitor replication lag and slot size
- drop dead replication slots when subscribers are removed
- `member_private_contacts` never leaves Identity DB
- do not introduce any real-time stack on day one

---

## Connection Management and Repository Shape

### Pools

```typescript
const identityPool = new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL });
const messagingPool = new Pool({ connectionString: process.env.MESSAGING_DATABASE_URL });
const clubPools = new Map<number, Pool>([
  [1, new Pool({ connectionString: process.env.CLUBS_DATABASE_URL })],
]);
```

### Repository layout

```typescript
export function createSplitRepository({
  identityPool,
  messagingPool,
  clubPools,
}): Repository {
  return {
    authenticateBearerToken: async (bearerToken) => {
      // identity only
    },

    ...buildTokenRepository({ pool: identityPool }),
    ...buildProfileRepository({ pool: identityPool }),
    ...buildMembershipRepository({ pool: identityPool, clubPools }),
    ...buildPlatformRepository({ pool: identityPool }),

    ...buildMessagingRepository({ messagingPool, identityPool }),
    ...buildMessagingRedactionsRepository({ pool: messagingPool }),

    ...buildEntitiesRepository({ clubPools }),
    ...buildEventsRepository({ clubPools }),
    ...buildClubRedactionsRepository({ clubPools }),
    ...buildQuotaRepository({ clubPools }),

    ...buildUpdatesRepository({ identityPool, messagingPool, clubPools }),
    ...buildAdminRepository({ identityPool, messagingPool, clubPools }),
    ...buildEmbeddingsRepository({ identityPool, clubPools }),
  };
}
```

### Contract cleanup

- remove `clubId` from `messages.send`
- remove required `clubId` from direct-thread responses
- make update `clubId` nullable
- add plane/source metadata to updates

---

## Migration System and Local Development

Migration directories:

```text
db/migrations/identity/
db/migrations/messaging/
db/migrations/clubs/
```

Scripts:

- `scripts/migrate-identity.sh`
- `scripts/migrate-messaging.sh`
- `scripts/migrate-clubs.sh`
- `scripts/setup-replication.sh`

Local env:

```bash
IDENTITY_DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_identity_dev"
MESSAGING_DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_messaging_dev"
CLUBS_DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_clubs_dev"
```

---

## Path to Multi-Shard

Day one:

- one Identity DB
- one Messaging DB
- club shard 1

Club scaling:

1. add read replicas for identity
2. add PgBouncer where needed
3. partition large club tables if necessary
4. add club shard 2
5. update `club_routing`

Messaging scaling:

Do **not** shard Messaging DB day one.

If messaging volume later requires sharding, introduce:

- `messaging_thread_directory(thread_id, kind, shard_id, status)`
- `messaging_inbox_index(member_id, thread_id, shard_id, last_message_at, unread_count)`

Then route by messaging shard, not by club.

---

## What Not To Do

- do not put `club_id` onto messaging threads/messages
- do not route messaging by club
- do not build SSE or WebSocket on day one
- do not create a separate per-recipient club inbox unless a concrete product use case appears
- do not promise a global total order across databases
- do not replicate `member_private_contacts`
- do not use bidirectional replication

---

## Full Implementation Surface

### SQL and schema

- identity tables stay in Identity DB
- messaging tables stay in Messaging DB
- club content and `club_activity` stay in Club DB
- `club_activity` gains audience filtering
- club-side `member_updates` are removed from the launch design

### Code

- `src/server.ts` - three DB pools, no `/updates/stream`
- `src/postgres.ts` - split repository composition
- `src/postgres/messages.ts` or renamed `src/postgres/messaging.ts` - Messaging DB writes/reads
- `src/postgres/updates.ts` - polling fan-in merge and fast-path checks
- `src/member-updates-notifier.ts` - removed entirely
- `src/contract.ts` - source-aware updates contract
- `src/schemas/messages.ts` - remove DM `clubId`
- `src/schemas/updates.ts` - polling-only updates
- `src/authorization.ts` - explicit auth helpers

### Scripts and ops

- migration scripts for three databases
- replication setup script
- bootstrap/reset/smoke tooling updated for three URLs
- systemd services updated for three databases
- test harness updated for three databases and replication

---

## Implementation Phases

### Phase 1: Schema split

- create Identity schema
- create Messaging schema
- create Club schema
- create replication from Identity to Messaging and Club shard 1
- create `club_routing`

### Phase 2: Authorization layer

- implement `canAccessMember`
- implement `canAccessPrivateContacts`
- implement `canStartDirectThread`
- implement `canAccessMessagingThread`
- implement `listCurrentSharedClubs`

### Phase 3: Contract cleanup

- remove `clubId` from messaging actions/results
- add source-aware updates contract
- remove club-private inbox assumptions

### Phase 4: Repository split

- identity repositories on Identity pool
- messaging repositories on Messaging pool
- club repositories on shard pools
- updates repository fans in Messaging + club activity

### Phase 5: Polling implementation

- implement fast-path checks
- implement per-source cursor encoding/decoding
- implement activity seeding via `club_activity_cursors`
- implement messaging inbox merge
- remove `/updates/stream`
- remove notifier code and NOTIFY trigger assumptions

### Phase 6: Tests

- member visibility auth tests
- direct-thread authorization tests
- messaging idempotent send / retry tests
- admission acceptance saga retry tests via `source_admission_id`
- updates polling merge tests across Messaging + club activity

### Phase 7: Verification

- same-host replication lag remains low
- direct-thread creation does not depend on club-shard replicated membership visibility
- `/updates` correctly returns admin-only club activity only for admins/owners
- no club-side per-recipient inbox is needed for launch

---

## Alternatives Considered

| Approach | Why rejected |
|----------|-------------|
| keep messaging in club shards | wrong ownership boundary, harder messaging correctness |
| keep a separate per-recipient club inbox at launch | complexity without a named product need |
| build SSE/WebSocket on day one | transport complexity too early |
| Centrifugo on day one | good future option, not needed for launch |
| custom LISTEN/NOTIFY fan-in | unnecessary complexity under polling-first design |
