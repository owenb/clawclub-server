#!/usr/bin/env bash
set -euo pipefail

# Create the three ClawClub databases from scratch, run migrations, and
# provision the app role on each.
#
# This is a ONE-TIME setup script for a fresh Postgres instance (e.g. Railway).
# It will refuse to run if any of the target databases already exist.
#
# Requires:
#   POSTGRES_URL — superuser connection to the *postgres* database (for CREATE DATABASE)
#   CLAWCLUB_DB_APP_PASSWORD — password for the clawclub_app runtime role
#
# Example (Railway):
#   POSTGRES_URL="postgresql://postgres:xxx@host:port/postgres" \
#   CLAWCLUB_DB_APP_PASSWORD="xxx" \
#     ./scripts/init-databases.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${POSTGRES_URL:?POSTGRES_URL must be set (superuser connection to the postgres database)}"
: "${CLAWCLUB_DB_APP_PASSWORD:?CLAWCLUB_DB_APP_PASSWORD must be set}"

IDENTITY_DB="clawclub_identity"
MESSAGING_DB="clawclub_messaging"
CLUBS_DB="clawclub_clubs"

# Build per-database URLs by replacing the database name in POSTGRES_URL.
# Handles both postgresql://.../<dbname> and postgresql://.../<dbname>?params.
make_url() {
  local db="$1"
  # Replace the database name (last path segment) in the URL
  echo "$POSTGRES_URL" | sed -E "s#/[^/?]+(\$|\?)#/${db}\1#"
}

IDENTITY_URL="$(make_url "$IDENTITY_DB")"
MESSAGING_URL="$(make_url "$MESSAGING_DB")"
CLUBS_URL="$(make_url "$CLUBS_DB")"

echo "=== Creating databases ==="
for db in "$IDENTITY_DB" "$MESSAGING_DB" "$CLUBS_DB"; do
  exists="$(psql "$POSTGRES_URL" -X -A -t -q -c \
    "SELECT 1 FROM pg_database WHERE datname = '${db}'" | tr -d '[:space:]')"

  if [[ "$exists" == "1" ]]; then
    echo "ERROR: database $db already exists. Drop it first if you want to start fresh." >&2
    exit 1
  fi

  psql "$POSTGRES_URL" -c "CREATE DATABASE ${db};"
  echo "  created $db"
done

echo ""
echo "=== Running migrations ==="
IDENTITY_DATABASE_URL="$IDENTITY_URL" \
  "$ROOT_DIR/scripts/migrate-db.sh" identity

MESSAGING_DATABASE_URL="$MESSAGING_URL" \
  "$ROOT_DIR/scripts/migrate-db.sh" messaging

CLUBS_DATABASE_URL="$CLUBS_URL" \
  "$ROOT_DIR/scripts/migrate-db.sh" clubs

echo ""
echo "=== Provisioning app role ==="
for url in "$IDENTITY_URL" "$MESSAGING_URL" "$CLUBS_URL"; do
  CLAWCLUB_DB_APP_PASSWORD="$CLAWCLUB_DB_APP_PASSWORD" \
    DATABASE_URL="$url" \
    "$ROOT_DIR/scripts/provision-app-role.sh"
done

echo ""
echo "=== Done ==="
echo ""
echo "Set these environment variables in Railway:"
echo "  IDENTITY_DATABASE_URL  = $(make_url "$IDENTITY_DB" | sed -E "s|://[^:]+:[^@]+@|://clawclub_app:${CLAWCLUB_DB_APP_PASSWORD}@|")"
echo "  MESSAGING_DATABASE_URL = $(make_url "$MESSAGING_DB" | sed -E "s|://[^:]+:[^@]+@|://clawclub_app:${CLAWCLUB_DB_APP_PASSWORD}@|")"
echo "  CLUBS_DATABASE_URL     = $(make_url "$CLUBS_DB" | sed -E "s|://[^:]+:[^@]+@|://clawclub_app:${CLAWCLUB_DB_APP_PASSWORD}@|")"
echo ""
echo "Then redeploy. After the server is up, run bootstrap to create your first member + club."
