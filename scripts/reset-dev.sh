#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IDENTITY_DB="clawclub_identity_dev"
MESSAGING_DB="clawclub_messaging_dev"
CLUBS_DB="clawclub_clubs_dev"
APP_PASSWORD="localdev"

echo "=== Dropping and recreating databases ==="
psql -h localhost -d postgres \
  -c "DROP DATABASE IF EXISTS $IDENTITY_DB;" \
  -c "CREATE DATABASE $IDENTITY_DB;" \
  -c "DROP DATABASE IF EXISTS $MESSAGING_DB;" \
  -c "CREATE DATABASE $MESSAGING_DB;" \
  -c "DROP DATABASE IF EXISTS $CLUBS_DB;" \
  -c "CREATE DATABASE $CLUBS_DB;"

echo "=== Running migrations ==="
IDENTITY_DATABASE_URL="postgresql://localhost/$IDENTITY_DB" \
  "$ROOT_DIR/scripts/migrate-db.sh" identity 2>&1 | tail -3

MESSAGING_DATABASE_URL="postgresql://localhost/$MESSAGING_DB" \
  "$ROOT_DIR/scripts/migrate-db.sh" messaging 2>&1 | tail -3

CLUBS_DATABASE_URL="postgresql://localhost/$CLUBS_DB" \
  "$ROOT_DIR/scripts/migrate-db.sh" clubs 2>&1 | tail -3

echo "=== Provisioning app role ==="
CLAWCLUB_DB_APP_PASSWORD="$APP_PASSWORD" \
  DATABASE_URL="postgresql://localhost/$IDENTITY_DB" \
  "$ROOT_DIR/scripts/provision-app-role.sh" 2>&1 | tail -1

CLAWCLUB_DB_APP_PASSWORD="$APP_PASSWORD" \
  DATABASE_URL="postgresql://localhost/$MESSAGING_DB" \
  "$ROOT_DIR/scripts/provision-app-role.sh" 2>&1 | tail -1

CLAWCLUB_DB_APP_PASSWORD="$APP_PASSWORD" \
  DATABASE_URL="postgresql://localhost/$CLUBS_DB" \
  "$ROOT_DIR/scripts/provision-app-role.sh" 2>&1 | tail -1

echo "=== Seeding identity database ==="
psql -h localhost -d "$IDENTITY_DB" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/db/seeds/dev-identity.sql" 2>&1 | tail -1

echo "=== Extracting IDs for cross-database seeding ==="
PSQL_VARS=()
while IFS='=' read -r name value; do
  [[ -n "$name" ]] && PSQL_VARS+=(-v "${name}=${value}")
done < <(psql -h localhost -d "$IDENTITY_DB" -X -A -t -q <<'SQL'
-- Member IDs
select 'member_' || replace(handle, '-', '_') || '=' || id from app.members order by handle;
-- Club IDs
select 'club_' || replace(slug, '-', '_') || '=' || id from app.clubs order by slug;
-- Membership IDs
select 'mid_' || replace(m.handle, '-', '_') || '_' || replace(c.slug, '-', '_') || '=' || cm.id
from app.club_memberships cm
join app.members m on m.id = cm.member_id
join app.clubs c on c.id = cm.club_id
order by m.handle, c.slug;
SQL
)

echo "  Extracted ${#PSQL_VARS[@]} cross-database references"

echo "=== Seeding clubs database ==="
psql -h localhost -d "$CLUBS_DB" -v ON_ERROR_STOP=1 \
  "${PSQL_VARS[@]}" \
  -f "$ROOT_DIR/db/seeds/dev-clubs.sql" 2>&1 | tail -1

echo "=== Seeding messaging database ==="
psql -h localhost -d "$MESSAGING_DB" -v ON_ERROR_STOP=1 \
  "${PSQL_VARS[@]}" \
  -f "$ROOT_DIR/db/seeds/dev-messaging.sql" 2>&1 | tail -1

echo "=== Creating tokens ==="
ACTIVE_MEMBERS=(
  owen-barnes
  alice-hound
  bob-whiskers
  charlie-paws
  diana-feathers
  eddie-scales
  fiona-hooves
  george-wings
  hannah-fins
  ivan-tusks
  julia-stripes
  kevin-spots
)

for handle in "${ACTIVE_MEMBERS[@]}"; do
  tok=$(IDENTITY_DATABASE_URL="postgresql://localhost/$IDENTITY_DB" \
    node --experimental-strip-types "$ROOT_DIR/src/token-cli.ts" create \
    --handle "$handle" --label localdev 2>&1 \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['bearerToken'])")
  echo "$handle: $tok"
done

echo ""
echo "=== Done ==="
echo ""
echo "Databases created:"
echo "  Identity:  $IDENTITY_DB"
echo "  Messaging: $MESSAGING_DB"
echo "  Clubs:     $CLUBS_DB"
echo ""
echo "Members (12 active + 1 suspended):"
echo "  owen-barnes     — Owner/superadmin of all clubs"
echo "  alice-hound     — DogClub, CatClub"
echo "  bob-whiskers    — CatClub, FoxClub"
echo "  charlie-paws    — DogClub, FoxClub"
echo "  diana-feathers  — DogClub, CatClub (admin), FoxClub"
echo "  eddie-scales    — DogClub (active), CatClub (paused)"
echo "  fiona-hooves    — FoxClub (active), DogClub (invited)"
echo "  george-wings    — CatClub (active), FoxClub (removed)"
echo "  hannah-fins     — DogClub (pending review)"
echo "  ivan-tusks      — DogClub, FoxClub"
echo "  julia-stripes   — CatClub"
echo "  kevin-spots     — DogClub (recently admitted)"
echo "  sam-shadow      — SUSPENDED (DogClub revoked, CatClub revoked)"
echo ""
echo "Seed data includes:"
echo "  - 28 entities (posts, opportunities, services, asks, events, comments, complaints, drafts)"
echo "  - 18 event RSVPs across 5 events"
echo "  - 15 vouches across all clubs"
echo "  - 6 admissions (cold, warm, nominated) in various states"
echo "  - 8 DM threads with 28 messages (some unread, 1 removed)"
echo ""
echo "Start the server with:"
echo "  IDENTITY_DATABASE_URL=\"postgresql://clawclub_app:localdev@localhost/$IDENTITY_DB\" \\"
echo "  MESSAGING_DATABASE_URL=\"postgresql://clawclub_app:localdev@localhost/$MESSAGING_DB\" \\"
echo "  CLUBS_DATABASE_URL=\"postgresql://clawclub_app:localdev@localhost/$CLUBS_DB\" \\"
echo "  npm run api:start"
