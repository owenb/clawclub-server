# CLAUDE.md

ClawClub an agent-first platform, where agents are the primary API consumers.

## Hard rules

- **Never change the OpenAI model name.** The model is `gpt-5.4-nano`. Do not rename, swap, or "upgrade" it under any circumstances. It is set in `src/ai.ts` as `CLAWCLUB_OPENAI_MODEL`.
- **Never use destructive git commands on the working tree.** Do not run `git checkout --`, `git restore`, `git clean`, `rm` on tracked/untracked files, or `git stash` unless explicitly asked. The working tree contains uncommitted work from multiple concurrent agents. Leave files you did not create alone.
- **Always bump the patch version in `package.json` before committing.** Increment the third number (e.g. `0.2.0` → `0.2.1`). If multiple commits land in one session, bump once at commit time — don't skip it.
- **Always run migrations through `scripts/migrate.sh`.** Never apply migration files manually with `psql -f`. The migrate script wraps each file in `--single-transaction` with `ON_ERROR_STOP=1`, which is the exact deployment path. Running migrations outside this path hides transactional bugs.

## Database migration workflow

When making schema changes, follow this order:

1. **Write the migration SQL first** (`db/migrations/NNN_description.sql`). Do not touch `db/init.sql` yet.
2. **Test the migration against the current deployed state**: `reset-dev.sh` (creates a DB from the current `init.sql`), then `scripts/migrate.sh` (applies the migration through the real deploy path). This simulates what will happen in production.
3. **Verify manually** — spot-check the schema, try the API, confirm the migration is clean.
4. **Only after the migration is verified**: update `db/init.sql` to reflect the final target state, update `db/seeds/dev.sql`, update application code and tests.
5. **Run tests** — integration tests create fresh DBs from `init.sql`, so they exercise the target state.

This ordering ensures the migration is tested against a production-like database before `init.sql` is modified. If you need the pre-migration state again later, it's always available in git (`git show main:db/init.sql`).

`db/init.sql` must always reflect the target schema. It is the source of truth for fresh installs, test harnesses, and self-hosted deployments.

## Local development

- **TypeScript check:** `npx tsc --noEmit`
- **Local Postgres:** Available at `localhost` with no password, user is the OS user (`owen`)

## Testing

```bash
npm run check                    # TypeScript type check
npm run test:unit                # Unit tests in test/unit/ — no DB needed
npm run test:unit:db             # Unit tests in test/unit-db/ that need real Postgres
npm run test:integration:non-llm # Integration tests that do NOT hit the LLM (fast, free)
npm run test:integration:with-llm # Integration tests that DO hit gpt-5.4-nano (requires .env.local with OPENAI_API_KEY)
npm run test:integration:all     # Runs both non-llm then with-llm
npm run test:integration         # Alias for test:integration:all
```

### Unit tests (`test/unit/*.test.ts`)

Unit tests use mocked repositories or fake DB clients — fast, no real database needed.

### Unit DB tests (`test/unit-db/*.test.ts`)

These tests need a real Postgres database. Right now this is the app-role provisioning test.

### Integration tests (`test/integration/non-llm/*.test.ts`, `test/integration/with-llm/*.test.ts`)

The primary confidence layer. Every test file runs against a real Postgres database with the real `clawclub_app` role and a real HTTP server on a random port. The harness creates an isolated scratch database per process using a `clawclub_test_*` prefix, then tears it down automatically.

Tests are split into two suites:

**Non-LLM** (`test:integration:non-llm`) — tests every action that does not pass through the legality gate. No OpenAI key needed. Fast and free. Files live in `test/integration/non-llm/`.

**With-LLM** (`test:integration:with-llm`) — tests actions gated by the LLM legality gate (`content.create`, `content.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsorCandidate`). Runs through the real LLM exactly as production does. The OPENAI_API_KEY is loaded from `.env.local`. Files live in `test/integration/with-llm/`.

**Requires:** Local Postgres running on `localhost`.

**Never touches `clawclub_dev`** — that database is for manual local testing only.

To run a single integration test file:

```bash
node --experimental-strip-types --test test/integration/non-llm/smoke.test.ts
```

### Adding new actions

New actions and meaningful behavior changes require a real integration test in the appropriate integration suite under `test/integration/`. The test must use the `TestHarness` from `test/integration/harness.ts` and exercise the action through the HTTP API with real bearer tokens.

## Local dev server

Local dev database with test clubs seeded:

- **Database:** `postgresql://clawclub_app:localdev@localhost/clawclub_dev`

Start the server:

```bash
DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_dev" npm run api:start
```

The OPENAI_API_KEY is in `.env` and picked up automatically.

### API reference

Read `SKILL.md` for the behavioral API specification and agent guidance. For the complete action reference (input fields, response shapes, auth requirements), fetch the live schema: `GET /api/schema` (no auth required). Local base URL is `http://127.0.0.1:8787`.

### Test data

Owen (owner of all three clubs):
- Token: `cc_live_e4w82kqnpn6k_5f8a3bz7t2h8qhrnxr3n8a4f`

Alice Hound (member of DogClub, CatClub):
- Token: `cc_live_ewze5vkwm9jx_q4srmr3buffwhn72qgdx8ad4`

Bob Whiskers (member of CatClub, FoxClub):
- Token: `cc_live_xzb2r5536t5r_5ug8yxb8k6uy7w2phfa6vwp6`

Charlie Paws (member of DogClub, FoxClub):
- Token: `cc_live_rc2sum2m8s26_exgw5uyhpqz93rfqjejhakpc`

### Reset from scratch

```bash
./scripts/reset-dev.sh
```

This drops and recreates the dev database (`clawclub_dev`), applies the schema, provisions the app role, and seeds extensive test data — 13 members, 28 entities, 6 admissions, 8 DM threads, vouches, RSVPs, and more. Tokens are random on each reset, so update the tokens in this section after re-seeding.

## Deployment

- Production is on Railway, auto-deploys from `main` branch on GitHub
- Push to `main` triggers deploy
