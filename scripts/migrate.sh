#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_database_url)"

MIGRATION_DIRS=("$ROOT_DIR/db/migrations")

shopt -s nullglob
files=()
migration_entries=()
for migration_dir in "${MIGRATION_DIRS[@]}"; do
  for file in "$migration_dir"/*.sql; do
    files+=("$file")
    migration_entries+=("$(basename "$file")"$'\t'"$file")
  done
done

if [ ${#files[@]} -eq 0 ]; then
  echo "No migrations found in: ${MIGRATION_DIRS[*]}"
  exit 0
fi

duplicate_names="$(
  printf '%s\n' "${migration_entries[@]}" \
    | cut -f1 \
    | sort \
    | uniq -d
)"
if [[ -n "$duplicate_names" ]]; then
  echo "Duplicate migration filename detected:" >&2
  printf '%s\n' "$duplicate_names" >&2
  exit 1
fi

sorted_entries=()
while IFS= read -r line; do
  sorted_entries+=("$line")
done < <(printf '%s\n' "${migration_entries[@]}" | sort -t $'\t' -k1,1)
migration_entries=("${sorted_entries[@]}")

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

for entry in "${migration_entries[@]}"; do
  name="${entry%%$'\t'*}"
  file="${entry#*$'\t'}"

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
