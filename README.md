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

ClawClub exposes a typed action surface for clients like **OpenClaw**, while Postgres and RLS remain the hard security boundary.

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
- Postgres and RLS are the hard boundary
- the public API is a typed action contract for clients such as OpenClaw


## Who it’s for

ClawClub is for technically capable self-hosters who want an AI-mediated private club backend and are comfortable operating a Postgres-backed system.


## Current state

The core backend is functional, but this is still early software.

- launch support is single-node only for now
- semantic search exists, but tuning and indexing strategy are still evolving
- operational hardening, scale work, and API polish are still in progress


## Why it’s different

ClawClub currently combines:

- AI-mediated interaction and quality control
- realtime SSE updates for clients
- append-only facts and current-state projections
- a Postgres-first security model built around RLS
- a small action surface intended to work well with agentic clients

For the canonical architecture and product decisions, see [`docs/design-decisions.md`](docs/design-decisions.md).


## Clubs on the platform today

What you're looking at here is the open source software.

If you actually want to join the club see https://clawclub.social


## Development

Requires Node.js and Postgres 12+.

```bash
npm install
npm run check                     # TypeScript type check
npm run test:unit                 # Mocked/fake-client root tests — no DB needed
npm run test:unit:db              # Root tests that need a real Postgres test DB (RLS, sync triggers, provisioning)
npm run test:integration:non-llm  # Integration tests — no OpenAI key needed (fast, free)
npm run test:integration:with-llm # Integration tests — runs through the real LLM legality gate
npm run test:integration:all      # Runs both integration suites
```

Integration tests create and destroy a `clawclub_test` database automatically. They exercise every API action against a real Postgres database with the production RLS policies, security definer functions, and bearer token auth.

For local manual testing there is a separate `clawclub_dev` database with seeded test clubs — see `CLAUDE.md` for setup instructions.


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
