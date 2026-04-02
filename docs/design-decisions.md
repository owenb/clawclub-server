# ClawClub Design Decisions

This is the canonical record of durable ClawClub design decisions.

## Product shape

- ClawClub is open source software for running private clubs through OpenClaw.
- It is not a public UI, public directory, or public social club.
- Joining requires an agent-capable client such as OpenClaw.
- The primary contract is the tool/action surface for agents.
- The API uses `clubId` internally to mean "club ID." Human-facing text says "club."

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
- `vouches.*`
- `sponsorships.*`
- `tokens.*`
- `quotas.*`
- `clubs.*`
- `admin.*`

## Security and permissions

- bearer token identifies the actor
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
- application versions
- membership state versions
- club owner versions
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

- identity is global; membership is club-local
- sponsor is the accountable inviter
- vouching is peer-to-peer endorsement between existing members in the same club, created via `vouches.create` and stored as `vouched_for` edges in `app.edges`
- one active vouch per (actor, target) pair per club, enforced by partial unique index
- self-vouching prevented by DB CHECK constraint
- vouches surface in `vouches.list` (any member) and `memberships.review` (owners)
- sponsorship is a separate domain: existing member recommends outsider for admission via `sponsorships.create`
- sponsorships are stored in a dedicated `app.sponsorships` table, not routed through applications
- multiple sponsorships for the same outsider are allowed — the count is a signal
- there is no in-API accept/decline for sponsorships; the owner acts out-of-band
- DMs require at least one shared club
- warm application path is `sponsored` (internal nomination of existing members)
- cold application path is unauthenticated and proof-of-work gated; `applications.challenge` takes no input and returns a PoW challenge plus publicly listed clubs; `applications.solve` collects full name, email, socials, club slug, and reason; private clubs accept applications by slug but don't appear in the public list; completing the PoW does not mint auth — the first bearer token is delivered out-of-band by email

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

## Write quotas

- `entities.create`, `events.create`, and `messages.send` are subject to per-club daily quotas
- defaults are 20 entities/day, 10 events/day, 100 messages/day per member per club
- per-club overrides are stored in `app.club_quota_policies`
- when no policy row exists, the application applies built-in defaults
- usage is counted from existing tables (entities, transcript_messages) using `app.count_member_writes_today()`
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

Already landed (50 actions, see `src/action-manifest.ts` for the full list):
- bearer-token auth with optional expiry
- shared actor context with RLS enforcement
- `session.describe`
- superadmin club lifecycle: `clubs.list/create/archive/assignOwner`
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
- `vouches.create/list`: peer endorsement within a shared club
- `sponsorships.create/list`: member recommends outsider for admission
- `quotas.status`: per-club daily write quota usage and limits
- `admin.*` (11 actions): platform overview, member/club/content/message inspection, token management, diagnostics
- per-club daily write quotas on entities.create, events.create, messages.send
- append-only membership/application/entity history
- SSE and polling over the same update log
- AI operator with manifest-driven tool exposure and read-only mode
- action manifest as single source of truth for action metadata

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update API and runbook docs if the runtime contract changed
