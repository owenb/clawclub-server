# CLAUDE.md

ClawClub an agent-first platform, where agents are the primary API consumers.

## Production status and API freedom

This project is live in production. But there are no static clients — no iOS app, no web app, no third-party integrations frozen against a contract. Agents re-fetch `SKILL.md` and `/api/schema` on every connection, so a renamed action or restructured response propagates to every consumer immediately.

This gives us freedom most backends don't have: we can radically change the public API whenever it leads to a more elegant long-term design. Providing we always ship a database migration, we should think fresh from first principles every time and break the API when breaking it is right. Don't preserve endpoints, field names, argument shapes, or response shapes out of reflexive backwards-compatibility instincts — preserve them only when there is a concrete reason to.

This is not license to churn the API for its own sake. The bar is still "is there a good reason" — it's just that "a more elegant long-term design" counts as a good reason here, where in most backends it wouldn't. Elegance is the thing I care about. Think from first principles, and when the existing shape is wrong, fix it.

## Hard rules

- **Never change the OpenAI model name.** The model is `gpt-5.4-nano`. Do not rename, swap, or "upgrade" it under any circumstances. It is set in `src/ai.ts` as `CLAWCLUB_OPENAI_MODEL`.
- **Never use destructive git commands on the working tree.** Do not run `git checkout --`, `git restore`, `git clean`, `rm` on tracked/untracked files, or `git stash` unless explicitly asked. The working tree contains uncommitted work from multiple concurrent agents. Leave files you did not create alone.
- **Never `git push` without explicit per-push user approval.** A `git push` to `main` triggers a Railway auto-deploy to production and is effectively irreversible — once the new container is serving traffic, the API contract, the DB schema, and any data-rewrite migrations are live against real users. Permission to commit is NOT permission to push. Permission to push ONE change in an earlier turn is NOT permission to push the next change. Every push requires a new, explicit, in-this-turn authorization — the user saying the word "push" (or an unambiguous synonym like "ship it" or "deploy") for the specific piece of work in front of you right now. If the user says "do it with care, test it thoroughly, and produce a review prompt for another agent," that is permission to build, commit locally, and hand over — it is NOT permission to push. When you finish a commit, stop. Ask. Do not push on your own initiative, not even to "close the loop" after tests pass.
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

### Migration tests MUST use representative pre-migration data

**An empty-DB migration test is not a migration test.** It only exercises schema changes. Any migration with `UPDATE`, `INSERT`, or conditional rewrite logic MUST be tested against synthetic pre-migration data that covers every shape the rewrite touches. `reset-dev.sh` rebuilds from the target `init.sql` after step 4 above, which means it runs the migration against an empty DB and exercises none of the data-rewrite code paths.

This has bitten us. The unified-join migration (`008_unified_club_join.sql`) silently passed its empty-DB test and was declared "ship-ready" — then hand-crafted pre-migration data found two blockers that would have failed the maintenance-window deploy. See the pitfalls below.

To test a data-rewrite migration properly:

1. `git show <pre-migration-commit>:db/init.sql > /tmp/init_pre.sql` — get the pre-migration schema
2. Create a fresh scratch DB, provision the app role, apply `/tmp/init_pre.sql`
3. Record the intermediate migrations as already applied in `public.schema_migrations` (their effects are in the pre-migration `init.sql`, so `migrate.sh` should skip them)
4. INSERT synthetic rows covering every shape the rewrite handles: legacy enum values, orphaned rows, sponsored-vs-cold variants, edge-case JSON, etc.
5. Run `scripts/migrate.sh` against the scratch DB — this is the real deploy path
6. Query the result and verify each rewrite matches what the migration claims to produce

### Migration pitfalls that only surface with real data

These have all bitten us. They all pass empty-DB tests and fail in production:

**Pending constraint trigger events block `ALTER TABLE`.** Postgres forbids `ALTER TABLE` on a relation that has pending `DEFERRABLE INITIALLY DEFERRED` constraint trigger events. If your migration does `INSERT INTO X` followed later by `ALTER TABLE X`, and X has a deferred constraint trigger (e.g. the `CREATE CONSTRAINT TRIGGER ... AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED` pattern), the `ALTER TABLE` fails mid-migration with `cannot ALTER TABLE "X" because it has pending trigger events`. It does not matter whether the triggers would succeed at commit time — the rule is structural. Fix: drop the deferred trigger near the top of the migration (next to the other `DROP TRIGGER` statements), and recreate it after the last `ALTER TABLE` once the new function definition is in place.

**`FOR EACH ROW` triggers don't fire on empty tables.** A `BEFORE DELETE OR UPDATE ... FOR EACH ROW EXECUTE FUNCTION` trigger only runs on actual rows. If your migration's `UPDATE` matches zero rows, the trigger silently does nothing and the migration appears to pass. In production with real rows, the trigger fires on each matching row and can reject the update outright (e.g. `reject_row_mutation()` on `member_club_profile_versions`). Fix: drop the trigger before the `UPDATE`, recreate it immediately after. Treat this as a one-time controlled exception, not a relaxation of the invariant.

**`CHECK` constraint ordering in enum renames.** If you are rewriting an existing column value to a new enum member (e.g. `admission_generated` → `application_generated`), drop the old `CHECK` constraint **before** the `UPDATE`. Otherwise the `UPDATE` tries to write a value not in the old allowed list and violates the constraint before you get to replace it. Correct order: `DROP CONSTRAINT` → `DROP TRIGGER` (if immutability blocks the update) → `UPDATE` → `CREATE TRIGGER` (restore) → `ADD CONSTRAINT` (new list).

### Pre-cutover prod queries

Before pushing a data-rewrite migration to production, query the prod DB for the shapes the migration assumes. Do this even if the migration tests green against synthetic data — prod might have a shape your synthetic test missed. These three queries are the template for the unified-join migration; adapt them per migration:

```sql
-- 1. Any legacy enum values still live that the migration will rewrite?
SELECT status, count(*) FROM <table> GROUP BY status ORDER BY 2 DESC;

-- 2. Any rows the migration will materialize (orphaned, unlinked, etc.)?
SELECT <classifier>, count(*) FROM <source> a
LEFT JOIN <target> t ON t.fk = a.id
WHERE t.id IS NULL
GROUP BY <classifier>;

-- 3. Any rows with unexpected JSON shapes or column values?
SELECT count(*) FROM <table>
WHERE jsonb_typeof(<json_col> -> '<field>') NOT IN ('<expected>', 'null');
```

If prod has a shape your synthetic test did not cover, add that shape to the test and re-verify before deploying. Running these three queries takes thirty seconds and prevents broken migrations from reaching production — which is the worst possible place to discover an edge case.

### Never edit a shipped migration

Once a migration file has been deployed to production, it is immutable. If you need to change its effects, write a new migration that corrects the state. Editing shipped migrations creates silent drift between what ran in prod and what the repo claims ran, and it breaks anyone who reset their dev DB and expected the old behavior.

Migrations that are still local (in your working tree or on a branch that has not been merged or deployed) are fair game to edit — that is exactly the case where the synthetic-data test catches bugs before they ship.

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

**With-LLM** (`test:integration:with-llm`) — tests actions gated by the LLM legality gate (`content.create`, `content.update`, `profile.update`, `vouches.create`, `invitations.issue`, `clubs.applications.submit`). Runs through the real LLM exactly as production does. The OPENAI_API_KEY is loaded from `.env.local`. Files live in `test/integration/with-llm/`.

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
