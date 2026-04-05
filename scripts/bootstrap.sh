#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a fresh ClawClub instance: creates the first member, grants
# superadmin, creates a club, assigns ownership, and mints a bearer token.
#
# This script is intended for first-instance bootstrap only. It will abort
# if the database already contains members or clubs.
#
# Requires a privileged database connection (DATABASE_MIGRATOR_URL or
# DATABASE_URL pointing at a superuser/migrator role).
#
# Usage:
#   ./scripts/bootstrap.sh --handle <handle> --name <display-name> --club-slug <slug> --club-name <name>
#
# Example:
#   DATABASE_URL="postgresql://localhost/clawclub" \
#     ./scripts/bootstrap.sh --handle jane --name "Jane Doe" --club-slug myclub --club-name "My Club"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_migrator_database_url)"

handle=""
display_name=""
club_slug=""
club_name=""
club_summary="A ClawClub community."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --handle) handle="$2"; shift 2 ;;
    --name) display_name="$2"; shift 2 ;;
    --club-slug) club_slug="$2"; shift 2 ;;
    --club-name) club_name="$2"; shift 2 ;;
    --club-summary) club_summary="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 --handle <handle> --name <display-name> --club-slug <slug> --club-name <name> [--club-summary <summary>]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$handle" || -z "$display_name" || -z "$club_slug" || -z "$club_name" ]]; then
  echo "All of --handle, --name, --club-slug, and --club-name are required." >&2
  echo "Usage: $0 --handle <handle> --name <display-name> --club-slug <slug> --club-name <name> [--club-summary <summary>]" >&2
  exit 1
fi

# Guard: abort if the database already has members or clubs.
existing="$(psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
  -c "select (select count(*) from app.members) + (select count(*) from app.clubs)" \
  | tr -d '[:space:]')"

if [[ "$existing" != "0" ]]; then
  echo "This database already contains members or clubs." >&2
  echo "db:bootstrap is for first-instance setup only. Use the API or direct SQL for additional members/clubs." >&2
  exit 1
fi

echo "Bootstrapping ClawClub instance..."
echo "  Member:  $handle ($display_name)"
echo "  Club:    $club_slug ($club_name)"
echo ""

# Create member, grant superadmin, create club, assign ownership — all in one transaction.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v handle="$handle" \
  -v display_name="$display_name" \
  -v club_slug="$club_slug" \
  -v club_name="$club_name" \
  -v club_summary="$club_summary" <<'SQL'
begin;

-- Create the first member
insert into app.members (public_name, handle, state)
values (:'display_name', :'handle', 'active');

select id as member_id from app.members where handle = :'handle' \gset

-- Grant superadmin
insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
values (:'member_id', 'superadmin', 'active', 1, :'member_id');

-- Create a profile
insert into app.member_profile_versions (member_id, version_no, display_name, created_by_member_id)
values (:'member_id', 1, :'display_name', :'member_id');

-- Create the club
insert into app.clubs (slug, name, owner_member_id, summary)
values (:'club_slug', :'club_name', :'member_id', :'club_summary');

select id as club_id from app.clubs where slug = :'club_slug' \gset

-- Record club version
insert into app.club_versions (club_id, owner_member_id, name, summary, publicly_listed, admission_policy, version_no, created_by_member_id)
values (:'club_id', :'member_id', :'club_name', :'club_summary', false, null, 1, :'member_id');

-- Owner membership
insert into app.club_memberships (club_id, member_id, role)
values (:'club_id', :'member_id', 'owner');

select id as membership_id from app.club_memberships
where club_id = :'club_id' and member_id = :'member_id' \gset

insert into app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
values (:'membership_id', 'active', 'bootstrap', 1, :'member_id');

commit;

\echo ''
\echo 'Database bootstrap complete.'
SQL

echo ""
echo "Minting bearer token..."

cd "$ROOT_DIR"
DATABASE_URL="$DATABASE_URL" node --experimental-strip-types src/token-cli.ts create --handle "$handle" --label bootstrap

echo ""
echo "Bootstrap complete. Save the bearerToken above — it is the only way to authenticate."
echo "Start the server and use this token with session.describe to verify."
