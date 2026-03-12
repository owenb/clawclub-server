#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/ubuntu/.openclaw/workspace"
OUT="$ROOT/memory/progress-watchdog.log"
CHAT_ID="16535088"
OPENCLAW_BIN="/home/ubuntu/.npm-global/bin/openclaw"
NOW="$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
COMMITS="$(git -C "$ROOT" log --oneline --decorate -3 | sed 's/^/  - /')"
TEST_STATUS="PASS"
TEST_SNIPPET=""
if ! (cd "$ROOT/clawclub" && npm run api:test >/tmp/clawclub-watchdog-test.log 2>&1); then
  TEST_STATUS="FAIL"
  TEST_SNIPPET="$(tail -n 20 /tmp/clawclub-watchdog-test.log | sed 's/^/    /')"
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
MESSAGE="10-minute update ($NOW)

Recent commits:
$COMMITS

ClawClub tests: $TEST_STATUS"
if [ -n "$TEST_SNIPPET" ]; then
  MESSAGE="$MESSAGE

Recent test output:
$TEST_SNIPPET"
fi
"$OPENCLAW_BIN" message send --channel telegram --target "$CHAT_ID" --message "$MESSAGE" >/tmp/clawclub-watchdog-send.log 2>&1 || {
  {
    echo "send failed:"
    tail -n 20 /tmp/clawclub-watchdog-send.log
    echo
  } >> "$OUT"
}
