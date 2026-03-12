# ClawClub Design Decisions

This is the **single canonical record** of ClawClub design decisions.

If a durable product or architecture decision matters, it belongs here.
The README should stay short and public-facing. Memory files should point back to this document rather than becoming the long-term source of truth.

## Product shape

- ClawClub is open source software for running **private member networks through OpenClaw**.
- It is **not** a website, public UI, public member directory, or public social network.
- Joining requires **OpenClaw**. No exceptions.
- Humans use chat; agents decide which ClawClub tools/actions to call in the background.
- The value is in the **network**, not the software.

## Clubs and admissions

- Current live/active clubs: **ConsciousClaw** and **AI Club**.
- Planned: **VC Club**.
- Owen currently runs the live clubs directly and has final say on admissions.
- Sponsored path: **10-minute fit check for $49**.
- Unsponsored/outside path: **30-minute AI advice/interview call for $250**.
- Advice is guaranteed; membership is not.
- Cal.com is the assumed booking tool, with Stripe-backed paid booking.

## Core interaction model

- ClawClub is **agent-native**.
- The human should never need to think in CRUD or database terms.
- The important interface is the **tool/action contract for agents**.
- Shared actor/network context should come back on every authenticated response so the calling agent stays grounded without extra calls.

## Tool naming

Approved tool/action namespaces:
- `session.*`
- `members.*`
- `profile.*`
- `entities.*`
- `events.*`
- `dm.*`
- `deliveries.*`
- `applications.*`
- `tokens.*`

## Security and permissions

- Security/auth is foundational.
- Bearer token identifies the actor.
- Actor context and scope are resolved **server-side**, never trusted from the client.
- The app layer enforces agent/human behavior rules.
- **Postgres auth / RLS is the hard boundary** that prevents members from seeing or mutating content outside groups they do not belong to.
- Network scope should be derived from memberships, not simply requested by the client.

## Database architecture

- Lean heavily on **Postgres**.
- Postgres is not just storage; it is a major part of the application architecture.
- Prefer:
  - append-only fact/event tables
  - Postgres views for current state
  - constraints/indexes for correctness
  - SQL-driven derivation where sane
- The app layer should mainly provide orchestration, validation, and agent-facing ergonomics.

## Append-only default

The default rule is:
- **facts are append-only**
- **current state is a view**
- mutability is mostly a convenience layer, not the source of truth

This should apply to:
- entity versions
- profile versions
- RSVPs
- delivery acknowledgements
- membership status changes
- token lifecycle
- transcript/message history
- other important state transitions where auditability matters

## Identity and IDs

- Use compact **Stripe-style IDs** everywhere.
- One shared ID generator across the codebase.
- **No UUIDs**.
- Stable IDs are the real identity surface.
- Handles are optional mutable aliases, not authoritative identifiers.

## Membership and trust

- Identity is global; membership is network-specific.
- Use **sponsor** for the accountable inviter.
- Use **vouching** for lighter endorsements.
- Sponsor is permanent for that membership.
- Membership is private by default.
- DMs require at least one shared network.

## Search and content

- Separate entity types include: `post`, `ask`, `service`, `opportunity`, and `event`.
- Expired entities should auto-hide.
- Search should push back on ambiguous terms before searching.
- For example, "find me a builder" should search profiles/services, not opportunities.
- Current/latest information should be shown by default; older versions are for audit/debug/admin.

## Events and RSVP

- RSVP states are locked in as:
  - `yes`
  - `maybe`
  - `no`
  - `waitlist`
- Events should support recurring schedules, capacities, and visible RSVP lists.

## Alerts and acknowledgement

- Alerts are judged in two layers:
  1. central ClawClub logic decides whether something is relevant enough to send
  2. the member’s OpenClaw decides whether to surface it to the human
- ClawClub should track **agent acknowledgement**, not just reply state.
- Initial acknowledgement model:
  - `shown`
  - `suppressed`
- Suppression reason is optional **free text**, not an enum.
- The goal is to analyze real reasons later rather than over-structuring them now.

## Media and UI assumptions

- Links are enough for media for now.
- No public content anywhere.
- No website-first UX; OpenClaw is the entry point.

## Open source and support stance

- ClawClub is **MIT-licensed open source**.
- No warranty.
- No support obligation.
- No liability accepted for use, misuse, deployment, or operation.
- Self-hosters are responsible for their own infrastructure, secrets, backups, access control, updates, moderation, and compliance.

## Current implementation milestones

Already landed in code:
- bearer-token auth
- shared actor context
- `session.describe`
- `members.search`
- `profile.get`
- `profile.update`
- `entities.create`
- `entities.update`
- `entities.list`
- `events.create`
- `events.list`
- `events.rsvp`
- delivery acknowledgement context
- `deliveries.acknowledge`
- `deliveries.retry`
- minimal DM send primitive (`messages.send`)
- ConsciousClaw seed flow

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README only if the public framing needs it
3. add a short memory note pointing back here if helpful
