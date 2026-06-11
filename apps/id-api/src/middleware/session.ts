import type { Context, MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import type { SessionRecord } from '../repos/session.js'
import type { SessionCache } from '../session/cache.js'
import { errors } from '../errors.js'
import { hashToken, readCookie } from '@rallypoint/crypto'
import { TOKEN_PREFIXES } from '@rallypoint/shared'

// Session resolution per the slice-0 namespace split:
//   /api/v1/ui/*  -> cookie only (__Host-rp_session)
//   /api/v1/sdk/* -> bearer only (Authorization: Bearer rps_live_…)
//
// Pulled out into one middleware factory so the policy is in one
// place. Cache-then-DB lookup, attach `session` and `user` to
// the Hono context for downstream handlers.

export type SessionSource = 'cookie' | 'bearer'

export interface SessionMiddlewareDeps {
  cache: SessionCache
}

// Cookie name moved to env (`env.SESSION_COOKIE_NAME`) per #20 so
// dev can drop the `__Host-` prefix (Firefox/Safari silently drop
// __Host- cookies on http://localhost). Production default stays
// `__Host-rp_session`.

export function attachSessionCache(cache: SessionCache): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    c.set('sessionCache', cache)
    await next()
  }
}

export function requireSession(source: SessionSource): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const session = await resolveSession(c, source)
    if (!session) {
      throw source === 'cookie' ? errors.sessionRequired() : errors.bearerRequired()
    }
    c.set('session', session)
    await next()
  }
}

async function resolveSession(
  c: Context<HonoApp>,
  source: SessionSource,
): Promise<SessionRecord | null> {
  const raw = extractRawToken(c, source)
  if (!raw) return null
  if (!raw.startsWith(TOKEN_PREFIXES.session)) return null

  const idHash = hashToken(raw)
  const cache = c.var.sessionCache
  if (cache) {
    const cached = cache.get(idHash)
    if (cached !== undefined) {
      return validateSession(cached)
    }
  }
  const row = await c.var.repos.sessions.findByIdHash(idHash)
  const validated = validateSession(row)
  cache?.put(idHash, validated)
  return validated
}

function validateSession(row: SessionRecord | null): SessionRecord | null {
  if (!row) return null
  if (row.absoluteExpiresAt.getTime() < Date.now()) return null
  return row
}

function extractRawToken(c: Context<HonoApp>, source: SessionSource): string | null {
  if (source === 'cookie') {
    const cookieHeader = c.req.header('cookie') ?? ''
    return readCookie(cookieHeader, c.var.env.SESSION_COOKIE_NAME)
  }
  // bearer
  const auth = c.req.header('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const tok = auth.slice('Bearer '.length).trim()
  return tok || null
}

