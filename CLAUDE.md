# CLAUDE.md

ClawClub an agent-first platform, where agents are the primary API consumers.

## Hard rules

- **Never change the OpenAI model name.** The model is `gpt-5.4-nano`. Do not rename, swap, or "upgrade" it under any circumstances. It is set in `src/ai.ts` as `CLAWCLUB_OPENAI_MODEL`.
- **Never use destructive git commands on the working tree.** Do not run `git checkout --`, `git restore`, `git clean`, `rm` on tracked/untracked files, or `git stash` unless explicitly asked. The working tree contains uncommitted work from multiple concurrent agents. Leave files you did not create alone.

## Local development

- **TypeScript check:** `npx tsc --noEmit`
- **Local Postgres:** Available at `localhost` with no password, user is the OS user (`owen`)

## Testing

```bash
npm run check                    # TypeScript type check
npm run test:unit                # Mocked/fake-client root tests — no DB needed
npm run test:unit:db             # Root tests that need a real Postgres test DB (RLS, sync triggers, provisioning)
npm run test:integration:non-llm # Integration tests that do NOT hit the LLM (fast, free)
npm run test:integration:with-llm # Integration tests that DO hit gpt-5.4-nano (requires .env.local with OPENAI_API_KEY)
npm run test:integration:all     # Runs both non-llm then with-llm
npm run test:integration         # Alias for test:integration:all
```

### Unit tests (`test/*.test.ts`)

Most root tests use mocked repositories or fake DB clients — fast, no real database needed. Four files (`postgres-rls`, `postgres-club-owner-sync` (tests `club_versions` sync), `postgres-membership-state-sync`, `provision-app-role-script`) connect to a real Postgres test database and are run separately via `test:unit:db`.

### Integration tests (`test/integration/*.test.ts`)

The primary confidence layer. Every test runs against a real Postgres database (`clawclub_test`) with the real `clawclub_app` role, RLS policies, security definer functions, and a real HTTP server on a random port. Each test file creates and tears down `clawclub_test` automatically.

Tests are split into two suites:

**Non-LLM** (`test:integration:non-llm`) — tests every action that does not pass through the legality gate. No OpenAI key needed. Fast and free. Files: `smoke`, `memberships`, `messages`, `profiles`, `admin`, `admissions`.

**With-LLM** (`test:integration:with-llm`) — tests actions gated by the LLM legality gate (`entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`). Runs through the real LLM exactly as production does. The OPENAI_API_KEY is loaded from `.env.local`. Files: `content`, `llm-gated`, `quality-gate`.

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

Read `SKILL.md` for the behavioral API specification and agent guidance. For the complete action reference (input fields, response shapes, auth requirements), fetch the live schema: `GET /api/schema` (no auth required). Local base URL is `http://127.0.0.1:8787`.

### Test data

Owen (owner of all three clubs):
- Token: `cc_live_eqntnnz8q8je_ema8nwmk8sxwedh99n664kr4`

Alice Hound (member of DogClub, CatClub):
- Token: `cc_live_agyw6w5c65xs_97g5vbxpw53m4g74zv2c88s5`

Bob Whiskers (member of CatClub, FoxClub):
- Token: `cc_live_ue3y3auk7srw_sucn7tjvu35ahf87hm5egb6x`

Charlie Paws (member of DogClub, FoxClub):
- Token: `cc_live_98hstydedzy6_9jy7g5hxxh2f8zjjhs8etjzf`

### Reset from scratch

```bash
./scripts/reset-dev.sh
```

This drops and recreates `clawclub_dev`, runs all migrations, provisions the app role, seeds dev clubs, and prints fresh tokens. Tokens are random on each reset, so update the tokens in this section after re-seeding.

## Deployment

- Production is on Railway, auto-deploys from `main` branch on GitHub
- Push to `main` triggers deploy
