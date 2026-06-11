import { createBindingObjectStore } from '@rallypoint/object-store'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import type { Services } from './types.js'

// `opts` carries optional service-binding fetchers and the R2 bucket binding
// from the Worker entry (worker.ts).
export function buildServices(
  env: Env,
  opts?: { rpidFetch?: typeof fetch | undefined; objectStore?: R2Bucket },
): Services {
  if (!opts?.objectStore) {
    throw new Error('buildServices: objectStore R2Bucket binding is required (#409)')
  }
  return {
    idClient: createIdClientService({ apiBase: env.RPID_API_URL, fetchImpl: opts?.rpidFetch }),
    rpidSso: createRpidSsoService({
      apiBase: env.RPID_API_URL,
      apiKey: env.MONEY_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    profiles: createProfilesClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.MONEY_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    settings: createSettingsClientService({
      apiBase: env.RPID_API_URL,
      apiKey: env.MONEY_API_KEY,
      fetchImpl: opts?.rpidFetch,
    }),
    // Native R2 binding (env.OBJECT_STORE) — ambient creds, private
    // bucket, bytes stream through the Worker (#409).
    objectStore: createBindingObjectStore(opts.objectStore),
  }
}

export type { Services } from './types.js'
