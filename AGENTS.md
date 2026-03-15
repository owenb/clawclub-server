# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript runtime. `server.ts` is the HTTP entrypoint, `app-contract.ts` holds shared app/repository types, and `app.ts` routes actions into domain handlers such as `app-admissions.ts`, `app-cold-applications.ts`, `app-content.ts`, `app-messages.ts`, `app-profile.ts`, `app-system.ts`, and `app-updates.ts`. `postgres.ts` wires auth/runtime concerns, while `src/postgres/*.ts` holds repository modules by domain. Operational entrypoints include `token-cli.ts`, `http-smoke.ts`, `ai-smoke.ts`, and `ai-operator.ts`. `test/` mirrors runtime behavior with `*.test.ts` files. SQL migrations live in `db/migrations/` and use ordered numeric prefixes. Supporting material lives in `docs/`, shell automation in `scripts/`, queue state in `automation/progress-queue.json`, and deployment units in `ops/systemd/`.

## Build, Test, and Development Commands
There is no separate build step; Node 22 runs `.ts` files directly with `--experimental-strip-types`.

- `npm run api:start` starts the local API on `127.0.0.1:8787`.
- `npm run api:test` runs the full `node:test` suite in `test/`.
- `npm run api:http:smoke` boots the real server on a random local port and exercises `GET /updates`, `session.describe`, and the main read surfaces.
- `npm run db:migrate` applies SQL migrations using `DATABASE_URL`.
- `npm run db:status` shows applied versus pending migrations.
- `npm run db:health` checks migration status, runtime role safety, projection-view ownership safety, and optionally hits `session.describe`.
- `npm run db:provision:app-role` creates the least-privilege runtime Postgres role from `DATABASE_MIGRATOR_URL`.
- `npm run api:smoke` or `npm run api:operator:smoke` exercises higher-level AI flows.

## Coding Style & Naming Conventions
Follow the existing TypeScript style: ESM imports, single quotes, semicolons, and 2-space indentation. Keep modules small and explicit; prefer named helpers over hidden side effects. Use `kebab-case` for filenames, `camelCase` for functions/variables, and `PascalCase` for types. Keep SQL migrations additive and append a new numbered file instead of editing an applied migration.

## Testing Guidelines
Tests use Node’s built-in runner plus `node:assert/strict`. Add or update `test/*.test.ts` files alongside the behavior you change, and mirror the runtime surface when possible, for example `src/server.ts` -> `test/server.test.ts`. Validate both HTTP update surfaces when you touch transport behavior: polling via `GET /updates` and SSE via `GET /updates/stream`.

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects such as `Protect membership and subscription source tables` and `Add append-only entity archive flow`. Keep commits focused and descriptive. Pull requests should explain the behavior change, note any new env vars or migrations, list the commands you ran, and include sample `curl` output or logs for HTTP or operator changes.

## Security & Configuration Tips
Local setup requires PostgreSQL 14+, `psql`, Node 22+, and `DATABASE_URL` from [`.env.example`](/Users/owen/Work/ClawClub/clawclub/.env.example). Never commit real bearer tokens, production connection strings, or `.env` secrets. Use a dedicated non-superuser, non-`BYPASSRLS` app role for runtime, keep `app` projection views owned by the dedicated non-login view-owner role created by migrations, and validate migration or RLS changes with the health or smoke scripts before opening a PR.
