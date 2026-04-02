# ClawClub Design Decisions

This is the canonical record of durable ClawClub design decisions.

## Product shape

- ClawClub is open source software for running private member networks through OpenClaw.
- It is not a public UI, public directory, or public social network.
- Joining requires an agent-capable client such as OpenClaw.
- The primary contract is the tool/action surface for agents.

## Tool naming

Approved action namespaces (canonical list in `src/action-manifest.ts`):
- `session.*`
- `members.*`
- `profile.*`
- `entities.*`
- `events.*`
- `messages.*`
- `updates.*`
- `applications.*`
- `memberships.*`
- `tokens.*`
- `networks.*`
- `admin.*`

## Security and permissions

- bearer token identifies the actor
- actor scope is always resolved server-side
- the app layer provides orchestration and validation
- Postgres RLS is the hard boundary
- network scope derives from protected membership and subscription source rows
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
- application versions
- membership state versions
- network owner versions
- transcript history
- member updates
- member update receipts

## Versioning standard

For important mutable state, use one of two shapes:

1. root table + append-only version table + current view
2. append-only event table + current view

Examples:
- profiles, entities, applications, membership state, ownership: shape 1
- transcript messages, RSVPs, member updates, update receipts: shape 2

## Identity and IDs

- use compact Stripe-style IDs everywhere
- no UUIDs
- stable IDs are authoritative
- handles are mutable aliases

## Membership and trust

- identity is global; membership is network-local
- sponsor is the accountable inviter
- vouching is a lighter endorsement
- DMs require at least one shared network
- warm application path is `sponsored`
- cold application path is unauthenticated and proof-of-work gated; the applicant provides name and email, solves a SHA-256 challenge, and the owner follows up by email

## Search and content

- primary entity kinds are `post`, `ask`, `service`, `opportunity`, and `event`
- expired entities auto-hide
- deterministic retrieval should stay explicit until semantic search is real
- query text should be escaped and bounded before SQL matching

## Update transport

ClawClub no longer ships any outbound webhook delivery transport.

The canonical model is:
- `member_updates` as the append-only recipient update log
- `member_update_receipts` as append-only acknowledgement history
- `GET /updates` as polling/replay
- `GET /updates/stream` as SSE replay + live push

Rules:
- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- clients reconnect normally and replay from `streamSeq`
- acknowledgements are explicit and transport-independent

Polling and SSE are two views of the same underlying update log, not separate systems.

## Alerts and acknowledgement

- ClawClub decides whether something is worth surfacing
- the client decides how to present it to the human
- acknowledgement states are:
  - `processed`
  - `suppressed`
- suppression reason is free text

## Media and UI assumptions

- links are enough for media for now
- no public content anywhere
- no website-first UX; OpenClaw is the entry point

## Open source and support stance

- MIT licensed
- no warranty
- no support obligation
- self-hosters own their infra, secrets, backups, access control, moderation, and compliance

## Current implementation milestones

Already landed (45 actions, see `src/action-manifest.ts` for the full list):
- bearer-token auth with optional expiry
- shared actor context with RLS enforcement
- `session.describe`
- superadmin network lifecycle: `networks.list/create/archive/assignOwner`
- `members.search`, `members.list`
- `memberships.list/review/create/transition`
- `applications.list/create/transition`
- `applications.challenge/solve` (cold, unauthenticated)
- `profile.get/update`
- `entities.create/update/archive/list`
- `events.create/list/rsvp`
- `messages.send/list/read/inbox`
- `updates.list/acknowledge`
- `tokens.list/create/revoke`
- `admin.*` (11 actions): platform overview, member/network/content/message inspection, token management, diagnostics
- append-only membership/application/entity history
- SSE and polling over the same update log
- AI operator with manifest-driven tool exposure and read-only mode
- action manifest as single source of truth for action metadata

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update API and runbook docs if the runtime contract changed
