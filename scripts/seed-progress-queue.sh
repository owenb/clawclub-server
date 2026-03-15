#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT="${ROOT:-$(cd "$PROJECT_ROOT/.." && pwd)}"
AUTOMATION_DIR="${AUTOMATION_DIR:-$PROJECT_ROOT/automation}"
QUEUE_FILE="${QUEUE_FILE:-$AUTOMATION_DIR/progress-queue.json}"
NOW="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$AUTOMATION_DIR"

cat >"$QUEUE_FILE" <<JSON
{
  "version": 1,
  "updatedAt": "$NOW",
  "activeTaskId": null,
  "tasks": [
    {
      "id": "roadmap-update-stream-resume-hardening",
      "title": "Harden update stream resume semantics and replay docs",
      "status": "queued",
      "createdAt": "$NOW",
      "prompt": "Work in $PROJECT_ROOT only. Implement the next ClawClub reliability slice for the member update stream: tighten cursor replay semantics, add or update tests around reconnect/resume behavior, and refresh the docs so OpenClaw-style agents have a crisp transport contract. Keep it simple and append-only. Commit cleanly and report concise milestones/blockers."
    },
    {
      "id": "roadmap-embeddings-foundation",
      "title": "Add the smallest embeddings-ready foundation for profiles and entities with docs/tests",
      "status": "queued",
      "createdAt": "$NOW",
      "prompt": "Work in $PROJECT_ROOT only. Implement the smallest useful embeddings-ready foundation for ClawClub without overbuilding: add schema/app placeholders or interfaces needed to support embeddings for profiles and entities later, plus tests and a short design/doc update. Keep it simple and transparent. Commit cleanly and report concise milestones/blockers."
    },
    {
      "id": "roadmap-search-ranking-pass",
      "title": "Tighten member search toward structured-plus-ranking behavior without full semantic search",
      "status": "queued",
      "createdAt": "$NOW",
      "prompt": "Work in $PROJECT_ROOT only. Improve member search in a small real way that moves toward the documented structured-plus-ranking direction without pretending full semantic search exists yet. Prefer deterministic ranking/filters/tests/docs over big architecture. Keep it simple and transparent. Commit cleanly and report concise milestones/blockers."
    }
  ]
}
JSON

printf 'Seeded %s with 3 queued roadmap tasks\n' "$QUEUE_FILE"
