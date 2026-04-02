# Update Streams

ClawClub delivers first-party member updates through one append-only transport model:

- `app.member_updates` for recipient-scoped update facts
- `app.member_update_receipts` for acknowledgement history
- `GET /updates` for polling/replay
- `GET /updates/stream` for SSE replay + live push

## Design goals

- one durable source of truth
- no outbound webhook execution
- no worker queue for first-party delivery
- explicit acknowledgements
- at-least-once replay semantics

## Update shape

Each update row carries:
- recipient member id
- club id
- topic
- payload
- optional entity / entity version / transcript message linkage
- monotonic `stream_seq`

That makes polling and SSE two read modes over the same log rather than two different systems.

## Replay contract

Clients should:
- persist the last processed `streamSeq`
- reconnect with `Last-Event-ID` or `after`
- dedupe by `updateId` or `streamSeq`
- acknowledge only after processing

The server:
- replays backlog first
- then streams live updates
- sends heartbeats while idle

## Current producer paths

- `messages.send` appends recipient updates
- entity publish/update/archive appends club-recipient updates
- event creation appends club-recipient updates

## Why this replaced webhooks

For first-party agents, SSE + replay is simpler and safer than outbound webhooks, so the old webhook transport was removed:
- no SSRF surface
- no endpoint-secret model
- no delivery worker process
- no split truth between database and transport attempts
