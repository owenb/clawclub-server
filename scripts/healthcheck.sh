#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must be set}"
APP_URL="${CLAWCLUB_APP_URL:-http://127.0.0.1:${PORT:-8787}}"

printf '== migration status ==\n'
./scripts/migration-status.sh

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
