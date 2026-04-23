#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_database_url)"
MIGRATIONS_DIR="$ROOT_DIR/db/migrations"

table_exists="$(
  psql "$DATABASE_URL" -X -A -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'schema_migrations' and c.relkind = 'r'" \
  | tr -d '[:space:]'
)"

if [ "$table_exists" != "1" ]; then
  echo "ERROR: public.schema_migrations does not exist. Run scripts/migrate.sh to bootstrap." >&2
  exit 1
fi

printf '%-40s %s\n' "MIGRATION" "STATUS"
printf '%-40s %s\n' "---------" "------"

PENDING_COUNT=0

shopt -s nullglob
for file in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$file")"
  applied="$({
    psql "$DATABASE_URL" -X -A -t -q \
      -v ON_ERROR_STOP=1 \
      -v migration_name="$name" \
      -c "select applied_at::text from public.schema_migrations where filename = :'migration_name'";
  } | tr -d '\r')"

  if [ -n "$applied" ]; then
    printf '%-40s applied %s\n' "$name" "$applied"
  else
    printf '%-40s pending\n' "$name"
    PENDING_COUNT=$((PENDING_COUNT + 1))
  fi
done

if [ "$PENDING_COUNT" -gt 0 ]; then
  echo ""
  echo "ERROR: $PENDING_COUNT pending migration(s)"
  exit 1
fi
