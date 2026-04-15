#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <public-name> <club-slug>" >&2
  echo "" >&2
  echo "Requires CLAWCLUB_OWNER_TOKEN in the environment." >&2
  echo "example:" >&2
  echo "  CLAWCLUB_OWNER_TOKEN=cc_live_... $0 'Jane Doe' your-club" >&2
  exit 1
fi

if [[ -z "${CLAWCLUB_OWNER_TOKEN:-}" ]]; then
  echo "CLAWCLUB_OWNER_TOKEN must be set (a bearer token for the club owner)" >&2
  exit 1
fi

public_name="$1"
club_slug="$2"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
source "$repo_dir/scripts/lib/database-urls.sh"

database_url="$(require_database_url)"
api_base_url="${CLAWCLUB_API_URL:-http://127.0.0.1:8787}"

echo "Checking API reachability at $api_base_url..."
if ! curl -sS -f -o /dev/null \
  -H "Authorization: Bearer $CLAWCLUB_OWNER_TOKEN" \
  "$api_base_url/updates?limit=1"; then
  echo "ClawClub API is not reachable or CLAWCLUB_OWNER_TOKEN is not accepted at $api_base_url" >&2
  exit 1
fi

echo "Creating member '$public_name'..."

member_id="$(psql "$database_url" -X -A -t -q -v ON_ERROR_STOP=1 -v public_name="$public_name" <<'SQL'
insert into members (public_name, display_name, state)
values (:'public_name', :'public_name', 'active')
returning id;
SQL
)"
if [[ -z "$member_id" ]]; then
  echo "Failed to create member '$public_name'" >&2
  exit 1
fi

echo "Member created: $member_id"

club_id="$(psql "$database_url" -X -A -t -q -v ON_ERROR_STOP=1 -v club_slug="$club_slug" \
  -c "select id from clubs where slug = :'club_slug'")"
if [[ -z "$club_id" ]]; then
  echo "No club found with slug '$club_slug'" >&2
  exit 1
fi

owner_member_id="$(psql "$database_url" -X -A -t -q -v ON_ERROR_STOP=1 -v club_slug="$club_slug" \
  -c "select owner_member_id from clubs where slug = :'club_slug'")"

echo "Adding membership to $club_slug ($club_id)..."

membership_response=$(curl -s -f -X POST "$api_base_url/api" \
  -H "Authorization: Bearer $CLAWCLUB_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"action":"clubadmin.memberships.create","input":{"clubId":"%s","memberId":"%s","sponsorMemberId":"%s","initialStatus":"active","reason":"Added via add-member script"}}' \
    "$club_id" "$member_id" "$owner_member_id")")

echo "Membership response:"
echo "$membership_response" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))" 2>/dev/null || echo "$membership_response"

membership_id="$(psql "$database_url" -X -A -t -q -v ON_ERROR_STOP=1 -v club_id="$club_id" -v member_id="$member_id" \
  -c "select id from club_memberships where club_id = :'club_id' and member_id = :'member_id'")"
if [[ -z "$membership_id" ]]; then
  echo "Failed to resolve membership id — membership may not have been created" >&2
  exit 1
fi

echo ""
echo "Creating comped subscription for membership $membership_id..."

psql "$database_url" -v ON_ERROR_STOP=1 -v membership_id="$membership_id" -v owner_member_id="$owner_member_id" <<'SQL'
insert into club_subscriptions (membership_id, payer_member_id, status, amount)
values (:'membership_id', :'owner_member_id', 'active', 0)
on conflict do nothing;
SQL

echo "Comped subscription created."

echo ""
echo "Minting bearer token..."

cd "$repo_dir"
token_output=$(DATABASE_URL="$database_url" node --experimental-strip-types src/token-cli.ts create --member "$member_id" --label invite)

echo "$token_output"

echo ""
echo "Done. Share the bearerToken above with $public_name."
