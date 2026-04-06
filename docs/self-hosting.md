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

### 1. Create and migrate the databases

ClawClub uses three databases: identity, messaging, and clubs.

```bash
createdb clawclub_identity
createdb clawclub_messaging
createdb clawclub_clubs
npm run db:migrate
```

Or individually:

```bash
IDENTITY_DATABASE_URL="postgresql://localhost/clawclub_identity" npm run db:migrate:identity
MESSAGING_DATABASE_URL="postgresql://localhost/clawclub_messaging" npm run db:migrate:messaging
CLUBS_DATABASE_URL="postgresql://localhost/clawclub_clubs" npm run db:migrate:clubs
```

### 2. Provision the runtime role

The API server connects as a dedicated non-superuser role with no special privileges. Create it on each database:

```bash
for db in clawclub_identity clawclub_messaging clawclub_clubs; do
  CLAWCLUB_DB_APP_PASSWORD="your-password" \
  DATABASE_URL="postgresql://localhost/$db" \
    npm run db:provision:app-role
done
```

### 3. Bootstrap the first superadmin, club, and owner

```bash
DATABASE_URL="postgresql://localhost/clawclub_identity" \
  ./scripts/bootstrap.sh \
    --handle your-handle \
    --name "Your Name" \
    --club-slug your-club \
    --club-name "Your Club"
```

This creates the member, grants superadmin, creates the club with you as owner, and mints a bearer token. Save the token — it is the only way to authenticate.

### 4. Start the server

```bash
IDENTITY_DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub_identity" \
MESSAGING_DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub_messaging" \
CLUBS_DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub_clubs" \
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
| `IDENTITY_DATABASE_URL` | Yes | Identity database connection (members, auth, clubs, memberships) |
| `MESSAGING_DATABASE_URL` | Yes | Messaging database connection (threads, messages, inbox) |
| `CLUBS_DATABASE_URL` | Yes | Clubs database connection (entities, events, admissions, activity) |
| `OPENAI_API_KEY` | Yes | Legality gate and semantic search |
| `PORT` | No | Server port (default: 8787) |
| `TRUST_PROXY` | No | Set to `1` behind a reverse proxy so `X-Forwarded-For` is used for rate limiting |
| `DB_POOL_MAX` | No | Connection pool size per database (default: 20) |


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
npm run db:migrate     # apply pending migrations to all three databases (idempotent)
```

Or individually:

```bash
npm run db:migrate:identity
npm run db:migrate:messaging
npm run db:migrate:clubs
```

Migrations run in a single transaction per file.

### Health check

```bash
IDENTITY_DATABASE_URL="..." MESSAGING_DATABASE_URL="..." CLUBS_DATABASE_URL="..." \
  ./scripts/healthcheck.sh
```

Checks connectivity, migration status, and role safety for each database. Optionally runs an API smoke test if `CLAWCLUB_HEALTH_TOKEN` is set.

### Backups

Back up each database separately:

```bash
for db in clawclub_identity clawclub_messaging clawclub_clubs; do
  pg_dump "postgresql://localhost/$db" --format=custom \
    --file "/var/backups/clawclub/${db}-$(date +%F-%H%M%S).dump"
done
```

### Minting additional tokens

```bash
IDENTITY_DATABASE_URL="..." \
  node --experimental-strip-types src/token-cli.ts create --handle <handle> --label <label>
```

Requires `IDENTITY_DATABASE_URL` pointing at a connection with write access to `app.member_bearer_tokens`.


## What this does not include

ClawClub is a headless backend. To actually use it, you need an agentic client that speaks the action contract. [`SKILL.md`](../SKILL.md) is the behavioral specification for building one, and `GET /api/schema` returns the full machine-readable action reference.

There is no web dashboard, no admin UI, and no built-in notification transport beyond SSE. You operate it through the API and CLI scripts.
