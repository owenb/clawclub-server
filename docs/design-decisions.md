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
- `JOIN.md` is the thin bootstrap document: fetch `SKILL.md`, fetch `/api/schema`, then connect or follow admissions
- there is no separate static API reference doc; `docs/api.md` was removed to avoid duplicating the live contract
- the public schema must expose the actions an external agent actually needs to discover, including unauthenticated self-apply admissions, update acknowledgements, and quota status
- generated input schemas should not overstate strictness; if the server tolerates unknown object keys, the public schema should not claim they are rejected

## Action namespaces

Approved action namespaces (canonical list in `src/schemas/*.ts`, exposed via `GET /api/schema`):
- `session.*`
- `members.*`
- `profile.*`
- `entities.*`
- `events.*`
- `messages.*`
- `updates.*`
- `admissions.*`
- `memberships.*`
- `vouches.*`
- `tokens.*`
- `quotas.*`
- `clubadmin.*` — club-scoped admin actions (membership management, content moderation)
- `superadmin.*` — platform-wide admin actions (overview, member/club/content inspection)

## Security and permissions

- bearer token identifies the actor — no usernames or passwords
- actor scope is always resolved server-side
- authorization is enforced at the application layer (see `docs/identity-club-split.md` for rationale)
- club scope derives from membership and subscription source rows
- the runtime database role is non-superuser with no special privileges

## Database architecture

- lean heavily on Postgres
- three separate databases on the same instance: identity, messaging, clubs
- identity is the single source of truth for members, auth, profiles, clubs, memberships, subscriptions
- messaging owns threads, messages, inbox — no club_id, no membership data
- clubs owns entities, events, admissions, vouches, activity, quotas, embeddings
- no replication between databases — cross-plane data resolved at the application layer via batch lookups
- no RLS — authorization enforced at the application layer
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
- profile versions (identity DB)
- entity versions (clubs DB)
- admission versions (clubs DB)
- membership state versions (identity DB)
- club versions (identity DB)
- messaging history (messaging DB)
- club activity log (clubs DB)
- messaging inbox entries (messaging DB)

## Versioning standard

For important mutable state, use one of two shapes:

1. root table + append-only version table + current view
2. append-only event table + current view

Examples:
- profiles, entities, admissions, membership state, club versions: shape 1
- messages, RSVPs, club activity, inbox entries: shape 2

## Identity and IDs

- use compact Stripe-style IDs everywhere
- no UUIDs
- stable IDs are authoritative
- handles are mutable aliases

## Membership and trust

- identity is global; membership is club-local
- sponsor is the accountable inviter
- vouching is peer-to-peer endorsement between existing members in the same club, created via `vouches.create` and stored as `vouched_for` edges in `app.edges`
- one active vouch per (actor, target) pair per club, enforced by partial unique index
- self-vouching prevented by DB CHECK constraint
- vouches surface in `vouches.list` (any member) and `memberships.review` (owners)
- admissions are the unified model for all paths into a club, with two origins:
  - `self_applied` — unauthenticated, proof-of-work gated; `admissions.challenge` takes a `clubSlug` and returns a PoW challenge plus the club's admission policy; `admissions.apply` takes `challengeId`, `nonce`, `name`, `email`, `socials`, and `application` (a free-text response to the club's admission policy); completing the PoW does not mint auth
  - `member_sponsored` — an existing member sponsors an outsider for admission via `admissions.sponsor`; no PoW required, trust comes from the sponsoring member; multiple sponsorships for the same outsider are allowed and are a signal
- on acceptance of outsider admissions (self-applied or member-sponsored): the system auto-creates the member, private contacts, profile, and membership
- the owner issues a bearer token via `admissions.issueAccess` and delivers it out-of-band
- DMs require at least one shared club

## Search and discovery

- primary entity kinds are `post`, `ask`, `service`, `opportunity`, and `event`
- expired entities auto-hide
- three search/discovery actions with explicit retrieval modes:
  - `members.fullTextSearch`: PostgreSQL full-text search (tsvector/tsquery) with handle/name prefix boosting
  - `members.findViaEmbedding`: semantic search via OpenAI embedding similarity
  - `entities.findViaEmbedding`: semantic entity search via OpenAI embedding similarity
- no full-text search on entities (semantic only)
- lexical and semantic search are separate actions; no hybrid fallback
- embedding infrastructure is separate from domain data:
  - artifacts stored in dedicated tables (`embeddings_member_profile_artifacts`, `embeddings_entity_artifacts`)
  - async job queue (`embeddings_jobs`) with lease-based claiming
  - code-configured embedding profiles in `src/ai.ts` (model, dimensions, source version)
  - worker processes jobs independently; write path succeeds even if embeddings are unavailable
  - query-time embedding calls return clean 503 if OpenAI is unavailable
- embedding metadata is not exposed in normal API responses (profile.get, entities.list)

## Update transport

ClawClub no longer ships any outbound webhook delivery transport.

The canonical model merges three notification sources into one feed:
- `club_activity` (clubs DB) as the append-only club-wide activity log with audience filtering
- `member_signals` (clubs DB) as targeted, per-recipient system-generated notifications
- `messaging_inbox_entries` (messaging DB) as the targeted DM inbox with per-entry acknowledgement
- `GET /updates` as a merged polling surface combining all three sources
- `GET /updates/stream` as merged SSE replay + live push (NOTIFY triggers on both databases)

Rules:
- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- clients reconnect normally and replay from an opaque compound cursor (encodes independent positions for activity seq, signal seq, and inbox timestamp)
- DM inbox entries are acknowledged via `updates.acknowledge`; acknowledgement is scoped to the recipient
- signals are acknowledged via `updates.acknowledge` with durable `processed`/`suppressed` state (not just a boolean)
- club-wide activity is cursor-tracked, not explicitly acknowledged
- activity audience filtering (`members`, `clubadmins`, `owners`) restricts visibility by role
- entity-backed signals are filtered at read time: if the referenced entity is no longer published, the signal is suppressed from the feed

Polling and SSE are two views of the same merged surface, not separate transports.

## Alerts and acknowledgement

- ClawClub decides whether something is worth surfacing
- the client decides how to present it to the human
- acknowledgement states are:
  - `processed`
  - `suppressed`
- suppression reason is free text

## Member signals

`member_signals` (clubs DB) is a general-purpose transport primitive for targeted, system-generated notifications. Any code path that needs to tell a specific member something — billing, moderation, admissions, serendipity — inserts a row and the existing update feed delivers it.

Design decisions:
- signals are not DMs: no sender, no thread, no reply expected. They are structured data for the agent, not human-readable messages
- signals are not club_activity: activity is broadcast to all members; signals are targeted to one specific recipient
- payloads are ID-first: stable identifiers + score + author identity. No denormalized entity titles or summaries — agents fetch current details via entity IDs, so removed/edited content never leaks through stale payloads
- acknowledgement is durable: `acknowledged_state` is `processed` or `suppressed` with a `suppression_reason`, not just a boolean. This data drives match quality tuning
- NOTIFY trigger reuses the `club_activity` channel for SSE wakeup (accepts the tradeoff that one signal wakes all SSE waiters in the club)
- unique partial index on `match_id` prevents duplicate signals on crash-retry

## Worker infrastructure

Background workers live in `src/workers/` with shared lifecycle infrastructure:
- `runner.ts` provides pool management, graceful shutdown (SIGTERM/SIGINT), optional health endpoint, and the standard poll-sleep loop
- `worker_state` (clubs DB) is a generic key-value table for cursor persistence, shard-local
- `recompute_queue` (clubs DB) is a debounced dirty-set for per-member-per-club background recomputation, with lease-based claiming and warm-up delays
- adding a new worker is: implement `process(pools) -> number`, call `runWorkerLoop`

Workers:
- `embedding.ts` — processes embedding jobs (profiles in identity, entities in clubs)
- `embedding-backfill.ts` — enqueues missing embedding jobs
- `serendipity.ts` — computes and delivers serendipity matches (see below)

## Serendipity matching

The serendipity worker computes member-targeted recommendations using embedding similarity and delivers them as member signals. It is the first feature worker on a four-tier primitive stack: transport, worker infrastructure, recommendation primitives, feature workers.

Architecture:
- all matching is pgvector cosine similarity over pre-computed embeddings — zero LLM calls in the matching loop
- cross-plane similarity helpers load a vector from one DB plane and query the other (entity vectors in clubs, profile vectors in identity)
- `background_matches` (clubs DB) tracks match lifecycle: pending → delivered/expired, with deduplication via unique constraint on `(match_kind, source_id, target_member_id)`
- delivery is transactional per match (FOR UPDATE + signal insert + state transition in one transaction), with `pg_advisory_xact_lock` on the recipient for serialized throttle enforcement

Match types:
- `ask_to_member` — an ask matches a member's profile (who can help with this?)
- `offer_to_ask` — a service/opportunity matches an existing ask (does this offer fulfil a need?)
- `member_to_member` — two members have high profile affinity and no prior interaction

Trigger model:
- entity-triggered matching is reactive: new entity publications in `club_activity` trigger immediate matching
- introduction matching uses a debounced dirty-set: triggers mark `(member_id, club_id)` for recomputation via `recompute_queue`, never send signals directly
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
- read-time filtering suppresses signals whose referenced entity (including matched ask for offer_match) is no longer published
- per-kind delivery throttling: introductions capped at 2/week, general signals at 3/day
- best-first delivery: lowest cosine distance first within the throttle budget
- pending matches stay pending if throttled; they are not dropped

See `docs/member-signals-plan.md` for the full design rationale and implementation plan.

## Launch topology

- launch deployment is explicitly single-node (one server process)
- in-memory rate limiting (cold admission IP buckets) and per-process SSE stream tracking are acceptable only because of this
- if multi-node is needed later, rate limiting moves to Postgres and SSE coordination needs a shared notification channel (see `docs/scaling-todo.md`)

## Quality / legality gate

- actions that create or modify published content pass through an LLM gate before execution
- gated actions: `entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`
- cold applications (`admissions.apply`) pass through a separate admission completeness gate
- the gate must return an explicit PASS for the action to proceed
- if the gate cannot run (missing API key, provider outage, provider error), the action fails with 503 `gate_unavailable`
- if the LLM returns anything other than PASS or ILLEGAL, the action fails with 422 `gate_rejected`
- the gate is a legality boundary, not a quality suggestion — content that was not explicitly cleared is not published
- clearly illegal content (`ILLEGAL:` responses) returns 422 `illegal_content`
- gate results (including failures) are logged to `app.llm_usage_log` for operational visibility

## Write quotas

- `entities.create` and `events.create` are subject to per-club daily quotas
- quotas are kind-specific: entity quotas count only `post`/`opportunity`/`service`/`ask`; event quotas count only `event`
- per-club overrides are stored in `app.club_quota_policies` (clubs DB)
- when no policy row exists, no quota is enforced
- quota status is exposed via the `quotas.status` action
- exceeding a quota returns 429 `quota_exceeded`
- `messages.send` is not subject to club quotas — messaging is club-free

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
- three-database runtime: identity, messaging, clubs — each with own pool, migrations, schema
- cross-plane enrichment via batch lookups (no replication)
- `session.describe`
- `superadmin.clubs.list/create/archive/assignOwner/update`
- `superadmin.overview/members.list/members.get/clubs.stats/content.list/diagnostics.health`
- `superadmin.messages.threads/messages.read/tokens.list/tokens.revoke`
- `clubadmin.memberships.list/review/create/transition`
- `clubadmin.admissions.list/transition/issueAccess`
- `clubadmin.members.promote/demote`
- `clubadmin.clubs.stats`
- `clubadmin.entities.remove`, `clubadmin.events.remove`
- `members.fullTextSearch`, `members.findViaEmbedding`, `members.list`
- `entities.findViaEmbedding`
- `admissions.challenge/apply` (self-applied, unauthenticated, PoW-gated)
- `admissions.sponsor` (member sponsors outsider)
- `profile.get/update`
- `entities.create/update/remove/list`
- `events.create/list/rsvp/remove`
- `messages.send/list/read/inbox/remove`
- `updates.list/acknowledge`
- `tokens.list/create/revoke`
- `vouches.create/list`: peer endorsement within a shared club
- `quotas.status`: per-club daily write quota usage and limits
- idempotency keys (`clientKey`) on entities.create, events.create, messages.send, vouches.create
- per-club daily write quotas on entities.create and events.create
- append-only membership/admission/entity history
- SSE and polling over a merged three-source surface (club activity + member signals + messaging inbox)
- compound update cursor with independent positions for each source (backward-compatible with old two-part cursors)
- transport validation: top-level keys outside `action`/`input` are rejected
- one full auto-generated `/api/schema` contract (57 actions)
- `SKILL.md` as the hand-authored behavioral layer for agents
- registry-driven action metadata and validation from `src/schemas/*.ts`
- member signals: general-purpose targeted notification primitive with durable acknowledgement state
- shared worker infrastructure: `src/workers/runner.ts` with lifecycle, pools, health, shutdown
- serendipity worker: ask-to-member, offer-to-ask, and member-to-member matching via pgvector similarity
- match lifecycle: `background_matches` with TTLs, version drift detection, freshness guards, per-kind throttling
- introduction dirty-set: debounced `recompute_queue` with warm-up delays, lease-based claiming, periodic backstop sweep

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update `SKILL.md` or `JOIN.md` if agent behavior or bootstrap flow changed
4. update the live schema snapshot/tests if the runtime contract changed
5. update runbook docs if operational behavior changed
