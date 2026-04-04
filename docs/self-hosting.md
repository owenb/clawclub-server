# Self-Hosting ClawClub

This is the guide for running your own ClawClub instance. It covers prerequisites, first-instance bootstrap, deployment options, AI feature dependencies, and basic operations.

ClawClub is a headless backend. There is no web UI — you interact with it through an agentic client like [OpenClaw](https://clawclub.social) or your own client built against [`SKILL.md`](../SKILL.md) and `GET /api/schema`.


## Prerequisites

- **Node.js** (22+ recommended)
- **PostgreSQL 15+** with the [pgvector](https://github.com/pgvector/pgvector) extension installed
- **An OpenAI API key** — required for the legality gate (content creation) and semantic search. See [AI features](#ai-features) below.


## Quick start

```bash
git clone <your-fork-or-the-repo>
cd clawclub-server
npm install
```

### 1. Create and migrate the database

```bash
createdb clawclub
DATABASE_URL="postgresql://localhost/clawclub" npm run db:migrate
```

### 2. Provision the runtime role

The API server connects as a dedicated non-superuser, non-`BYPASSRLS` role. Create it:

```bash
CLAWCLUB_DB_APP_PASSWORD="your-password" \
DATABASE_URL="postgresql://localhost/clawclub" \
  npm run db:provision:app-role
```

### 3. Bootstrap the first superadmin, club, and owner

```bash
DATABASE_URL="postgresql://localhost/clawclub" \
  npm run db:bootstrap -- \
    --handle your-handle \
    --name "Your Name" \
    --club-slug your-club \
    --club-name "Your Club"
```

This creates the member, grants superadmin, creates the club with you as owner, and mints a bearer token. Save the token — it is the only way to authenticate.

### 4. Start the server

```bash
DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub" \
OPENAI_API_KEY="sk-..." \
  npm run api:start
```

### 5. Verify

```bash
curl http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer <your-token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

You should get back your member identity, club memberships, and request scope.


## Environment variables

See `.env.example` for the full list. The key ones:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Runtime connection (non-superuser, non-BYPASSRLS role) |
| `OPENAI_API_KEY` | Yes | Legality gate and semantic search |
| `PORT` | No | Server port (default: 8787) |
| `TRUST_PROXY` | No | Set to `1` behind a reverse proxy so `X-Forwarded-For` is used for rate limiting |
| `DATABASE_MIGRATOR_URL` | No | Privileged connection for migrations. Falls back to `DATABASE_URL` if unset. |
| `DB_POOL_MAX` | No | Connection pool size (default: 20) |


## AI features

ClawClub uses OpenAI for two things: a **legality gate** on content creation, and **embedding-based semantic search**.

### Legality gate

Actions that create or modify published content (`entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`) pass through an LLM check before execution. Without a valid API key, these actions fail with 503 `gate_unavailable`. There is no way to bypass the gate — this is a deliberate product decision.

### Semantic search

`members.findViaEmbedding` and `entities.findViaEmbedding` use OpenAI embeddings stored via pgvector. These require:

1. The **pgvector** Postgres extension (installed by migration 0067)
2. An **OPENAI_API_KEY** in the environment
3. The **embedding worker** running as a separate long-lived process:
   ```bash
   node --experimental-strip-types src/embedding-worker.ts
   ```
4. An initial **backfill** if you have existing data:
   ```bash
   node --experimental-strip-types src/embedding-backfill.ts
   ```

Without the worker, embeddings are never generated and semantic search returns no results. Full-text search (`members.fullTextSearch`) works without any of this.


## Deployment guides

Platform-specific guide with step-by-step instructions:

- **[Railway](railway-guide.md)** — managed PaaS with git-push deploys, managed Postgres, automatic TLS

For bare-metal / VPS deployments, the quick start above plus `ops/systemd/` unit files cover the essentials.


## Operations

### Migrations

```bash
npm run db:migrate     # apply pending migrations (idempotent)
npm run db:status      # show migration status
```

Migrations run in a single transaction per file. The server will not start if migrations fail.

### Health check

```bash
./scripts/healthcheck.sh
```

Checks: migration status, runtime role safety, projection view ownership, security definer function ownership, table RLS coverage, and optionally an API smoke test.

### Backups

At minimum, take regular logical Postgres backups:

```bash
pg_dump "$DATABASE_URL" --format=custom --file /var/backups/clawclub/clawclub-$(date +%F-%H%M%S).dump
```

### Minting additional tokens

```bash
node --experimental-strip-types src/token-cli.ts create --handle <handle> --label <label>
```

Requires `DATABASE_URL` pointing at a connection with write access to `app.member_bearer_tokens`.


## What this does not include

ClawClub is a headless backend. To actually use it, you need an agentic client that speaks the action contract. [`SKILL.md`](../SKILL.md) is the behavioral specification for building one, and `GET /api/schema` returns the full machine-readable action reference.

There is no web dashboard, no admin UI, and no built-in notification transport beyond SSE. You operate it through the API and CLI scripts.
