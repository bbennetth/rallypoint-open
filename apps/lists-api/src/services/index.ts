import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import type { Services } from './types.js'

// `rpc` carries the typed `Service<IdRPC>` binding from the Worker entry
// (worker.ts). PR 2 of feat/rpc-bindings: services delegate directly to
// IdRPC's typed methods; the legacy LISTS_API_KEY-bearer HTTP path is
// gone. PR 3 deletes the now-unused env vars.
export function buildServices(
  env: Env,
  rpc?: { rpid?: Service<IdRPC> | undefined },
): Services {
  // See apps/events-api/src/services/index.ts for the rationale: a
  // missing binding shouldn't crash the Worker boot — only the route
  // that calls into it should fail. Lazy throwing stub.
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `lists-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure rallypoint-id is ` +
              `running (scripts/dev.sh boots all five) so wrangler's dev registry ` +
              `connects them.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', rpc?.rpid)
  void env
  return {
    idClient: createIdClientService(rpid),
    rpidSso: createRpidSsoService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
  }
}

export type { Services } from './types.js'
