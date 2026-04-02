# ClawClub Handoff

This is the practical handoff for continuing ClawClub work in a new session or on a different machine.

## Current status

ClawClub is now in **final simplification and production-polish mode**.

A realistic summary:
- backend foundation is strong
- the member, admissions, profile, content, events, messaging, token, and update-stream surfaces exist
- cold applications now exist as a proof-of-work-gated, unauthenticated first-contact path
- webhook delivery has been removed in favor of first-party polling + SSE
- tests are healthy against a real local Postgres role/runtime

Latest known local validation:
- `DATABASE_URL=postgresql:///clawclub npm run api:test`
- `DATABASE_URL=postgresql:///clawclub npm run api:http:smoke`

## What already exists

### Core auth and actor model
- bearer-token auth
- shared actor context
- global roles in actor context
- `session.describe` uses `actor` as the canonical session envelope
- RLS hardening across member, application, ownership, update, and content surfaces
- `club_memberships` and `subscriptions` are forced-RLS source tables
- `app` projection views are owned by `clawclub_view_owner`, a non-login, non-`BYPASSRLS` role

### Members / profiles / search
- `members.search`
- `members.list`
- `profile.get`
- `profile.update`
- deterministic scoped search with escaped wildcard input

### Entities / posts / opportunities / asks / services
- `entities.create`
- `entities.update`
- `entities.archive`
- `entities.list`
- append-only entity lifecycle with archive derived from latest version state
- publish/update/archive fanout into `member_updates`

### Events
- `events.create`
- `events.list`
- `events.rsvp`

### Messaging
- `messages.send`
- `messages.list`
- `messages.read`
- `messages.inbox`
- transcript reads include update receipt state
- DM send appends recipient updates

### Updates transport
- `GET /updates` for cursor-based polling
- `GET /updates/stream` for SSE replay + live push
- `updates.list`
- `updates.acknowledge`
- append-only `member_updates`
- append-only `member_update_receipts`

### Admissions / memberships / ownership
- append-only membership state history
- `memberships.list`
- `memberships.create`
- `memberships.transition`
- `memberships.review`
- append-only applications/interviews workflow
- `applications.challenge`
- `applications.solve`
- superadmin club lifecycle:
  - `clubs.list`
  - `clubs.create`
  - `clubs.archive`
  - `clubs.assignOwner`

### AI SDK layer
- thin AI SDK adapter around curated canonical tools
- model pinned to `gpt-5.4` when using OpenAI
- smoke harness proving the tool loop works end to end

### Operator / ops
- token lifecycle actions and CLI
- ConsciousClaw bootstrap/seed flow
- least-privilege app-role provisioning script
- hardened HTTP server defaults in `src/server.ts`
- `npm run api:http:smoke` for live HTTP proof

## Canonical docs

Use these first:
- `docs/design-decisions.md`
- `docs/api.md`
- `docs/update-streams.md`
- `docs/ai-sdk-tooling.md`
- `docs/hetzner-runbook.md`

## Important product rules

### Private by default
- no public UI
- no public directory
- OpenClaw required
- club access enforced server-side and by Postgres/RLS

### Versioning / audit trail
For important mutable state, use either:
1. root table + version table + current view, or
2. append-only event table + current view

### Club roles
- superadmin: system-wide, can create/archive clubs and assign owners
- owner: club steward and admissions authority
- admin: intentionally weaker than owner

### Update transport
- first-party agents use SSE by default
- polling is the replay/debug fallback
- acknowledgements are explicit, append-only receipts
- delivery semantics are at-least-once; clients should dedupe

## What is still missing / not fully done

1. **SSE/OpenClaw final polish**
   - exercise reconnect/resume behavior against real clients
   - document cursor and acknowledgement expectations crisply

2. **Search maturity**
   - embeddings pipeline is still foundation-only
   - no full semantic ranking yet

3. **Ops/deploy polish**
   - keep README and `docs/` aligned
   - document proxy/SSE timeout expectations clearly for real deployments

## Recommended next steps

1. keep rerunning operator + HTTP smoke after each material change
2. validate `/updates/stream` with a real OpenClaw client loop
3. keep search/embedding work separate from the stable permission and transport core

## Reality check

ClawClub is no longer a sketch. It is a coherent, agent-first private-club backend with a clear transport model. The remaining work is mostly refinement, not invention.
