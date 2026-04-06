#!/usr/bin/env bash
set -euo pipefail

# Run migrations for all three database planes.
# Expects IDENTITY_DATABASE_URL, MESSAGING_DATABASE_URL, CLUBS_DATABASE_URL
# (or their _MIGRATOR_URL variants) to be set.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/migrate-db.sh" identity
"$SCRIPT_DIR/migrate-db.sh" messaging
"$SCRIPT_DIR/migrate-db.sh" clubs
