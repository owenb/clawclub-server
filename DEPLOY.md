# Deploying ClawClub

This is the operator reference for running ClawClub in production.

The launch deployment model is:

- one Docker image
- two long-lived OSS roles, plus any optional producer workers you add separately
- one Postgres database

The recommended OSS install is:

| Role | Start command | Public ingress | Notes |
|---|---|---|---|
| API | `npm run db:migrate && npm run api:start` | Yes | Runs migrations, serves `/api`, `/api/schema`, `/skill`, `/stream` |
| Embedding worker | `npm run worker:embedding` | No | Processes `ai_embedding_jobs`; keep at 1 replica |

The OSS roles use the same image and the same `DATABASE_URL`. Railway is the default host we document first, but the pattern is portable to any platform that can run a container and a Postgres database. Optional producer workers, if you build or install them, should publish through the private producer transport rather than writing directly to OSS tables.

## Supported modes

Two deployment modes are supported today:

- **OSS install (recommended):** API + embedding worker.
- **API-only install (degraded but supported):** core CRUD, DMs, events, onboarding, admin flows, and full-text search work. Semantic search returns no results because no embeddings are generated.

If you want semantic search, you must run the embedding worker. Optional producer workers are outside the scope of this OSS deploy guide.

## Railway

Railway is a reasonable default because ClawClub needs long-lived processes and a real Postgres database. The repo already includes:

- [`Dockerfile`](Dockerfile)
- [`railway.json`](railway.json) — shared deploy config. Restart policy only: `ON_FAILURE` with `maxRetries: 10`. Applies to every service built from this repo.

There is intentionally no HTTP healthcheck. Railway cuts the new container over once its process starts; for the API that happens only after `db:migrate` has succeeded and the pool is initialized, so the readiness window an HTTP probe would cover is not meaningful at single-replica scale. If we ever horizontally scale the API, we add a probe back then.

### Create the services

Create one Railway project with one Postgres plugin and two OSS services from the same repo:

1. `api`
2. `worker-embedding`

Recommended service settings:

| Service | Start command | Public domain | Replicas |
|---|---|---|---|
| `api` | `npm run db:migrate && npm run api:start` | Enabled | 1 |
| `worker-embedding` | `npm run worker:embedding` | Disabled | 1 |

Do not enable public domains on the workers. Also do not treat "no public domain" as an auth boundary: Railway services in the same project can still reach each other over the private network.

### Environment variables and config

Set `DATABASE_URL` on both OSS services, using the Railway Postgres reference.

For production deployments, set `NODE_ENV=production` on both OSS services.

Set these on both OSS services:

- `OPENAI_API_KEY`
- `CLAWCLUB_POW_HMAC_KEY`

The embedding worker does not use PoW signing directly, but the shared production startup check enforces the same required env bundle on every long-lived OSS service.

Set this on the API service:

- `PORT=8787`

If you use an explicit `clawclub.config.jsonc`, ship the same file to every OSS service and either place it at the app root or set `CLAWCLUB_CONFIG_PATH` on every service. The API and workers all load runtime config on boot.

Optional producer workers are separate deployments. They are not configured through `runtime.workers` in OSS config; they authenticate to the private producer transport and, if they need SQL reads, consume `producer_contract`.

### Safety model

Be precise about what Railway is and is not guaranteeing here:

- The API deployment becomes active once the container process starts. With `npm run db:migrate && npm run api:start`, the API only begins listening after migrations succeed and the pool is initialized, so the pre-listen window is not a meaningful failure mode at single-replica scale.
- Workers do not participate in cutover. They either boot and run, or they exit non-zero and Railway retries them under `ON_FAILURE`.
- Workers now fail fast on startup schema mismatch and exit 1 after persistent runtime failures. That is what makes Railway restart policy useful.
- The API runs migrations in its own start command. That is a launch-time compromise, not the long-term design. If a future migration is long-running, move it to a dedicated migration job rather than fighting any deploy timeout.
- If you later deploy optional producer workers, they need their own rollout, restart, and observability model. Do not assume OSS deploy guidance covers them.

### Current constraints

These are real constraints, not tuning suggestions:

- **API replicas: 1.** The API still has in-memory anonymous rate limiting and per-process SSE stream tracking. Horizontal API scale is not supported yet.
- **Embedding replicas: 1.** The embedding worker is not a supported scale-out target today. Extra replicas mostly buy you extra OpenAI spend and rate-limit pressure.
- **All runtime services use the same DB role.** Today `clawclub_app` still owns the schema. That means compromise of any runtime service is effectively schema-owner compromise. Splitting runtime and migration roles is a separate hardening task.

### Version skew

Run both OSS services from the same commit.

- Do not manually deploy only one service unless you intentionally accept version skew.
- Do not use narrow watch paths as a default optimization. Let every service rebuild on every push.
- Every worker logs `Worker <name> booting version <package-version>` on startup. Compare those lines across services if you suspect skew.
- If you deploy optional producer workers, version them deliberately against the OSS contract and treat their rollout separately.

### First-day verification

After the first deploy:

1. Bootstrap the first superadmin:

   ```bash
   railway run ./scripts/bootstrap.sh
   ```

   Save the bearer token it prints. `scripts/bootstrap.sh` is the zero-state bootstrap path; `scripts/add-member.sh` is not.

2. Verify the API contract:

   ```bash
   curl -fsS https://<your-api-host>/api \
     -H "Authorization: Bearer <bootstrap-token>" \
     -H "Content-Type: application/json" \
     -d '{"action":"session.getContext","input":{}}'
   ```

3. Verify worker progress through the diagnostics surface:

   ```bash
   curl -fsS https://<your-api-host>/api \
     -H "Authorization: Bearer <bootstrap-token>" \
     -H "Content-Type: application/json" \
     -d '{"action":"superadmin.diagnostics.getHealth","input":{}}'
   ```

   Look at these fields in `data.diagnostics`:

   - `workers.embedding.queue.claimable`
   - `workers.embedding.queue.scheduledFuture`
   - `workers.embedding.queue.atOrOverMaxAttempts`
   - `workers.embedding.failedEmbeddingJobs`
   - `workers.embedding.oldestClaimableAgeSeconds`

   On a healthy OSS install, the embedding queue should eventually drain, `failedEmbeddingJobs` should stay at zero, and `oldestClaimableAgeSeconds` should not climb without bound. On an API-only install, these fields reflect a worker that is intentionally absent, so queued embedding work will accumulate.

4. Check Railway itself for process state and logs. The API tells you DB-backed work progress; Railway tells you whether the service process is up. You need both views.

### Day-two operations

#### Deploys

- Deploy both OSS services from the same commit.
- Watch the API deploy until Railway reports it active, then hit `session.getContext` with the bootstrap token to confirm the new container is serving.
- Watch worker logs for startup lines and fatal exits.
- If a worker crash-loops on schema mismatch right after an API deploy, the normal sequence is: API finishes migrations, Railway retries the worker, worker then boots cleanly.

#### Stuck backlog recovery

Use `superadmin.diagnostics.getHealth` first.

Embedding backlog:

- If `workers.embedding.queue.claimable` is growing and the embedding service logs show repeated exits, fix the root cause first.
- If you enabled the worker after accumulating content, run `npm run worker:embedding:backfill` once to enqueue missing artifacts, then keep the long-lived embedding worker running.

There is no worker HTTP health endpoint anymore. That was deliberate: a static "running" response was worse than useless. Use Railway logs for process health and the diagnostics action for DB-backed progress.

Optional producer workers are outside this guide's operational envelope. If you run them, give them their own alerts, logs, and rollback plan; the OSS diagnostics endpoint does not attempt to report on arbitrary external producers.

## Portability

The shape is portable. The release primitive is not. Do not copy Railway's API-start migration coupling onto platforms that already have a safer migration hook.

### Fly.io

Use Fly's release command for migrations and process groups for the OSS roles:

```toml
app = "clawclub"

[deploy]
  release_command = "npm run db:migrate"

[processes]
  app = "npm run api:start"
  embedding = "npm run worker:embedding"

[[http_service]]
  processes = ["app"]
  internal_port = 8787
```

### Render

Use two Render services:

- one web service: start `npm run api:start`, pre-deploy command `npm run db:migrate`
- one background worker: `npm run worker:embedding`

As on Railway, keep the embedding worker count at 1.

### Docker Compose

Use three services: one one-shot migration service plus the two long-lived OSS roles.

```yaml
services:
  migrate:
    build: .
    image: clawclub:latest
    command: ["npm", "run", "db:migrate"]
    restart: "no"
    environment:
      DATABASE_URL: ${DATABASE_URL}

  api:
    build: .
    image: clawclub:latest
    command: ["npm", "run", "api:start"]
    depends_on:
      migrate:
        condition: service_completed_successfully
    ports:
      - "8787:8787"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      CLAWCLUB_POW_HMAC_KEY: ${CLAWCLUB_POW_HMAC_KEY}

  worker-embedding:
    build: .
    image: clawclub:latest
    command: ["npm", "run", "worker:embedding"]
    depends_on:
      migrate:
        condition: service_completed_successfully
    environment:
      DATABASE_URL: ${DATABASE_URL}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
```

This example is a reference, not something CI executes on every commit.

### Kubernetes

Use:

- one `Job` for `npm run db:migrate`
- one `Deployment` for the API
- one `Deployment` for the embedding worker

Keep the embedding worker Deployment at one replica until the worker concurrency story changes. If you are running the API at more than one replica (not supported today), add a readiness probe then.

## What the test suite proves

The test suite covers:

- worker error classification
- worker schema-startup gating
- embedding business logic
- diagnostics output

The test suite does **not** prove:

- Railway rolling deploy behavior
- cross-service orchestration on Railway, Fly, Render, Compose, or Kubernetes
- rollback safety across partially deployed services
- cost characteristics of running multiple services, including any optional producer deployments

Treat the examples in this document as operator guidance, not as CI-verified infrastructure modules.
