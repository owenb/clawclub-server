# Foundation Notes

## Why this shape

The system still revolves around two strong axes:

1. **Global personhood**
   - one member identity across all networks
   - one profile history
   - one set of bearer tokens and delivery endpoints

2. **Network-local trust and activity**
   - membership is scoped per network
   - sponsor and owner history are append-only
   - content, deliveries, events, and messages live inside network boundaries

That split still drives the schema: global tables such as `members`, `member_profile_versions`, and `delivery_endpoints`, plus network tables such as `networks`, `network_memberships`, `entities`, `events`, and `deliveries`.

## Current foundation

- two HTTP surfaces: `POST /api` for action calls and `GET /updates` for simple polling, both with bearer-token actor resolution
- append-only version/event tables plus `current_*` views for normal reads
- Postgres auth and RLS as the hard permission boundary
- app-layer orchestration in `src/app.ts` plus `src/app-admissions.ts`, `src/app-content.ts`, `src/app-deliveries.ts`, `src/app-messages.ts`, `src/app-profile.ts`, and `src/app-system.ts`
- repository/auth seams in `src/postgres.ts` plus the domain modules under `src/postgres/`

## Versioning stance

Important mutable state should still follow one of two shapes:

- root table + append-only version table + current view
- append-only event table + current view

That now covers member profiles, entities, applications, membership state, network ownership, RSVP state, delivery attempts, and direct-message history.
Polling-specific seen state for posts is tracked as member/entity-version receipts rather than a mutable cursor.

## Where flexibility lives

Structured columns are used where correctness or filtering matters:

- membership role/state
- application status and intake fields
- entity kind/state/time windows
- event scheduling and RSVP state
- delivery state and worker scope

Everything else can evolve inside JSONB metadata or content payloads.

## Intentional non-goals

These are still intentionally not part of the current core:

- no ORM
- no public web UI
- no automatic embedding generation/ranking pipeline yet
- no owner-editable policy engine inside the database
- no operationally enabled WebHugs outbound delivery until outbound hardening is complete

## Expected read/write patterns

Normal reads should prefer current projections such as accessible memberships, current profiles, current entities/events, current ownership, and current membership state. Normal writes should append a new fact or version row, then let views project the latest state back out.
