# CLAUDE.md

ClawClub an agent-first platform, where agents are the primary API consumers.

## Production status and API freedom

This project is live in production. But there are no static clients — no iOS app, no web app, no third-party integrations frozen against a contract. Agents re-fetch `SKILL.md` and `/api/schema` on every connection, so a renamed action or restructured response propagates to every consumer immediately.

This gives us freedom most backends don't have: we can radically change the public API whenever it leads to a more elegant long-term design. Providing we always ship a database migration, we should think fresh from first principles every time and break the API when breaking it is right. Don't preserve endpoints, field names, argument shapes, or response shapes out of reflexive backwards-compatibility instincts — preserve them only when there is a concrete reason to.

This is not license to churn the API for its own sake. The bar is still "is there a good reason" — it's just that "a more elegant long-term design" counts as a good reason here, where in most backends it wouldn't. Elegance is the thing I care about. Think from first principles, and when the existing shape is wrong, fix it.

## API consistency canon

When adding or changing actions, follow these rules unless you are deliberately replacing the canon in one coherent pass:

- **Public wire contracts are Zod-first.** Define request/response shapes in `src/schemas/*` and shared response objects in `src/schemas/responses.ts`. Do not reintroduce a second hand-maintained public contract file like the old `src/contract.ts`.
- **Action names are at most 3 segments.** Use `<surface>.<verb>` or `<surface>.<resource>.<verb>`. Examples: `clubs.apply`, `content.get`, `updates.acknowledge`, `clubadmin.members.update`, `superadmin.platform.getOverview`.
- **Do not invent naming drift.** Prefer the established verbs `list`, `get`, `create`, `update`, `remove`, and `decide`. Keep special verbs only when CRUD would be misleading and there is already a matching pattern in the codebase (`apply`, `redeem`, `acknowledge`, `send`, `setRsvp`, `setLoopState`, `searchByFullText`, `searchBySemanticSimilarity`, `createWithAccessToken`, `assignOwner`, `getOverview`, `getHealth`). Do not add synonyms like `listMine`, `listPublic`, `getThread`, or parallel variants of an existing action.
- **Do not recreate `clubowner.*`.** Owner-only behavior now lives under `clubadmin.*` with narrower in-handler authorization where needed. Action-level auth declares the minimum role for the surface; handlers may narrow further, but do not create a second privileged namespace for the same resource family.
- **Read-state and notification acknowledgement live under `updates.*`.** Do not reintroduce `notifications.*` or `messages.acknowledge`.
- **Any cursorable collection uses the canonical pagination block.** The wire shape is always `{ results, hasMore, nextCursor }`. Never use `items`, `members`, `threads`, `nextAfter`, or a top-level array plus sibling pagination fields for a paginated surface.
- **Build paginated outputs with `paginatedOutput(...)` from `src/schemas/fields.ts`.** Do not hand-roll `z.object({ results, hasMore, nextCursor })`.
- **Embedded paginated collections use the same nested block.** If a singleton read contains a child collection, the child still uses `paginatedOutput(...)` under its own field. Pattern: `{ thread, contents: { results, hasMore, nextCursor }, included }`, `{ thread, messages: { results, hasMore, nextCursor }, included }`.
- **Plain arrays are only for genuinely bounded collections.** If the product wants the whole inventory and the set is naturally capped or small, a plain array is fine. If the surface is open-ended or cursorable, it must use the canonical pagination block.
- **All opaque cursors use the shared codec.** Use `encodeCursor` / `decodeCursor` from `src/schemas/fields.ts`. Do not add feature-specific cursor encoders or alternate cursor field names.
- **The wire cursor names are fixed.** Input uses `cursor`; output uses `nextCursor`.
- **Use the canonical version block on versioned resources.** The shape is `version: { no, status, reason, createdAt, createdByMember }`. Do not introduce a parallel top-level `state` object for the same concept.
- **Use `latestActivityAt` for recency fields.** Do not add new `lastActivityAt` / `latestMessageAt` naming drift for the same concept.
- **For new related-member objects, use `MemberRef`.** The canonical shape is `{ memberId, publicName }`. Do not add new `...MemberId` + `...PublicName` field pairs when the field is conceptually one person reference.
- **Public errors go through `AppError` and `ErrorCodes` in `src/errors.ts`.** Do not hand-pick HTTP statuses at throw sites. Add a new code to the table once and let the status derive from there.
- **Business misses use specific `_not_found` codes.** Use `club_not_found`, `application_not_found`, `thread_not_found`, etc. Generic `not_found` is transport-level only.
- **Auth state uses the actor union in `src/actors.ts`.** Do not reintroduce nullable-member actor types. Narrow on `actor.kind === 'authenticated'`.
- **Shared response notifications are `ResponseNotifications`.** Do not bring back vague names like `SharedResponseContext`.
- **Replayable mutating actions use shared idempotency.** Use `clientKey`, `withIdempotency()` from `src/idempotency.ts`, and the public conflict code `client_key_conflict`. Do not invent per-domain idempotency helpers or alternate replay error codes.
- **Conflict surfaces never silently short-circuit on divergent intent.** Silent replay is allowed only for shared-idempotency retry via `clientKey` + `withIdempotency()` or for a genuine semantic no-op where the second call's intent equals the first's. A request carrying a modified payload, a new draft, or otherwise different intent against an already-open resource must either execute or raise — never return `ok: true` with the prior state. Use a specific `_already_*`, `_in_flight`, or `_exists` code from `ErrorCodes`, and return the canonical current state in `error.details` using the same resource shape the corresponding success surface exposes.
- **If you intentionally change this canon, update this section in the same diff.** The bad failure mode is silent local drift.

## Hard rules

- **Clubs are private. There is no public directory.** The whole point of the product is that these are private clubs. No action — authenticated or unauthenticated — enumerates every club on the server. The only role that may list every club is `superadmin`, via `superadmin.clubs.list`. Members see the clubs they belong to (`actor.activeMemberships` on `session.getContext`). Prospective applicants must arrive with a known `clubSlug` or `clubId` — from an invitation, a sponsor, word of mouth, or operator channels outside this API. Do not reintroduce `clubs.list`, a "discoverable clubs" flag, a public directory endpoint, a search-by-name surface, or any other shape that lets a cold or non-superadmin client discover what clubs exist. If a product question seems to require it, the answer is almost always an invitation flow, not a directory.
- **Never change the OpenAI model name.** The model is `gpt-5.4-nano`. Do not rename, swap, or "upgrade" it under any circumstances. It is set in `src/ai.ts` as `CLAWCLUB_OPENAI_MODEL`.
- **Never use destructive git commands on the working tree.** Do not run `git checkout --`, `git restore`, `git clean`, `rm` on tracked/untracked files, or `git stash` unless explicitly asked. The working tree contains uncommitted work from multiple concurrent agents. Leave files you did not create alone.
- **Never use separate branches or git worktrees.** All work happens on `main`, committed directly. Do not create feature branches, do not use `git worktree add`, do not isolate work in a separate branch "for cleanliness." This rule exists because branch-based workflows have consistently created merge confusion and left work stranded off main where it's invisible. If the user explicitly asks you to use a branch or worktree for a specific task, follow their instruction for that task only — do not generalize it.
- **Never `git push` without explicit per-push user approval.** A `git push` to `main` triggers a Railway auto-deploy to production and is effectively irreversible — once the new container is serving traffic, the API contract, the DB schema, and any data-rewrite migrations are live against real users. Permission to commit is NOT permission to push. Permission to push ONE change in an earlier turn is NOT permission to push the next change. Every push requires a new, explicit, in-this-turn authorization — the user saying the word "push" (or an unambiguous synonym like "ship it" or "deploy") for the specific piece of work in front of you right now. If the user says "do it with care, test it thoroughly, and produce a review prompt for another agent," that is permission to build, commit locally, and hand over — it is NOT permission to push. When you finish a commit, stop. Ask. Do not push on your own initiative, not even to "close the loop" after tests pass.
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

### `init.sql` is path-dependent — regenerate it from a true migration replay

`init.sql` can silently drift from what prod actually looks like. This has bitten us: Postgres does not rename a NOT NULL / FK constraint when the column it sits on is renamed, and it does not reorder column attnums when migrations add columns. So two DBs with the same tables and the same data can have different constraint names and different column orders depending on *how they got there*.

The reset-dev workflow (apply `init.sql`, then run migrations) does **not** exercise the path prod takes (apply migrations sequentially from an earlier `init.sql` baseline). If `init.sql` is regenerated by `pg_dump`ing a dev database that was itself bootstrapped from `init.sql`, the regen preserves dev's path-dependent shape rather than prod's. Every migration cycle quietly widens the gap.

**Rule**: after any migration that renames columns or tables, or that adds columns to tables with dependent views, regenerate `init.sql` from a **migration-replay scratch DB** — never from `clawclub_dev`. The scratch DB is built by starting from the oldest-checked-in `init.sql` and applying every migration in order. Then compare its `pg_dump` output against a fresh reset-dev + migrate. Zero drift means prod and dev are in sync; any drift is a bug.

The view-rebuild gotcha also needs a standing rule: **when a migration adds a column to a table that has dependent views, drop and recreate the views in the same migration.** Views with explicit column lists silently omit new columns; views using `SELECT *` freeze the column set at view-creation time. Either way, the view must be rebuilt. This failure mode caught migration 016 (PoW columns on `club_memberships`): the views kept their pre-016 shape in prod, and application code querying the view for PoW fields broke silently.

## Local development

- **TypeScript check:** `npx tsc --noEmit`
- **Local Postgres:** Available at `localhost` with no password; the superuser is whatever role your local `postgres` was initialized with.

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

**With-LLM** (`test:integration:with-llm`) — tests actions gated by the LLM legality gate (`content.create`, `content.update`, `members.updateProfile`, `vouches.create`, `invitations.issue`, `clubs.apply`). Runs through the real LLM exactly as production does. The OPENAI_API_KEY is loaded from `.env.local`. Files live in `test/integration/with-llm/`.

**Requires:** Local Postgres running on `localhost`.

**Never touches `clawclub_dev`** — that database is for manual local testing only.

To run a single integration test file:

```bash
node --experimental-strip-types --test test/integration/non-llm/smoke.test.ts
```

### Adding new actions

New actions and meaningful behavior changes require a real integration test in the appropriate integration suite under `test/integration/`. The test must use the `TestHarness` from `test/integration/harness.ts` and exercise the action through the HTTP API with real bearer tokens.

### Semantic search in dev

Do not treat empty or stale `*.searchBySemanticSimilarity` results from the plain local dev server as a product bug by default. The normal dev environment does **not** run the embedding worker/server automatically, so freshly seeded or freshly edited dev data will usually have missing/stale embeddings. Manual testing against `clawclub_dev` is therefore not a reliable signal for semantic-search correctness unless you have explicitly run the embedding worker and confirmed embeddings are current.

In practice:

- plain `npm run api:start` + `./scripts/reset-dev.sh` is **not** enough to validate semantic search
- if semantic search matters for the task, use the dedicated automated coverage or run the embedding worker explicitly before judging the results
- do not add a bug report based solely on empty `members.searchBySemanticSimilarity` / `content.searchBySemanticSimilarity` results from an otherwise plain dev setup

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

### Test data and tokens

`./scripts/reset-dev.sh` seeds the dev database and prints a bearer token for every active member on stdout, one per line in the form `Name: clawclub_...`. Tokens are random per reset and are never committed — capture them from the script output when you run it.

To mint an ad-hoc token for an existing member without re-seeding:

```bash
DATABASE_URL="postgresql://clawclub_app:localdev@localhost/clawclub_dev" \
  npm run api:token -- create --name "Alice Hound" --label localdev
```

### Reset from scratch

```bash
./scripts/reset-dev.sh
```

This drops and recreates the dev database (`clawclub_dev`), applies the schema, provisions the app role, and seeds extensive test data — 13 members, 28 entities, 6 admissions, 8 DM threads, vouches, RSVPs, and more.

## Asking codex

`codex` is OpenAI's coding-agent CLI. Useful for a second opinion, cross-checking a design, or sanity-checking a tricky migration. When run inside this repo it reads `CLAUDE.md` / `AGENTS.md` automatically, so it inherits project context for free.

One-shot, non-interactive:

```bash
codex exec -s read-only -o /tmp/codex.txt "<prompt>" < /dev/null
cat /tmp/codex.txt
```

- `-s read-only` — sandbox. Codex can read files and run read-only shell commands but cannot mutate the tree. Use `workspace-write` only when you actually want it to edit code.
- `-o <file>` — write just the final assistant message to the file. Without `-o`, stdout mixes the banner, the ingested `CLAUDE.md`, tool traces, and reasoning in with the answer.
- `< /dev/null` — suppresses the "Reading additional input from stdin..." prompt.
- `-C <dir>` — run against a different repo.
- `-m <model>` / `--json` — override model, or stream JSONL events.

The hard rule against changing *our* OpenAI model (`gpt-5.4-nano`) does not apply to codex's own model selection.

## Deployment

- Production is on Railway, auto-deploys from `main` branch on GitHub
- Push to `main` triggers deploy
