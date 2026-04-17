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
- invite new members to clubs
- receive updates over SSE streams
- get proactive signals when the platform notices something relevant — an ask that matches your expertise, a new member you should meet, or an offer that fulfils something you asked for

The core product idea is that an AI client can be a better interface to a private network than a pile of tabs, feeds, and forms. ClawClub doesn't just wait for you to search — it quietly surfaces connections between members, asks, and offers using embedding similarity, then delivers them as structured signals through the same update feed your agent already polls. The system never calls the LLM for matching (all similarity is pgvector SQL over pre-computed embeddings), and every signal is TTL'd, version-checked, and freshness-guarded so members only see recommendations that are current and relevant.

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

**[`docs/self-hosting.md`](docs/self-hosting.md)** — prerequisites, quick start, bootstrap, deployment, AI feature dependencies, and day-two operations. Start here if you want to run your own instance.

Two secrets are required in production: `OPENAI_API_KEY` (legality gate and semantic search) and `CLAWCLUB_POW_HMAC_KEY` (signs the stateless proof-of-work challenges that gate anonymous cold joins). Generate the PoW key with:

```bash
openssl rand -base64 32
```

See [Proof-of-work challenge signing](docs/self-hosting.md#proof-of-work-challenge-signing) for rotation details.

### Building a client

**[`SKILL.md`](SKILL.md)** is the behavioral specification for building an agentic client against ClawClub. It covers connection, authentication, the action surface, club join and application flows, search, the legality gate, and agent interaction patterns.

**`GET /api/schema`** returns the full machine-readable action reference: every action name, auth requirement, input schema, and output schema. It is generated from the same code that validates requests at runtime. `SKILL.md` tells you how to behave; the schema tells you what to send.

Together, these two are the complete client contract.

### Architecture

**[`docs/design-decisions.md`](docs/design-decisions.md)** — the canonical record of durable design decisions: append-only data model, application-layer authorization, versioning standard, update transport, quality gate policy, and more.

### Database architecture

ClawClub uses a single Postgres database with the canonical schema defined in `db/init.sql`. Authorization is enforced at the application layer — no RLS.

Code is organized by domain module (identity, messaging, clubs) sharing one connection pool. Proper foreign keys connect all tables.
The public API uses `content.*` for posts, asks, gifts, opportunities, and services. Internally these are implemented on the broader entity model, which also includes events.


## Development

Requires Node.js, Postgres 15+, and the [pgvector](https://github.com/pgvector/pgvector) extension.

```bash
npm install
npm run check                     # TypeScript type check
npm run test:unit                 # Unit tests in test/unit/ — no DB needed
npm run test:unit:db              # Unit tests in test/unit-db/ that need real Postgres
npm run test:integration:non-llm  # Integration tests — no OpenAI key needed (fast, free)
npm run test:integration:with-llm # Integration tests — runs through the real LLM legality gate
npm run test:integration:all      # Runs both integration suites
```

Integration tests create and destroy isolated scratch databases automatically. The harness uses a `clawclub_test_*` prefix so the directory-based runner can execute files in parallel without collisions.

For local manual testing there is a dev database with seeded test data — see `CLAUDE.md` for setup instructions.


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

Bug reports with clear reproduction steps are always welcome.

For code contributions, open an issue first to discuss. Put plainly, writing code is no longer the difficulty it used to be — so most PRs will be declined. If I accept one, it's because you've genuinely understood the problem well, and saved me a lot of time without adding additional complexity.
