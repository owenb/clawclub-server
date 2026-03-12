# ClawClub

<p align="center">
  <img src="assets/brand/clawclub-logo-door.png" alt="ClawClub door logo" width="320" />
</p>

**MIT-licensed open source software for agent-native private member networks.**

ClawClub is the software layer.
The value is in the network, the trust, the curation, and the people — not in keeping the code closed.

Inside ClawClub, there can be many different private member networks, each with its own purpose, rules, and membership.
**ConsciousClaw** is one example network inside ClawClub — the original spiritually oriented club that inspired the whole thing.

This is **not** a public social network.
It is **not** a dating app.
It is a private, invitation-based system for helping aligned people find one another for friendship, collaboration, service, projects, opportunities, gatherings, and direct connection.

## Why this exists

Most community software assumes one of two models:
- public audience building
- generic workplace collaboration

ClawClub is for neither.

It is for curated, trust-based member networks where:
- membership matters
- introductions matter
- context matters
- private discovery matters
- the interface can be conversational instead of form-heavy

The design assumption is that an AI agent can be a better interface to a private network than a traditional dashboard full of tabs and filters.

## What ClawClub is for

ClawClub is meant to support private networks where members can:
- discover other members
- maintain rich profiles
- post updates
- offer services
- post opportunities
- make asks
- create events and recurring gatherings
- RSVP to events
- share travel / temporary presence
- exchange resources
- coordinate projects
- vouch for one another
- DM other members when they share a network

The interface is primarily **agent-native**:
- people interact through OpenClaw
- the agent talks to the ClawClub server
- the server enforces hard permissions and network scope
- there is no assumption of a public web UI

## Open source stance

ClawClub is being built as an **MIT-licensed open source project**.

That means the code should be:
- readable
- self-hostable
- inspectable
- easy to extend
- easy to eject from
- useful even without a central hosted service

The moat, if there is one, is not proprietary code.
It is the quality of the network itself:
- trust
- taste
- curation
- relationships
- culture

This open source project is provided **as is**:
- no warranty
- no guarantee of support
- no guarantee of security, uptime, or suitability
- no liability accepted for your use, misuse, deployment, or operation of it
- use it at your own risk

If you self-host ClawClub, you are responsible for your own:
- infrastructure
- secrets
- backups
- access control
- updates
- moderation decisions
- legal and compliance obligations

## Core product principles

### 1. Global identity, network-local trust
A person has one core identity across ClawClub.
They do not become different people in different networks.

But membership, trust, sponsorship, subscriptions, and most activity are scoped per network.

That means:
- one member identity
- one profile history
- one auth token surface per person
- many possible network memberships
- sponsor fixed per network membership
- private visibility scoped to shared networks only

### 2. Private by default
There is no public content anywhere in the system.

Members should only see content inside networks where they are active members.
Network membership itself should be treated as private by default, except where overlapping shared context makes disclosure appropriate.

### 3. Conversation is the interface
Writes should be agent-mediated.
The human talks to OpenClaw, OpenClaw talks to ClawClub, and ClawClub records the resulting facts.

This means the system should preserve:
- chat transcripts for traceability
- provenance from created entities back to transcript rows where possible
- reviewable action flows rather than direct raw table manipulation by ordinary members

### 4. Immutable history
Important content should be append-only and versioned.
Edits should create new versions rather than overwriting old ones.
Users normally see only the latest version, but the older history remains available for admin/debug/audit.

### 5. Structured enough to query, flexible enough to evolve
ClawClub uses:
- typed Postgres columns for high-value filters and invariants
- JSONB for evolving shape
- embeddings for semantic search and matching

The goal is to avoid freezing the schema too early while still making reliable search, scoping, and policy enforcement possible.

### 6. Keep the surface area small
The product should use the fewest primitives and actions needed to express the real use cases.
A smaller surface area makes the system:
- easier to reason about
- easier to test
- easier to document
- easier for agents to use well
- easier to maintain in public

## Networks inside ClawClub

ClawClub is the platform.
A network inside ClawClub is a private club with its own:
- name
- purpose
- manifesto / covenant
- membership set
- sponsor relationships
- payment/subscription rules
- content and activity scope

Examples of possible networks:
- ConsciousClaw
- a local founders network
- a service/community network
- a neighborhood or city-based private club

Most people may belong to one network, but the model supports membership in many.

## Membership model

Membership is intended to be:
- private
- invitation-based
- sponsor-backed
- responsibility-based
- usually paid, but waivable

Important rules already agreed:
- use **sponsor** for the accountable inviter
- use **vouching** for lighter endorsements
- sponsor is permanent for that membership
- every vouch must include a reason
- sponsors may eventually be limited in how many new people they bring in over time
- members may only search/post/interact inside networks where they are currently entitled to act

## Trust and moderation

ClawClub is deliberately relational rather than anonymous.

Moderation assumptions:
- complaints go to the network owner/operator
- chat logs may be inspected if needed
- sponsor accountability matters
- the system should support auditability without turning into hidden social scoring

Current trust primitives are intentionally simple:
- sponsor
- vouch
- historical actions / participation

## Supported content types

The current model distinguishes at least these kinds of things:
- **member profile**
- **post**
- **opportunity**
- **service**
- **ask**
- **event**

Important distinctions:
- opportunities are not necessarily paid or full-time
- services are offerings, often with prices or terms
- asks are requests for help/resources/people
- events include time and place, and can recur

Expired asks, services, opportunities, and events should auto-hide.

## Search and discovery

Search is one of the core reasons this product exists.

ClawClub should support search across:
- people
- profiles
- services
- asks
- opportunities
- events
- locations
- linked writings/content

Search should combine:
- deterministic network scoping
- structured filters
- text search
- embedding ranking
- trust/vouch context

Important search behavior already agreed:
- ambiguous requests should sometimes trigger clarification before searching
- for example, "find me a builder" may need clarification
- people/services should not be confused with opportunities
- results should default to current/latest information, not raw historical dumps

## Messaging, alerts, and acknowledgement

DMs are person-to-person.
Two people may DM only when they share at least one network.

When showing a DM, the system should reveal only the networks shared by both parties in that context — not unrelated memberships.

Webhook delivery to each member’s OpenClaw is central to the design.

Alerting should use a two-layer judgment model:
1. central ClawClub agent/server decides whether something is relevant enough to send
2. the member’s OpenClaw decides whether to surface it to the human

ClawClub should track **agent acknowledgement**, not just reply state.
A pending item remains unread/unacknowledged until the member’s agent either:
- surfaces it to the human, or
- suppresses it and records why

That acknowledgement state should feed back into the shared response context for future requests.

The system should store transcripts for:
- debugging
- traceability
- provenance links back into content creation flows

## Events and presence

Events are first-class enough to support:
- dates/times
- locations
- recurring schedules
- RSVPs
- max capacities
- visible RSVP lists within the relevant network

Location should distinguish between:
- home base
- current city / temporary presence

Presence updates and travel windows are expected to be important use cases.

## Architecture

Current stack:
- Node.js / TypeScript
- PostgreSQL
- SQL-first design
- OpenClaw as the primary interface
- bearer-token auth for the first cut

Likely security hardening later:
- Row Level Security where it genuinely adds defense in depth
- stronger token verification / token tables instead of the current development placeholder
- richer audit and permission boundaries

## Current code status

ClawClub is **real but early**.
It has moved beyond idea/spec stage and into actual implementation, but it is not yet a full product.

### What exists now
- SQL migrations under `db/migrations/`
- schema for members, profiles, networks, memberships, subscriptions, entities, entity versions, vouches/edges, transcripts, locations, media, embeddings, deliveries, and current/latest read views
- thin Node API skeleton
- single action endpoint: `POST /api`
- hashed bearer-token auth with shared actor context returned on authenticated responses
- initial actions:
  - `session.describe`
  - `members.search`
  - `profile.get`
  - `profile.update`
  - `entities.create`
  - `entities.list`
- token generation utility and CLI helper
- ConsciousClaw seed script for the first real network/member bootstrap
- tests for action routing and access scoping
- shell scripts for migrate/status/smoke/pressure testing

### What is not complete yet
- `entities.update` append-only versioning flow
- event creation and RSVP actions
- DM actions
- delivery acknowledgement flow
- webhook delivery end to end
- embeddings generation/ranking pipeline
- subscription/billing enforcement flows
- full OpenClaw skill integration against the live server
- polished first-user bootstrap walkthrough

## Clubs on the network today

The software is generic, but there are already specific clubs being formed on top of it.

### Live / active clubs
- **ConsciousClaw** — for tech-minded spiritual people
- **AI Club** — for serious people who want to stay close to the frontier of AI and use it well

### Coming soon
- **VC Club** — a private network for venture capital and adjacent people

## Joining one of Owen's clubs

For the first clubs run directly by Owen, sponsorship and fit both matter.

The intended flow is:
1. someone is sponsored or otherwise introduced
2. they book a **30-minute call with Owen for $250**
3. they receive real advice during that call, especially around the latest AI landscape where relevant
4. Owen also uses the call to assess fit, seriousness, values, and whether the person should be admitted

Important:
- **the advice is what is guaranteed**
- **membership is not guaranteed**
- the call is paid regardless of whether someone is admitted to a club

Booking link:
- _coming soon_

## If we announced this today

The truthful framing would be:
- the project is open source
- the foundation is real
- the product is under active construction
- early adopters can inspect, follow, contribute, and self-host
- it is not yet a finished public launch

## Quickstart

Requirements:
- PostgreSQL 15+
- `psql`
- `DATABASE_URL`
- Node.js 22+

Setup:

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed:consciousclaw
npm run api:test
npm run api:start
```

Generate a bearer token for a member:

```bash
npm run api:token -- <member_id> [label]
```

Example request:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Demo path

A minimal believable demo path today is:
1. migrate the database
2. seed ConsciousClaw
3. mint a bearer token for the seeded member
4. call `session.describe`
5. call `profile.get`
6. call `profile.update`
7. call `entities.create`
8. call `entities.list`

That is enough to show:
- real auth
- real actor context
- profile reads/writes
- generic network content creation/listing

## Data model direction

The data model currently centers on these ideas:
- **members**: global identity
- **networks**: private clubs within ClawClub
- **network_memberships**: sponsor-backed membership facts
- **subscriptions**: per-network payment/entitlement
- **entities** + **entity_versions**: posts, asks, services, opportunities, events, and other publishable objects
- **edges**: vouching and other graph relationships
- **transcript threads/messages**: conversational provenance
- **locations**: home base, current city, entity/event location links
- **deliveries**: webhook and notification pipeline
- **media**: private links for now
- **embeddings**: semantic matching layer

Important design choices already made:
- Stripe-style compact IDs instead of UUIDs
- one shared ID generation path
- append-only versions where changes matter
- soft-delete/archive rather than hard delete in normal flows
- old versions hidden from ordinary users by default
- sponsor facts treated as stable/permanent
- canonical permission scope from accessible memberships
- append-only RSVP history with a current-read surface

## Why the current API is action-based

The current API uses one endpoint with action routing instead of route-per-table CRUD.

That is intentional.
This product is meant to be consumed by agents, and the actions should map to user intentions more than table operations.

Current request shape:

```http
POST /api
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "action": "session.describe",
  "input": {}
}
```

## Repository layout

```text
.
├── db/
│   └── migrations/
├── docs/
├── scripts/
├── src/
├── test/
├── LICENSE
├── README.md
├── SKILL.md
├── covenant.md
├── notes.md
└── use-cases.md
```

## Public repo hygiene

This repository is intended to be public-facing.
That means:
- no workspace memory files
- no private assistant state
- no hidden local assumptions in docs
- clear setup instructions
- straightforward licensing

## Key supporting documents

This README now holds the main project overview.
The remaining documents are still useful for deeper detail:

- `docs/api.md` — current action envelope and bearer-scoped server behavior
- `docs/foundation.md` — why the schema is shaped this way
- `docs/pressure-test.md` — where the first model was too loose and how it was hardened
- `use-cases.md` — pressure-testing of asks, projects, travel, alerts, mentorship, etc.
- `covenant.md` — the original network covenant draft
- `notes.md` — older scratchpad/design notes

Over time, some of these may be reduced further as the README becomes the main canonical overview.

## Near-term roadmap

The next practical implementation steps are:
1. add `entities.update` append-only versioning
2. add event + RSVP flows
3. add delivery acknowledgement and unread-context flow
4. add DM/shared-network validation flows
5. add webhook delivery flow end to end
6. add embeddings-backed ranking and richer search
7. tighten self-hosting/bootstrap docs
8. connect the shared OpenClaw skill end to end

## Contributing

The code is open source because the project benefits from scrutiny, contribution, and self-hosting.
If you want to contribute, the best early areas are likely to be:
- API shape review
- Postgres schema review
- self-hosting/dev setup polish
- event + RSVP flow
- delivery acknowledgement design
- documentation and examples

## Current status in one sentence

ClawClub has a real and growing implementation spine; the next phase is turning it from a strong foundation into a fully usable private-network product.
