#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must be set}"
APP_URL="${CLAWCLUB_APP_URL:-http://127.0.0.1:${PORT:-8787}}"

printf '== migration status ==\n'
./scripts/migration-status.sh

printf '\n== database role safety ==\n'
role_safety="$(
  psql "$DATABASE_URL" -X -A -F '|' -t -q \
    -v ON_ERROR_STOP=1 \
    -c "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user" 2>/dev/null || true
)"
role_safety="$(printf '%s' "$role_safety" | tr -d '\r' | head -n 1)"
IFS='|' read -r db_role db_superuser db_bypassrls <<<"$role_safety"

if [[ -z "${db_role:-}" || -z "${db_superuser:-}" || -z "${db_bypassrls:-}" ]]; then
  echo 'unknown (could not parse role safety check)'
elif [[ "$db_superuser" = "t" || "$db_bypassrls" = "t" ]]; then
  echo "unsafe: role=$db_role superuser=$db_superuser bypassrls=$db_bypassrls"
else
  echo "ok: role=$db_role superuser=$db_superuser bypassrls=$db_bypassrls"
fi

if [[ -n "${CLAWCLUB_WORKER_BEARER_TOKEN:-}" ]]; then
  printf '\n== worker token env ==\n'
  echo 'present'
else
  printf '\n== worker token env ==\n'
  echo 'missing CLAWCLUB_WORKER_BEARER_TOKEN'
fi

if [[ -n "${CLAWCLUB_HEALTH_TOKEN:-}" ]]; then
  printf '\n== api session.describe ==\n'
  curl -fsS "$APP_URL/api" \
    -H "Authorization: Bearer $CLAWCLUB_HEALTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"action":"session.describe","input":{}}' >/tmp/clawclub-health.json
  cat /tmp/clawclub-health.json
  rm -f /tmp/clawclub-health.json
else
  printf '\n== api session.describe ==\n'
  echo 'skipped (set CLAWCLUB_HEALTH_TOKEN to enable)'
fi
