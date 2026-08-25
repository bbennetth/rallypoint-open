#!/usr/bin/env bash
# Apply scripts/seed-demo-festival.sql — the system-owned "Harvest Moon
# Festival" demo (owner = the PR #792 SYSTEM_USER_ID sentinel) — to an
# events-api D1 database. Idempotent; safe to re-run.
#
# Usage:
#   bash scripts/seed-demo-festival.sh            # local dev D1 (default)
#   bash scripts/seed-demo-festival.sh qa         # remote rp-events-qa
#   bash scripts/seed-demo-festival.sh prod       # remote rp-events-prod
#
# local  targets the same Miniflare state dev.sh migrates
#        (apps/events-api/.wrangler/state) — run `npm run dev:stack` (or at
#        least its migration step) first so the schema exists.
# qa/prod resolve the database BY NAME via the Cloudflare API (the checked-in
#        wrangler.toml intentionally carries no database_id — cf-deploy.yml
#        injects it), so they need wrangler auth: `wrangler login` or
#        CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-local}"
SEED_FILE="scripts/seed-demo-festival.sql"

case "$TARGET" in
  local)
    echo "[seed-demo-festival] applying to local dev D1 (apps/events-api/.wrangler/state)..."
    (cd apps/events-api && npx wrangler d1 execute DB --local --file "../../$SEED_FILE")
    ;;
  qa|prod)
    DB_NAME="rp-events-$TARGET"
    echo "[seed-demo-festival] applying to REMOTE $DB_NAME ..."
    npx wrangler d1 execute "$DB_NAME" --remote --file "$SEED_FILE"
    ;;
  *)
    echo "[seed-demo-festival] unknown target '$TARGET' (expected: local | qa | prod)" >&2
    exit 1
    ;;
esac

echo "[seed-demo-festival] done. Event slug: harvest-moon-demo (owner: system)."
