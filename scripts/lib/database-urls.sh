#!/usr/bin/env bash

# ClawClub uses a single role for both runtime and schema management.
# There is one URL: $DATABASE_URL.
#
# Bootstrap-time scripts (provision-app-role.sh, db/init.sql) need admin
# credentials and should be invoked with DATABASE_URL pointing at a
# privileged role (e.g. postgres). Day-to-day deploys (migrate.sh, the
# server) use DATABASE_URL pointing at clawclub_app, which owns the
# public schema and can run any DDL the app needs.

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo 'DATABASE_URL must be set' >&2
    return 1
  fi

  printf '%s\n' "$DATABASE_URL"
}
