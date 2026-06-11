import { createBindingObjectStore } from '@rallypoint/object-store'
import { createListsClient } from '@rallypoint/lists-client'
import { createMoneyClient } from '@rallypoint/money-client'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createRpidReauthService } from './rpid-reauth.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import { createOpenMeteoProvider } from './weather/index.js'
import type { Services } from './types.js'

// `bindings` carries the Worker R2 bucket binding (native CF binding,
// ambient creds, no keys needed — #409).
// `opts` carries optional service-binding fetchers from the Worker entry
// (worker.ts) — one per same-account dependency (id, lists, money). When a
// binding is present its fetcher dispatches the cross-Worker hop in-process;
// when absent (local `wrangler dev`) the clients fall back to the global
// fetch and the existing public-URL path.
export function buildServices(
  env: Env,
  bindings: { objectStore: R2Bucket },
  opts?: {
    rpidFetch?: typeof fetch | undefined
    listsFetch?: typeof fetch | undefined
    moneyFetch?: typeof fetch | undefined
  },
): Services {
  // The lists/money client configs take `fetch?` without an explicit
  // `| undefined`, so spread the key in only when a binding is present
  // (exactOptionalPropertyTypes); absent → the client uses global fetch.
  const listsFetchOpt = opts?.listsFetch ? { fetch: opts.listsFetch } : {}
  const moneyFetchOpt = opts?.moneyFetch ? { fetch: opts.moneyFetch } : {}
  return {
    idClient: createIdClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.EVENTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    rpidSso: createRpidSsoService({
      apiBase: env.RPID_API_URL,
      apiKey: env.EVENTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    rpidReauth: createRpidReauthService({
      apiBase: env.RPID_API_URL,
      apiKey: env.EVENTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    profiles: createProfilesClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.EVENTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    settings: createSettingsClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.EVENTS_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    // Native R2 binding (bindings.objectStore) — ambient creds, private
    // bucket, bytes stream through the Worker (#409).
    objectStore: createBindingObjectStore(bindings.objectStore),
    listsClient: createListsClient({
      baseUrl: env.LISTS_API_URL,
      apiKey: env.EVENTS_API_KEY,
      ...listsFetchOpt,
    }),
    moneyClient: createMoneyClient({
      baseUrl: env.MONEY_API_URL,
      apiKey: env.EVENTS_API_KEY,
      ...moneyFetchOpt,
    }),
    weather: createOpenMeteoProvider({
      forecastUrl: env.OPEN_METEO_FORECAST_URL,
      airQualityUrl: env.OPEN_METEO_AIR_QUALITY_URL,
      commercialApiKey: env.OPEN_METEO_COMMERCIAL_API_KEY,
    }),
  }
}

export type { Services } from './types.js'
