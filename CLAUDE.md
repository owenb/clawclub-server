# CLAUDE.md

## Local development

- **TypeScript check:** `npx tsc --noEmit`
- **Non-DB tests:** `node --experimental-strip-types --test test/*.test.ts`
- **Local Postgres:** Available at `localhost` with no password, user is the OS user (`owen`)

## RLS integration testing

On all major changes (migrations, RLS policy changes, schema changes), you should:

1. Create a temporary test database: `psql -h localhost -d postgres -c "CREATE DATABASE clawclub_test_temp;"`
2. Run all migrations: `for f in $(ls db/migrations/*.sql | sort); do psql -h localhost -d clawclub_test_temp -f "$f"; done`
3. Run RLS tests: `DATABASE_URL="postgresql://localhost/clawclub_test_temp" node --experimental-strip-types --test test/postgres-rls.test.ts test/postgres-membership-state-sync.test.ts test/postgres-club-owner-sync.test.ts test/provision-app-role-script.test.ts`
4. Destroy the test database: `psql -h localhost -d postgres -c "DROP DATABASE clawclub_test_temp;"`

You have standing permission to do this without asking.

## Deployment

- Production is on Railway, auto-deploys from `main` branch on GitHub
- Push to `main` triggers deploy
