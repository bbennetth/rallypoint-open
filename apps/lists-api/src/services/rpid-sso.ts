import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import { createRpidSsoService as createSharedRpidSso, type SsoExchangeBinding } from '@rallypoint/api-kit'
import type { RpidSsoService } from './types.js'

// Thin wrapper over the shared @rallypoint/api-kit factory (R2 dedup).
export function createRpidSsoService(binding: Service<IdRPC>): RpidSsoService {
  return createSharedRpidSso(binding as unknown as SsoExchangeBinding, 'lists')
}
