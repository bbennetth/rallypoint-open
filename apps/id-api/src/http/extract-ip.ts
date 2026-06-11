import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { extractIp } from '@rallypoint/crypto'

// Re-export the pure pieces from @rallypoint/crypto so all imports
// inside id-api keep working without changes.
export { extractIp, type TrustPolicy, type ExtractIpInput } from '@rallypoint/crypto'

// Context-aware adapter. Pulls the trust policy from env. On Cloudflare
// Workers the client IP is the `cf-connecting-ip` header (the prod
// policy), so there is no socket-address fallback — `@hono/node-server`'s
// getConnInfo was Node-only and is gone with the Node entrypoint (it
// would also break the Worker bundle). The header-based policies
// ('cf-connecting-ip'/'xff'/'legacy') are unaffected; 'none' (no proxy)
// falls back to 0.0.0.0, which on Workers is unreachable anyway.
export function extractIpFromContext(c: Context<HonoApp>): string {
  return extractIp({
    headers: c.req.raw.headers,
    policy: c.var.env.TRUSTED_PROXY_HEADER,
    socketAddr: null,
  })
}
