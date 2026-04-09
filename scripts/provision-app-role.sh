#!/usr/bin/env bash
set -euo pipefail

# Bootstrap step (one-time per database).
#
# Creates the clawclub_app role and grants it the privileges it needs to
# both run the app AND manage the schema (CREATE on schema public, plus
# CONNECT on the database). After this script runs, db/init.sql will
# create all schema objects under clawclub_app's ownership via SET
# SESSION AUTHORIZATION, so clawclub_app can ALTER/DROP them in
# subsequent migrations.
#
# Requires DATABASE_URL to point at an admin/superuser connection — only
# a superuser can CREATE ROLE. After bootstrap, day-to-day deploys use
# DATABASE_URL pointing at clawclub_app itself.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_database_url)"
APP_ROLE="${CLAWCLUB_DB_APP_ROLE:-clawclub_app}"
APP_PASSWORD="${CLAWCLUB_DB_APP_PASSWORD:-}"
DATABASE_NAME="${CLAWCLUB_DB_NAME:-}"

if [[ -z "$APP_PASSWORD" ]]; then
  echo 'CLAWCLUB_DB_APP_PASSWORD must be set' >&2
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
    --set app_password="$APP_PASSWORD" \
    --set database_name="$DATABASE_NAME" <<'SQL'
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
select format('grant usage, create on schema public to %I', :'app_role') \gexec
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

printf 'Provisioned %s on database %s.\n' "$APP_ROLE" "$DATABASE_NAME"
printf 'Now run db/init.sql with the same admin DATABASE_URL — it will create the schema under %s ownership.\n' "$APP_ROLE"
