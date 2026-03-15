# Foundation Notes

## Why this shape

The system still revolves around two strong axes:

1. **Global personhood**
   - one member identity across all networks
   - one profile history
   - one bearer-token inventory

2. **Network-local trust and activity**
   - membership is scoped per network
   - sponsor and owner history are append-only
   - content, events, messages, and update fanout live inside network boundaries

That split drives the schema: global tables such as `members`, `member_profile_versions`, and `member_bearer_tokens`, plus network tables such as `networks`, `network_memberships`, `entities`, `events`, `transcript_*`, and `member_updates`.

## Current foundation

- three HTTP surfaces: `POST /api`, `GET /updates`, and `GET /updates/stream`
- append-only version/event tables plus `current_*` views for normal reads
- Postgres auth and RLS as the hard permission boundary
- RLS-protected membership/subscription source rows feeding scope helpers
- app-layer orchestration in `src/app.ts` plus `src/app-admissions.ts`, `src/app-content.ts`, `src/app-messages.ts`, `src/app-profile.ts`, `src/app-system.ts`, and `src/app-updates.ts`
- repository/auth seams in `src/postgres.ts` plus the domain modules under `src/postgres/`

## Versioning stance

Important mutable state should use one of two shapes:

- root table + append-only version table + current view
- append-only event table + current view

That now covers member profiles, entities, applications, membership state, network ownership, RSVP state, message history, member updates, and member update receipts.

## Transport stance

The durable truth is the database, not the socket.

- `member_updates` is the append-only recipient update log
- `member_update_receipts` is the append-only acknowledgement history
- `GET /updates` is the replay/polling fallback
- `GET /updates/stream` is the canonical first-party transport

This keeps the model simple:
- no outbound webhook execution
- no worker queue for first-party delivery
- no endpoint-secret surface

## Where flexibility lives

Structured columns are used where correctness or filtering matters:

- membership role/state
- application status and intake fields
- entity kind/state/time windows
- event scheduling and RSVP state
- update topic and acknowledgement state

Everything else can evolve inside JSONB metadata or content payloads.

## Intentional non-goals

- no ORM
- no public web UI
- no automatic embedding generation pipeline yet
- no third-party webhook transport
- no owner-editable policy engine inside the database

## Expected read/write patterns

Normal reads should prefer current projections such as accessible memberships, current profiles, current entities/events, current ownership, current membership state, and pending member updates. Normal writes should append a new fact or version row, then let views project the latest state back out.
