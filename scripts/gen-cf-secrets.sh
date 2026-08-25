#!/usr/bin/env bash
# scripts/gen-cf-secrets.sh — generate the CF_WORKER_SECRETS JSON for the
# GitHub Actions deploy workflow (.github/workflows/cf-deploy.yml).
#
# CF_WORKER_SECRETS is one repo-level secret shaped:
#   { "<env>": { "<app>": { "SECRET_NAME": "value", ... } } }
# The push-secrets step jq-slices `.[env][app]` per matrix leg and runs
# `wrangler secret bulk`. See docs/deploy/cloudflare.md for the full key list.
#
# This script fills in every key that is a pure random value (HMAC/session/
# pepper keys, admin token) with `openssl rand -base64 32`. The cross-app
# *_API_KEY peer keys are GONE — every cross-Worker call now goes through
# typed WorkerEntrypoint RPC bindings (feat/rpc-bindings + the fitness
# catch-up), so no app authenticates a peer with a shared bearer any more.
#
# Keys that must come from a third party are emitted as the literal
# placeholder REPLACE_ME (override with $CF_SECRETS_PLACEHOLDER) — you fill
# these by hand before pushing:
#   RESEND_API_KEY            (Resend dashboard)
#   TURNSTILE_SECRET          (Cloudflare Turnstile dashboard)
# OPEN_METEO_COMMERCIAL_API_KEY is optional (commercial weather tier only) and
# is intentionally omitted — add it to events-api by hand if you use that tier.
# planner-api's VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are also
# intentionally omitted: generate a DISTINCT keypair per env with
# `npx tsx scripts/gen-vapid-keys.ts` and paste them in by hand — emitting an
# identical placeholder into both envs would trip check-vapid-isolation.sh.
# Note: R2 object-store access keys are no longer needed — the apps bind their
# R2 buckets natively via [[r2_buckets]] in wrangler.toml (OBJECT_STORE binding).
#
# Usage:
#   ./scripts/gen-cf-secrets.sh            # both envs: { "qa": {...}, "prod": {...} }
#   ./scripts/gen-cf-secrets.sh qa         # one env:   { "qa": {...} }
#   ./scripts/gen-cf-secrets.sh > cf-worker-secrets.json   # then edit placeholders
#
# Then set the repo secret from the edited file (do NOT commit it):
#   gh secret set CF_WORKER_SECRETS < cf-worker-secrets.json
#
# Re-running generates fresh values — rotating a secret is just a re-run +
# re-set + redeploy. qa and prod always get independent values.

set -euo pipefail

command -v openssl >/dev/null 2>&1 || {
  echo "gen-cf-secrets: openssl is required (used to generate random keys)" >&2
  exit 1
}

PLACEHOLDER="${CF_SECRETS_PLACEHOLDER:-REPLACE_ME}"

rnd() { openssl rand -base64 32; }

# Emit one env's app->secrets object. All values are JSON-safe: base64 output
# never contains a quote or backslash, and the placeholder is a bare literal,
# so direct interpolation into the JSON template needs no escaping.
#
# Every random value is pre-generated into a local up front (rather than inline
# `$(rnd)` in the heredoc) purely for readability — note that `set -e` does NOT
# reliably abort on a failed command substitution nested inside `$(...)`, so a
# blank-secret regression is caught instead by the empty-value guard in main
# (a `": ""` in the output means a generation failure). Every key is per-app
# independent — there are no shared peer keys since the RPC-bindings migration.
# lists-mcp is absent by design: it has no runtime secrets (only NODE_ENV).
emit_env_block() {
  local argon2_pepper session_hmac signin_hmac admin_token
  local lists_session events_session money_session planner_session fitness_session admin_session
  local lists_rt events_rt money_rt
  argon2_pepper=$(rnd); session_hmac=$(rnd); signin_hmac=$(rnd); admin_token=$(rnd)
  lists_session=$(rnd); events_session=$(rnd); money_session=$(rnd)
  planner_session=$(rnd); fitness_session=$(rnd); admin_session=$(rnd)
  lists_rt=$(rnd); events_rt=$(rnd); money_rt=$(rnd)

  cat <<JSON
{
    "id-api": {
      "ARGON2_PEPPER": "${argon2_pepper}",
      "SESSION_HMAC_KEY": "${session_hmac}",
      "SIGNIN_CODE_HMAC_KEY": "${signin_hmac}",
      "ADMIN_TOKEN": "${admin_token}",
      "RESEND_API_KEY": "${PLACEHOLDER}",
      "TURNSTILE_SECRET": "${PLACEHOLDER}"
    },
    "lists-api": {
      "LISTS_SESSION_KEY_V1": "${lists_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${lists_rt}"
    },
    "events-api": {
      "EVENTS_SESSION_KEY_V1": "${events_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${events_rt}",
      "ADMIN_USER_IDS": "${PLACEHOLDER}"
    },
    "money-api": {
      "MONEY_SESSION_KEY_V1": "${money_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${money_rt}"
    },
    "planner-api": {
      "PLANNER_SESSION_KEY_V1": "${planner_session}"
    },
    "fitness-api": {
      "FITNESS_SESSION_KEY_V1": "${fitness_session}"
    },
    "admin-api": {
      "ADMIN_SESSION_KEY_V1": "${admin_session}",
      "ADMIN_USER_IDS": "${PLACEHOLDER}"
    }
  }
JSON
}

ENV_ARG="${1:-}"
case "$ENV_ARG" in
  "")
    output=$(printf '{\n  "qa": %s,\n  "prod": %s\n}\n' "$(emit_env_block)" "$(emit_env_block)")
    ;;
  qa | prod)
    output=$(printf '{\n  "%s": %s\n}\n' "$ENV_ARG" "$(emit_env_block)")
    ;;
  *)
    echo "Usage: $0 [qa|prod]   (no arg = both envs)" >&2
    exit 1
    ;;
esac

# Guard against a silent generation failure: every value is either a 44-char
# base64 key or the non-empty placeholder, so an empty "KEY": "" can only mean a
# failed `openssl` that `set -e` didn't catch (it does not propagate out of a
# nested command substitution). Fail loudly rather than emit a blank secret.
if printf '%s' "$output" | grep -q '": ""'; then
  echo "gen-cf-secrets: a generated key came out empty (openssl failure?)" >&2
  exit 1
fi
printf '%s\n' "$output"

# Guidance to stderr so stdout stays pure JSON (safe to redirect / pipe).
cat >&2 <<'MSG'

gen-cf-secrets: random keys filled in. Before pushing:
  1. Replace every REPLACE_ME with the real third-party credential:
       id-api: RESEND_API_KEY, TURNSTILE_SECRET
       admin-api: ADMIN_USER_IDS (comma-separated RPID user ids; the
         allowlist that gates admin.rallypt.*; empty = nobody)
       events-api: ADMIN_USER_IDS — MUST be the SAME value as
         admin-api's (it grants owner rights on system-owned events;
         drift makes system events manageable in admin-web but 404
         in events-web)
  2. Add planner-api's VAPID keys — a DISTINCT keypair per env
     (npx tsx scripts/gen-vapid-keys.ts): VAPID_PUBLIC_KEY,
     VAPID_PRIVATE_KEY, VAPID_SUBJECT. check-vapid-isolation.sh fails
     the deploy if qa and prod share a keypair.
Optional (commercial Open-Meteo tier only): add OPEN_METEO_COMMERCIAL_API_KEY
to events-api by hand.
Note: the cross-app *_API_KEY peer keys are gone (RPC bindings replaced the
HTTP+bearer paths), and lists-mcp needs no secrets at all. R2 object-store
access keys are also not needed — the apps use native R2 bindings.

Then set the repo secret (do NOT commit the JSON file):
  gh secret set CF_WORKER_SECRETS < cf-worker-secrets.json
MSG
