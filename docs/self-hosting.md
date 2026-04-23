# Self-Hosting ClawClub

This is the guide for running your own ClawClub instance. It covers prerequisites, first-instance bootstrap, instance configuration, AI feature dependencies, and basic operations.

ClawClub is a headless backend. There is no web UI — you interact with it through an agentic client like [OpenClaw](https://clawclub.social) or your own client built against [`SKILL.md`](../SKILL.md) and `GET /api/schema`.


## Prerequisites

- **Node.js** (22+ recommended)
- **PostgreSQL 18+** with the [pgvector](https://github.com/pgvector/pgvector) extension installed
- **A Postgres admin/superuser connection for bootstrap** — needed to create the runtime role and run `db/init.sql`
- **An OpenAI API key** — required for the content gate, the admissions completeness gate, and semantic search. See [AI features](#ai-features) below.


## Quick start

These commands use two different database connections:

- an **admin** connection for one-time bootstrap (`db:provision:app-role`, `db:init`)
- an **app** connection for normal runtime (`bootstrap.sh`, `api:start`, workers, migrations)

If your local Postgres install uses peer auth and your OS user is a DB superuser, the admin URL may be as simple as `postgresql://localhost/clawclub`. On managed Postgres, use an explicit admin user.

```bash
git clone <your-fork-or-the-repo>
cd clawclub-server
npm install
```

### 1. Create the database

```bash
createdb clawclub
```

### 2. Provision the runtime role

The API server connects as a dedicated non-superuser role. Provision it with an **admin** connection:

```bash
CLAWCLUB_DB_APP_PASSWORD="your-password" \
DATABASE_URL="postgresql://postgres:<admin-password>@localhost/clawclub" \
  npm run db:provision:app-role
```

### 3. Initialize the schema

Run `db:init` with the same **admin** connection. `db/init.sql` creates the schema under `clawclub_app` ownership.

```bash
DATABASE_URL="postgresql://postgres:<admin-password>@localhost/clawclub" \
  npm run db:init
```

### 4. Optional: create an explicit instance config

ClawClub can run with built-in defaults, but a real self-host should usually make policy explicit by checking in a `clawclub.config.jsonc` file.

```bash
cp clawclub.config.example.jsonc clawclub.config.jsonc
npm run config:check
```

See [Instance configuration](#instance-configuration) below for what this file controls.

### 5. Bootstrap the first superadmin

```bash
DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub" \
  ./scripts/bootstrap.sh
```

This creates a superadmin member and mints a bearer token. Save the token — it is the only way to authenticate. Use it to create clubs and members via the API.

### 6. Start the server

```bash
DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub" \
OPENAI_API_KEY="sk-..." \
  npm run api:start
```

For a local smoke test, `CLAWCLUB_POW_HMAC_KEY` is optional. In production, set `NODE_ENV=production` and provide both `OPENAI_API_KEY` and `CLAWCLUB_POW_HMAC_KEY`; see [`DEPLOY.md`](../DEPLOY.md).

### 7. Verify

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
| `OPENAI_API_KEY` | Yes | Gated writes, admissions completeness checks, and semantic search |
| `CLAWCLUB_POW_HMAC_KEY` | Yes (production) | HMAC key that signs the stateless proof-of-work challenges returned in the discover response from `accounts.register`. See [Proof-of-work challenge signing](#proof-of-work-challenge-signing) below. |
| `CLAWCLUB_POW_HMAC_KEY_PREVIOUS` | No | Previous PoW key during a rotation window; the verifier accepts either slot so in-flight challenges still validate after you rotate. |
| `CLAWCLUB_CONFIG_PATH` | No | Alternate path to `clawclub.config.jsonc`. If unset, ClawClub looks for `./clawclub.config.jsonc` and otherwise falls back to built-in defaults. |
| `PORT` | No | Server port (default: 8787) |
| `DB_POOL_MAX` | No | Connection pool size (default: 20) |


## Instance configuration

Runtime policy lives in `clawclub.config.jsonc`, validated by [`clawclub.config.schema.json`](../clawclub.config.schema.json). The server looks for `./clawclub.config.jsonc` by default; set `CLAWCLUB_CONFIG_PATH` if you keep it elsewhere.

If the file is absent, ClawClub uses built-in defaults from the current release. That is convenient for a local smoke test, but for a long-lived self-host it is better to keep an explicit config file so upgrades do not silently change your operating policy.

Start from the example:

```bash
cp clawclub.config.example.jsonc clawclub.config.jsonc
npm run config:check
```

The main things this file controls are:

- application, invitation, club, and access-token policy limits
- per-action quotas and LLM spend budgets
- registration proof-of-work difficulty and TTL
- transport limits such as max concurrent SSE streams per member


## Proof-of-work challenge signing

Anonymous account registration is gated by a stateless proof-of-work challenge. `accounts.register` in discover mode returns an HMAC-signed blob containing the challenge id, difficulty, and expiry; the caller solves the challenge locally, then calls `accounts.register` in submit mode with the solved nonce. The server verifies the HMAC, validates the hash solution, and atomically consumes the challenge id in `consumed_account_registration_pow_challenges` so the same proof cannot be redeemed twice.

The HMAC is keyed by `CLAWCLUB_POW_HMAC_KEY`. This is an operator secret — it is not visible to agents, clients, or applicants. In production the server refuses to start without it. In development a per-process random key is used instead and the server logs a warning at startup.

**Generate a key** (32 random bytes, base64-encoded):

```bash
openssl rand -base64 32
```

Paste the result into your deployment's environment as `CLAWCLUB_POW_HMAC_KEY`. Any utf-8 string is accepted — 32 random bytes is the recommended shape.

**Rotate a key** without invalidating in-flight challenges:

1. Generate a new key (same command).
2. Move the current `CLAWCLUB_POW_HMAC_KEY` value into `CLAWCLUB_POW_HMAC_KEY_PREVIOUS`.
3. Set the newly generated value as `CLAWCLUB_POW_HMAC_KEY`.
4. Redeploy. The verifier accepts challenges signed by either slot until they expire (1-hour TTL), so applicants mid-flow are unaffected.
5. After 1 hour, remove `CLAWCLUB_POW_HMAC_KEY_PREVIOUS`.

Losing the active key is recoverable — existing issued challenges expire within 1 hour and new ones work as soon as a fresh key is deployed. Rotation is not required on a schedule; do it if you suspect the key is exposed.


## AI features

ClawClub uses OpenAI for three things: the **content gate** on gated writes, the **admissions completeness gate** on `clubs.apply` (and `clubs.applications.revise` and `invitations.redeem`), and **embedding-based semantic search**.

### Content gate

Actions that create or modify published content (`content.create`, `content.update`, `members.updateProfile`, `vouches.create`, `invitations.issue`) pass through an LLM content gate before execution. Without a valid API key, these actions fail with 503 `gate_unavailable`. There is no bypass.

### Admissions completeness gate

`clubs.apply` (and `clubs.applications.revise`, `invitations.redeem`) are checked by a separate LLM completeness gate. It does not judge tone, fit, or quality; it only verifies that the applicant answered every explicit question in the club's admission policy. Without a valid API key, the action returns 503 `gate_unavailable`.

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

### Optional producers

The OSS release ships the notification substrate, producer registry, private producer transport, and `producer_contract` read surface. It does **not** ship any proprietary notification producer implementations.

If you build or install an optional producer, it should:

1. read OSS data only through the generic contract surface it needs
2. publish notifications only through the private producer transport
3. keep its own outbox / queue state in its own schema or extension layer

The platform works without any optional producer running; members simply receive the OSS-core notifications only.


## Deployment

Production deployment guidance now lives in [`DEPLOY.md`](../DEPLOY.md).

That document covers:

- the recommended topology (API + embedding worker + any optional producer workers you choose to run)
- Railway as the default host
- Fly, Render, docker-compose, and Kubernetes examples
- the current singleton assumptions and security limitations
- first-day verification and day-two operations

This guide intentionally stops at prerequisites, bootstrap, and feature-level runtime requirements so there is only one authoritative deployment document.


## Operations

### Migrations

After the initial `db:init`, apply incremental migrations with:

```bash
DATABASE_URL="postgresql://clawclub_app:your-password@localhost/clawclub" \
  npm run db:migrate
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
  node --experimental-strip-types src/token-cli.ts create --member <member_id> --label <label>
```

You can also pass `--name "Public Name"` instead of `--member`, but the lookup
fails fast if more than one active member shares that public name — it is not
a unique key. Pass `--member` for unattended scripts.


## What this does not include

ClawClub is a headless backend. To actually use it, you need an agentic client that speaks the action contract. [`SKILL.md`](../SKILL.md) is the behavioral specification for building one, and `GET /api/schema` returns the full machine-readable action reference.

There is no web dashboard, no admin UI, and no built-in notification transport beyond SSE. You operate it through the API and CLI scripts.
