#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_MIGRATOR_URL="$(require_migrator_database_url)"
APP_ROLE="${CLAWCLUB_DB_APP_ROLE:-clawclub_app}"
APP_PASSWORD="${CLAWCLUB_DB_APP_PASSWORD:-}"
SCHEMA_NAME="${CLAWCLUB_DB_SCHEMA:-app}"
DATABASE_NAME="${CLAWCLUB_DB_NAME:-}"

if [[ -z "$APP_PASSWORD" ]]; then
  echo 'CLAWCLUB_DB_APP_PASSWORD must be set' >&2
  exit 1
fi

if [[ -z "$DATABASE_NAME" ]]; then
  DATABASE_NAME="$(
    psql "$DATABASE_MIGRATOR_URL" -X -A -t -q -v ON_ERROR_STOP=1 -c 'select current_database()' \
      | tr -d '[:space:]'
  )"
fi

run_provision_sql() {
  psql "$DATABASE_MIGRATOR_URL" \
    -v ON_ERROR_STOP=1 \
    --set app_role="$APP_ROLE" \
    --set app_password="$APP_PASSWORD" \
    --set database_name="$DATABASE_NAME" \
    --set schema_name="$SCHEMA_NAME" <<'SQL'
select exists(select 1 from pg_roles where rolname = :'app_role') as app_role_exists \gset

select format(
  case
    when :'app_role_exists' = 't' then
      'alter role %I with login password %L nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls'
    else
      'create role %I with login password %L nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls'
  end,
  :'app_role',
  :'app_password'
) \gexec

select format('grant connect on database %I to %I', :'database_name', :'app_role') \gexec
select format('grant usage on schema %I to %I', :'schema_name', :'app_role') \gexec
select format('grant select, insert, update, delete on all tables in schema %I to %I', :'schema_name', :'app_role') \gexec
select format('grant usage, select on all sequences in schema %I to %I', :'schema_name', :'app_role') \gexec
select format('grant execute on all functions in schema %I to %I', :'schema_name', :'app_role') \gexec
select format('alter default privileges in schema %I grant select, insert, update, delete on tables to %I', :'schema_name', :'app_role') \gexec
select format('alter default privileges in schema %I grant usage, select on sequences to %I', :'schema_name', :'app_role') \gexec
select format('alter default privileges in schema %I grant execute on functions to %I', :'schema_name', :'app_role') \gexec

select exists (
  select 1
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'schema_migrations'
    and c.relkind = 'r'
) as schema_migrations_exists \gset

select case
  when :'schema_migrations_exists' = 't' then format('grant select on table public.schema_migrations to %I', :'app_role')
end \gexec
SQL
}

attempt=1
while true; do
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  if run_provision_sql >"$stdout_file" 2>"$stderr_file"; then
    cat "$stdout_file"
    rm -f "$stdout_file" "$stderr_file"
    break
  fi

  status=$?
  stderr_contents="$(cat "$stderr_file")"
  stdout_contents="$(cat "$stdout_file")"
  rm -f "$stdout_file" "$stderr_file"

  if [[ $status -eq 3 && "$stderr_contents" == *"tuple concurrently updated"* && $attempt -lt 3 ]]; then
    attempt=$((attempt + 1))
    sleep 0.2
    continue
  fi

  if [[ -n "$stdout_contents" ]]; then
    printf '%s\n' "$stdout_contents"
  fi
  printf '%s\n' "$stderr_contents" >&2
  exit "$status"
done

printf 'Provisioned runtime Postgres role %s on database %s.\n' "$APP_ROLE" "$DATABASE_NAME"
printf 'Use DATABASE_URL for this runtime role and reserve DATABASE_MIGRATOR_URL for migrations, seeds, and bootstrap work.\n'
