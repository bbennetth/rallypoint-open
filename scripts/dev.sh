#!/usr/bin/env bash
# scripts/dev.sh — one-command local dev stack for Rallypoint (Cloudflare-native).
#
# Boots all Workers under `wrangler dev` (local D1 + R2 + Durable Objects
# via Miniflare) plus all the Vite UIs, in this terminal with prefixed logs.
# No Docker, no Postgres, no Mailpit, no MinIO — the CF migration (#313) moved
# everything onto Workers primitives:
#   • D1 (SQLite)   — local, under .wrangler/state; migrations applied below.
#   • R2            — Miniflare in-process emulator (was MinIO).
#   • Mail          — MAILER=log (the wrangler.toml default) prints every email
#                     into the [id-api] log (was Mailpit). Grab verify/reset
#                     links from there.
#
# Ctrl+C stops every server. Nothing is left running in the background.
#
# Browser:
#   http://localhost:5173   — Rallypoint ID hosted UI
#                              (use Chrome until #20 lands; Safari/Firefox
#                              silently drop __Host- cookies on http://localhost)
#   http://localhost:5174   — Rallypoint Events hosted UI
#   http://localhost:5175   — Rallypoint Lists hosted UI
#   http://localhost:5176   — Rallypoint Money hosted UI
#   http://localhost:5177   — Rallypoint Planner hosted UI
#   http://localhost:5178   — Rallypoint Health hosted UI
#   http://localhost:5179   — Rallypoint Admin hosted UI
#   http://localhost:8080   — RPID API; /api/v1/health is unauthenticated
#   http://localhost:8081   — Events API; /api/v1/health is unauthenticated
#   http://localhost:8082   — Lists API; /api/v1/health is unauthenticated
#   http://localhost:8083   — Money API; /api/v1/health is unauthenticated
#   http://localhost:8084   — Planner API; /api/v1/health is unauthenticated
#   http://localhost:8085   — Lists MCP server; /health unauthenticated, POST / is the MCP endpoint
#   http://localhost:8086   — Fitness API; /api/v1/health is unauthenticated
#   http://localhost:8087   — Admin API; /api/v1/health is unauthenticated
#   http://localhost:8088   — AI trace API (ai-api); RPC-only + /api/v1/health
#
# After the APIs go healthy, scripts/seed-dev.sh runs against id-api and
# (idempotently) seeds two dev accounts — demo@example.com and
# admin@example.com — both with password RallypointDev!2026 and 2FA code
# 000000. The seed is dev-only (gated on DEV_AUTO_VERIFY_EMAIL=true,
# DEV_SIGNIN_CODE_OVERRIDE=000000, CAPTCHA=allow in apps/id-api/.dev.vars
# below — none of those keys exist in qa/prod). You can still sign up new
# accounts via http://localhost:5173/signup at any time.

set -euo pipefail

# --- self-root so the script works from anywhere -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
cd "$REPO_ROOT"

# --- arg parsing -------------------------------------------------
case "${1:-up}" in
  up)
    ;;
  help|--help|-h)
    sed -n '2,40p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Usage: $0 [up|help]" >&2
    exit 1
    ;;
esac

# --- prerequisites ------------------------------------------------
for cmd in npm node npx curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[dev.sh] missing required command: $cmd" >&2
    exit 1
  fi
done

# --- cross-app SSO host vars for id-api (.dev.vars) --------------
# wrangler dev loads secrets from a per-app `.dev.vars` file, NOT the host
# process env. After PR 3 of feat/rpc-bindings the `*_API_KEY` Bearer
# tokens are gone (consumers reach id-api through the IdRPC binding) so
# only the `SSO_*_HOST` mint-time host allowlist remains here — the SSO
# code mint endpoint (still HTTP for browsers) needs them to validate
# return_to_host against the per-client allowlist. Generated
# idempotently; .dev.vars is gitignored.
ID_DEV_VARS="$REPO_ROOT/apps/id-api/.dev.vars"
# Append-if-missing for each DEV-only key — so an existing checkout
# that pre-dates these flags picks them up on the next `npm run
# dev:stack` instead of silently keeping a stale .dev.vars (which is
# gitignored and easy to forget). The full heredoc below still runs
# when the file is brand-new.
ensure_dev_var() {
  local key=$1 value=$2 comment=$3
  if [[ -f "$ID_DEV_VARS" ]] && ! grep -q "^${key}=" "$ID_DEV_VARS"; then
    {
      printf '\n# %s\n' "$comment"
      printf '%s=%s\n' "$key" "$value"
    } >> "$ID_DEV_VARS"
    echo "[dev.sh] added missing $key to apps/id-api/.dev.vars"
  fi
}
ensure_dev_var SSO_FITNESS_HOST localhost:5178 \
  "Dev SSO host for fitness-web; gates mint with client='fitness'."
ensure_dev_var SSO_ADMIN_HOST localhost:5179 \
  "Dev SSO host for admin-web; gates mint with client='admin'."
ensure_dev_var DEV_SIGNIN_CODE_OVERRIDE 000000 \
  "Dev-only: force every 2FA signin code to this constant (see scripts/dev.sh)."
ensure_dev_var CAPTCHA allow \
  "Dev-only: skip Turnstile siteverify (AlwaysAllowVerifier)."
ensure_dev_var DEV_AUTO_VERIFY_EMAIL true \
  "Dev-only: signups land as email_verified=true with no verify email."
# Drop the retired cross-app `*_API_KEY` lines that PR 3 of feat/rpc-bindings
# deleted (id-api no longer reads them, but a stale entry is noise for
# anyone grepping secrets on a pre-PR3 checkout).
if [[ -f "$ID_DEV_VARS" ]]; then
  for stale in EVENTS_API_KEY LISTS_API_KEY MONEY_API_KEY PLANNER_API_KEY FITNESS_API_KEY; do
    if grep -q "^${stale}=" "$ID_DEV_VARS"; then
      sed -i.bak "/^${stale}=/d" "$ID_DEV_VARS" && rm -f "$ID_DEV_VARS.bak"
      echo "[dev.sh] removed retired $stale from apps/id-api/.dev.vars"
    fi
  done
fi
if [[ ! -f "$ID_DEV_VARS" ]]; then
  echo "[dev.sh] writing apps/id-api/.dev.vars (shared dev SSO keys + hosts)..."
  cat > "$ID_DEV_VARS" <<'DEVVARS'
# Generated by scripts/dev.sh — local dev only, gitignored.
# Cross-app SSO host allowlist (required for the SSO code-mint endpoint to
# accept a return_to_host). The bearer-token gate that used to live here
# (EVENTS_API_KEY / LISTS_API_KEY / MONEY_API_KEY / PLANNER_API_KEY /
# FITNESS_API_KEY) is gone after PR 3 of feat/rpc-bindings.
SSO_EVENTS_HOST=localhost:5174
SSO_LISTS_HOST=localhost:5175
SSO_MONEY_HOST=localhost:5176
SSO_PLANNER_HOST=localhost:5177
SSO_FITNESS_HOST=localhost:5178
SSO_ADMIN_HOST=localhost:5179

# Dev-only: force every 2FA signin code to a known constant so dev
# loops can complete signin by typing the value below instead of
# fishing the random code out of the [id-api] MAILER=log output on
# every signin. NEVER set in qa/prod; absent (no override) restores
# the real random-code generator.
DEV_SIGNIN_CODE_OVERRIDE=000000

# Dev-only: skip the real Turnstile siteverify (id-api boots its
# AlwaysAllowVerifier instead). Lets scripts/seed-dev.sh signup
# demo@example.com + admin@example.com without a real captcha widget.
CAPTCHA=allow

# Dev-only: signups land as email_verified=true with no verification
# email sent. Pairs with DEV_SIGNIN_CODE_OVERRIDE so the dev:seed
# users can sign in immediately with the known 2FA code.
DEV_AUTO_VERIFY_EMAIL=true
DEVVARS
fi

# --- local D1 migrations -----------------------------------------
# `wrangler d1 migrations apply <binding> --local` reads each app's
# migrations_dir from its wrangler.toml and applies pending files to the
# local (Miniflare) D1 under .wrangler/state. Idempotent — re-runs are no-ops.
apply_migrations() {
  local app=$1
  echo "[dev.sh] applying D1 migrations for $app..."
  ( cd "apps/$app" && npx wrangler d1 migrations apply DB --local )
}
for app in id-api events-api lists-api money-api planner-api fitness-api admin-api ai-api; do
  apply_migrations "$app"
done

# --- shutdown handler --------------------------------------------
# wrangler/vite each spawn a sub-tree (npx -> node -> workerd/esbuild), so
# signalling only the top subshell leaves grandchildren alive. Walk the whole
# descendant tree and TERM each one, depth-first.
PIDS=()
kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}
cleanup() {
  trap - INT TERM HUP EXIT
  echo ""
  echo "[dev.sh] stopping all servers..."
  # `${PIDS[@]+…}` guards the empty-array case: under `set -u`, a bare
  # "${PIDS[@]}" on an empty array is an unbound-variable error on older bash
  # (e.g. macOS 3.2 / bash <4.4), which would crash cleanup itself if the trap
  # fires before any server started.
  for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
    [[ -n "$pid" ]] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
# INT = Ctrl+C; TERM = kill/ops; HUP = terminal closed; EXIT = catch-all.
trap cleanup INT TERM HUP EXIT

# --- start a Worker (wrangler dev) on an explicit port -----------
# No wrangler.toml has a [dev] port, so pass --port (bare `wrangler dev`
# defaults to :8787 and would collide). Each wrangler also opens an
# inspector socket — defaults to :9229 — so without an explicit
# `--inspector-port` per app, only the FIRST wrangler dev binds and
# every subsequent one fails with `Address already in use (127.0.0.1:9229)`.
# Derive the inspector port from the HTTP port: 8080 -> 9229, 8081 -> 9230,
# 8082 -> 9231, etc., so the per-app ranges are stable + collision-free.
# awk + fflush() prefixes each line in near-real-time without holding output
# in pipe buffers (POSIX-portable; sed -u is a GNU-only extension that fails
# on BSD/macOS sed).
start_api() {
  local app=$1 port=$2 label=$3
  local inspector_port=$((9229 + port - 8080))
  echo "[dev.sh] starting $app on :$port (inspector :$inspector_port)..."
  ( cd "apps/$app" && npx wrangler dev --port "$port" --inspector-port "$inspector_port" 2>&1 | awk -v p="[$label]" '{ print p " " $0; fflush() }' ) &
  PIDS+=($!)
}
start_web() {
  local app=$1 port=$2 label=$3
  echo "[dev.sh] starting $app on :$port..."
  ( cd "apps/$app" && npx vite --port "$port" --strictPort 2>&1 | awk -v p="[$label]" '{ print p " " $0; fflush() }' ) &
  PIDS+=($!)
}

start_api id-api      8080 id-api
start_api events-api  8081 events-api
start_api lists-api   8082 lists-api
start_api money-api   8083 money-api
start_api planner-api 8084 planner-api
# lists-mcp: the Lists MCP server Worker (RPL v1.0.0 slice 11). No D1, no
# web UI. Reaches lists-api via the Service<ListsRPC> binding (PR 2 of
# feat/rpc-bindings).
start_api lists-mcp   8085 lists-mcp
start_api fitness-api 8086 fitness-api
# admin-api: the Rallypoint Admin BFF (exercise-submission review queue).
# Set ADMIN_USER_IDS in apps/admin-api/.dev.vars to grant yourself access.
start_api admin-api   8087 admin-api
# ai-api: the AI trace-corpus owner (traces + feedback + retention). No web
# UI; fitness-api reaches it via the Service<AiRPC> binding. R2 (AI_STORE)
# is Miniflare-local, auto-created from [[r2_buckets]].
start_api ai-api      8088 ai-api

start_web id-web      5173 id-web
start_web events-web  5174 events-web
start_web lists-web   5175 lists-web
start_web money-web   5176 money-web
# Web Push needs no build-time key: planner-web and fitness-web fetch the
# VAPID public key at runtime from each API's GET /api/v1/push/public-key
# (the DEV_VAPID_* fallbacks in each API's env.ts serve it locally).
start_web planner-web 5177 planner-web
start_web fitness-web 5178 fitness-web
start_web admin-web   5179 admin-web

# --- health-wait banner ------------------------------------------
# Poll all five API /api/v1/health endpoints each iteration (not one port at a
# time — that would burn the timeout budget sequentially on a slow boot) until
# they all answer or one global ~90s budget elapses, then print the URL table.
echo "[dev.sh] waiting for the eight APIs to become healthy..."
all_apis_healthy() {
  local port
  for port in 8080 8081 8082 8083 8084 8086 8087 8088; do
    curl -fsS "http://localhost:$port/api/v1/health" >/dev/null 2>&1 || return 1
  done
  # lists-mcp exposes /health (not /api/v1/health — it's not a /api/v1 app).
  curl -fsS "http://localhost:8085/health" >/dev/null 2>&1 || return 1
  return 0
}
health_tries=0
until all_apis_healthy; do
  health_tries=$((health_tries + 1))
  if (( health_tries > 180 )); then
    echo "[dev.sh] WARNING: not all APIs were healthy within ~90s (continuing — check the logs above)." >&2
    break
  fi
  sleep 0.5
done

# --- seed demo + admin -------------------------------------------
# Idempotent: re-runs land at the same end state. Errors are non-fatal
# (the stack stays up; the user can still sign up manually at :5173).
bash "$REPO_ROOT/scripts/seed-dev.sh" || true

cat <<'BANNER'

  ============================================================
   Rallypoint dev stack is up (Cloudflare-native; Ctrl+C stops)
  ============================================================
   ID       http://localhost:5173   (API :8080)
   Events   http://localhost:5174   (API :8081)
   Lists    http://localhost:5175   (API :8082)
   Money    http://localhost:5176   (API :8083)
   Planner  http://localhost:5177   (API :8084)
   Health   http://localhost:5178   (API :8086)
   Admin    http://localhost:5179   (API :8087)
   Lists MCP  http://localhost:8085   (MCP server; /health, POST / )
   AI traces  http://localhost:8088   (RPC-only; /api/v1/health)
  ------------------------------------------------------------
   Mail -> MAILER=log: verify/reset links print in the [id-api]
   log (auto-verify is on in dev; verify links rarely needed).
   Seeded dev users (signup is also open at :5173):
     demo@example.com  / RallypointDev!2026   (2FA: 000000)
     admin@example.com / RallypointDev!2026   (2FA: 000000)
  ============================================================

BANNER

# Block until a server exits or the user Ctrl+C's (the trap handles teardown).
wait
