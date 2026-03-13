#!/usr/bin/env bash
set -euo pipefail

member_handle="${1:-owen-barnes}"
label="${2:-bootstrap}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
source "$repo_dir/scripts/lib/database-urls.sh"

token_database_url="${DATABASE_URL:-${DATABASE_MIGRATOR_URL:-}}"
if [[ -z "$token_database_url" ]]; then
  echo 'DATABASE_URL or DATABASE_MIGRATOR_URL must be set' >&2
  exit 1
fi

cd "$repo_dir"

./scripts/migrate.sh
./scripts/seed-consciousclaw.sh
DATABASE_URL="$token_database_url" \
  node --experimental-strip-types src/token-cli.ts create --handle "$member_handle" --label "$label" --metadata '{"bootstrap":true,"seed":"consciousclaw"}'
