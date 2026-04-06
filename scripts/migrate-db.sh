#!/usr/bin/env bash
set -euo pipefail

# Generic migration runner for a named database plane.
# Usage: ./scripts/migrate-db.sh <plane>
#   plane: identity | messaging | clubs
#
# Environment:
#   <PLANE>_DATABASE_URL or <PLANE>_MIGRATOR_URL — connection string
#   Falls back to DATABASE_MIGRATOR_URL / DATABASE_URL for backwards compat.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLANE="${1:-}"
if [[ -z "$PLANE" ]]; then
  echo "Usage: $0 <identity|messaging|clubs>" >&2
  exit 1
fi

PLANE_UPPER="$(echo "$PLANE" | tr '[:lower:]' '[:upper:]')"
MIGRATIONS_DIR="$ROOT_DIR/db/migrations/$PLANE"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Migration directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

# Resolve database URL: prefer PLANE-specific, fall back to generic
migrator_var="${PLANE_UPPER}_MIGRATOR_URL"
db_var="${PLANE_UPPER}_DATABASE_URL"
if [[ -n "${!migrator_var:-}" ]]; then
  DATABASE_URL="${!migrator_var}"
elif [[ -n "${!db_var:-}" ]]; then
  DATABASE_URL="${!db_var}"
elif [[ -n "${DATABASE_MIGRATOR_URL:-}" ]]; then
  DATABASE_URL="$DATABASE_MIGRATOR_URL"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="$DATABASE_URL"
else
  echo "Set ${migrator_var} or ${db_var} (or DATABASE_MIGRATOR_URL / DATABASE_URL)" >&2
  exit 1
fi

export DATABASE_URL

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)

if [ ${#files[@]} -eq 0 ]; then
  echo "[$PLANE] No migrations found in $MIGRATIONS_DIR"
  exit 0
fi

# Ensure schema_migrations tracking table exists
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'schema_migrations'
      and c.relkind = 'r'
  ) then
    create table public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  end if;
end
$$;
SQL

for file in "${files[@]}"; do
  name="$(basename "$file")"

  escaped_name="${name//\'/\'\'}"
  already_applied="$({
    psql "$DATABASE_URL" -X -A -t -q \
      -v ON_ERROR_STOP=1 \
      -c "select 1 from public.schema_migrations where filename = '${escaped_name}'";
  } | tr -d '[:space:]')"

  if [ "$already_applied" = "1" ]; then
    echo "[$PLANE] skip $name"
    continue
  fi

  echo "[$PLANE] apply $name"
  {
    cat "$file"
    echo "INSERT INTO public.schema_migrations (filename) VALUES ('${escaped_name}');"
  } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction
done
