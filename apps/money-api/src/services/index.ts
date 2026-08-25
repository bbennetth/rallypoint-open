import { createBindingObjectStore } from '@rallypoint/object-store'
import type { R2Bucket, Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import type { Services } from './types.js'

// `opts` carries the Worker R2 bucket binding and the typed
// `Service<IdRPC>` binding from worker.ts. PR 2 of feat/rpc-bindings:
// services delegate directly to IdRPC; the MONEY_API_KEY-bearer HTTP
// path is gone.
export function buildServices(
  env: Env,
  opts?: { rpid?: Service<IdRPC> | undefined; objectStore?: R2Bucket },
): Services {
  if (!opts?.objectStore) {
    throw new Error('buildServices: objectStore R2Bucket binding is required (#409)')
  }
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `money-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure rallypoint-id is running.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', opts.rpid)
  void env
  return {
    idClient: createIdClientService(rpid),
    rpidSso: createRpidSsoService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
    objectStore: createBindingObjectStore(opts.objectStore),
  }
}

export type { Services } from './types.js'
