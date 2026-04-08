#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

APP_URL="${CLAWCLUB_APP_URL:-http://127.0.0.1:${PORT:-8787}}"
healthcheck_failed=0

# ── Database connectivity ──────────────────────────────────

url="${DATABASE_URL:-}"
if [[ -z "$url" ]]; then
  printf "== database ==\nSKIP: DATABASE_URL not set\n\n"
else
  printf "== database ==\n"

  # Check connectivity
  if ! psql "$url" -X -A -t -q -c "select 1" >/dev/null 2>&1; then
    echo "FAIL: cannot connect"
    healthcheck_failed=1
    printf '\n'
  else
    # Check role is not superuser
    role_info="$(psql "$url" -X -A -F '|' -t -q -c "select current_user, rolsuper from pg_roles where rolname = current_user" 2>/dev/null || true)"
    IFS='|' read -r db_role db_superuser <<<"$role_info"
    if [[ "${db_superuser:-}" = "t" ]]; then
      echo "WARNING: connected as superuser ($db_role)"
    else
      echo "ok: role=$db_role superuser=false"
    fi

    # Check migration status
    migration_count="$(psql "$url" -X -A -t -q -c "select count(*)::text from public.schema_migrations" 2>/dev/null || echo "0")"
    latest_migration="$(psql "$url" -X -A -t -q -c "select max(filename) from public.schema_migrations" 2>/dev/null || echo "none")"
    echo "migrations: $migration_count applied, latest: $latest_migration"

    # Check table count
    table_count="$(psql "$url" -X -A -t -q -c "select count(*)::text from information_schema.tables where table_schema = 'app'" 2>/dev/null || echo "0")"
    echo "tables: $table_count in app schema"

    printf '\n'
  fi
fi

# ── API health ──────────────────────────────────────────────

if [[ -n "${CLAWCLUB_HEALTH_TOKEN:-}" ]]; then
  printf '== api session.getContext ==\n'
  if curl -fsS "$APP_URL/api" \
    -H "Authorization: Bearer $CLAWCLUB_HEALTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"action":"session.getContext","input":{}}' 2>/dev/null | head -c 500; then
    echo
  else
    echo "FAIL: API health check failed"
    healthcheck_failed=1
  fi
else
  printf '== api session.getContext ==\nskipped (set CLAWCLUB_HEALTH_TOKEN to enable)\n'
fi

exit "$healthcheck_failed"
