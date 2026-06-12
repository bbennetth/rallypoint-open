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
# pepper keys, admin token, and the cross-app *_API_KEY peer keys) with
# `openssl rand -base64 32`. The shared *_API_KEY values are generated ONCE
# per env and copied into every app that needs them (id-api is the authority).
#
# Keys that must come from a third party are emitted as the literal
# placeholder REPLACE_ME (override with $CF_SECRETS_PLACEHOLDER) — you fill
# these by hand before pushing:
#   RESEND_API_KEY            (Resend dashboard)
#   TURNSTILE_SECRET          (Cloudflare Turnstile dashboard)
# OPEN_METEO_COMMERCIAL_API_KEY is optional (commercial weather tier only) and
# is intentionally omitted — add it to events-api by hand if you use that tier.
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
# (a `": ""` in the output means a generation failure). Cross-app peer keys are
# generated once here and copied into each app that authenticates against them
# (id-api is the authority); REALTIME_TOKEN_HMAC_KEY is per-app independent.
emit_env_block() {
  local argon2_pepper session_hmac signin_hmac admin_token
  local events_api_key lists_api_key money_api_key planner_api_key
  local lists_session events_session money_session planner_session
  local lists_rt events_rt money_rt
  argon2_pepper=$(rnd); session_hmac=$(rnd); signin_hmac=$(rnd); admin_token=$(rnd)
  local mcp_api_key
  events_api_key=$(rnd); lists_api_key=$(rnd)
  money_api_key=$(rnd); planner_api_key=$(rnd)
  # The Lists MCP Worker's key — the same value lives under lists-api
  # (MCP_API_KEY, accepted by its /sdk gate) and lists-mcp (LISTS_MCP_API_KEY,
  # what the Worker presents). RPL v1.0.0 slice 11.
  mcp_api_key=$(rnd)
  lists_session=$(rnd); events_session=$(rnd); money_session=$(rnd); planner_session=$(rnd)
  lists_rt=$(rnd); events_rt=$(rnd); money_rt=$(rnd)

  cat <<JSON
{
    "id-api": {
      "ARGON2_PEPPER": "${argon2_pepper}",
      "SESSION_HMAC_KEY": "${session_hmac}",
      "SIGNIN_CODE_HMAC_KEY": "${signin_hmac}",
      "EVENTS_API_KEY": "${events_api_key}",
      "LISTS_API_KEY": "${lists_api_key}",
      "MONEY_API_KEY": "${money_api_key}",
      "PLANNER_API_KEY": "${planner_api_key}",
      "ADMIN_TOKEN": "${admin_token}",
      "RESEND_API_KEY": "${PLACEHOLDER}",
      "TURNSTILE_SECRET": "${PLACEHOLDER}"
    },
    "lists-api": {
      "LISTS_API_KEY": "${lists_api_key}",
      "LISTS_SESSION_KEY_V1": "${lists_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${lists_rt}",
      "EVENTS_API_KEY": "${events_api_key}",
      "PLANNER_API_KEY": "${planner_api_key}",
      "MCP_API_KEY": "${mcp_api_key}"
    },
    "lists-mcp": {
      "LISTS_MCP_API_KEY": "${mcp_api_key}"
    },
    "events-api": {
      "EVENTS_API_KEY": "${events_api_key}",
      "PLANNER_API_KEY": "${planner_api_key}",
      "EVENTS_SESSION_KEY_V1": "${events_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${events_rt}"
    },
    "money-api": {
      "MONEY_API_KEY": "${money_api_key}",
      "EVENTS_API_KEY": "${events_api_key}",
      "MONEY_SESSION_KEY_V1": "${money_session}",
      "REALTIME_TOKEN_HMAC_KEY": "${money_rt}"
    },
    "planner-api": {
      "PLANNER_API_KEY": "${planner_api_key}",
      "PLANNER_SESSION_KEY_V1": "${planner_session}"
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

gen-cf-secrets: random + peer keys filled in. Before pushing, replace every
REPLACE_ME with the real third-party credential:
  id-api: RESEND_API_KEY, TURNSTILE_SECRET
Optional (commercial Open-Meteo tier only): add OPEN_METEO_COMMERCIAL_API_KEY
to events-api by hand.
Note: R2 object-store access keys are no longer in this template — the apps
use native R2 bindings (OBJECT_STORE via [[r2_buckets]] in wrangler.toml).

Then set the repo secret (do NOT commit the JSON file):
  gh secret set CF_WORKER_SECRETS < cf-worker-secrets.json
MSG
