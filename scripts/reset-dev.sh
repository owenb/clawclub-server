#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB_NAME="clawclub_dev"
APP_ROLE="clawclub_app"
APP_PASSWORD="localdev"

echo "=== Dropping and recreating database ==="
psql -h localhost -d postgres \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;"

echo "=== Provisioning app role ==="
CLAWCLUB_DB_APP_PASSWORD="$APP_PASSWORD" \
  DATABASE_URL="postgresql://localhost/$DB_NAME" \
  "$ROOT_DIR/scripts/provision-app-role.sh" 2>&1 | tail -1

echo "=== Applying schema ==="
psql -h localhost -d "$DB_NAME" -v ON_ERROR_STOP=1 --single-transaction \
  -f "$ROOT_DIR/db/init.sql" 2>&1 | tail -3

echo "=== Running migrations ==="
DATABASE_URL="postgresql://$APP_ROLE:$APP_PASSWORD@localhost/$DB_NAME" \
  "$ROOT_DIR/scripts/migrate.sh"

echo "=== Seeding database ==="
psql -h localhost -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/db/seeds/dev.sql" 2>&1 | tail -1

echo "=== Creating tokens ==="
ACTIVE_MEMBERS=(
  "Morgan Keeper"
  "Alice Hound"
  "Bob Whiskers"
  "Charlie Paws"
  "Diana Feathers"
  "Eddie Scales"
  "Fiona Hooves"
  "George Wings"
  "Hannah Fins"
  "Ivan Tusks"
  "Julia Stripes"
  "Kevin Spots"
)

for name in "${ACTIVE_MEMBERS[@]}"; do
  tok=$(DATABASE_URL="postgresql://localhost/$DB_NAME" \
    node --experimental-strip-types "$ROOT_DIR/src/token-cli.ts" create \
    --name "$name" --label localdev 2>&1 \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['bearerToken'])")
  echo "$name: $tok"
done

echo ""
echo "=== Done ==="
echo ""
echo "Database: $DB_NAME"
echo ""
echo "Members (12 active + 1 suspended):"
echo "  Morgan Keeper   — Owner/superadmin of all clubs"
echo "  Alice Hound     — DogClub, CatClub"
echo "  Bob Whiskers    — CatClub, FoxClub"
echo "  Charlie Paws    — DogClub, FoxClub"
echo "  Diana Feathers  — DogClub, CatClub (admin), FoxClub"
echo "  Eddie Scales    — DogClub (active), CatClub (cancelled)"
echo "  Fiona Hooves    — FoxClub (active), DogClub application (revision required)"
echo "  George Wings    — CatClub (active), FoxClub (removed)"
echo "  Hannah Fins     — DogClub application (awaiting review)"
echo "  Ivan Tusks      — DogClub, FoxClub"
echo "  Julia Stripes   — CatClub (active), DogClub application (awaiting review)"
echo "  Kevin Spots     — DogClub (recently admitted)"
echo "  Sam Shadow      — SUSPENDED (DogClub removed, CatClub removed)"
echo ""
echo "Start the server with:"
echo "  DATABASE_URL=\"postgresql://clawclub_app:localdev@localhost/$DB_NAME\" npm run api:start"
