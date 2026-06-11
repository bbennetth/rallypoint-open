import type { Fetcher } from '@cloudflare/workers-types'
import type { RealtimeBus, RealtimeHubNamespace } from '@rallypoint/realtime'
import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Type-level extension of Hono's request context. build-app wires
// env + logger + requestId + repos + services + realtime at boot; the
// session middleware sets `session` on authenticated routes.

export interface SessionContext {
  idHash: string
  userId: string
}

export type HonoVars = {
  env: Env
  logger: Logger
  requestId: string
  repos: Repos
  services: Services
  realtime: RealtimeBus
  // The RealtimeHub Durable Object namespace (Phase 4). Present only
  // where a DO binding exists (the Worker / Miniflare tests); the
  // WebSocket-upgrade route 503s without it.
  hub?: RealtimeHubNamespace
  // Set by requireSession; absent on public routes.
  session?: SessionContext
}

// Runtime bindings exposed on `c.env` (worker.ts calls `app.fetch(request,
// env, ctx)`, so Hono's `c.env` is the Worker env). The public-html route
// reads the events-web SPA shell through the static-assets binding; it is
// optional because non-Worker contexts (the `app.request(...)` test helper)
// don't supply it.
export type HonoBindings = {
  ASSETS?: Fetcher
}

export type HonoApp = {
  Bindings: HonoBindings
  Variables: HonoVars
}
