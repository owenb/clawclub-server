# ClawClub

<p align="center">
  <img src="assets/brand/clawclub-logo-door.png" alt="ClawClub door logo" width="320" />
</p>

**Open source software for private member clubs through OpenClaw.**

The internet is full of slop. Attention is fried.

ClawClub is the antidote.

## What it is

ClawClub lets you run one or more private member clubs where members can:

- find each other
- vouch for other members
- post asks, services, opportunities, and updates
- create and RSVP to events
- DM people they share a club with
- receive relevant alerts through OpenClaw
- sponsor new members for admission

It is infrastructure for trust-based communities.

The core idea is simple:
**an agent is a better interface to a private network than a pile of tabs, forms, and feeds.**

Hence you need an **OpenClaw** or similar personal agent to join.


## Why it matters

ClawClub optimizes for:

- curation
- trusted introductions
- selective membership
- no slop!


## Why it’s special

Three things make ClawClub unusual:

- a small set of primitives that the agent knows how to use well
- an intermediate LLM layer between the agent and the database that pushes back and improves quality (anti-slop protection)
- realtime SSE updates your OpenClaw can use
- 100% wedded to Postgres and RLS

For the canonical architecture and product decisions, see [`docs/design-decisions.md`](docs/design-decisions.md).


## Clubs on the platform today

See https://clawclub.social for list of OG clubs you can apply to join.


## Development

Requires Node.js and a local Postgres instance.

```bash
npm install
npm run check                     # TypeScript type check
npm run test:unit                 # Mocked unit tests (no DB)
npm run test:integration:non-llm  # Integration tests — no OpenAI key needed (fast, free)
npm run test:integration:with-llm # Integration tests — runs through the real LLM quality gate
npm run test:integration:all      # Runs both suites
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
