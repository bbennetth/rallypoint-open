#!/usr/bin/env bash
# Seed the local id-api with the canonical dev users — demo@example.com
# and admin@example.com. Idempotent: re-runs over existing rows land at
# the same end state (signup returns ok silently for already-existing
# users; the dev-auto-verify branch in handleSignup ensures the user
# ends up email_verified=true regardless).
#
# Depends on the dev stack's DEV-only env knobs:
#   CAPTCHA=allow             — skip the real Turnstile siteverify
#   DEV_AUTO_VERIFY_EMAIL=true — skip the verify-email email step
# Both are set by scripts/dev.sh's .dev.vars heredoc.
#
# Standalone run (rare): start `npm run dev:stack` first, then
# `bash scripts/seed-dev.sh`.

set -euo pipefail

ID_API_URL="${ID_API_URL:-http://localhost:8080}"
DEV_PASSWORD="${DEV_SEED_PASSWORD:-RallypointDev!2026}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "[seed-dev] WARNING: jq is required to parse the CSRF response; install jq and re-run." >&2
  exit 1
fi

# CSRF double-submit. Issue a token (sets rp_csrf cookie + returns
# value in body), then echo the same token in the X-RP-CSRF header
# on every state-changing POST. Parse via jq — a sed regex against
# the raw JSON would silently extract garbage if the response shape
# ever shifts, which lands as a 403 the caller can't diagnose.
echo "[seed-dev] fetching CSRF token from $ID_API_URL ..."
CSRF_TOKEN=$(curl -fsS -c "$COOKIE_JAR" "$ID_API_URL/api/v1/ui/csrf" \
  | jq -r '.csrfToken // empty')
if [[ -z "$CSRF_TOKEN" ]]; then
  echo "[seed-dev] WARNING: could not get a CSRF token (id-api not up?)" >&2
  exit 1
fi

signup() {
  local email=$1 name=$2
  # CAPTCHA=allow in .dev.vars makes the token value irrelevant
  # server-side; pass a marker string for clarity in audit logs.
  local payload
  payload=$(printf '{"email":%s,"password":%s,"name":%s,"captchaToken":"dev-seed-skip"}' \
    "\"$email\"" "\"$DEV_PASSWORD\"" "\"$name\"")
  local body
  # The /api/v1/ui/* origin allowlist (middleware/origin.ts, E1 #19)
  # rejects state-changing POSTs with no Origin header. Send the API's
  # own origin — PUBLIC_BASE_URL, which ID_API_URL equals in dev — since
  # it's on the allowlist alongside UI_ORIGIN.
  body=$(curl -fsS -X POST "$ID_API_URL/api/v1/ui/signup" \
    -b "$COOKIE_JAR" \
    -H 'content-type: application/json' \
    -H "x-rp-csrf: $CSRF_TOKEN" \
    -H "origin: $ID_API_URL" \
    -H 'user-agent: rallypoint-dev-seed/1.0' \
    -d "$payload") || {
    echo "[seed-dev] WARNING: signup for $email failed (id-api not up?)" >&2
    return 1
  }
  echo "[seed-dev] $email -> ${body}"
}

echo "[seed-dev] seeding demo + admin against $ID_API_URL ..."
signup 'demo@example.com'  'Demo User'  || true
signup 'admin@example.com' 'Admin User' || true
echo "[seed-dev] done. Password for both accounts: $DEV_PASSWORD"
