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
- The `actor` envelope is canonical session state; actions should not duplicate the same member/network context again inside `data` unless the payload is genuinely different.

## Tool naming

Approved tool/action namespaces:
- `session.*`
- `members.*`
- `profile.*`
- `entities.*`
- `events.*`
- `messages.*`
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

## Versioning standard

ClawClub should use one consistent versioning philosophy across the database.

For important mutable state, use one of these two shapes:

### Shape A: root table + version table + current view
Use this for stateful domain objects with stable identity and evolving state.

Pattern:
- `thing`
- `thing_versions`
- `current_thing`

Examples:
- profiles
- entities
- applications
- membership states
- network ownership
- global roles
- future network settings/policy objects

The root table gives the object a durable identity.
The version table is append-only history.
The current view gives the latest state for normal reads.

### Shape B: append-only event table + current view
Use this for naturally event-like data where each row is already a meaningful fact.

Pattern:
- `thing_events`
- `current_thing`

Examples:
- RSVPs
- delivery attempts
- transcript messages
- some trust/vouching edges

This is the same philosophy, just a different natural shape.
The event table is the durable history, and the current view projects the latest useful state.

## Versioning rule

For all important mutable domain state in ClawClub, use either:
1. a root table + append-only version table + current view, or
2. an append-only event table + current view.

In-place mutation should not be the primary source of truth for important state.

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
- Until embeddings-backed search exists, text retrieval should stay explicit and deterministic: exact/prefix/title hits outrank broad body matches, and time remains the tie-breaker.
- Embeddings should remain append-only facts with latest-per-version projection views. For now, the minimal foundation is just current profile/entity embedding metadata on reads, not a full indexing queue or ranking engine.
- Owner admissions views should expose the handoff to activation directly on the current application projection: linked membership, its current status, and whether the accepted application is ready for activation.
- The final owner handoff should stay append-only and transactional: accepting a completed interview may append the membership activation state in the same transaction, rather than relying on a hidden mutable side channel.

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
- Webhook delivery signing should be practical, not ceremonial: resolve sender secrets server-side, sign the exact raw body, and ship a tiny receiver verification helper so the path is usable end-to-end.
- Delivery execution auth should be separate from ordinary member bearer auth. Worker/service tokens should be explicit, Postgres-backed, and scoped to allowed network ids so background executors do not inherit full member session authority.
- Worker/service tokens should also decay with real membership access: their stored scope is only a ceiling, and runtime auth should intersect it with the actor's current memberships so stale tokens lose authority automatically.
- Short-term proactive notification delivery should also support a simple non-LLM polling endpoint, conceptually `/updates`, called by OpenClaw every 5 minutes.
- `/updates` should return unseen DMs and unseen network posts the member is allowed to see.
- The server, not the cron job, should track what each member has already seen for this polling surface so the same updates are not re-notified repeatedly.
- Even if something has already been surfaced through `/updates`, the conversational/LLM layer may still resurface it later if it is relevant in context.

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
- superadmin network lifecycle actions
- `members.search`
- `members.list`
- `profile.get`
- `profile.update`
- `entities.create`
- `entities.update`
- `entities.list`
- `events.create`
- `events.list`
- `events.rsvp`
- `messages.inbox`
- `messages.list`
- `messages.read`
- delivery acknowledgement context
- `deliveries.acknowledge`
- `deliveries.retry`
- delivery endpoint CRUD, worker auth, and execution plumbing
- `memberships.list`
- `memberships.create`
- `memberships.review`
- `memberships.transition`
- `applications.list`
- `applications.create`
- `applications.transition`
- `tokens.list`
- `tokens.create`
- `tokens.revoke`
- `messages.send`
- ConsciousClaw bootstrap/seed flow

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README only if the public framing needs it
3. add a short memory note pointing back here if helpful
