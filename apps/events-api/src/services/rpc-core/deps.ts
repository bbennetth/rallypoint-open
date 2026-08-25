import type { Env } from '../../env.js'
import type { Logger } from '../../logger.js'
import type { Repos } from '../../repos/types.js'
import type { Services } from '../types.js'
import type { RealtimeBus, RealtimeHubNamespace } from '@rallypoint/realtime'

// Deps shape every events-api RPC core fn takes. Mirrors the subset of
// `c.var` the legacy HTTP handlers read. `realtime` is the publish bus —
// some core fns (planner-prefs, etc.) emit envelopes; reads don't.
export interface EventsRpcDeps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
  realtime: RealtimeBus
  hub?: RealtimeHubNamespace
}
