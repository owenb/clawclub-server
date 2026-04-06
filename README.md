# ClawClub

<p align="center">
  <img src="assets/brand/clawclub-logo-door.png" alt="ClawClub door logo" width="320" />
</p>

**Very early open source software for AI-mediated private member clubs.**

ClawClub is a Postgres-native backend for running private clubs where members can:

- find each other
- post asks, services, opportunities, and updates
- create and RSVP to events
- DM people they share a club with
- use early semantic search built on embeddings and pgvector
- vouch for existing members
- sponsor new members for admission
- receive updates over SSE streams

The core product idea is that an AI client can be a better interface to a private network than a pile of tabs, feeds, and forms.

**This is a headless backend, not a UI.** You interact with ClawClub through an agentic client like [OpenClaw](https://clawclub.social) or your own client built against the action contract.


## Status

ClawClub is very new software.

- expect rough edges
- expect APIs and schema details to change
- no warranty
- no support obligation
- self-host and operate at your own risk

If you deploy it, you are responsible for your own infrastructure, secrets, access control, backups, moderation, updates, and compliance.


## What it is

ClawClub is infrastructure for trust-based communities.

It is built around three ideas:

- AI mediation is part of the product, not an optional add-on
- Postgres is the storage layer; authorization is enforced at the application layer
- the public API is a typed action contract for clients such as OpenClaw


## Clubs on the platform today

What you're looking at here is the open source software.

If you actually want to join the club see https://clawclub.social


## Start here

### Self-hosting

**[`docs/self-hosting.md`](docs/self-hosting.md)** — prerequisites, quick start, bootstrap, deployment guides (Railway and Hetzner), AI feature dependencies, and day-two operations. Start here if you want to run your own instance.

### Building a client

**[`SKILL.md`](SKILL.md)** is the behavioral specification for building an agentic client against ClawClub. It covers connection, authentication, the action surface, admission flows, search, the legality gate, and agent interaction patterns.

**`GET /api/schema`** returns the full machine-readable action reference: every action name, auth requirement, input schema, and output schema. It is generated from the same code that validates requests at runtime. `SKILL.md` tells you how to behave; the schema tells you what to send.

Together, these two are the complete client contract.

### Architecture

**[`docs/design-decisions.md`](docs/design-decisions.md)** — the canonical record of durable design decisions: append-only data model, application-layer authorization, versioning standard, update transport, quality gate policy, and more.

### Database architecture

ClawClub uses three separate Postgres databases instead of one:

| Database | What it owns | Why it's separate |
|----------|-------------|-------------------|
| **Identity** | Members, auth tokens, profiles, clubs, memberships, subscriptions, routing | Single source of truth for "who are you and what can you access." Never shards. |
| **Messaging** | Threads, messages, inbox state, receipts | Conversations are between people, not tied to any club. Can scale independently of club content. |
| **Club** (shard 1) | Entities, events, RSVPs, admissions, vouches, activity feed, quotas, embeddings | All club content lives here. When a single shard fills up, clone the schema and route new clubs to shard 2. |

All three run on the same Postgres instance today. The split exists so that each plane can move to its own server, add read replicas, or shard independently when the time comes — without rewriting the application layer.

Cross-plane data (member names in club content, counterpart names in message threads) is resolved at the application layer via batch lookups against the identity database. No replication between databases.

**[`docs/identity-club-split.md`](docs/identity-club-split.md)** — the full architectural plan: table assignments, cross-plane operations, and implementation phases.


## Development

Requires Node.js, Postgres 15+, and the [pgvector](https://github.com/pgvector/pgvector) extension.

```bash
npm install
npm run check                     # TypeScript type check
npm run test:unit                 # Mocked/fake-client root tests — no DB needed
npm run test:unit:db              # Root tests that need a real Postgres test DB (provisioning)
npm run test:integration:non-llm  # Integration tests — no OpenAI key needed (fast, free)
npm run test:integration:with-llm # Integration tests — runs through the real LLM legality gate
npm run test:integration:all      # Runs both integration suites
```

Integration tests create and destroy three databases (`clawclub_identity_test`, `clawclub_messaging_test`, `clawclub_clubs_test`) automatically. They exercise every API action against real Postgres databases with bearer token auth.

For local manual testing there are three dev databases with seeded test data — see `CLAUDE.md` for setup instructions.


## Open source stance

ClawClub is MIT-licensed open source.

This project is provided **as is**:
- no warranty
- no support obligation
- no guarantee of security, uptime, or suitability
- no liability accepted for your use, misuse, deployment, or operation of it
- use it at your own risk

If you self-host ClawClub, you are responsible for your own infrastructure, secrets, backups, access control, updates, moderation, and compliance.


## Contributing

Put plainly, writing code is no longer the difficulty it used to be. So it's most unlikely I'll accept your PR. If I do, it's because you've genuinely understood the problem well, and saved me a lot of time without adding additional complexity.
