#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/home/ubuntu/.openclaw/workspace}"
PROJECT_ROOT="${PROJECT_ROOT:-$ROOT/clawclub}"
AUTOMATION_DIR="${AUTOMATION_DIR:-$PROJECT_ROOT/automation}"
QUEUE_FILE="${QUEUE_FILE:-$AUTOMATION_DIR/progress-queue.json}"
RUNS_DIR="${RUNS_DIR:-$AUTOMATION_DIR/runs}"
LOCK_FILE="${LOCK_FILE:-$AUTOMATION_DIR/progress-foreman.lock}"
OUT="${OUT:-$ROOT/memory/progress-watchdog.log}"
CHAT_ID="${CHAT_ID:-16535088}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/home/ubuntu/.npm-global/bin/openclaw}"
DRY_RUN="${FOREMAN_DRY_RUN:-0}"
NOW="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$AUTOMATION_DIR" "$RUNS_DIR" "$(dirname "$OUT")"

if [ ! -f "$QUEUE_FILE" ]; then
  cat >"$QUEUE_FILE" <<'JSON'
{
  "version": 1,
  "updatedAt": null,
  "activeTaskId": null,
  "tasks": []
}
JSON
fi

log() {
  printf '[%s] foreman: %s\n' "$NOW" "$1" >> "$OUT"
}

with_queue() {
  local filter="$1"
  local tmp
  tmp="$(mktemp)"
  jq "$filter" "$QUEUE_FILE" > "$tmp"
  mv "$tmp" "$QUEUE_FILE"
}

queue_get() {
  jq -r "$1" "$QUEUE_FILE"
}

task_field() {
  local task_id="$1"
  local field="$2"
  jq -r --arg id "$task_id" ".tasks[] | select(.id == \$id) | $field" "$QUEUE_FILE"
}

validate_queue() {
  local validation_output
  validation_output="$(jq -r '
    . as $queue
    | def has_command: (.command? // "") != "";
      def has_prompt: (.prompt? // "") != "";
      def valid_status: (.status == "queued" or .status == "running" or .status == "done" or .status == "failed");

      if $queue.version != 1 then
        "queue version must be 1"
      elif ($queue.tasks | type) != "array" then
        ".tasks must be an array"
      elif (($queue.tasks | map(.id) | unique | length) != ($queue.tasks | length)) then
        "task ids must be unique"
      elif any($queue.tasks[]?; (.id // "") == "") then
        "every task needs a non-empty id"
      elif any($queue.tasks[]?; (valid_status | not)) then
        "every task needs a valid status"
      elif any($queue.tasks[]?; (has_command and has_prompt) or ((has_command or has_prompt) | not)) then
        "every task must define exactly one of command or prompt"
      elif (($queue.tasks | map(select(.status == "running")) | length) > 1) then
        "queue cannot contain more than one running task"
      elif ($queue.activeTaskId != null and ([$queue.tasks[] | select(.id == $queue.activeTaskId)] | length) != 1) then
        "activeTaskId must point to exactly one task"
      elif ($queue.activeTaskId == null and (($queue.tasks | map(select(.status == "running")) | length) != 0)) then
        "running task requires activeTaskId"
      elif ($queue.activeTaskId != null and ([$queue.tasks[] | select(.id == $queue.activeTaskId and .status == "running")] | length) != 1) then
        "activeTaskId must point to the running task"
      else
        "ok"
      end
  ' "$QUEUE_FILE")"

  if [ "$validation_output" != "ok" ]; then
    log "queue validation failed: $validation_output"
    return 1
  fi
}

mark_finished_if_complete() {
  local active_task_id pid exit_code_file exit_code status finished_now
  active_task_id="$(queue_get '.activeTaskId // empty')"
  [ -n "$active_task_id" ] || return 0

  pid="$(task_field "$active_task_id" '.launch.pid // empty')"
  exit_code_file="$(task_field "$active_task_id" '.launch.exitCodeFile // empty')"

  if [ -n "$pid" ] && [ "$pid" != "dry-run" ] && kill -0 "$pid" 2>/dev/null; then
    log "active task still running: $active_task_id (pid $pid)"
    return 0
  fi

  if [ -n "$exit_code_file" ] && [ -f "$exit_code_file" ]; then
    exit_code="$(cat "$exit_code_file")"
  else
    exit_code="unknown"
  fi

  if [ "$exit_code" = "0" ]; then
    status='done'
  else
    status='failed'
  fi
  finished_now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  with_queue "(.updatedAt = \"$finished_now\")
    | (.activeTaskId = null)
    | (.tasks |= map(if .id == \"$active_task_id\" then . + {
        status: \"$status\",
        finishedAt: \"$finished_now\",
        lastExitCode: \"$exit_code\"
      } else . end))"

  log "marked task $active_task_id as $status (exit=$exit_code)"
}

launch_next_task() {
  local active_task_id next_task_id next_title next_command next_prompt launch_now run_dir log_file exit_code_file wrapper pid message
  active_task_id="$(queue_get '.activeTaskId // empty')"
  if [ -n "$active_task_id" ]; then
    log "launch skipped: active task already set to $active_task_id"
    return 0
  fi

  next_task_id="$(queue_get '.tasks | map(select(.status == "queued")) | .[0].id // empty')"
  if [ -z "$next_task_id" ]; then
    log 'launch skipped: no queued tasks'
    return 0
  fi

  next_title="$(task_field "$next_task_id" '.title // .id')"
  next_command="$(task_field "$next_task_id" '.command // empty')"
  next_prompt="$(task_field "$next_task_id" '.prompt // empty')"

  run_dir="$RUNS_DIR/$next_task_id"
  mkdir -p "$run_dir"
  log_file="$run_dir/output.log"
  exit_code_file="$run_dir/exit-code"
  launch_now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  if [ "$DRY_RUN" = "1" ]; then
    wrapper="dry-run"
    pid="dry-run"
    with_queue "(.updatedAt = \"$launch_now\")
      | (.activeTaskId = \"$next_task_id\")
      | (.tasks |= map(if .id == \"$next_task_id\" then . + {
          status: \"running\",
          startedAt: \"$launch_now\",
          launch: {
            mode: \"dry-run\",
            wrapper: \"$wrapper\",
            pid: \"$pid\",
            logFile: \"$log_file\",
            exitCodeFile: \"$exit_code_file\"
          }
        } else . end))"
    printf 'dry-run would launch task %s at %s\n' "$next_task_id" "$launch_now" > "$log_file"
    echo 0 > "$exit_code_file"
    log "dry-run launched task $next_task_id ($next_title)"
  else
    if [ -n "$next_command" ]; then
      wrapper="$next_command"
    else
      wrapper="$OPENCLAW_BIN agent --to $CHAT_ID --message $(printf '%q' "$next_prompt")"
    fi

    (
      set +e
      cd "$PROJECT_ROOT"
      bash -lc "$wrapper" >"$log_file" 2>&1
      exit_code="$?"
      printf '%s' "$exit_code" > "$exit_code_file"
      exit "$exit_code"
    ) &
    pid="$!"

    with_queue "(.updatedAt = \"$launch_now\")
      | (.activeTaskId = \"$next_task_id\")
      | (.tasks |= map(if .id == \"$next_task_id\" then . + {
          status: \"running\",
          startedAt: \"$launch_now\",
          launch: {
            mode: \"live\",
            wrapper: \"$wrapper\",
            pid: \"$pid\",
            logFile: \"$log_file\",
            exitCodeFile: \"$exit_code_file\"
          }
        } else . end))"

    log "launched task $next_task_id ($next_title) with pid $pid"
  fi

  message="Foreman launched ClawClub queue item

- Task: $next_task_id
- Title: $next_title"
  if [ -n "$next_command" ]; then
    message="$message
- Command: $next_command"
  fi
  if [ -n "$next_prompt" ]; then
    message="$message
- Prompt: $next_prompt"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    message="$message
- Mode: dry-run"
  fi

  "$OPENCLAW_BIN" message send --channel telegram --target "$CHAT_ID" --message "$message" >/tmp/clawclub-foreman-send.log 2>&1 || {
    log "telegram send failed for task $next_task_id"
    tail -n 20 /tmp/clawclub-foreman-send.log >> "$OUT" 2>/dev/null || true
  }
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log 'another foreman tick holds the lock; exiting'
  exit 0
fi

if ! validate_queue; then
  exit 1
fi

mark_finished_if_complete
validate_queue
launch_next_task
