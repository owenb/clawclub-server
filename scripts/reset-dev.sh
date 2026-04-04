#!/usr/bin/env bash
set -euo pipefail

echo "=== Resetting clawclub_dev ==="
psql -h localhost -d postgres -c "DROP DATABASE IF EXISTS clawclub_dev;" -c "CREATE DATABASE clawclub_dev;"

echo "=== Running migrations ==="
DATABASE_URL="postgresql://localhost/clawclub_dev" ./scripts/migrate.sh 2>&1 | tail -1

echo "=== Provisioning app role ==="
CLAWCLUB_DB_APP_PASSWORD="localdev" DATABASE_URL="postgresql://localhost/clawclub_dev" ./scripts/provision-app-role.sh 2>&1 | tail -1

echo "=== Seeding dev clubs ==="
psql -h localhost -d clawclub_dev -f db/seeds/dev-clubs.sql 2>&1 | tail -1

echo "=== Creating tokens ==="
for handle in owen-barnes alice-hound bob-whiskers charlie-paws; do
  tok=$(DATABASE_URL="postgresql://localhost/clawclub_dev" node --experimental-strip-types src/token-cli.ts create --handle "$handle" --label localdev 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['bearerToken'])")
  echo "$handle: $tok"
done

echo ""
echo "=== Done. Start the server with: ==="
echo "  source .env.local && DATABASE_URL=\"postgresql://clawclub_app:localdev@localhost/clawclub_dev\" npm run api:start"
