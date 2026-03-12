#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/ubuntu/.openclaw/workspace"
OUT="$ROOT/memory/progress-watchdog.log"
mkdir -p "$ROOT/memory"
{
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S UTC')] progress watchdog tick"
  echo "recent commits:"
  git -C "$ROOT" log --oneline --decorate -5 | sed 's/^/  /'
  echo "clawclub tests:"
  (cd "$ROOT/clawclub" && npm run api:test >/tmp/clawclub-watchdog-test.log 2>&1 && echo "  PASS" || { echo "  FAIL"; tail -n 40 /tmp/clawclub-watchdog-test.log | sed 's/^/    /'; })
  echo
} >> "$OUT"
