#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PROJECT_ROOT="$TMP_ROOT/clawclub"
AUTOMATION_DIR="$PROJECT_ROOT/automation"
RUNS_DIR="$AUTOMATION_DIR/runs"
QUEUE_FILE="$AUTOMATION_DIR/progress-queue.json"
OUT="$TMP_ROOT/progress-watchdog.log"
OPENCLAW_BIN="$TMP_ROOT/openclaw-stub.sh"
FOREMAN_SCRIPT="$SCRIPT_DIR/progress-foreman.sh"

mkdir -p "$RUNS_DIR" "$PROJECT_ROOT"
cat > "$OPENCLAW_BIN" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$OPENCLAW_BIN"

cat > "$QUEUE_FILE" <<'JSON'
{
  "version": 1,
  "updatedAt": null,
  "activeTaskId": null,
  "tasks": [
    {
      "id": "t1",
      "title": "success path one",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:00Z",
      "command": "printf 'one'"
    },
    {
      "id": "t2",
      "title": "success path two",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:01Z",
      "command": "printf 'two'"
    }
  ]
}
JSON

ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"
sleep 1
ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"
ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"
sleep 1
ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"

jq -e '.activeTaskId == null' "$QUEUE_FILE" >/dev/null
jq -e '.tasks[0].status == "done"' "$QUEUE_FILE" >/dev/null
jq -e '.tasks[1].status == "done"' "$QUEUE_FILE" >/dev/null
[ "$(cat "$RUNS_DIR/t1/output.log")" = "one" ]
[ "$(cat "$RUNS_DIR/t2/output.log")" = "two" ]
launch_count="$(grep -c 'launched task t1' "$OUT")"
[ "$launch_count" = "1" ]

cat > "$QUEUE_FILE" <<'JSON'
{
  "version": 1,
  "updatedAt": null,
  "activeTaskId": null,
  "tasks": [
    {
      "id": "dup",
      "title": "first",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:00Z",
      "command": "printf first"
    },
    {
      "id": "dup",
      "title": "second",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:01Z",
      "command": "printf second"
    }
  ]
}
JSON

if ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"; then
  echo "expected duplicate-id validation failure" >&2
  exit 1
fi

grep -q 'queue validation failed: task ids must be unique' "$OUT"

echo "progress foreman test passed"
