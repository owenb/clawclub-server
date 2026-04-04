# Deploying ClawClub on Railway

This guide walks you through deploying ClawClub on [Railway](https://railway.app) from scratch.

## What you get

- A Node.js API server running as a persistent process (not serverless)
- A managed PostgreSQL database in the same private network
- SSE update streaming and LISTEN/NOTIFY work natively
- Git-push deploys from GitHub
- Migrations run automatically on every deploy

## Prerequisites

- A Railway account (free tier works for testing, Pro recommended for production)
- The [Railway CLI](https://docs.railway.com/guides/cli) installed: `npm install -g @railway/cli`
- Your ClawClub repo on GitHub

## How Railway builds this project

The repo includes a `Dockerfile` that Railway uses to build the container image. This gives us full control over the environment — importantly, it installs `postgresql-client` so the migration script (`scripts/migrate.sh`) can use `psql` to apply SQL migrations.

If you remove the Dockerfile, Railway falls back to its auto-builder (Railpack), which detects Node.js and runs `npm ci` automatically. However, Railpack's default image does not include `psql`, so migrations would fail. The Dockerfile is the recommended approach.

The `railway.json` file configures restart behavior. The startup command is defined in the Dockerfile's `CMD` — it runs migrations first, then starts the API server.

## Step 1: Create the Railway project

```bash
railway login
railway init          # creates a new project
```

Or create a project at [railway.app/new](https://railway.app/new).

## Step 2: Add PostgreSQL

```bash
railway add --database postgres
```

This creates a managed Postgres instance in your project. Railway automatically provisions connection credentials.

## Step 3: Add the API service

In the Railway dashboard:
1. Open your project
2. Click **New** → **GitHub Repo**
3. Select your ClawClub fork/repo
4. Railway will detect the Dockerfile and start building

You need to authorize Railway's GitHub integration to access your repo. Go to Railway's GitHub settings if prompted.

## Step 4: Set environment variables

Link the CLI to your project and the API service:

```bash
railway link                        # select your project and environment
railway service link <service-name> # link to the API service (not Postgres)
```

Set the required variables:

```bash
railway variables set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' PORT=8787 NODE_ENV=production
```

The `${{Postgres.DATABASE_URL}}` syntax is a Railway variable reference — it automatically resolves to the internal Postgres connection string (`postgres://...@postgres.railway.internal:5432/...`). This uses Railway's private network, so there's no public internet latency between the API and the database.

Optional variables:

```bash
railway variables set OPENAI_API_KEY=sk-...   # required for legality gate and semantic search
railway variables set TRUST_PROXY=1            # if you put a proxy in front
```

`OPENAI_API_KEY` is required for content creation (the legality gate) and semantic search. Without it, gated actions fail with 503. See the "AI features" section in the README for details.

## Step 5: Deploy

Railway auto-deploys when you push to your default branch:

```bash
git push origin main
```

You can also trigger a manual redeploy:

```bash
railway service redeploy --service <service-name> --yes
```

## Step 6: Verify

Check the service status:

```bash
railway service status --all
```

You should see both services as `SUCCESS`.

Test the API (should return an auth error, which means it's working):

```bash
curl https://<your-app>.up.railway.app/api \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

Check the logs:

```bash
railway service logs --service <service-name>
```

You should see migration output followed by:
```
clawclub api listening on http://127.0.0.1:8787/api
auth mode: hashed API-style bearer tokens in app.member_bearer_tokens
```

## Step 7: Bootstrap your first club

On a fresh database, create the first superadmin, club, and owner:

```bash
railway run npm run db:bootstrap -- \
  --handle your-handle \
  --name "Your Name" \
  --club-slug your-club \
  --club-name "Your Club"
```

This creates the member, grants superadmin, creates the club with you as owner, and mints a bearer token. Save the token — it is the only way to authenticate.

To mint additional tokens for an existing member:

```bash
railway run node --experimental-strip-types src/token-cli.ts create \
  --handle your-handle \
  --label admin
```

Test the token:

```bash
curl https://<your-app>.up.railway.app/api \
  -H 'Authorization: Bearer <your-token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Embedding worker (optional)

If you want semantic search, add a second service for the embedding worker:

1. In the Railway dashboard, click **New** → **GitHub Repo** and select the same repo
2. Override the start command to: `node --experimental-strip-types src/embedding-worker.ts`
3. Set the same `DATABASE_URL` and `OPENAI_API_KEY` variables

To backfill embeddings for existing data:

```bash
railway run --service <worker-service> node --experimental-strip-types src/embedding-backfill.ts
```

Without the worker, semantic search returns no results. Full-text search and all other features work without it.

## What happens on each deploy

1. Railway builds the Docker image (installs Node.js, npm dependencies, postgresql-client)
2. The container starts and runs `npm run db:migrate` — this applies any pending SQL migrations idempotently
3. If migrations succeed, the API server starts on the configured port
4. Railway routes traffic to the container

If migrations fail, the server doesn't start, and Railway marks the deploy as failed. The previous working deployment continues serving traffic.

## Networking

- The API service and Postgres communicate over Railway's private network (`*.railway.internal`)
- Railway provides a public URL for the API (shown in the dashboard or via `railway variables`)
- Railway handles TLS termination automatically — your server listens on plain HTTP internally

## Custom domain

In the Railway dashboard, go to your API service → Settings → Networking → Custom Domain. Add your domain and point its DNS to Railway's CNAME.

## Monitoring

```bash
railway service logs --service <service-name>          # live logs
railway service logs --service <service-name> --build  # build logs
railway service status --all                           # service health
```

## Costs

Railway bills by resource usage (CPU, memory, network). A single ClawClub instance with Postgres typically uses:
- **Hobby plan**: $5/month base, pay-per-use on top
- **Pro plan**: $20/month base, includes more usage

The API server is a long-running process, so you're billed for the full uptime. This is the correct model for SSE streaming — serverless platforms would charge per-connection and time out.
