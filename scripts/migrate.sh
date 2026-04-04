#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_migrator_database_url)"
MIGRATIONS_DIR="$ROOT_DIR/db/migrations"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)

if [ ${#files[@]} -eq 0 ]; then
  echo "No migrations found in $MIGRATIONS_DIR"
  exit 0
fi

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
    echo "skip $name"
    continue
  fi

  echo "apply $name"
  {
    cat "$file"
    echo "INSERT INTO public.schema_migrations (filename) VALUES ('${escaped_name}');"
  } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction
done
