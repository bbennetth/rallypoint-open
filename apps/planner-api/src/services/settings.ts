import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import { SettingsError } from '@rallypoint/id-client'
import type { SettingsClientService } from './types.js'
import type { RpcReturn } from './_rpc.js'

export { SettingsError }

export function createSettingsClientService(binding: Service<IdRPC>): SettingsClientService {
  return {
    async get(userId, namespace) {
      const result = (await binding.getSettings(userId, namespace, { client: 'planner' })) as RpcReturn<
        IdRPC['getSettings']
      >
      if (result.kind === 'forbidden') {
        throw new SettingsError(403, 'forbidden', 'App may not access this settings namespace.')
      }
      return result.settings
    },
    async patch(userId, namespace, patch) {
      const result = (await binding.patchSettings(userId, namespace, patch, {
        client: 'planner',
      })) as RpcReturn<IdRPC['patchSettings']>
      if (result.kind === 'forbidden') {
        throw new SettingsError(403, 'forbidden', 'App may not access this settings namespace.')
      }
      return result.settings
    },
  }
}
