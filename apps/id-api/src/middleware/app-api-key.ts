import type { MiddlewareHandler } from 'hono'
import type { AppApiKeyClient, HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { constantTimeEqual } from '@rallypoint/crypto'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'

// App-API-key bearer gate for the /sdk/* endpoints product apps call
// server-to-server (SSO exchange, session re-auth, batch user lookup).
// Each product app registers its own key (EVENTS_API_KEY, LISTS_API_KEY,
// MONEY_API_KEY, PLANNER_API_KEY); the gate accepts any configured one and **binds the
// matched client identifier to `c.var.appApiKeyClient`** so downstream
// handlers can enforce per-app compartmentalisation (e.g. an EVENTS
// key can't exchange a LISTS-issued SSO code; closes #159).
//
// Same anti-fingerprint posture as the ADMIN_TOKEN gate
// (apps/id-api/src/routes/admin.ts): no keys configured at all → 404
// (route does not exist on this deployment); wrong/absent header → 403.
// Constant-time compare on every configured key — no early-return on
// match and no data-dependent skip on an empty bearer, so the
// comparison count is fixed at `keys.length` regardless of input.
// `constantTimeEqual` handles the empty / length-mismatch case
// (returns false) without leaking.
export const requireAppApiKey: MiddlewareHandler<HonoApp> = async (c, next) => {
  const candidates: Array<{ client: AppApiKeyClient; key: string }> = [
    { client: 'events' as const, key: c.var.env.EVENTS_API_KEY ?? '' },
    { client: 'lists' as const, key: c.var.env.LISTS_API_KEY ?? '' },
    { client: 'money' as const, key: c.var.env.MONEY_API_KEY ?? '' },
    { client: 'planner' as const, key: c.var.env.PLANNER_API_KEY ?? '' },
  ]
  const configured = candidates.filter((e) => e.key.length > 0)

  if (configured.length === 0) {
    throw new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
  }
  const header = c.req.header('authorization') ?? ''
  const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

  let matchedClient: AppApiKeyClient | null = null
  for (const entry of configured) {
    if (constantTimeEqual(supplied, entry.key)) matchedClient = entry.client
  }
  if (matchedClient === null) {
    throw errors.forbidden('App API authentication required.')
  }
  c.set('appApiKeyClient', matchedClient)
  await next()
}
