#!/usr/bin/env bash

# Bootstrap-time scripts use DATABASE_URL as an admin connection to the
# target database. App deploys still run migrations and the server as
# clawclub_app. Optional producer workers may use a separate runtime role.

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo 'DATABASE_URL must be set' >&2
    return 1
  fi

  printf '%s\n' "$DATABASE_URL"
}
