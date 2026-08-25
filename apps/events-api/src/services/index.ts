import { createBindingObjectStore } from '@rallypoint/object-store'
import type { R2Bucket, Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { ListsRPC } from '@rallypoint/lists-api'
import type { Logger } from '@rallypoint/logger'
import type { MoneyRPC } from '@rallypoint/money-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createRpidReauthService } from './rpid-reauth.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import { createListsClientService } from './lists-client.js'
import { createMoneyClientService } from './money-client.js'
import { createOpenMeteoProvider } from './weather/index.js'
import type { Services } from './types.js'

// `bindings` carries the Worker R2 bucket binding (native CF binding,
// ambient creds, no keys needed — #409).
// `rpc` carries the cross-Worker `Service<XRPC>` bindings exposed by the
// producer Workers (id-api, lists-api, money-api). PR 2 of
// feat/rpc-bindings: services delegate directly to typed RPC methods
// (`env.RPID.verifySession(token)` etc.), so the EVENTS_API_KEY-bearer
// HTTP path is gone and `apiBase`/`apiKey` are no longer threaded
// through. PR 3 deletes the now-unused env vars.
export function buildServices(
  env: Env,
  bindings: { objectStore: R2Bucket },
  rpc?: {
    rpid?: Service<IdRPC> | undefined
    lists?: Service<ListsRPC> | undefined
    money?: Service<MoneyRPC> | undefined
  },
  // Isolate-scoped logger. Only the id client uses it today, to report
  // a display-name lookup it degraded past instead of throwing.
  logger?: Logger,
): Services {
  // RPC bindings are required at deploy-time (the wrangler.toml
  // [[services]] blocks make wrangler refuse to boot without the
  // producers running), but the test harness `new EventsRPC(...)` path
  // instantiates this Worker with no bindings to exercise routes that
  // don't reach a sibling Worker. Build a lazy throwing stub so a
  // missing binding fails ONLY when a route actually calls into it.
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `events-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure rallypoint-id / ` +
              `rallypoint-lists / rallypoint-money are running (scripts/dev.sh boots all five) ` +
              `so wrangler's dev registry connects them.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', rpc?.rpid)
  const lists = lazyBinding('LISTS', rpc?.lists)
  const money = lazyBinding('MONEY', rpc?.money)
  return {
    idClient: createIdClientService(rpid, logger),
    rpidSso: createRpidSsoService(rpid),
    rpidReauth: createRpidReauthService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
    // Native R2 binding (bindings.objectStore) — ambient creds, private
    // bucket, bytes stream through the Worker (#409).
    objectStore: createBindingObjectStore(bindings.objectStore),
    listsClient: createListsClientService(lists),
    moneyClient: createMoneyClientService(money),
    weather: createOpenMeteoProvider({
      forecastUrl: env.OPEN_METEO_FORECAST_URL,
      airQualityUrl: env.OPEN_METEO_AIR_QUALITY_URL,
      commercialApiKey: env.OPEN_METEO_COMMERCIAL_API_KEY,
    }),
  }
}

export type { Services } from './types.js'
