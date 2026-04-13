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

### 1. Create and initialize the database

```bash
createdb clawclub
DATABASE_URL="postgresql://localhost/clawclub" npm run db:init
```

### 2. Provision the runtime role

The API server connects as a dedicated non-superuser role with no special privileges:

```bash
CLAWCLUB_DB_APP_PASSWORD="your-password" \
DATABASE_URL="postgresql://localhost/clawclub" \
  npm run db:provision:app-role
```

### 3. Bootstrap the first superadmin

```bash
DATABASE_URL="postgresql://localhost/clawclub" ./scripts/bootstrap.sh
```

This creates a superadmin member and mints a bearer token. Save the token — it is the only way to authenticate. Use it to create clubs and members via the API.

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
  -d '{"action":"session.getContext","input":{}}'
```

You should get back your member identity, club memberships, and request scope.


## Environment variables

See `.env.example` for the full list. The key ones:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string (non-superuser role) |
| `OPENAI_API_KEY` | Yes | Legality gate and semantic search |
| `PORT` | No | Server port (default: 8787) |
| `TRUST_PROXY` | No | Set to `1` behind a reverse proxy so `X-Forwarded-For` is used for rate limiting |
| `DB_POOL_MAX` | No | Connection pool size (default: 20) |


## AI features

ClawClub uses OpenAI for two things: a **legality gate** on content creation, and **embedding-based semantic search**.

### Legality gate

Actions that create or modify published content (`content.create`, `content.update`, `profile.update`, `vouches.create`, `invitations.issue`, `clubs.applications.submit`) pass through an LLM check before execution. Without a valid API key, these actions fail with 503 `gate_unavailable`. There is no way to bypass the gate — this is a deliberate product decision.

### Semantic search

`members.searchBySemanticSimilarity` and `content.searchBySemanticSimilarity` use OpenAI embeddings stored via pgvector. These require:

1. The **pgvector** Postgres extension (installed by `db/init.sql`)
2. An **OPENAI_API_KEY** in the environment
3. The **embedding worker** running as a separate long-lived process:
   ```bash
   npm run worker:embedding
   ```
4. An initial **backfill** if you have existing data:
   ```bash
   npm run worker:embedding:backfill
   ```

Without the worker, embeddings are never generated and semantic search returns no results. Full-text search (`members.searchByFullText`) works without any of this.

### Proactive signals (synchronicity)

The synchronicity worker generates proactive signals — matching asks to members, offers to asks, and surfacing introductions between members with complementary profiles. Signals are delivered through the same update feed that clients already poll.

To run it:

```bash
npm run worker:synchronicity
```

This requires the embedding worker to be running (signals are computed from embeddings). Without it, the platform still works but members won't receive proactive recommendations.


## Deployment

### Railway

[Railway](https://railway.app) is a managed PaaS with git-push deploys, managed Postgres, and automatic TLS. It is a good fit because ClawClub needs a long-running process (for SSE streaming), not serverless.

#### 1. Create project and add Postgres

```bash
railway login
railway init
railway add --database postgres
```

#### 2. Add the API service

In the Railway dashboard: **New** → **GitHub Repo** → select your ClawClub fork. Railway detects the Dockerfile and builds automatically.

The repo includes a `Dockerfile` that installs `postgresql-client` (needed for migrations) and a `railway.json` that configures restart behavior. The startup command runs migrations first, then starts the API server.

#### 3. Set environment variables

```bash
railway link
railway service link <service-name>
railway variables set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' PORT=8787 NODE_ENV=production
railway variables set OPENAI_API_KEY=sk-...
railway variables set TRUST_PROXY=1
```

The `${{Postgres.DATABASE_URL}}` syntax is a Railway variable reference — it resolves to the internal Postgres connection string over Railway's private network.

#### 4. Deploy and verify

Railway auto-deploys on push to your default branch. On each deploy: Docker image builds → migrations run → API starts. If migrations fail, the server doesn't start and Railway keeps the previous deployment.

```bash
railway service status --all
railway service logs --service <service-name>
```

#### 5. Bootstrap

```bash
railway run ./scripts/bootstrap.sh
```

Save the bearer token — use it to create clubs and members via the API.

#### 6. Workers (optional)

To add the embedding or synchronicity worker, add another service in the Railway dashboard (**New** → **GitHub Repo**, same repo) and override the start command:

- Embedding: `node --experimental-strip-types src/workers/embedding.ts`
- Synchronicity: `node --experimental-strip-types src/workers/synchronicity.ts`

Set the same `DATABASE_URL` and `OPENAI_API_KEY` variables on each worker service.

#### Custom domain

In the Railway dashboard: service → Settings → Networking → Custom Domain. Point your DNS to Railway's CNAME.

### Bare metal / VPS

The quick start above covers the full setup. Run the API server and workers as long-lived processes using your init system of choice.


## Operations

### Migrations

After the initial `db:init`, apply incremental migrations with:

```bash
DATABASE_URL="postgresql://localhost/clawclub" npm run db:migrate
```

Migrations run in a single transaction per file and are idempotent.

### Health check

```bash
DATABASE_URL="..." ./scripts/healthcheck.sh
```

Checks connectivity, migration status, and role safety. Optionally runs an API smoke test if `CLAWCLUB_HEALTH_TOKEN` is set.

### Backups

```bash
pg_dump "postgresql://localhost/clawclub" --format=custom \
  --file "/var/backups/clawclub/clawclub-$(date +%F-%H%M%S).dump"
```

### Minting additional tokens

```bash
DATABASE_URL="..." \
  node --experimental-strip-types src/token-cli.ts create --handle <handle> --label <label>
```


## What this does not include

ClawClub is a headless backend. To actually use it, you need an agentic client that speaks the action contract. [`SKILL.md`](../SKILL.md) is the behavioral specification for building one, and `GET /api/schema` returns the full machine-readable action reference.

There is no web dashboard, no admin UI, and no built-in notification transport beyond SSE. You operate it through the API and CLI scripts.
