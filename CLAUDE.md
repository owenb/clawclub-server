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
