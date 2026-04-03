# CLAUDE.md

## Hard rules

- **Never change the OpenAI model name.** The model is `gpt-5.4-nano`. Do not rename, swap, or "upgrade" it under any circumstances. It is set in `src/ai.ts` as `CLAWCLUB_OPENAI_MODEL`.

## Local development

- **TypeScript check:** `npx tsc --noEmit`
- **Local Postgres:** Available at `localhost` with no password, user is the OS user (`owen`)

## Testing

```bash
npm run check                    # TypeScript type check
npm run test:unit                # Mocked unit tests — no DB needed
npm run test:integration:non-llm # Integration tests that do NOT hit the LLM (fast, free)
npm run test:integration:with-llm # Integration tests that DO hit gpt-5.4-nano (requires .env.local with OPENAI_API_KEY)
npm run test:integration:all     # Runs both non-llm then with-llm
npm run test:integration         # Alias for test:integration:all
```

### Unit tests (`test/*.test.ts`)

Fast, mocked repository tests. Good for handler logic and input validation. No database required.

### Integration tests (`test/integration/*.test.ts`)

The primary confidence layer. Every test runs against a real Postgres database (`clawclub_test`) with the real `clawclub_app` role, RLS policies, security definer functions, and a real HTTP server on a random port. Each test file creates and tears down `clawclub_test` automatically.

Tests are split into two suites:

**Non-LLM** (`test:integration:non-llm`) — tests every action that does not pass through the quality gate. No OpenAI key needed. Fast and free. Files: `smoke`, `memberships`, `messages`, `profiles`, `admin`, `admissions`.

**With-LLM** (`test:integration:with-llm`) — tests actions gated by the LLM quality gate (`entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`). Runs through the real LLM exactly as production does. The OPENAI_API_KEY is loaded from `.env.local`. Files: `content`, `llm-gated`, `quality-gate`.

**Requires:** Local Postgres running on `localhost`.

**Never touches `clawclub_dev`** — that database is for manual local testing only.

To run a single integration test file:

```bash
node --experimental-strip-types --test test/integration/content.test.ts
```

### Adding new actions

New actions and meaningful behavior changes require a real integration test in `test/integration/`. The test must use the `TestHarness` from `test/integration/harness.ts` and exercise the action through the HTTP API with real bearer tokens.

## Local dev server

A local dev database `clawclub_dev` is available with three test clubs seeded.

- **Database:** `postgresql://clawclub_app:localdev@localhost/clawclub_dev`
- **Migrator URL (for migrations/seeds):** `postgresql://localhost/clawclub_dev`

Start the server:

```bash
DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_dev" npm run api:start
```

The OPENAI_API_KEY is in `.env` and picked up automatically.

### API reference

Read `SKILL.md` for the full API specification — all actions, request/response shapes, and behavior. The "How to connect" section covers the request envelope, auth, and available routes. Local base URL is `http://127.0.0.1:8787`.

### Test data

Owen (owner of all three clubs):
- Token: `cc_live_hcaxssfakp3t_p746d34twf6axxrc3m7y5enh`

Alice Hound (member of DogClub, CatClub):
- Token: `cc_live_9j3myegfuvuj_bn599m5thtz7vqkf2u658k53`

Bob Whiskers (member of CatClub, FoxClub):
- Token: `cc_live_4nhb8nk7p2gs_84s6j5p7fc4353mfqyusk85h`

Charlie Paws (member of DogClub, FoxClub):
- Token: `cc_live_4cwzhjrnee7w_e7fj2pcud9g6jbv8n4fytxw7`

### Reset from scratch

```bash
psql -h localhost -d postgres -c "DROP DATABASE clawclub_dev;" -c "CREATE DATABASE clawclub_dev;"
DATABASE_URL="postgresql://localhost/clawclub_dev" ./scripts/migrate.sh
CLAWCLUB_DB_APP_PASSWORD="localdev" DATABASE_URL="postgresql://localhost/clawclub_dev" ./scripts/provision-app-role.sh
psql -h localhost -d clawclub_dev -f db/seeds/dev-clubs.sql
DATABASE_URL="postgresql://localhost/clawclub_dev" node --experimental-strip-types src/token-cli.ts create --handle owen-barnes --label localdev
DATABASE_URL="postgresql://localhost/clawclub_dev" node --experimental-strip-types src/token-cli.ts create --handle alice-hound --label localdev
DATABASE_URL="postgresql://localhost/clawclub_dev" node --experimental-strip-types src/token-cli.ts create --handle bob-whiskers --label localdev
DATABASE_URL="postgresql://localhost/clawclub_dev" node --experimental-strip-types src/token-cli.ts create --handle charlie-paws --label localdev
```

Note: tokens are random on each reset, so update the tokens in this section after re-seeding.

## Deployment

- Production is on Railway, auto-deploys from `main` branch on GitHub
- Push to `main` triggers deploy
