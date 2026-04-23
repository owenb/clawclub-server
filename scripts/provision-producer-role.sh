#!/usr/bin/env bash
set -euo pipefail

# Bootstrap/update step for an optional producer runtime role.
#
# Creates a non-owner role for external notification producers and grants it:
#   - CONNECT on the target database
#   - USAGE on schemas public / producer_contract
#   - SELECT/EXECUTE on producer_contract objects
#
# The role intentionally does NOT own OSS schemas and does NOT get
# public-schema table DML. Producers read generic OSS producer_contract
# surfaces and publish notifications through the private HTTP transport.
#
# Requires DATABASE_URL to point at an admin/superuser connection.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_database_url)"
APP_ROLE="${CLAWCLUB_DB_APP_ROLE:-clawclub_app}"
PRODUCER_ROLE="${CLAWCLUB_DB_PRODUCER_ROLE:-clawclub_producer}"
PRODUCER_PASSWORD="${CLAWCLUB_DB_PRODUCER_PASSWORD:-}"
DATABASE_NAME="${CLAWCLUB_DB_NAME:-}"

if [[ -z "$PRODUCER_PASSWORD" ]]; then
  echo 'CLAWCLUB_DB_PRODUCER_PASSWORD must be set' >&2
  exit 1
fi

if [[ -z "$DATABASE_NAME" ]]; then
  DATABASE_NAME="$(
    psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -c 'select current_database()' \
      | tr -d '[:space:]'
  )"
fi

run_provision_sql() {
  psql "$DATABASE_URL" \
    -v ON_ERROR_STOP=1 \
    --set app_role="$APP_ROLE" \
    --set producer_role="$PRODUCER_ROLE" \
    --set producer_password="$PRODUCER_PASSWORD" \
    --set database_name="$DATABASE_NAME" <<'SQL'
select exists(select 1 from pg_roles where rolname = :'producer_role') as producer_role_exists \gset

select format(
  case
    when :'producer_role_exists' = 't' then
      'alter role %I with login password %L nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls'
    else
      'create role %I with login password %L nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls'
  end,
  :'producer_role',
  :'producer_password'
) \gexec

select format('alter role %I set statement_timeout = %L', :'producer_role', '60000') \gexec
select format('alter role %I set lock_timeout = %L', :'producer_role', '5000') \gexec
select format('alter role %I set idle_in_transaction_session_timeout = %L', :'producer_role', '30000') \gexec

select format('grant connect on database %I to %I', :'database_name', :'producer_role') \gexec
select format('grant usage on schema public to %I', :'producer_role') \gexec
select format('revoke all on all tables in schema public from %I', :'producer_role') \gexec
select format('revoke all on all sequences in schema public from %I', :'producer_role') \gexec
select case when exists (
  select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'new_id'
)
then format('grant execute on function public.new_id() to %I', :'producer_role')
end \gexec

select exists(select 1 from pg_namespace where nspname = 'producer_contract') as producer_contract_exists \gset

select case when :'producer_contract_exists' = 't'
  then format('grant usage on schema producer_contract to %I', :'producer_role')
end \gexec
select case when :'producer_contract_exists' = 't'
  then format('grant select on all tables in schema producer_contract to %I', :'producer_role')
end \gexec
select case when :'producer_contract_exists' = 't'
  then format('grant execute on all functions in schema producer_contract to %I', :'producer_role')
end \gexec
select case when :'producer_contract_exists' = 't'
  then format(
    'alter default privileges for role %I in schema producer_contract grant select on tables to %I',
    :'app_role',
    :'producer_role'
  )
end \gexec
select case when :'producer_contract_exists' = 't'
  then format(
    'alter default privileges for role %I in schema producer_contract grant execute on functions to %I',
    :'app_role',
    :'producer_role'
  )
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

printf 'Provisioned %s on database %s.\n' "$PRODUCER_ROLE" "$DATABASE_NAME"
printf 'Producer workers should connect with CLAWCLUB_PRODUCER_DATABASE_URL using %s, not clawclub_app.\n' "$PRODUCER_ROLE"
