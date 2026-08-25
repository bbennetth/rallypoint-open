import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import { SettingsError } from '@rallypoint/id-client'
import type { SettingsClientService } from './types.js'
import type { RpcReturn } from './_rpc.js'

// Delegates to the `Service<IdRPC>` binding's settings methods. The
// `client: 'events'` caller hint is what id-api uses to enforce the
// per-app namespace allowlist (events may access its own + the shared
// `'shared'` bag); a `forbidden` result becomes the legacy
// `SettingsError('forbidden')` so call sites keep their catch shape.

export { SettingsError }

export function createSettingsClientService(binding: Service<IdRPC>): SettingsClientService {
  return {
    async get(userId, namespace) {
      const result = (await binding.getSettings(userId, namespace, { client: 'events' })) as RpcReturn<
        IdRPC['getSettings']
      >
      if (result.kind === 'forbidden') {
        throw new SettingsError(403, 'forbidden', 'App may not access this settings namespace.')
      }
      return result.settings
    },
    async patch(userId, namespace, patch) {
      const result = (await binding.patchSettings(userId, namespace, patch, {
        client: 'events',
      })) as RpcReturn<IdRPC['patchSettings']>
      if (result.kind === 'forbidden') {
        throw new SettingsError(403, 'forbidden', 'App may not access this settings namespace.')
      }
      return result.settings
    },
  }
}
