# ClawClub Handoff

This document is the practical handoff for continuing ClawClub work in a new session or on a different machine.

## Current status

ClawClub is **close, but not fully finished**.

A realistic summary:
- backend foundation is strong
- core product flows are mostly present
- tests are healthy
- major remaining work is finish-line polish, production hardening, and a few last workflow gaps

Latest known test state at handoff:
- `108/108` passing

## What already exists

### Core auth and actor model
- bearer-token auth
- shared actor context
- global roles in actor context
- superadmin network/owner surface
- separate worker auth for delivery execution
- RLS hardening on important shared surfaces

### Members / profiles / search
- `members.search`
- `members.list`
- `profile.get`
- `profile.update`
- deterministic member-search ranking improvements
- embeddings-ready projection placeholders (foundation only, not full semantic search)

### Entities / posts / opportunities / asks / services
- `entities.create`
- `entities.update`
- `entities.list`
- deterministic entity/event retrieval improvements

### Events
- `events.create`
- `events.list`
- `events.rsvp`

### Messaging
- `messages.send`
- `messages.list`
- `messages.read`
- `messages.inbox`
- transcript reads include current delivery receipt/ack state
- operator AI chat runner exists on top of the AI SDK layer

### Deliveries
- `deliveries.list`
- `deliveries.acknowledge`
- `deliveries.retry`
- `deliveries.claim`
- `deliveries.complete`
- `deliveries.fail`
- `deliveries.attempts`
- `deliveries.endpoints.list/create/update/revoke`
- `deliveries.execute`
- delivery worker CLI loop
- signing scaffolding + real secret resolution path
- endpoint health counters for operators
- append-only delivery attempt history

### Admissions / memberships / ownership
- append-only membership state history
- `memberships.list`
- `memberships.create`
- `memberships.transition`
- `memberships.review`
- owner-only membership control
- append-only applications/interviews workflow
- application-to-membership activation handoff summary
- superadmin network lifecycle surface:
  - `networks.list`
  - `networks.create`
  - `networks.archive`
  - `networks.assignOwner`

### AI SDK layer
- thin AI SDK adapter around curated canonical tools
- model pinned to `gpt-5.4` when using OpenAI
- smoke harness proving the tool loop works end-to-end
- admissions workflow has also been exposed into the curated AI tools

### Operator / ops
- token lifecycle actions and CLI
- bootstrap helpers for ConsciousClaw
- Hetzner deployment runbook

## Canonical docs

Use these first:
- `docs/design-decisions.md` — canonical design/spec decisions
- `docs/api.md` — current action/API surface
- `docs/ai-sdk-tooling.md` — AI SDK adapter notes
- `docs/hetzner-runbook.md` — server deployment/ops notes

## Important product rules

### Private by default
- no public UI
- no public directory
- OpenClaw required
- network access enforced server-side and by Postgres/RLS

### Versioning / audit trail
For important mutable state, use either:
1. root table + version table + current view, or
2. append-only event table + current view

### Club roles
- superadmin: system-wide, can create/archive clubs and assign owners
- owner: one per club for now, handles admissions and member state changes
- admin: intentionally weaker than owner

### Content quality
- high signal to noise
- opportunity/job posts should answer: **"Do we have everything we need here for someone else to make a decision?"**
- regular posts should avoid slop/hype/redundant chatter
- genuine thought, invitations, asks, and concrete coordination are preferred

### Update polling
Short-term delivery model should include a simple non-LLM polling endpoint, conceptually `/updates`, called by OpenClaw on a 5-minute cron.
The server, not the cron, tracks what each member has already seen.
This is still a planned slice, not a finished one.

## What is still missing / not fully done

These are the highest-value remaining gaps:

1. **Final finish-line review / cleanup**
   - find rough edges and inconsistencies
   - make sure no misleading half-finished surface remains

2. **Simple `/updates` polling endpoint**
   - non-LLM REST endpoint
   - unseen DMs + unseen network posts
   - per-member seen tracking on the server
   - do not rely on dumb cron state

3. **Production hardening polish**
   - confirm worker/service auth shape is clean everywhere
   - final security pass over the newest surfaces
   - confirm secret/signing story end-to-end

4. **Search maturity**
   - embeddings pipeline is still foundation-level only
   - no full semantic ranking yet

5. **Operator UX polish**
   - some owner/superadmin flows likely still need tightening or simplification

## What was removed / changed in local automation

The local 10-minute cron watchdog was **removed** at Owen’s request.
Do not assume the old cron is still installed.
Any future automation should be reintroduced deliberately rather than assumed.

## Recommended next steps

If continuing in a new coding session, I would do this in order:

1. implement `/updates`
2. final finish-line review and cleanup pass
3. final production-hardening pass
4. verify end-to-end operator/member flows again after those changes
5. only then call it effectively complete

## Reality check

ClawClub is no longer a sketch.
It is a real, coherent, mostly-built system.

But it is not yet fully done until the remaining finish-line items above are closed.
