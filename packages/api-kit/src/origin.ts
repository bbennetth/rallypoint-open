import type { MiddlewareHandler } from 'hono'

// Origin allowlist for /api/v1/ui/* (docs/design/api-namespaces-cors.md).
// Hardened variant (E1 #19, 2026-06-24 audit):
//   - State-changing requests (POST/PUT/PATCH/DELETE) MUST carry an Origin
//     header. Browsers always send it on cross-origin writes; non-browser
//     clients that omit it are rejected — CSRF double-submit is no longer the
//     sole defense.
//   - Safe requests (GET/HEAD/OPTIONS) still pass without an Origin header
//     (browsers omit it on same-origin GETs; server-side reads have none).
//   - A present Origin (any method) must match one of the configured allowed
//     origins, else 403.
//
// Copy-pasted across the HTTP APIs (differing by the UI-origin env var, and —
// before this extraction — by whether the state-changing-requires-Origin
// hardening had been applied at all: admin-api and fitness-api still ran the
// weaker legacy variant). Extracting the hardened variant lifts those two to
// match their five siblings.

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface RequireAllowedOriginConfig {
  /**
   * Env keys whose values are the allowed origins. Single-origin apps pass one
   * key (e.g. `['EVENTS_UI_ORIGIN']`); id-api passes two (`['UI_ORIGIN',
   * 'PUBLIC_BASE_URL']`) because its inline /verify-email page is served by the
   * API and POSTs back to the API's own origin.
   */
  allowedOriginEnvKeys: string[]
  /** App error factory — thrown so the app's error handler formats it. */
  errors: { forbidden(message: string): Error }
}

interface OriginCtxVars {
  env: Record<string, unknown>
}

export function createRequireAllowedOrigin(
  config: RequireAllowedOriginConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) {
      if (STATE_CHANGING_METHODS.has(c.req.method.toUpperCase())) {
        throw config.errors.forbidden('Origin header required for state-changing requests.')
      }
      return next()
    }
    const vars = c.var as unknown as OriginCtxVars
    const allowed = new Set(config.allowedOriginEnvKeys.map((key) => String(vars.env[key])))
    if (!allowed.has(origin)) {
      throw config.errors.forbidden(`Origin not allowed: ${origin}`)
    }
    await next()
  }
}
