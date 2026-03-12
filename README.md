# ClawClub

ClawClub is a private-members-network backend built for OpenClaw.

It is the actual software product.
Inside ClawClub, there can be many different private member networks, each with its own purpose, rules, and membership.
**ConsciousClaw** is one example network inside ClawClub — the original spiritually oriented club that inspired the whole thing.

This is **not** a public social network.
It is **not** a dating app.
It is a private, invitation-based system for helping aligned people find one another for friendship, collaboration, service, projects, opportunities, gatherings, and direct connection.

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

## Messaging and DMs

DMs are person-to-person.
Two people may DM only when they share at least one network.

When showing a DM, the system should reveal only the networks shared by both parties in that context — not unrelated memberships.

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

## Alerts and delivery

Webhook delivery to each member’s OpenClaw is central to the design.

Alerting should use a two-layer judgment model:
1. central ClawClub agent/server decides whether something is relevant enough to send
2. the member’s OpenClaw decides whether to surface it to the human

Early bias: better to err slightly on the side of useful alerts than to suppress too much, while still avoiding spam.

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

The project is in **foundation stage**.
It is real, but not yet end-to-end complete.

What exists now:
- SQL migrations under `db/migrations/`
- a schema covering members, profiles, networks, memberships, subscriptions, entities, entity versions, vouches/edges, transcripts, locations, media, embeddings, deliveries, and current/latest read views
- a thin Node API skeleton
- a single action endpoint: `POST /api`
- bearer-scoped actor resolution
- initial actions:
  - `session.describe`
  - `members.search`
  - `profile.get`
  - `profile.update`
  - `entities.create`
  - `entities.list`
- tests for action routing and access scoping
- shell scripts for migrate/status/smoke/pressure testing

What is not complete yet:
- real token/auth model beyond the first simple bearer pattern
- broader profile workflows beyond the first read/update flow
- entity creation/update flows
- DM actions
- event creation / RSVP actions through the API
- webhook delivery end to end
- embeddings generation/ranking pipeline
- subscription/billing enforcement flows
- full OpenClaw skill integration against the live server

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
- 12-character random IDs instead of UUIDs
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
clawclub/
├── db/
│   └── migrations/
├── docs/
├── scripts/
├── src/
├── test/
├── covenant.md
├── notes.md
├── use-cases.md
└── SKILL.md
```

## Running locally

Requirements:
- PostgreSQL 15+
- `psql`
- `DATABASE_URL`

Setup:

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run api:test
npm run api:start
```

Other useful commands:

```bash
npm run db:status
npm run db:smoke
npm run db:pressure
npm run db:seed:consciousclaw
```

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

## Short roadmap

The next practical implementation steps are:
1. replace the auth placeholder with a proper bearer token model
2. deepen profile flows beyond the first `profile.get` / `profile.update` actions
3. add entity update/versioning actions on top of the shared `entities.*` surface
4. add event + RSVP flows
5. add DM/shared-network validation flows
6. add delivery/webhook flows
7. add embeddings-backed ranking and richer search
8. connect the shared OpenClaw skill end to end

## Current status in one sentence

ClawClub has a strong, real foundation and a clear spec; the remaining work is to turn that foundation into a fully usable private-network product.