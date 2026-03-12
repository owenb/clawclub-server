#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

member_handle="${1:-owen-barnes}"
label="${2:-bootstrap}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"

cd "$repo_dir"

./scripts/migrate.sh
./scripts/seed-consciousclaw.sh
node --experimental-strip-types src/token-cli.ts create --handle "$member_handle" --label "$label" --metadata '{"bootstrap":true,"seed":"consciousclaw"}'
