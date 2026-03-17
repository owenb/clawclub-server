# Hardening & Consistency Plan

Full codebase audit completed 2026-03-17. Each item below includes context, why it matters, and the proposed fix.

---

## 1. Guard non-null assertions after queries

**Where**: `src/postgres/applications.ts`, `src/postgres/content.ts` — multiple `rows[0]!` usages after INSERT...RETURNING or SELECT queries.

**Why**: If a row isn't returned (RLS blocks it, concurrent delete, unexpected empty result), the `!` assertion silently produces `undefined` and the error surfaces later as a confusing property-access crash rather than a clear message.

**Fix**: Replace each `rows[0]!` with an explicit guard that throws an `AppError` if the row is missing. Pattern:

```typescript
const row = result.rows[0];
if (!row) throw new AppError(500, 'missing_row', 'Expected row not returned');
```

Audit every `!` assertion in `src/postgres/` and apply the same treatment.

---

## 2. Rate-limit cold application endpoints

**Where**: `src/server.ts` request handling, `src/app-cold-applications.ts`.

**Why**: `applications.challenge` and `applications.solve` are unauthenticated. Without rate limiting, an attacker can spam challenge creation to fill the applications table or brute-force nonce submissions. The proof-of-work gate slows individual solves but doesn't prevent volume.

**Fix**: Add a simple in-memory IP-based rate limiter at the HTTP layer for unauthenticated actions. Track request counts per IP with a sliding window (e.g., 10 challenges per IP per hour, 30 solve attempts per IP per hour). Use a `Map<string, { count: number, resetAt: number }>` — no external dependency needed. Return 429 when exceeded.

---

## 3. Clarify archive vs expiry semantics

**Where**: `src/postgres/content.ts` `archiveEntity()` — sets `expires_at = archivedAt`.

**Why**: Every other entity version treats `expires_at` as an independent business field (when the content naturally expires). Archiving overloads this field to mean "hidden since this timestamp," which conflates two concepts. A query filtering on `expires_at` can't distinguish "expired naturally" from "manually archived."

**Fix**: Stop setting `expires_at` on archive. The `state = 'archived'` column already controls visibility. Update the archive INSERT to pass `NULL` for `expires_at` (or carry forward the previous version's value). Verify that all queries filtering archived content use the `state` column, not `expires_at`.

---

## 4. Normalize DM thread participants

**Where**: `src/postgres/messages.ts` — counterpart computed dynamically via `created_by_member_id` comparison.

**Why**: The "other party" is calculated at read time by checking who created the thread and comparing against the current actor. This is fragile: if the schema evolves (group threads, self-messages) or the logic is duplicated elsewhere, it can diverge.

**Fix**: Add explicit `participant_a` and `participant_b` columns to the thread table (or a join table `dm_thread_participants`). Populate via a migration that backfills from existing threads. Update the message queries to use the explicit columns. This also simplifies inbox queries — no CASE expressions needed.

---

## 5. Parameterize migration script SQL

**Where**: `scripts/migrate.sh` line 44 — `where filename = '$name'` with shell interpolation.

**Why**: A migration filename containing a single quote would break the query. While filenames come from the filesystem (low practical risk), parameterized queries are a hygiene baseline for any SQL execution.

**Fix**: Use psql's `-v` variable binding:

```bash
psql -v "migration_name=$name" -c "SELECT 1 FROM public.schema_migrations WHERE filename = :'migration_name'"
```

---

## 6. Make add-member.sh resilient to API state

**Where**: `scripts/add-member.sh` — calls `curl http://127.0.0.1:8787/api` without checking if the server is up.

**Why**: If the API isn't running, the script fails midway — the member and membership rows exist in the DB but the token mint fails, leaving a half-provisioned member.

**Fix**: Add a pre-flight check at the top of the script that hits `GET /updates` (or any lightweight endpoint) and exits with a clear message if the API isn't reachable. Alternatively, mint the token directly via `src/token-cli.ts` (which uses the DB directly) instead of going through the HTTP API.

---

## 7. Fix token-cli privilege escalation path

**Where**: `src/token-cli.ts` — tries `DATABASE_MIGRATOR_URL` first, falls back to `DATABASE_URL`.

**Why**: The migrator URL has schema-mutation privileges (CREATE TABLE, ALTER, etc.). Token operations only need INSERT/SELECT on the tokens table. If both env vars are set, token-cli silently uses the more privileged connection.

**Fix**: Reverse the preference: try `DATABASE_URL` first, fall back to `DATABASE_MIGRATOR_URL` only if the primary isn't set. Add a comment explaining why.

---

## 8. Set NODE_ENV in systemd service

**Where**: `ops/systemd/clawclub-api.service`.

**Why**: Without an explicit `NODE_ENV=production`, Node.js and npm dependencies may behave differently (e.g., verbose logging, development-only code paths, different error handling).

**Fix**: Add `Environment=NODE_ENV=production` to the `[Service]` section, before the `EnvironmentFile` line (so the env file can override if needed).

---

## 9. Consistent error shape for cold application path

**Where**: `src/app-cold-applications.ts` throws `AppError` before actor resolution; `src/app.ts` wraps errors with actor context.

**Why**: Authenticated endpoints return `{ ok: false, action, actor, error }`. Cold application errors may return `{ ok: false, error }` without the `actor` field. Clients parsing the response shape need to handle two formats.

**Fix**: In `src/app.ts`, ensure the catch block always includes a consistent error envelope. For unauthenticated paths where there is no actor, include `actor: null` explicitly rather than omitting the field.

---

## 10. Add exhaustiveness check for action dispatch

**Where**: `src/app.ts` — each `handle*Action` returns `null` for unrecognized actions, and the router falls through to a generic error.

**Why**: A typo in an action name silently falls through all handlers. There's no compile-time or runtime signal that an action string doesn't match any handler. This makes debugging harder and could mask routing bugs.

**Fix**: After all handlers have been tried, log the unmatched action name at warn level before returning the error. Optionally, maintain a `Set<string>` of all known action names (derived from the handler switch cases) and check membership before dispatch — this turns unknown actions into a fast, explicit rejection rather than a full handler chain traversal.

---

## 11. Share embedding projection types

**Where**: `src/postgres/content.ts`, `src/postgres/profile.ts`, `src/postgres/admissions.ts` — each defines its own row type for embedding projection columns.

**Why**: The same `embedding_id`, `embedding_dimensions`, `embedding_model`, `embedding_source_text` fields are repeated across multiple files. If the projection view changes, every copy must be updated.

**Fix**: Define a shared `EmbeddingProjectionRow` type in `src/app-contract.ts` and import it in each repo file. Add a shared `mapEmbeddingProjection()` helper (extending what `src/postgres/projections.ts` already does).

---

## 12. Align progress queue paths

**Where**: `automation/progress-queue.json` has hardcoded `/home/ubuntu/.openclaw/workspace/clawclub` paths; `scripts/seed-progress-queue.sh` uses `$PROJECT_ROOT`.

**Why**: If the deployment path changes or the queue is seeded in a different environment, the hardcoded paths break silently.

**Fix**: Update `seed-progress-queue.sh` to always write paths using `$PROJECT_ROOT`. Update `progress-foreman.sh` to resolve paths relative to the script's own location rather than trusting absolute paths in the queue file.

---

## Execution Order

Roughly ordered by risk reduction and independence:

1. **Guard non-null assertions** (#1) — pure safety, no schema change
2. **Token-cli privilege fix** (#7) — one-line swap, high leverage
3. **NODE_ENV in systemd** (#8) — one-line addition
4. **Parameterize migrate.sh** (#5) — small script fix
5. **Add-member.sh resilience** (#6) — small script fix
6. **Consistent error shape** (#9) — small app.ts change
7. **Action dispatch exhaustiveness** (#10) — small app.ts change
8. **Archive vs expiry semantics** (#3) — content.ts + query audit
9. **Share embedding types** (#11) — refactor, no behavior change
10. **Rate-limit cold applications** (#2) — new code in server.ts
11. **Align progress queue paths** (#12) — script + queue file
12. **Normalize DM participants** (#4) — migration + query rewrite, largest change
