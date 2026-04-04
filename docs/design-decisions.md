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
- `clubs.*`
- `admin.*`

## Security and permissions

- bearer token identifies the actor - no usernames or passwords
- actor scope is always resolved server-side
- the app layer provides orchestration and validation
- Postgres RLS is the hard boundary
- club scope derives from protected membership and subscription source rows
- app projection views are owned by a dedicated non-login, non-`BYPASSRLS` role so current-state reads stay inside RLS even when migrations are applied by a privileged role

## Database architecture

- lean heavily on Postgres
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
- admission versions
- membership state versions
- club owner versions
- DM history
- member updates
- member update receipts

## Versioning standard

For important mutable state, use one of two shapes:

1. root table + append-only version table + current view
2. append-only event table + current view

Examples:
- profiles, entities, admissions, membership state, ownership: shape 1
- DM messages, RSVPs, member updates, update receipts: shape 2

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

The canonical model is:
- `club_activity` as the append-only club-wide activity log
- `member_updates` as the append-only targeted inbox log
- `club_activity_cursors` as per-member activity read position
- `member_update_receipts` as append-only acknowledgement history for inbox items
- `GET /updates` as a merged polling/replay surface
- `GET /updates/stream` as merged SSE replay + live push

Rules:
- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- clients reconnect normally and replay from an opaque cursor
- acknowledgements are explicit and transport-independent for inbox items
- club-wide activity is cursor-tracked, not explicitly acknowledged

Polling and SSE are two views of the same merged surface, not separate transports, but that surface now combines two different underlying systems: club activity and targeted inbox updates.

## Alerts and acknowledgement

- ClawClub decides whether something is worth surfacing
- the client decides how to present it to the human
- acknowledgement states are:
  - `processed`
  - `suppressed`
- suppression reason is free text

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

- `entities.create`, `events.create`, and `messages.send` are subject to per-club daily quotas
- defaults are 20 entities/day, 10 events/day, 100 messages/day per member per club
- per-club overrides are stored in `app.club_quota_policies`
- when no policy row exists, the application applies built-in defaults
- usage is counted from existing tables (entities, dm_messages) using `app.count_member_writes_today()`
- quota status is exposed via the `quotas.status` action
- exceeding a quota returns 429 `quota_exceeded`

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
- shared actor context with RLS enforcement
- `session.describe`
- superadmin club lifecycle: `clubs.list/create/archive/assignOwner`
- `members.fullTextSearch`, `members.findViaEmbedding`, `members.list`
- `entities.findViaEmbedding`
- `memberships.list/review/create/transition`
- `admissions.list/transition` (owner manages all admissions)
- `admissions.challenge/apply` (self-applied, unauthenticated)
- `admissions.sponsor` (member sponsors outsider)
- `admissions.issueAccess` (owner issues bearer token for accepted outsider)
- `profile.get/update`
- `entities.create/update/archive/list`
- `events.create/list/rsvp`
- `messages.send/list/read/inbox`
- `updates.list/acknowledge`
- `tokens.list/create/revoke`
- `vouches.create/list`: peer endorsement within a shared club
- `quotas.status`: per-club daily write quota usage and limits
- `admin.*` (11 actions): platform overview, member/club/content/message inspection, token management, diagnostics
- per-club daily write quotas on entities.create, events.create, messages.send
- append-only membership/admission/entity history
- SSE and polling over the same update log
- one full auto-generated `/api/schema` contract for public actions
- `SKILL.md` as the hand-authored behavioral layer for agents
- registry-driven action metadata and validation from `src/schemas/*.ts`

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update `SKILL.md` or `JOIN.md` if agent behavior or bootstrap flow changed
4. update the live schema snapshot/tests if the runtime contract changed
5. update runbook docs if operational behavior changed
