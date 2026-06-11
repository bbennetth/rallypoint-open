import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import type { Services } from './types.js'

// `opts` carries optional service-binding fetchers from the Worker entry
// (worker.ts). When a binding is present its fetcher dispatches the
// cross-Worker hop in-process; when absent (local `wrangler dev`) the
// clients fall back to the global fetch and the existing public-URL path.
export function buildServices(
  env: Env,
  opts?: { rpidFetch?: typeof fetch | undefined },
): Services {
  return {
    idClient: createIdClientService({ apiBase: env.RPID_API_URL, fetchImpl: opts?.rpidFetch }),
    rpidSso: createRpidSsoService({
      apiBase: env.RPID_API_URL,
      apiKey: env.LISTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    profiles: createProfilesClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.LISTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    settings: createSettingsClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.LISTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
  }
}

export type { Services } from './types.js'
