#!/usr/bin/env bash
# scripts/cf-bootstrap.sh — idempotent one-shot local bootstrap for a
# Cloudflare environment. Creates the D1 databases and R2 buckets for all
# 5 Workers in the target env. Equivalent to the "Ensure CF resources" step
# in .github/workflows/cf-deploy.yml, but runnable locally without triggering
# a full deploy.
#
# Usage:
#   ./scripts/cf-bootstrap.sh qa
#   ./scripts/cf-bootstrap.sh prod
#
# Prerequisites:
#   - wrangler installed and authenticated (CLOUDFLARE_API_TOKEN +
#     CLOUDFLARE_ACCOUNT_ID in env, or `wrangler login`)
#   - The two zones rallypt.dev (qa) and rallypt.app (prod) must already be
#     added to the target CF account before deploying (custom_domain routes
#     require the zone to exist).
#
# This script does NOT set secrets — generate the CF_WORKER_SECRETS JSON with
# scripts/gen-cf-secrets.sh and set it as a repo secret per the
# docs/deploy/cloudflare.md runbook. Re-running is safe: `|| true` tolerates
# "already exists" errors.

set -euo pipefail

# ---- arg validation --------------------------------------------------
ENV="${1:-}"
if [[ "$ENV" != "qa" && "$ENV" != "prod" ]]; then
  echo "Usage: $0 <qa|prod>" >&2
  exit 1
fi

echo "[cf-bootstrap] target environment: ${ENV}"
echo ""

# ---- D1 databases ----------------------------------------------------
# One D1 per app, named rp-<app>-<env>. wrangler >=4.45 links by name so
# no database_id is needed in wrangler.toml.
D1_NAMES=(
  "rp-id-${ENV}"
  "rp-lists-${ENV}"
  "rp-events-${ENV}"
  "rp-money-${ENV}"
  "rp-planner-${ENV}"
)

echo "[cf-bootstrap] creating D1 databases (idempotent)..."
for db in "${D1_NAMES[@]}"; do
  echo "  wrangler d1 create ${db}"
  npx wrangler d1 create "${db}" || true
done

echo ""

# ---- R2 buckets ------------------------------------------------------
# events + money + id each have an object store (maps/receipts/avatars).
# The apps bind the bucket natively via [[r2_buckets]] in wrangler.toml
# (OBJECT_STORE binding) — no S3 keys or endpoint needed.
# lists and planner have no object store.
R2_BUCKETS=(
  "rallypoint-events-${ENV}"
  "rallypoint-money-${ENV}"
  "rallypoint-id-${ENV}"
)

echo "[cf-bootstrap] creating R2 buckets (idempotent)..."
for bucket in "${R2_BUCKETS[@]}"; do
  echo "  wrangler r2 bucket create ${bucket}"
  npx wrangler r2 bucket create "${bucket}" || true
done

echo ""

# ---- next steps ------------------------------------------------------
cat <<EOF
[cf-bootstrap] Done. Resources created (or already existed) for env=${ENV}.

Next steps:
  1. Set the 3 repository secrets (Settings -> Secrets and variables ->
     Actions -> Repository secrets) per the docs/deploy/cloudflare.md
     runbook: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and
     CF_WORKER_SECRETS. Generate the CF_WORKER_SECRETS JSON with:
       ./scripts/gen-cf-secrets.sh > cf-worker-secrets.json
       # fill in the REPLACE_ME third-party creds, then:
       gh secret set CF_WORKER_SECRETS < cf-worker-secrets.json

  2. Trigger the deploy: Actions -> "CF deploy" -> Run workflow -> ${ENV}.
     The workflow's ensure step is idempotent so you can also rely on it
     instead of running this script first. The R2 buckets created above
     are bound to the Workers natively via [[r2_buckets]] in wrangler.toml
     (no S3 keys or endpoint needed).

  3. The prod deploy is gated by the 'prod' GitHub Environment's required
     reviewer — add one (Settings -> Environments -> prod) before the first
     prod deploy. The deploy job blocks until a reviewer approves.
EOF
