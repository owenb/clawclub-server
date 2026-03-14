# ClawClub Handoff

This document is the practical handoff for continuing ClawClub work in a new session or on a different machine.

## Current status

ClawClub is **near the finish line but still in hardening and simplification mode**.

A realistic summary:
- backend foundation is strong
- the main member, admissions, messaging, event, and delivery surfaces exist
- tests are healthy
- the remaining work is mostly finish-line simplification, docs, WebHugs hardening before re-enable, and the last module splits

Latest known test state at handoff:
- `121/121` passing

## What already exists

### Core auth and actor model
- bearer-token auth
- shared actor context
- global roles in actor context
- `session.describe` now treats `actor` as the canonical session envelope
- superadmin network/owner surface
- separate worker auth for delivery execution
- RLS hardening across member, application, ownership, and delivery surfaces

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
- app-role provisioning script for least-privilege runtime DB access

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

1. **Remaining code simplification**
   - finish splitting the remaining profile/entity/message logic out of the big shared modules
   - keep action and repository seams as explicit as the newer admissions and delivery paths

2. **WebHugs hardening before re-enable**
   - outbound `https` validation
   - SSRF blocking
   - timeout/redirect limits
   - retry/backoff plus endpoint-level disable rules

3. **Simple `/updates` polling endpoint**
   - non-LLM REST endpoint
   - unseen DMs + unseen network posts
   - per-member seen tracking on the server
   - still optional, but it is the cleanest proactive surface if OpenClaw needs polling

4. **Search maturity**
   - embeddings pipeline is still foundation-level only
   - no full semantic ranking yet

5. **Docs and deployment polish**
   - keep README and `docs/` aligned with the now-split code layout
   - keep the “worker optional while WebHugs are disabled” story explicit

## What was removed / changed in local automation

The local 10-minute cron watchdog was **removed** at Owen’s request.
Do not assume the old cron is still installed.
Any future automation should be reintroduced deliberately rather than assumed.

## Recommended next steps

If continuing in a new coding session, I would do this in order:

1. finish the remaining module splits
2. harden WebHugs before re-enabling them
3. decide whether `/updates` is needed before launch
4. verify end-to-end operator/member flows again after those changes
5. only then call it effectively complete

## Reality check

ClawClub is no longer a sketch.
It is a real, coherent, mostly-built system.

But it is not yet fully done until the remaining finish-line items above are closed.
