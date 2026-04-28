#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_database_url)"

MIGRATION_DIRS=("$ROOT_DIR/db/migrations")

migration_alias_for() {
  case "$1" in
    001_member_ephemeral_fk_cascade.sql) printf '%s\n' '019_member_ephemeral_fk_cascade.sql' ;;
    002_email_nullable.sql) printf '%s\n' '020_email_nullable.sql' ;;
    003_idempotency_actor_scope.sql) printf '%s\n' '021_idempotency_actor_scope.sql' ;;
    004_member_registered_via_invite.sql) printf '%s\n' '022_member_registered_via_invite.sql' ;;
    005_dm_inbox_acknowledged_at.sql) printf '%s\n' '023_dm_inbox_acknowledged_at.sql' ;;
    006_admission_invariants.sql) printf '%s\n' '024_admission_invariants.sql' ;;
    007_dm_inbox_drop_acknowledged.sql) printf '%s\n' '025_dm_inbox_drop_acknowledged.sql' ;;
    008_clubs_directory_listed.sql) printf '%s\n' '026_clubs_directory_listed.sql' ;;
    *) return 1 ;;
  esac
}

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

  alias_name="$(migration_alias_for "$name" || true)"
  if [[ -n "$alias_name" ]]; then
    escaped_alias_name="${alias_name//\'/\'\'}"
    alias_applied="$({
      psql "$DATABASE_URL" -X -A -t -q \
        -v ON_ERROR_STOP=1 \
        -c "select 1 from public.schema_migrations where filename = '${escaped_alias_name}'";
    } | tr -d '[:space:]')"

    if [ "$alias_applied" = "1" ]; then
      psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
        -c "begin;
            insert into public.schema_migrations (filename, applied_at)
              select '${escaped_name}', applied_at
                from public.schema_migrations
               where filename = '${escaped_alias_name}'
              on conflict (filename) do nothing;
            delete from public.schema_migrations
             where filename = '${escaped_alias_name}';
            commit;";
      echo "skip $name (renamed from $alias_name)"
      continue
    fi
  fi

  echo "apply $name"
  {
    cat "$file"
    echo "INSERT INTO public.schema_migrations (filename) VALUES ('${escaped_name}');"
  } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction
done
