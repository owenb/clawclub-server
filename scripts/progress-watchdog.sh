#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT="${ROOT:-$(cd "$PROJECT_ROOT/.." && pwd)}"
OUT="${OUT:-$ROOT/memory/progress-watchdog.log}"
CHAT_ID="${CHAT_ID:-16535088}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
FOREMAN_SCRIPT="${FOREMAN_SCRIPT:-$PROJECT_ROOT/scripts/progress-foreman.sh}"
NOW="$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
COMMITS="$(git -C "$PROJECT_ROOT" log --oneline --decorate -3 | sed 's/^/  - /')"
TEST_STATUS="PASS"
TEST_SNIPPET=""
if ! (cd "$PROJECT_ROOT" && npm run api:test >/tmp/clawclub-watchdog-test.log 2>&1); then
  TEST_STATUS="FAIL"
  TEST_SNIPPET="$(tail -n 20 /tmp/clawclub-watchdog-test.log | sed 's/^/    /')"
fi
if [ -x "$FOREMAN_SCRIPT" ]; then
  "$FOREMAN_SCRIPT"
fi
{
  echo "[$NOW] progress watchdog tick"
  echo "recent commits:"
  echo "$COMMITS"
  echo "clawclub tests:"
  echo "  $TEST_STATUS"
  if [ -n "$TEST_SNIPPET" ]; then
    echo "$TEST_SNIPPET"
  fi
  echo
} >> "$OUT"
# Telegram reporting disabled by request.
# The watchdog now logs state and lets the foreman keep work moving quietly.
