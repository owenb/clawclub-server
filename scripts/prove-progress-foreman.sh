#!/usr/bin/env bash
set -euo pipefail

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PROJECT_ROOT="$TMP_ROOT/clawclub"
AUTOMATION_DIR="$PROJECT_ROOT/automation"
RUNS_DIR="$AUTOMATION_DIR/runs"
QUEUE_FILE="$AUTOMATION_DIR/progress-queue.json"
OUT="$TMP_ROOT/progress-watchdog.log"
OPENCLAW_BIN="$TMP_ROOT/openclaw-stub.sh"
FOREMAN_SCRIPT="/home/ubuntu/.openclaw/workspace/clawclub/scripts/progress-foreman.sh"
ARTIFACT_DIR="$PROJECT_ROOT/artifacts"

mkdir -p "$RUNS_DIR" "$PROJECT_ROOT" "$ARTIFACT_DIR"
cat > "$OPENCLAW_BIN" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$OPENCLAW_BIN"

cat > "$QUEUE_FILE" <<JSON
{
  "version": 1,
  "updatedAt": null,
  "activeTaskId": null,
  "tasks": [
    {
      "id": "proof-plan",
      "title": "write first proof artifact",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:00Z",
      "command": "mkdir -p '$ARTIFACT_DIR' && printf 'first\n' > '$ARTIFACT_DIR/01-first.txt'"
    },
    {
      "id": "proof-advance",
      "title": "write second proof artifact",
      "status": "queued",
      "createdAt": "2026-03-13T00:00:01Z",
      "command": "mkdir -p '$ARTIFACT_DIR' && printf 'second\n' > '$ARTIFACT_DIR/02-second.txt'"
    }
  ]
}
JSON

for _ in 1 2 3 4; do
  ROOT="$TMP_ROOT" PROJECT_ROOT="$PROJECT_ROOT" AUTOMATION_DIR="$AUTOMATION_DIR" QUEUE_FILE="$QUEUE_FILE" RUNS_DIR="$RUNS_DIR" OUT="$OUT" OPENCLAW_BIN="$OPENCLAW_BIN" CHAT_ID="test" "$FOREMAN_SCRIPT"
  sleep 1
done

jq -e '.activeTaskId == null' "$QUEUE_FILE" >/dev/null
jq -e '.tasks | map(.status) == ["done", "done"]' "$QUEUE_FILE" >/dev/null
[ -f "$ARTIFACT_DIR/01-first.txt" ]
[ -f "$ARTIFACT_DIR/02-second.txt" ]
[ "$(grep -c 'launched task proof-plan' "$OUT")" = "1" ]
[ "$(grep -c 'launched task proof-advance' "$OUT")" = "1" ]

printf 'proof ok: launch -> complete -> advance ran once per task\n'
