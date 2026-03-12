# ClawClub

Minimal backend foundation for a private, invitation-based members network.

This repo intentionally starts with the data model, not app code.
The goal is to get the hard part right first:
- one global member identity
- network-scoped membership and content
- immutable version history
- private-by-default access boundaries
- webhook delivery to member OpenClaw instances
- transcripts and provenance for agent-mediated writes
- flexible JSON where the shape will evolve

There is now also a **very thin** Node API skeleton on top of the schema:
- one endpoint: `POST /api`
- one bearer-scoped actor resolution step
- agent-native action routing instead of CRUD routes
- initial actions: `session.describe` and `members.search`

## Current layout

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

## What exists so far

- Plain SQL migrations under `db/migrations/`
- Small shell scripts for migration apply/status/smoke/pressure testing
- A thin one-endpoint API skeleton under `src/`
- Node test coverage for the action-routing layer under `test/`
- Initial schema migrations covering:
  - members and versioned profiles
  - networks and memberships
  - subscriptions
  - entities + immutable entity versions
  - comments / complaints / event support
  - access-scoped membership and subscription views
  - append-only RSVP history with current-read views
  - edges for vouching and related graph links
  - transcript threads/messages with provenance links
  - locations and member/entity location links
  - private media links
  - embeddings storage
  - webhook delivery endpoints and deliveries
  - convenience views for “latest/current” reads

## Design principles

- SQL-first, no ORM assumptions
- immutable writes where content changes matter
- stable IDs + append-only versions
- typed columns for common filters, JSONB for evolving detail
- global identity, network-local activity
- no public content anywhere
- avoid premature application code

## Requirements

- PostgreSQL 15+
- `psql`
- `DATABASE_URL`

## Usage

Copy `.env.example` if needed, then run:

```bash
./scripts/migrate.sh
./scripts/migration-status.sh
./scripts/smoke-test.sh
./scripts/pressure-test.sh
```

Or via npm if you prefer:

```bash
npm run db:migrate
npm run db:status
npm run db:smoke
npm run db:pressure
npm run api:test
npm run api:start
```

## Notes

- The schema uses 12-character random IDs instead of UUIDs.
- Embeddings are stored as numeric arrays for portability in the first cut.
  If/when pgvector becomes a hard requirement, this can be migrated cleanly.
- Sponsor quota enforcement and higher-level policy flows remain application logic for now.
  The schema preserves the facts needed to enforce and audit them.
- `app.accessible_network_memberships` is now the canonical SQL surface for "which networks can this member actually use right now?"
- `app.current_event_rsvps` keeps current RSVP reads simple while preserving append-only RSVP history.
- The API skeleton intentionally uses a single action endpoint instead of route-per-table CRUD.
- See `docs/pressure-test.md` for the first schema pressure-test pass and what it deliberately still leaves to application logic.
- See `docs/api.md` for the current action envelope and bearer-scoped server behavior.
