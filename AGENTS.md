# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript runtime. `server.ts` is the HTTP entrypoint, `app.ts` holds shared action plumbing, `app-admissions.ts` and `app-deliveries.ts` own domain action handlers, and `postgres.ts` plus `src/postgres/*.ts` implement auth and repository access. The other `*-cli.ts` files and `delivery-worker.ts` are operational entrypoints. `test/` mirrors runtime behavior with `*.test.ts` files. SQL migrations live in `db/migrations/` and use ordered numeric prefixes such as `0015_delivery_worker_tokens.sql`. Supporting material lives in `docs/`, shell automation in `scripts/`, queue state in `automation/progress-queue.json`, and deployment units in `ops/systemd/`.

## Build, Test, and Development Commands
There is no separate build step; Node 22 runs `.ts` files directly with `--experimental-strip-types`.

- `npm run api:start` starts the local API on `127.0.0.1:8787`.
- `npm run api:test` runs the full `node:test` suite in `test/`.
- `npm run db:migrate` applies SQL migrations using `DATABASE_URL`.
- `npm run db:status` shows applied versus pending migrations.
- `npm run db:health` checks migration status and optionally hits `session.describe`.
- `npm run db:provision:app-role` creates the least-privilege runtime Postgres role from `DATABASE_MIGRATOR_URL`.
- `npm run api:smoke` or `npm run api:operator:smoke` exercises higher-level flows.

## Coding Style & Naming Conventions
Follow the existing TypeScript style: ESM imports, single quotes, semicolons, and 2-space indentation. Keep modules small and explicit; prefer named helpers over hidden side effects. Use `kebab-case` for filenames, `camelCase` for variables/functions, and `PascalCase` for types. Keep SQL migrations additive and append a new numbered file instead of editing an applied migration.

## Testing Guidelines
Tests use Node’s built-in runner plus `node:assert/strict`. Add or update `test/*.test.ts` files alongside the behavior you change, and mirror the runtime surface when possible, for example `src/server.ts` -> `test/server.test.ts`. No coverage threshold is checked in, so contributors should add regression tests for API actions, repository behavior, and scripts they touch.

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects such as `Harden worker auth against stale access` and `Add Hetzner deployment runbook`. Keep commits focused and descriptive. Pull requests should explain the behavior change, note any new env vars or migrations, list the commands you ran, and include sample `curl` output or logs for API/worker changes. Screenshots are only useful when docs or assets change.

## Security & Configuration Tips
Local setup requires PostgreSQL 14+, `psql`, Node 22+, and `DATABASE_URL` from [`.env.example`](/Users/owen/Work/ClawClub/clawclub/.env.example). Never commit real bearer tokens, webhook secrets, or production connection strings. Use a dedicated non-superuser, non-`BYPASSRLS` app role for runtime, and validate migration or worker-token changes with the health or smoke scripts before opening a PR.
