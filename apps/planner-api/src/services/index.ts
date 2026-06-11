import { createListsClient } from '@rallypoint/lists-client'
import { createEventsClient } from '@rallypoint/events-client'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import type { Services } from './types.js'

// `opts` carries optional service-binding fetchers from the Worker entry
// (worker.ts) — one per same-account dependency (id, lists, events). When a
// binding is present its fetcher dispatches the cross-Worker hop in-process;
// when absent (local `wrangler dev`) the clients fall back to the global
// fetch and the existing public-URL path.
export function buildServices(
  env: Env,
  opts?: {
    rpidFetch?: typeof fetch | undefined
    listsFetch?: typeof fetch | undefined
    eventsFetch?: typeof fetch | undefined
  },
): Services {
  // The lists/events client configs take `fetch?` without an explicit
  // `| undefined`, so spread the key in only when a binding is present
  // (exactOptionalPropertyTypes); absent → the client uses global fetch.
  const listsFetchOpt = opts?.listsFetch ? { fetch: opts.listsFetch } : {}
  const eventsFetchOpt = opts?.eventsFetch ? { fetch: opts.eventsFetch } : {}
  return {
    idClient: createIdClientService({ apiBase: env.RPID_API_URL, fetchImpl: opts?.rpidFetch }),
    rpidSso: createRpidSsoService({
      apiBase: env.RPID_API_URL,
      apiKey: env.PLANNER_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    profiles: createProfilesClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.PLANNER_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    settings: createSettingsClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.PLANNER_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    listsClient: createListsClient({
      baseUrl: env.LISTS_API_URL,
      apiKey: env.PLANNER_API_KEY,
      ...listsFetchOpt,
    }),
    eventsClient: createEventsClient({
      baseUrl: env.EVENTS_API_URL,
      apiKey: env.PLANNER_API_KEY,
      ...eventsFetchOpt,
    }),
  }
}

export type { Services } from './types.js'
