import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { EventsRPC } from '@rallypoint/events-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import {
  createExerciseCatalogAdminService,
  createFitnessAdminService,
  createFoodSubmissionAdminService,
} from './fitness.js'
import { createSystemEventsAdminService } from './events.js'
import type { Services } from './types.js'

// `opts` carries the typed `Service<IdRPC>` + `Service<FitnessRPC>` bindings
// from the Worker entry (worker.ts). Services delegate directly to the RPC
// bindings (feat/rpc-bindings pattern) — there is no HTTP fallback path.
export function buildServices(
  _env: Env,
  opts?: {
    rpid?: Service<IdRPC> | undefined
    fitness?: Service<FitnessRPC> | undefined
    events?: Service<EventsRPC> | undefined
  },
): Services {
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `admin-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure the producer Worker is running.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', opts?.rpid)
  const fitness = lazyBinding('FITNESS', opts?.fitness)
  const events = lazyBinding('EVENTS', opts?.events)
  return {
    idClient: createIdClientService(rpid),
    rpidSso: createRpidSsoService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
    fitness: createFitnessAdminService(fitness),
    foodSubmissions: createFoodSubmissionAdminService(fitness),
    exerciseCatalog: createExerciseCatalogAdminService(fitness),
    systemEvents: createSystemEventsAdminService(events),
  }
}

export type { Services } from './types.js'
