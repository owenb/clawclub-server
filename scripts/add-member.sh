#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <handle> <public-name> <network-slug>" >&2
  echo "" >&2
  echo "Requires CLAWCLUB_OWNER_TOKEN in the environment." >&2
  echo "example:" >&2
  echo "  CLAWCLUB_OWNER_TOKEN=cc_live_... $0 jane-doe 'Jane Doe' consciousclaw" >&2
  exit 1
fi

if [[ -z "${CLAWCLUB_OWNER_TOKEN:-}" ]]; then
  echo "CLAWCLUB_OWNER_TOKEN must be set (the bearerToken from bootstrap-consciousclaw.sh)" >&2
  exit 1
fi

handle="$1"
public_name="$2"
network_slug="$3"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
source "$repo_dir/scripts/lib/database-urls.sh"

database_url="$(require_migrator_database_url)"

echo "Creating member '$handle' ($public_name)..."

psql "$database_url" -v ON_ERROR_STOP=1 -v handle="$handle" -v public_name="$public_name" <<'SQL'
insert into app.members (public_name, auth_subject, handle, metadata)
values (:'public_name', 'auth|' || :'handle', :'handle', '{}')
on conflict (handle) do update
set public_name = excluded.public_name,
    auth_subject = excluded.auth_subject;
SQL

member_id=$(psql "$database_url" -tA -c "select id from app.members where handle = '$handle';")
if [[ -z "$member_id" ]]; then
  echo "Failed to resolve member id for handle '$handle'" >&2
  exit 1
fi

echo "Member created: $member_id"

network_id=$(psql "$database_url" -tA -c "select id from app.networks where slug = '$network_slug';")
if [[ -z "$network_id" ]]; then
  echo "No network found with slug '$network_slug'" >&2
  exit 1
fi

owner_member_id=$(psql "$database_url" -tA -c "select owner_member_id from app.networks where slug = '$network_slug';")

echo "Adding membership to $network_slug ($network_id)..."

membership_response=$(curl -sf -X POST http://127.0.0.1:8787/api \
  -H "Authorization: Bearer $CLAWCLUB_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"action":"memberships.create","networkId":"%s","memberId":"%s","sponsorMemberId":"%s","role":"member","initialStatus":"active","reason":"Added via add-member script"}' \
    "$network_id" "$member_id" "$owner_member_id")")

echo "Membership response:"
echo "$membership_response" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))" 2>/dev/null || echo "$membership_response"

echo ""
echo "Minting bearer token..."

cd "$repo_dir"
token_output=$(DATABASE_URL="$database_url" node --experimental-strip-types src/token-cli.ts create --handle "$handle" --label invite)

echo "$token_output"

echo ""
echo "Done. Share the bearerToken above with $public_name."
