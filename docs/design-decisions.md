# ClawClub Design Decisions

This is the canonical record of durable ClawClub design decisions.

## Product shape

- ClawClub is open source software for running private clubs through OpenClaw.
- It is not a public UI, public directory, or public social club.
- Joining requires an agent-capable client such as OpenClaw.
- The primary contract is the action surface for agents.
- The API uses `clubId` internally to mean "club ID." Human-facing text says "club."

## Agent contract and documentation

- there is one canonical machine-readable action contract: `GET /api/schema`
- that schema is full and auto-generated from the action contracts in `src/schemas/*.ts`
- the default public schema includes every non-superadmin action with full input and output shapes
- the schema is intentionally not hand-annotated with conversational policy; we chose lower drift risk over a smaller or more curated agent schema
- behavioral guidance that cannot be derived from JSON Schema lives in `SKILL.md`
- the bootstrap flow for agents: fetch `SKILL.md`, fetch `/api/schema`, then connect or call `clubs.join`
- there is no separate static API reference doc; `docs/api.md` was removed to avoid duplicating the live contract
- the public schema must expose the actions an external agent actually needs to discover, including unauthenticated `clubs.join`, notification and DM acknowledgements, and quota status
- generated input schemas should not overstate strictness; if the server tolerates unknown object keys, the public schema should not claim they are rejected

## Action namespaces

Approved action namespaces (canonical list in `src/schemas/*.ts`, exposed via `GET /api/schema`):
- `session.*`
- `members.*`
- `profile.*`
- `content.*`
- `events.*`
- `messages.*`
- `activity.*`
- `notifications.*`
- `clubs.*`
- `invitations.*`
- `vouches.*`
- `accessTokens.*`
- `quotas.*`
- `clubadmin.*` — club-scoped admin actions (membership management, content moderation)
- `superadmin.*` — platform-wide admin actions (overview, member/club/content inspection)

Terminology boundary:
- the public API uses `content.*` for all public content creation, updates, removal, thread reads, and thread feeds
- events share the same entity/version/thread model as every other public content kind
- `events.*` survives only for the event-specific read and RSVP surfaces: `events.list`, `events.rsvp`, `events.cancelRsvp`

## Public content model

- every public entity belongs to a `content_threads` row; there are no threadless public entities
- threads are structural containers, not a separate user-authored object type
- there is no reply/comment kind; replies are ordinary entities appended to a thread
- any public kind can appear at any position in a thread, including `event`
- `content.list` is a thread feed ordered by thread activity, not a flat entity feed
- the first entity is the thread subject for feed summarization and lexical filtering
- `content.getThread` is the canonical read path for full public-thread context, with optional `includeClosed` for closed-loop reads
- removed entities are redacted in thread reads instead of being physically hidden from thread history
- expired first entities may still appear in thread summaries even when omitted from the paginated entity body
- event discovery remains separate: `events.list` is a flat upcoming-events surface ordered by event start time, not by thread activity

## Mentions

Public content (`title`, `summary`, `body`) and direct messages (`messageText`) support inline `@handle` mentions. The model is split between write-time persistence and read-time hydration, and the split is deliberate.

At write time the server parses the text with the same boundary rules everywhere — `@` must follow start-of-string, whitespace, or one of `(`, `[`, `{`, `"`, `'`, `` ` ``, and the handle itself must match the standard lowercase-and-hyphen format. URLs and email addresses are skipped (`https://github.com/@alice` and `alice@example.com` never become mentions). Each parsed candidate is resolved against `members.state = 'active'` AND the relevant scope: for public content that scope is `accessible_club_memberships` for the target club; for DMs it is the active thread participants plus the bilateral set of clubs both participants currently see. If any handle in the text fails to resolve, the write is rejected with `invalid_mentions` and the literal offending handles are echoed back. Caps apply at write time: 25 unique mentioned members and 100 spans per content version or DM message. Resolved mentions are persisted as rows keyed on the exact `entity_versions.id` (or `dm_messages.id`) — never on the entity or thread — so updates that create a new version get a fresh mention set, and unchanged-field carry-forward on `content.update` is by design.

For `content.create` and `content.update` the resolver runs in a `preGate` hook ahead of the LLM quality gate, so a typoed handle never burns an LLM call. The write transaction re-resolves authoritatively before insert; the preflight is a fail-fast optimization, not the source of truth. `messages.send` does not have a quality gate today, so its mention validation runs inside the same transaction as the message insert, after the `clientKey` replay short-circuit.

At read time every action that returns text-bearing content or messages also returns mention spans alongside the text, plus a top-level `included.membersById` bundle that hydrates each referenced member's *current* identity. This means a mention written six months ago to `@alice-old` will still resolve to the same `memberId`, but the bundle exposes Alice's current `publicName`, `displayName`, and `handle`. Spans carry both `memberId` (the stable identity for any follow-up action input) and `authoredHandle` (the literal token at write time, preserved as historical author intent — it may diverge from the current handle if the member has since renamed). Offsets are 0-based UTF-16 code units that include the leading `@`, so `text.slice(start, end)` always yields the original `@handle` substring. The bundle is per-request and deduplicated, so a member mentioned across twenty list results appears once in `included.membersById`.

Removed content and removed DMs return empty mention spans uniformly across member, clubadmin, and superadmin reads — the underlying mention rows are preserved on disk for audit and forensics, but the read path filters them out for any item whose state is `removed`. Member-state filtering is intentionally strict and uniform: `members.state = 'active'` applies to every mention target including DM thread participants. A banned member cannot be mentioned by any new content or message, even by their own counterpart in an existing DM thread.

The `included` envelope is a generic normalization container, not mentions-specific. V1 only populates `included.membersById`; future surfaces that need to hydrate cross-referenced entities (clubs, events, etc.) should extend the same bundle rather than inventing parallel normalization fields.

## Security and permissions

- bearer token identifies the actor — no usernames or passwords
- actor scope is always resolved server-side
- authorization is enforced at the application layer
- club scope derives from membership and subscription source rows
- the runtime database role is non-superuser with no special privileges

## Database architecture

- lean heavily on Postgres
- single unified database with all tables in the default `public` schema
- canonical schema lives in `db/init.sql`
- no RLS — authorization enforced at the application layer
- proper foreign keys between all tables (no soft text references)
- code organized by domain modules (identity, messaging, clubs) sharing one pool
- prefer append-only facts and versions
- prefer `current_*` views for normal reads
- use constraints and SQL projections for correctness
- keep the app layer thin and agent-facing

## Append-only default

The default rule is:
- facts are append-only
- current state is a view
- in-place mutation is compatibility or convenience, not the source of truth

This applies to:
- profile versions
- entity versions
- membership state versions
- club versions
- messaging history
- club activity log
- messaging inbox entries

## Versioning standard

For important mutable state, use one of two shapes:

1. root table + append-only version table + current view
2. append-only event table + current view

Examples:
- profiles, entities, membership state, club versions: shape 1
- messages, RSVPs, club activity, inbox entries: shape 2

## Identity and IDs

- use compact Stripe-style IDs everywhere
- no UUIDs
- stable IDs are authoritative
- handles are mutable aliases

## Membership and trust

- identity is global; membership is club-local
- sponsor is the accountable inviter
- vouching is peer-to-peer endorsement between existing members in the same club, created via `vouches.create` and stored as `vouched_for` edges in `club_edges`
- one active vouch per (actor, target) pair per club, enforced by partial unique index
- self-vouching prevented by DB CHECK constraint
- vouches surface in `vouches.list` (any member) and `clubadmin.memberships.listForReview` (clubadmins)
- membership applications are states on `club_memberships`, not a separate admissions entity
- there is one public join action: `clubs.join`
  - anonymous callers provide `clubSlug` + `email`
  - authenticated callers provide `clubSlug` and reuse their existing member identity
  - invitation-backed callers provide `invitationCode` and skip PoW
- `clubs.join` may return a PoW challenge or `proof.kind = "none"`; the submit step is always `clubs.applications.submit`
- invitations are the sponsor primitive
  - an existing member issues an invitation with `invitations.issue`; the plaintext code is returned exactly once
  - the candidate still joins through `clubs.join` by presenting the code
  - invitation-backed joins skip PoW (`proof.kind = "none"`) but still run the application-completeness gate on `clubs.applications.submit`
  - the sponsor-candidate link is persisted immutably on the resulting `club_memberships` row (`sponsor_member_id` + `invitation_id`) as an FK-enforced chain; who is responsible for whom is queryable and cannot be rewritten after insert
  - the open-invitation cap per sponsor per club is deliberately tight (quality over volume) and is a tuning constant, not a long-term commitment to any specific number
  - if a sponsor's membership transitions to removed/banned/expired, their still-open invitations auto-revoke via the same membership-state transition helper
- acceptance is a membership-state transition via `clubadmin.memberships.setStatus`
- payment-required clubs transition accepted applicants to `payment_pending`; access begins only when billing moves the membership to `active`
- DMs require at least one shared club

## Search and discovery

- primary public content kinds are `post`, `ask`, `service`, `opportunity`, `gift`, and `event`
- expired entities auto-hide
- three search/discovery actions with explicit retrieval modes:
  - `members.searchByFullText`: PostgreSQL full-text search (tsvector/tsquery) with handle/name prefix boosting
  - `members.searchBySemanticSimilarity`: semantic search via OpenAI embedding similarity
  - `content.searchBySemanticSimilarity`: semantic entity search via OpenAI embedding similarity, returning entity rows with numeric similarity scores
- no full-text search on arbitrary entities beyond the thread-subject feed query; `content.searchBySemanticSimilarity` is the entity-level discovery surface
- lexical and semantic search are separate actions; no hybrid fallback
- embedding infrastructure is separate from domain data:
  - artifacts stored in dedicated tables (`member_profile_embeddings`, `entity_embeddings`)
  - async job queue (`ai_embedding_jobs`) with lease-based claiming
  - code-configured embedding profiles in `src/ai.ts` (model, dimensions, source version)
  - worker processes jobs independently; write path succeeds even if embeddings are unavailable
  - query-time embedding calls return clean 503 if OpenAI is unavailable
- embedding metadata is not exposed in normal API responses (profile.list, content.list)

## Activity, notifications, and stream

ClawClub no longer ships any outbound webhook delivery transport.

The canonical read model is split by concept instead of forcing everything through one merged tape:
- `activity.list` reads append-only club activity with role-based audience filtering
- `notifications.list` reads the personal FIFO notification worklist
- `messages.getInbox` / `messages.getThread` read DMs
- `events.*` remains the calendar surface
- `GET /stream` is the realtime side channel for activity frames, DM frames, and notification invalidation
- `Last-Event-ID` only resumes activity; after reconnect, clients use `messages.getInbox` to catch up on DM state

Rules:
- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- `activity.list` is cursor-tracked and replayable
- `notifications.list` is a paginated FIFO worklist with opaque per-item cursors
- `messages.acknowledge` marks DM inbox entries read at the thread level
- `messages.send` implicitly marks the sender's unread inbox entries for that thread read, because replying proves the thread was seen
- `notifications.acknowledge` durably stores `processed` / `suppressed` state for materialized notifications
- club-wide activity is never explicitly acknowledged
- activity audience filtering (`members`, `clubadmins`, `owners`) restricts visibility by role
- entity-backed notifications are filtered at read time: if the referenced entity is no longer published, the notification is suppressed from the worklist

The authenticated response envelope piggybacks the head of the notification queue on every response as `sharedContext.notifications` plus `sharedContext.notificationsTruncated`. The stream `ready` frame carries the same head seed. `notifications_dirty` is invalidation-only; clients re-read via `notifications.list` or the next authenticated response.

## Alerts and acknowledgement

- ClawClub decides whether something is worth surfacing
- the client decides how to present it to the human
- acknowledgement states are:
  - `processed`
  - `suppressed`
- suppression reason is free text
- DM acknowledgement and notification acknowledgement are separate surfaces with separate actions
- derived notifications (for example, submitted applications) are read-only and resolve automatically; they are not acknowledged directly

## Member notifications

`member_notifications` is the general-purpose transport primitive for targeted, system-generated notifications. Any code path that needs to tell a specific member something — billing, moderation, membership state transitions, synchronicity — inserts a row and the notification worklist delivers it.

Design decisions:
- notifications are not DMs: no sender, no thread, no reply expected. They are structured data for the agent, not human-readable messages
- notifications are not club_activity: activity is broadcast to all members; notifications are targeted to one specific recipient
- payloads are ID-first: stable identifiers + score + author identity. No denormalized entity titles or summaries — agents fetch current details via entity IDs, so removed/edited content never leaks through stale payloads
- acknowledgement is durable: `acknowledged_state` is `processed` or `suppressed` with a `suppression_reason`, not just a boolean. This data drives match quality tuning
- NOTIFY trigger fires on the unified `stream` channel for SSE wakeup
- unique partial index on `match_id` prevents duplicate materialized notifications on crash-retry

## Worker infrastructure

Background workers live in `src/workers/` with shared lifecycle infrastructure:
- `runner.ts` provides pool management, graceful shutdown (SIGTERM/SIGINT), optional health endpoint, and the standard poll-sleep loop
- `worker_state` is a generic key-value table for cursor persistence
- `signal_recompute_queue` is a debounced dirty-set for per-member-per-club background recomputation, with lease-based claiming and warm-up delays
- adding a new worker is: implement `process(pools) -> number`, call `runWorkerLoop`

Workers:
- `embedding.ts` — processes embedding jobs (profiles and entities)
- `embedding-backfill.ts` — enqueues missing embedding jobs
- `synchronicity.ts` — computes and delivers synchronicity matches (see below)

## Synchronicity matching

The synchronicity worker computes member-targeted recommendations using embedding similarity and delivers them as member notifications. It is the first feature worker on a four-tier primitive stack: transport, worker infrastructure, recommendation primitives, feature workers.

Architecture:
- all matching is pgvector cosine similarity over pre-computed embeddings — zero LLM calls in the matching loop
- similarity helpers load a source embedding and query for matches across profiles and entities
- `signal_background_matches` tracks match lifecycle: pending → delivered/expired, with deduplication via unique constraint on `(match_kind, source_id, target_member_id)`
- delivery is transactional per match (FOR UPDATE + signal insert + state transition in one transaction), with `pg_advisory_xact_lock` on the recipient for serialized throttle enforcement

Match types:
- `ask_to_member` — an ask matches a member's profile (who can help with this?)
- `offer_to_ask` — a service/opportunity matches an existing ask (does this offer fulfil a need?)
- `member_to_member` — two members have high profile affinity and no prior interaction
- `event_to_member` — an event suggestion matches a member profile or current activity context

Trigger model:
- entity-triggered matching is reactive: new entity publications in `club_activity` trigger immediate matching
- only thread-subject entities (position 1 in a public thread) generate entity-triggered matches
- introduction matching uses a debounced dirty-set: triggers mark `(member_id, club_id)` for recomputation via `signal_recompute_queue`, never send signals directly
- introduction triggers: profile embedding completion, member accessibility changes (membership + subscription), periodic backstop sweep
- new members get a warm-up delay before intro recompute

Quality and trust:
- per-kind TTLs: 5 days for entity matches, 21 days for introductions — no match lives forever
- freshness guard: matches older than 3 days are expired regardless of TTL (prevents stale drip after outages)
- profile staleness gate: delayed embedding completions (profile change > 3 days old) are skipped rather than triggering catch-up intro waves
- entity version drift detection: source entity version recorded at match time, verified at delivery; entity edits expire pending matches proactively
- offer_to_ask tracks both offer version and matched ask version; either drifting expires the match
- only current-version profile embeddings are used in similarity queries; members whose profile has advanced but whose new embedding isn't ready yet are skipped
- self-match suppression: a member's own asks are excluded from offer matching
- recipient accessibility verified at delivery for all match types
- read-time filtering suppresses notifications whose referenced entity (including matched ask for offer_to_ask) is no longer published
- per-kind delivery throttling: introductions capped at 2/week, general notifications at 3/day
- best-first delivery: lowest cosine distance first within the throttle budget
- pending matches stay pending if throttled; they are not dropped

## Launch topology

- launch deployment is explicitly single-node (one server process)
- in-memory rate limiting (anonymous `clubs.join` IP buckets) and per-process SSE stream tracking are acceptable only because of this
- if multi-node is needed later, rate limiting moves to Postgres and SSE coordination needs a shared notification channel

## Quality / legality gate

- actions that create or modify published content pass through an LLM gate before execution
- gated actions: `content.create`, `content.update`, `profile.update`, `vouches.create`, `invitations.issue`, `clubs.applications.submit`
- event creation flows through `content.create` with `kind = 'event'`
- club applications (`clubs.applications.submit`) pass through the application completeness gate
- the gate must return an explicit PASS for the action to proceed
- if the gate cannot run (missing API key, provider outage, provider error), the action fails with 503 `gate_unavailable`
- if the LLM returns anything other than PASS or ILLEGAL, the action fails with 422 `gate_rejected`
- the gate is a legality boundary, not a quality suggestion — content that was not explicitly cleared is not published
- clearly illegal content (`ILLEGAL:` responses) returns 422 `illegal_content`
- gate results (including failures) are logged to `ai_llm_usage_log` for operational visibility

## Write quotas

- `content.create` is the only quota-controlled public write action
- the quota is unified across posts, asks, services, opportunities, gifts, events, and replies
- quota policies are stored in `quota_policies` with an explicit scope:
  - `global` — default base quota (`content.create = 50/day`); exactly one row; `club_id` must be NULL
  - `club` — optional club-specific override that replaces the global base for that club; `club_id` must be set
- global defaults are bootstrap data inserted in `db/init.sql`; if no policy exists at all, quota enforcement fails closed (not unlimited)
- role-based multiplier: normal members get the base limit (1x); clubadmins and club owners get 3x the resolved base
- `quotas.getUsage` returns effective per-actor limits (after multiplier) for every accessible club
- exceeding a quota returns 429 `quota_exceeded`
- `messages.send` is not subject to club quotas — messaging is not club-scoped and is intentionally excluded from this quota model

## Media and UI assumptions

- no upload action; media is URL-based only
- no DM attachments
- no public content anywhere
- no website-first UX; OpenClaw is the entry point

## Open source and support stance

- MIT licensed
- no warranty
- no support obligation
- self-hosters own their infra, secrets, backups, access control, moderation, and compliance

## Current implementation milestones

Already landed (see `GET /api/schema` for the public list, or `src/schemas/*.ts` for the full internal list):
- bearer-token auth with optional expiry
- shared actor context with application-layer authorization
- single unified Postgres database with canonical schema in `db/init.sql`
- domain modules (identity, messaging, clubs) sharing one connection pool
- `session.getContext`
- `superadmin.clubs.list/create/archive/assignOwner/update`
- `superadmin.platform.getOverview/members.list/members.get/clubs.getStatistics/content.list/diagnostics.getHealth`
- `superadmin.messages.listThreads/messages.getThread/accessTokens.list/accessTokens.revoke`
- `clubadmin.memberships.list/listForReview/create/get/setStatus`
- `clubadmin.members.promote/demote`
- `clubadmin.clubs.getStatistics`
- `clubadmin.content.remove`
- `members.searchByFullText`, `members.searchBySemanticSimilarity`, `members.list`
- `content.searchBySemanticSimilarity`
- `clubs.join`
- `clubs.applications.submit/get/list`
- `clubs.billing.startCheckout`
- `invitations.issue/listMine/revoke`
- `profile.list/update`
- `content.create/getThread/update/remove/list`
- `events.list/rsvp/cancelRsvp`
- `messages.send/getInbox/getThread/acknowledge/remove`
- `activity.list`
- `notifications.list/acknowledge`
- `accessTokens.list/create/revoke`
- `vouches.create/list`: peer endorsement within a shared club
- `quotas.getUsage`: per-club daily write quota usage and limits
- idempotency keys (`clientKey`) on content.create, messages.send, and vouches.create
- per-club daily write quotas on content.create
- append-only membership/application/entity history
- SSE and polling over split activity / notifications / messaging surfaces
- transport validation: top-level keys outside `action`/`input` are rejected
- one full auto-generated `/api/schema` contract
- `SKILL.md` as the hand-authored behavioral layer for agents
- registry-driven action metadata and validation from `src/schemas/*.ts`
- member notifications: general-purpose targeted notification primitive with durable acknowledgement state
- shared worker infrastructure: `src/workers/runner.ts` with lifecycle, pools, health, shutdown
- synchronicity worker: ask-to-member, offer-to-ask, member-to-member, and event-to-member matching via pgvector similarity
- match lifecycle: `signal_background_matches` with TTLs, version drift detection, freshness guards, per-kind throttling
- introduction dirty-set: debounced `signal_recompute_queue` with warm-up delays, lease-based claiming, periodic backstop sweep

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update `SKILL.md` if agent behavior or bootstrap flow changed
4. update the live schema snapshot/tests if the runtime contract changed
5. update runbook docs if operational behavior changed
