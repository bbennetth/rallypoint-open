import { getSettings, patchSettings, SettingsError } from '@rallypoint/id-client'
import type { UserId } from '@rallypoint/shared'
import type { SettingsClientService } from './types.js'

// Wraps the @rallypoint/id-client generic settings SDK, presenting
// LISTS_API_KEY as the caller and forwarding the session user as the
// `x-actor` subject. RPID enforces the namespace access rule against the
// app key's client ('lists') plus the shared cross-app bag; this
// wrapper just plumbs the bearer + subject through.

export { SettingsError }

export function createSettingsClientService(opts: {
  apiBase: string
  apiKey: string
  // Optional fetch override — a Cloudflare service-binding fetcher when one
  // is bound (RPID), else the global fetch. The id-client settings SDK
  // accepts the override as `fetch`. `| undefined` so the caller can pass
  // through an absent binding under exactOptionalPropertyTypes.
  fetchImpl?: typeof fetch | undefined
}): SettingsClientService {
  // Spread `fetch` in only when present so the SDK's `fetch?` (no explicit
  // `| undefined`) isn't handed undefined; absent → SDK global fetch.
  const fetchOpt = opts.fetchImpl ? { fetch: opts.fetchImpl } : {}
  return {
    async get(userId, namespace) {
      return getSettings({
        baseUrl: opts.apiBase,
        apiKey: opts.apiKey,
        userId: userId as UserId,
        namespace,
        ...fetchOpt,
      })
    },
    async patch(userId, namespace, patch) {
      return patchSettings({
        baseUrl: opts.apiBase,
        apiKey: opts.apiKey,
        userId: userId as UserId,
        namespace,
        patch,
        ...fetchOpt,
      })
    },
  }
}
