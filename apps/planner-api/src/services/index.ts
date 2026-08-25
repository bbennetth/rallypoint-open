import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { ListsRPC } from '@rallypoint/lists-api'
import type { EventsRPC } from '@rallypoint/events-api'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import { createListsClientFromBinding } from '@rallypoint/lists-rpc-client'
import { createEventsClientFromBinding } from './events-client-rpc.js'
import { createFitnessClientFromBinding } from './fitness-client-rpc.js'
import { createWebPushService } from './push.js'
import type { Services } from './types.js'

// `rpc` carries the typed `Service<XRPC>` bindings from the Worker entry
// (worker.ts). All four producers (id/lists/events/fitness) are reached
// through their RPC entrypoints — the last HTTP+API-key path (fitness)
// was retired when fitness-api caught up to feat/rpc-bindings.
export function buildServices(
  env: Env,
  rpc?: {
    rpid?: Service<IdRPC> | undefined
    lists?: Service<ListsRPC> | undefined
    events?: Service<EventsRPC> | undefined
    fitness?: Service<FitnessRPC> | undefined
  },
): Services {
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `planner-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure all four producers are running ` +
              `(scripts/dev.sh boots all six) so wrangler's dev registry connects them.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', rpc?.rpid)
  const lists = lazyBinding('LISTS', rpc?.lists)
  const events = lazyBinding('EVENTS', rpc?.events)
  const fitness = lazyBinding('FITNESS', rpc?.fitness)
  return {
    idClient: createIdClientService(rpid),
    rpidSso: createRpidSsoService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
    listsClient: createListsClientFromBinding(lists),
    eventsClient: createEventsClientFromBinding(events),
    fitnessClient: createFitnessClientFromBinding(fitness),
    webPush: createWebPushService({
      vapid: {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },
    }),
  }
}

export type { Services } from './types.js'
