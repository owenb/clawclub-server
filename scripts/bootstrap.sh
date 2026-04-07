#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a fresh ClawClub instance: creates a superadmin member and mints
# a bearer token. Use the token to create clubs and members via the API.
#
# This script is intended for first-instance bootstrap only. It will abort
# if the identity database already contains members.
#
# Requires a privileged database connection:
#   IDENTITY_DATABASE_URL or IDENTITY_MIGRATOR_URL
#   (falls back to DATABASE_MIGRATOR_URL / DATABASE_URL)
#
# Usage:
#   IDENTITY_DATABASE_URL="postgresql://..." ./scripts/bootstrap.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve database URL: prefer identity-specific, fall back to generic
if [[ -n "${IDENTITY_MIGRATOR_URL:-}" ]]; then
  DATABASE_URL="$IDENTITY_MIGRATOR_URL"
elif [[ -n "${IDENTITY_DATABASE_URL:-}" ]]; then
  DATABASE_URL="$IDENTITY_DATABASE_URL"
elif [[ -n "${DATABASE_MIGRATOR_URL:-}" ]]; then
  DATABASE_URL="$DATABASE_MIGRATOR_URL"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="$DATABASE_URL"
else
  echo "Set IDENTITY_DATABASE_URL or IDENTITY_MIGRATOR_URL (or DATABASE_MIGRATOR_URL / DATABASE_URL)" >&2
  exit 1
fi

# Guard: abort if the database already has members.
existing="$(psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
  -c "select count(*) from app.members" \
  | tr -d '[:space:]')"

if [[ "$existing" != "0" ]]; then
  echo "This database already contains members." >&2
  echo "db:bootstrap is for first-instance setup only. Use the API for additional members." >&2
  exit 1
fi

echo "Bootstrapping ClawClub instance..."
echo "  Creating superadmin member..."
echo ""

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

-- Create the superadmin member
insert into app.members (public_name, handle, state)
values ('Superadmin', 'superadmin', 'active');

select id as member_id from app.members where handle = 'superadmin' \gset

-- Grant superadmin role
insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
values (:'member_id', 'superadmin', 'active', 1, :'member_id');

-- Create a profile
insert into app.member_profile_versions (member_id, version_no, display_name, created_by_member_id)
values (:'member_id', 1, 'Superadmin', :'member_id');

commit;

\echo ''
\echo 'Superadmin member created.'
SQL

echo ""
echo "Minting bearer token..."

cd "$ROOT_DIR"
IDENTITY_DATABASE_URL="$DATABASE_URL" node --experimental-strip-types src/token-cli.ts create --handle superadmin --label bootstrap

echo ""
echo "Bootstrap complete. Save the bearerToken above — it is the only way to authenticate."
echo "Use this token to create clubs and members via the API."
