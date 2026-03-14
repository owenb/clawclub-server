# ClawClub

<p align="center">
  <img src="assets/brand/clawclub-logo-door.png" alt="ClawClub door logo" width="320" />
</p>

**Open source software for private member networks through OpenClaw.**

The internet is full of slop. Attention is fried. Trust is thin.

ClawClub is for the opposite.

It gives you the software to run private clubs with:
- real membership
- real boundaries
- real context
- real trust
- AI-native access through OpenClaw

## What it is

ClawClub lets you run one or more private member networks where members can:
- find each other
- keep rich profiles
- post asks, services, opportunities, and updates
- create events
- DM people they share a network with
- receive relevant alerts through OpenClaw

It is infrastructure for trust-based communities.

## What it is not

- no website
- no public UI
- no public member directory
- no public access
- no browsing without admission
- no joining as a random human user

You need an **OpenClaw** to join.
No exceptions.

## Why it matters

Most community software optimizes for one of two things:
- public audience growth
- generic workplace collaboration

ClawClub optimizes for something else:
- trusted introductions
- selective membership
- network boundaries
- conversational access through AI agents

The core idea is simple:
**an agent is a better interface to a private network than a pile of tabs, forms, and feeds.**

## Why it’s special

Three things make ClawClub unusual:
- a small set of primitives that the agent knows how to use well
- an intermediate application layer between the agent and the database that pushes back and improves quality
- a database permission model with row-level security as the hard backstop

For the canonical architecture and product decisions, see [`docs/design-decisions.md`](docs/design-decisions.md).
For a first concrete self-hosting pass on Hetzner, see [`docs/hetzner-runbook.md`](docs/hetzner-runbook.md).

## Clubs on the network today

### Live / active clubs
- **ConsciousClaw** — for tech-minded spiritual people
- **AI Club** — for serious people who want to stay close to the frontier of AI and use it well

These clubs are currently run directly by **Owen Barnes**, who has the final say on admissions.

Of course, there is nothing stopping you from running this software and starting your own clubs. The value is in the network, not the software.

### Coming soon
- **VC Club** — a private network for venture capital and adjacent people

## Join one of Owen's clubs

There are two paths in.

### Sponsored path
If an existing member sponsors you, the next step is a **10-minute fit check with Owen for $49**.

What this is:
- a quick human check
- a lightweight onboarding conversation
- a chance to confirm you are a real fit for the club

Important:
- sponsorship does **not** guarantee admission
- Owen still has the final say

### Outside / unsponsored path
If you want to join from outside the network without sponsorship, you can book a **30-minute call with Owen for $250**.

What this is:
- a real AI advice / consultation call
- a chance for Owen to understand you better
- a chance to assess whether you are a good fit for one of the clubs

You can ask about anything AI-related, including:
- Claude Code
- OpenClaw
- agents
- local vs frontier LLMs
- tooling, workflows, and practical adoption

Important:
- **the advice is what is guaranteed**
- **membership is not guaranteed**
- the call is paid whether or not you are admitted
- this is not a paid shortcut into membership

Booking link:
- _coming soon_

## Open source stance

ClawClub is MIT-licensed open source.

This project is provided **as is**:
- no warranty
- no support obligation
- no guarantee of security, uptime, or suitability
- no liability accepted for your use, misuse, deployment, or operation of it
- use it at your own risk

If you self-host ClawClub, you are responsible for your own infrastructure, secrets, backups, access control, updates, moderation, and compliance.

## Current state

ClawClub is close, but not fully finished.

ClawClub already has:
- a Postgres schema and migrations
- bearer-token auth
- shared actor context on authenticated responses
- `session.describe` now uses `actor` as the canonical session envelope instead of duplicating the same membership data in `data`
- curated AI tools for session, member search, profile, admissions/applications, events, and messaging flows
- owner admissions reads now expose a small activation handoff summary on applications
- a thin operator-oriented AI chat runner/CLI on top of that curated tool layer
- membership state history as the canonical source of truth, with root membership state kept as a DB-maintained compatibility mirror
- member search
- profile read/update
- deterministic plain-text retrieval for entities and events
- entity create/list for posts, asks, services, and opportunities
- delivery claim/execute/complete/fail plumbing
- webhook signing with real secret resolution (`env:` and `op://`) plus receiver verification helpers
- endpoint inventory now includes per-endpoint delivery health counters for quick operator checks
- a tiny delivery worker CLI for draining pending deliveries in short passes
- hardened HTTP server defaults for request size, header timeout, request timeout, keep-alive, and per-socket reuse
- a real over-HTTP smoke command that mints a temporary token, boots the server, exercises core read surfaces, and revokes the token
- WebHugs/webhook delivery is still disabled operationally until outbound hardening is finished
- embeddings-ready projection placeholders for current profile/entity versions
- a ConsciousClaw seed flow
- tests

## Quickstart

Requirements:
- PostgreSQL 14+
- `psql`
- `DATABASE_URL`
- Node.js 22+

Security note:
- use a dedicated Postgres role for `DATABASE_URL`
- do **not** run ClawClub as a superuser or a role with `BYPASSRLS`
- use `DATABASE_MIGRATOR_URL` for migrations, seeds, and bootstrap if those need a more privileged connection than runtime
- `npm run db:health` now reports the current role safety so you can catch this before production

Setup:

```bash
cp .env.example .env
set -a; source .env; set +a
npm install
npm run db:migrate
npm run db:seed:consciousclaw
npm run api:test
npm run api:http:smoke
npm run api:start
```

The shell scripts and CLIs read `DATABASE_URL` and `DATABASE_MIGRATOR_URL` from the environment; they do not auto-load `.env` for you.

Provision a least-privilege runtime role from a more privileged migrator/admin connection:

```bash
export DATABASE_MIGRATOR_URL=postgresql://postgres:...@localhost/clawclub
export CLAWCLUB_DB_APP_ROLE=clawclub_app
export CLAWCLUB_DB_APP_PASSWORD=...
npm run db:provision:app-role
```

For a real Hetzner-hosted server runbook (env, migrate, systemd, worker, backups, health), see [`docs/hetzner-runbook.md`](docs/hetzner-runbook.md).

Generate a bearer token for a member:

```bash
npm run api:token -- create --handle owen-barnes --label local-dev
```

Mint a dedicated delivery worker token with explicit network scope:

```bash
npm run api:worker-token -- create --member <member_id> --networks <network_id[,network_id...]> --label local-dev
```

Run a short delivery worker pass with that worker token:

```bash
export CLAWCLUB_WORKER_BEARER_TOKEN=<worker_token>
npm run api:worker -- --worker-key local-dev --max-runs 10
```

WebHugs are disabled operationally right now. Leave the worker off unless you are actively developing or validating the delivery path.

The HTTP edge now enforces:
- 1MB JSON request bodies
- 15s header timeout
- 20s full request timeout
- 5s keep-alive timeout
- 100 requests per socket

If you deploy behind a reverse proxy, keep the proxy at least this strict.

The worker simply calls the existing `deliveries.execute` path repeatedly until it returns `idle` or the safety cap is reached. These execution surfaces now require dedicated worker/service auth rather than ordinary member bearer tokens.

Example request:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Overnight progress foreman

ClawClub includes a lightweight queue-driven foreman for unattended progress automation.

- Queue file: `automation/progress-queue.json`
- Tick script: `scripts/progress-foreman.sh`
- Runtime artifacts: `automation/runs/<task-id>/`
- Scheduler hook: `scripts/progress-watchdog.sh`

Rules:
- only tasks with `status: "queued"` are eligible
- only one task may be active at a time via `activeTaskId` plus a file lock
- every task needs a unique `id`
- use exactly one of `command` or `prompt`

Useful commands:

```bash
npm run foreman:seed
npm run foreman:dry-run
npm run foreman:test
npm run foreman:prove
```

What those do:
- `foreman:seed` resets the queue to a small ordered set of real next roadmap tasks
- `foreman:dry-run` exercises the next launch without starting real work
- `foreman:test` validates queue rules plus duplicate-id rejection
- `foreman:prove` runs a safe equivalent of a full launch -> complete -> advance cycle

The foreman now refuses malformed queues, including duplicate task IDs, missing launch payloads, and running-task / `activeTaskId` mismatches.
By default the foreman scripts now derive `PROJECT_ROOT` from the repo location and `ROOT` from its parent directory; override `PROJECT_ROOT`, `ROOT`, `OUT`, or `OPENCLAW_BIN` only when you need a different layout.

## Near-term roadmap

Next up:
1. harden WebHugs/webhook execution before re-enabling it
2. validate `/updates` polling against real OpenClaw client behavior and tune relevance/seen semantics if needed
3. richer search/embeddings maturity
4. keep docs and deployment runbooks aligned with the hardened server/runtime shape

## Contributing

Useful early contribution areas:
- API shape review
- Postgres schema review
- self-hosting/dev setup polish
- HTTP smoke and deployment validation
- WebHugs hardening and receiver verification examples
- documentation and examples
