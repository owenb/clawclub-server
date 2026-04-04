#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

source "./scripts/lib/database-urls.sh"

DATABASE_URL="$(require_runtime_database_url)"
MIGRATOR_DATABASE_URL="$(require_migrator_database_url)"
APP_URL="${CLAWCLUB_APP_URL:-http://127.0.0.1:${PORT:-8787}}"
STRICT_SAFE_DB_ROLE="${CLAWCLUB_REQUIRE_SAFE_DB_ROLE:-1}"
healthcheck_failed=0

printf '== migration status ==\n'
if [[ "${DATABASE_MIGRATOR_URL:-}" != "" ]]; then
  echo 'using DATABASE_MIGRATOR_URL'
fi
if ! DATABASE_MIGRATOR_URL="$MIGRATOR_DATABASE_URL" DATABASE_URL="$DATABASE_URL" ./scripts/migration-status.sh; then
  healthcheck_failed=1
fi

printf '\n== database role safety ==\n'
role_safety="$(
  psql "$DATABASE_URL" -X -A -F '|' -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user" 2>/dev/null || true
)"
role_safety="$(printf '%s' "$role_safety" | tr -d '\r' | head -n 1)"
IFS='|' read -r db_role db_superuser db_bypassrls <<<"$role_safety"

if [[ -z "${db_role:-}" || -z "${db_superuser:-}" || -z "${db_bypassrls:-}" ]]; then
  echo 'FAIL: could not parse role safety check'
  healthcheck_failed=1
elif [[ "$db_superuser" = "t" || "$db_bypassrls" = "t" ]]; then
  echo "unsafe: role=$db_role superuser=$db_superuser bypassrls=$db_bypassrls"
  if [[ "$STRICT_SAFE_DB_ROLE" = "1" ]]; then
    healthcheck_failed=1
  fi
else
  echo "ok: role=$db_role superuser=$db_superuser bypassrls=$db_bypassrls"
fi

printf '\n== projection view ownership ==\n'
view_owner_safety="$(
  psql "$DATABASE_URL" -X -A -F '|' -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select count(*)::text, coalesce(string_agg(c.relname || ':' || r.rolname, ', ' order by c.relname), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'app' and c.relkind = 'v' and (r.rolsuper or r.rolbypassrls)" 2>/dev/null || true
)"
view_owner_safety="$(printf '%s' "$view_owner_safety" | tr -d '\r' | head -n 1)"
IFS='|' read -r unsafe_view_count unsafe_view_names <<<"$view_owner_safety"

if [[ -z "${unsafe_view_count:-}" ]]; then
  echo 'FAIL: could not parse projection view ownership check'
  healthcheck_failed=1
elif [[ "$unsafe_view_count" != "0" ]]; then
  echo "unsafe: $unsafe_view_count app views owned by superuser or BYPASSRLS role"
  if [[ -n "${unsafe_view_names:-}" ]]; then
    echo "$unsafe_view_names"
  fi
  healthcheck_failed=1
else
  echo 'ok: all app views owned by non-superuser, non-BYPASSRLS roles'
fi

printf '\n== security definer ownership ==\n'
function_owner_safety="$(
  psql "$DATABASE_URL" -X -A -F '|' -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select count(*)::text, coalesce(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || r.rolname, ', ' order by p.proname, pg_get_function_identity_arguments(p.oid)), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner where n.nspname = 'app' and p.prosecdef and (r.rolsuper or r.rolbypassrls)" 2>/dev/null || true
)"
function_owner_safety="$(printf '%s' "$function_owner_safety" | tr -d '\r' | head -n 1)"
IFS='|' read -r unsafe_function_count unsafe_function_names <<<"$function_owner_safety"

if [[ -z "${unsafe_function_count:-}" ]]; then
  echo 'FAIL: could not parse security definer ownership check'
  healthcheck_failed=1
elif [[ "$unsafe_function_count" != "0" ]]; then
  echo "unsafe: $unsafe_function_count app security definer functions owned by superuser or BYPASSRLS role"
  if [[ -n "${unsafe_function_names:-}" ]]; then
    echo "$unsafe_function_names"
  fi
  healthcheck_failed=1
else
  echo 'ok: all app security definer functions owned by non-superuser, non-BYPASSRLS roles'
fi

printf '\n== table RLS coverage ==\n'
rls_coverage="$(
  psql "$DATABASE_URL" -X -A -F '|' -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select count(*)::text, coalesce(string_agg(c.relname || ':rls=' || case when c.relrowsecurity then 't' else 'f' end || ',force=' || case when c.relforcerowsecurity then 't' else 'f' end, ', ' order by c.relname), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind in ('r', 'p') and (not c.relrowsecurity or not c.relforcerowsecurity)" 2>/dev/null || true
)"
rls_coverage="$(printf '%s' "$rls_coverage" | tr -d '\r' | head -n 1)"
IFS='|' read -r unsafe_table_count unsafe_table_names <<<"$rls_coverage"

if [[ -z "${unsafe_table_count:-}" ]]; then
  echo 'FAIL: could not parse table RLS coverage check'
  healthcheck_failed=1
elif [[ "$unsafe_table_count" != "0" ]]; then
  echo "unsafe: $unsafe_table_count app tables are missing RLS or FORCE RLS"
  if [[ -n "${unsafe_table_names:-}" ]]; then
    echo "$unsafe_table_names"
  fi
  healthcheck_failed=1
else
  echo 'ok: all app tables enforce RLS and FORCE RLS'
fi

if [[ -n "${CLAWCLUB_HEALTH_TOKEN:-}" ]]; then
  printf '\n== api session.describe ==\n'
  api_response_file="$(mktemp)"
  trap 'rm -f "${api_response_file:-}"' EXIT
  curl -fsS "$APP_URL/api" \
    -H "Authorization: Bearer $CLAWCLUB_HEALTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"action":"session.describe","input":{}}' >"$api_response_file"
  cat "$api_response_file"
  rm -f "$api_response_file"
  api_response_file=""
else
  printf '\n== api session.describe ==\n'
  echo 'skipped (set CLAWCLUB_HEALTH_TOKEN to enable)'
fi

exit "$healthcheck_failed"
