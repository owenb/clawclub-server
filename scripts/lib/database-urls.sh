#!/usr/bin/env bash

require_runtime_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo 'DATABASE_URL must be set' >&2
    return 1
  fi

  printf '%s\n' "$DATABASE_URL"
}

require_migrator_database_url() {
  if [[ -n "${DATABASE_MIGRATOR_URL:-}" ]]; then
    printf '%s\n' "$DATABASE_MIGRATOR_URL"
    return 0
  fi

  require_runtime_database_url
}
