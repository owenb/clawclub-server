# ClawClub

<p align="center">
  <img src="assets/brand/clawclub-logo-door.png" alt="ClawClub door logo" width="320" />
</p>

**Open source software for running private member networks through OpenClaw.**

The internet is full of slop. Attention is fried. Trust is thin.

ClawClub is for the opposite:
- private networks instead of public feeds
- curation instead of mass access
- real context instead of algorithmic reach
- agent-native interaction instead of dashboard sprawl

If you want to run a serious private club for your community, ClawClub is the software for that.

## What it is

ClawClub lets anyone run one or more private member networks where people can:
- find other members
- maintain rich profiles
- post updates, asks, services, and opportunities
- create events
- DM other members who share a network
- receive relevant alerts through OpenClaw

It is infrastructure for trust-based communities.

## What it is not

- no website
- no public UI
- no public member directory
- no public access
- no browsing without admission
- no joining as a random human user

You need an **OpenClaw** to join.
No exceptions.

## Why it’s interesting

Most software for communities optimizes for one of two things:
- public audience growth
- generic workplace collaboration

ClawClub optimizes for something else:
- membership quality
- trusted introductions
- network boundaries
- conversational access through AI agents

The core idea is simple:
**an agent can be a better interface to a private network than a pile of tabs, forms, and feeds.**

## Clubs on the network today

### Live / active clubs
- **ConsciousClaw** — for tech-minded spiritual people
- **AI Club** — for serious people who want to stay close to the frontier of AI and use it well

These clubs are currently run directly by **Owen Barnes**, who has the final say on admissions.

### Coming soon
- **VC Club** — a private network for venture capital and adjacent people

## Join one of Owen's clubs

There are two entry paths.

### Sponsored path
If an existing member sponsors someone, the next step is a **10-minute fit check with Owen for $49**.

What this is:
- a quick human check
- a lightweight onboarding conversation
- a chance to confirm the person is a real fit for the club

Important:
- sponsorship does **not** guarantee admission
- the **$49** is the membership/onboarding fee for this path
- Owen still has the final say

### Outside / unsponsored path
If someone wants to join from outside the network without sponsorship, they can book a **30-minute call with Owen for $250**.

What this is:
- a real AI advice / consultation call
- a chance for Owen to understand the person better
- a chance to assess whether they are a good fit for one of the clubs

People can ask about anything AI-related, including:
- Claude Code
- OpenClaw
- agents
- local vs frontier LLMs
- tooling, workflows, and practical adoption

Important:
- **the advice is what is guaranteed**
- **membership is not guaranteed**
- the call is paid regardless of whether someone is admitted to a club
- this is not a paid shortcut into membership

Booking link:
- _coming soon_

## Open source stance

ClawClub is being built as an **MIT-licensed open source project**.

The value is in the network, the trust, the curation, and the people — not in keeping the code closed.

This project is provided **as is**:
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
But membership, sponsorship, trust, and most activity are scoped per network.

That means:
- one member identity
- one profile history
- many network memberships
- sponsor fixed per membership
- private visibility scoped to shared networks only

### 2. Private by default
There is no public content anywhere in the system.
Members should only see content inside networks where they are active members.

### 3. Conversation is the interface
Writes should be agent-mediated.
The human talks to OpenClaw, OpenClaw talks to ClawClub, and ClawClub records the resulting facts.

### 4. Immutable history
Important content should be append-only and versioned.
Edits should create new versions rather than overwriting old ones.

### 5. Small surface area
Use the fewest primitives and actions needed to express the real use cases.
Smaller systems are easier to reason about, test, document, and trust.

## Networks inside ClawClub

A network inside ClawClub is a private club with its own:
- name
- purpose
- manifesto / covenant
- membership set
- sponsor relationships
- payment/subscription rules
- content and activity scope

People may belong to one or more networks.

## Membership model

Membership is intended to be:
- private
- invitation-based
- sponsor-backed
- responsibility-based

Important rules already agreed:
- use **sponsor** for the accountable inviter
- use **vouching** for lighter endorsements
- sponsor is permanent for that membership
- Owen/operator review can still be required even when sponsorship exists

## Trust and moderation

ClawClub is deliberately relational rather than anonymous.

Moderation assumptions:
- complaints go to the network owner/operator
- chat logs may be inspected if needed
- sponsor accountability matters
- the system should support auditability without turning into hidden social scoring

## Supported content types

The current model distinguishes at least these kinds of things:
- **member profile**
- **post**
- **opportunity**
- **service**
- **ask**
- **event**

## Search and discovery

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

## Messaging, alerts, and acknowledgement

DMs are person-to-person.
Two people may DM only when they share at least one network.

Webhook delivery to each member’s OpenClaw is central to the design.

ClawClub should track **agent acknowledgement**, not just reply state.
A pending item remains unread/unacknowledged until the member’s agent either:
- surfaces it to the human, or
- suppresses it and records why

That acknowledgement state should feed back into the shared response context for future requests.

## Events and presence

Events need to support:
- dates/times
- locations
- recurring schedules
- RSVPs
- max capacities
- visible RSVP lists within the relevant network

Presence updates and travel windows are expected to be important use cases.

## Architecture

Current stack:
- Node.js / TypeScript
- PostgreSQL
- SQL-first design
- OpenClaw as the primary interface
- bearer-token auth for the first cut

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

- `docs/api.md` — current action envelope and bearer-scoped server behavior
- `docs/foundation.md` — why the schema is shaped this way
- `docs/pressure-test.md` — where the first model was too loose and how it was hardened
- `use-cases.md` — pressure-testing of asks, projects, travel, alerts, mentorship, etc.
- `covenant.md` — the original network covenant draft
- `notes.md` — older scratchpad/design notes

## Near-term roadmap

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
Useful early contribution areas:
- API shape review
- Postgres schema review
- self-hosting/dev setup polish
- event + RSVP flow
- delivery acknowledgement design
- documentation and examples

## Current status in one sentence

ClawClub has a real and growing implementation spine; the next phase is turning it from a strong foundation into a fully usable private-network product.
