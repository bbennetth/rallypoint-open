#!/usr/bin/env bash
# scripts/check-vapid-isolation.sh — enforce that the planner-api VAPID
# keypairs differ between qa and prod (audit E1 #24).
#
# Why this matters: VAPID identifies the application server to push
# services (FCM / Apple / Mozilla). If qa and prod share a keypair, a
# QA push fires under prod's identity — meaning push services accept
# the auth and deliver to real user devices subscribed under the same
# `applicationServerKey`. The audit flagged this as a high-impact
# operator gap (the planner-api cron runs every minute in both envs,
# so a stale qa subscription list under shared VAPID = silent spam
# to real users).
#
# Usage:
#   # CI / pre-deploy — reads CF_WORKER_SECRETS from env
#   ./scripts/check-vapid-isolation.sh
#
#   # Local — pipe a file
#   ./scripts/check-vapid-isolation.sh < cf-worker-secrets.json
#
# Exits 0 when keys differ (or one env is missing — bootstrap-safe).
# Exits 2 when both envs have the same VAPID_PUBLIC_KEY OR the same
# VAPID_PRIVATE_KEY (either reuse is dangerous).

set -euo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "check-vapid-isolation: jq is required" >&2
  exit 1
}

# Read JSON from env var first (CI path), else stdin (local path).
if [ -n "${CF_WORKER_SECRETS:-}" ]; then
  JSON="$CF_WORKER_SECRETS"
elif [ ! -t 0 ]; then
  JSON="$(cat)"
else
  echo "check-vapid-isolation: provide CF_WORKER_SECRETS env or pipe JSON to stdin" >&2
  exit 1
fi

extract() {
  local env="$1"
  local key="$2"
  # `// empty` so a missing path yields the empty string (not "null").
  printf %s "$JSON" | jq -r --arg env "$env" --arg key "$key" \
    '.[$env]["planner-api"][$key] // empty'
}

QA_PUB="$(extract qa VAPID_PUBLIC_KEY)"
PROD_PUB="$(extract prod VAPID_PUBLIC_KEY)"
QA_PRIV="$(extract qa VAPID_PRIVATE_KEY)"
PROD_PRIV="$(extract prod VAPID_PRIVATE_KEY)"

# Bootstrap-safe: if either env is missing the key entirely, skip the
# check (the deploy itself will fail loudly on a missing required
# secret). The check is only meaningful when both envs have a value.
if [ -z "$QA_PUB" ] || [ -z "$PROD_PUB" ]; then
  echo "check-vapid-isolation: one or both envs missing VAPID_PUBLIC_KEY (bootstrap-safe skip)"
  exit 0
fi

fail=0
if [ "$QA_PUB" = "$PROD_PUB" ]; then
  echo "check-vapid-isolation: ERROR — qa and prod share the same VAPID_PUBLIC_KEY" >&2
  fail=1
fi
if [ -n "$QA_PRIV" ] && [ -n "$PROD_PRIV" ] && [ "$QA_PRIV" = "$PROD_PRIV" ]; then
  echo "check-vapid-isolation: ERROR — qa and prod share the same VAPID_PRIVATE_KEY" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-vapid-isolation: see docs/ops/secrets.md for how to rotate per env." >&2
  exit 2
fi

echo "check-vapid-isolation: qa and prod VAPID keypairs differ — OK"
