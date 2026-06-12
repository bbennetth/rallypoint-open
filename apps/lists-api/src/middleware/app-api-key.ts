import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import type { Env } from '../env.js'
import { ApiError, errors } from '../errors.js'
import { constantTimeEqual } from '@rallypoint/crypto'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'

// App-API-key bearer gate for the /api/v1/sdk/* endpoints peer apps call
// server-to-server. A group list's scope_id is an opaque Events group_id that
// lists-api cannot authorize against (no group table here), so the SDK trusts
// that a holder of a configured peer-app key has already authorized the
// request on its side. Two peers are recognised: events-api (EVENTS_API_KEY,
// group-lists reads) and planner-api (PLANNER_API_KEY, personal task-list
// reads + writes). Same anti-fingerprint posture as RPID's gate
// (apps/id-api/.../app-api-key.ts): if NONE of the named keys are configured
// → 404 (route does not exist on this deployment), wrong/absent header → 403.
// Constant-time compare on the match.

// Parameterised factory: `keys` names which env vars to accept as valid bearer
// tokens for the route group. Reads the named keys from the request-scoped env
// (c.var.env), filters to those that are configured + non-empty, then applies
// the anti-fingerprint / constant-time-compare posture.
export function requireSdkKey(
  opts: { keys: Array<'EVENTS_API_KEY' | 'PLANNER_API_KEY' | 'MCP_API_KEY'> },
): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const envObj: Env = c.var.env
    const keys = opts.keys
      .map((name) => envObj[name])
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
    if (keys.length === 0) {
      throw new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
    }
    const header = c.req.header('authorization') ?? ''
    const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    // Compare against every configured key with no early-return on match, so a
    // match's position in the pool isn't observable. constantTimeEqual is
    // content-constant-time but returns false on a length mismatch, so the
    // configured key's *length* is still inferable by timing — an accepted
    // tradeoff shared with RPID's gate; the secret bytes never leak.
    let matched = false
    for (const key of keys) {
      if (constantTimeEqual(supplied, key)) matched = true
    }
    if (!matched) throw errors.forbidden('App API authentication required.')
    await next()
  }
}

// The three read paths that events-api is authorised to call. Any other
// /api/v1/sdk/* path requires the PLANNER_API_KEY. Using a single
// combined middleware avoids double-gating the paths that carry both
// GET (events-accessible) and mutating methods (planner-only) on the
// same URL.
const EVENTS_READ_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/sdk/lists',
  'GET /api/v1/sdk/lists/:listId/items',
  'GET /api/v1/sdk/lists/:listId/fields',
])

// Hono stores the matched route pattern (not the resolved URL) on
// `c.req.routePath` after routing, but middleware fires BEFORE route
// handlers, so `routePath` is the **raw path** at middleware time.
// We match on `c.req.method + ' ' + pathWithoutQuery` instead.
function normalizeRawPath(rawPath: string): string {
  // Strip query string — Hono's req.path does this already, but defensive.
  const q = rawPath.indexOf('?')
  return q === -1 ? rawPath : rawPath.slice(0, q)
}

// Build the canonical route-pattern key for a live request by replacing
// path segments that look like entity ids (contain an underscore, e.g.
// `lst_01ABCD…`, `lse_01ABCD…`) with their Hono param placeholder.
// This covers the three events-api read routes without requiring us to
// maintain a parallel URL parser.
function routeKey(method: string, rawPath: string): string {
  const path = normalizeRawPath(rawPath)
  const segments = path.split('/')
  const normalized = segments.map((seg) => {
    // Entity id segments follow the `<prefix>_<ulid>` pattern. Replace
    // with the param placeholder used in EVENTS_READ_ROUTES so the Set
    // lookup works regardless of the actual id value.
    // Allow underscores within the id body (e.g. `lst_does_not_exist` in
    // tests) so fake / non-ULID ids are still normalised correctly.
    if (/^[a-z]+_[A-Za-z0-9_]+$/.test(seg)) return ':listId'
    return seg
  })
  return `${method} ${normalized.join('/')}`
}

// Single combined gate for the entire /api/v1/sdk/* surface. The three
// read routes events-api calls accept either configured key; everything
// else requires PLANNER_API_KEY only. Applied once in build-app.ts via
// app.use('/api/v1/sdk/*', sdkKeyGate) so there is no double-gating.
export const sdkKeyGate: MiddlewareHandler<HonoApp> = async (c, next) => {
  const isEventsRead = EVENTS_READ_ROUTES.has(routeKey(c.req.method, c.req.path))
  // Events read routes accept either events or planner keys. Every other
  // /sdk/* route (the write surface + the MCP resolve-token + MCP-driven
  // item/comment writes) accepts the planner key OR the MCP Worker's key.
  const keyNames: Array<'EVENTS_API_KEY' | 'PLANNER_API_KEY' | 'MCP_API_KEY'> = isEventsRead
    ? ['EVENTS_API_KEY', 'PLANNER_API_KEY']
    : ['PLANNER_API_KEY', 'MCP_API_KEY']
  await requireSdkKey({ keys: keyNames })(c, next)
}
