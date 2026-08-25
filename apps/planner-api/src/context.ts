import type { AiTracesRpc } from '@rallypoint/ai'
import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import type { AiBinding } from './services/assist.js'

// Type-level extension of Hono's request context. build-app wires
// env + logger + requestId + repos + services at boot; the session
// middleware sets `session` on authenticated routes.

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
  // Set by requireSession; absent on public routes.
  session?: SessionContext
  // Set by requireSession ONLY when the offline-grace branch fires
  // (E4 O2): id-api was unreachable but the row's last_verified_at
  // is still within SESSION_OFFLINE_TTL_HOURS. Handlers that need
  // hard freshness (admin / financial writes / token-rotation paths)
  // can opt out by inspecting this flag and returning 503.
  offlineGrace?: boolean
}

// Raw Worker bindings reachable via Hono's `c.env`. Most of planner-api's
// upstreams go through the Services bag; AI Assist is the exception — its
// Workers AI + trace bindings are read straight off `c.env` (see
// routes/assist.ts) so they don't have to be threaded through every Services
// fake. Both are optional: a deployment without Workers AI has no AI binding,
// and AI_TRACES absent just means assist runs untraced.
export interface WorkerBindings {
  AI?: AiBinding
  AI_TRACES?: AiTracesRpc
  [key: string]: unknown
}

export type HonoApp = {
  Variables: HonoVars
  Bindings: WorkerBindings
}
