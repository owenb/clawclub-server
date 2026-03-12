#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

  already_applied="$({
    psql "$DATABASE_URL" -X -A -t -q \
      -v ON_ERROR_STOP=1 \
      -c "select 1 from public.schema_migrations where filename = '$name'";
  } | tr -d '[:space:]')"

  if [ "$already_applied" = "1" ]; then
    echo "skip $name"
    continue
  fi

  echo "apply $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c "insert into public.schema_migrations (filename) values ('$name')"
done
