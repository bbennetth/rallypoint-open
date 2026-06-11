import type { RpidReauthService } from './types.js'

// Calls RPID's password step-up (apps/id-api POST
// /api/v1/sdk/session/reauth, added in this same slice). Body
// `{ user_id, password }`, auth via the EVENTS_API_KEY bearer.
//   200 { ok:true }            → { ok:true }
//   401                        → { ok:false, reason:'reauth_failed' }
// Anything else throws (transport, 5xx, unset/wrong key).

export function createRpidReauthService(opts: {
  apiBase: string
  apiKey: string
  // `| undefined` so callers can pass through an absent service binding
  // under exactOptionalPropertyTypes; internally defaults to global fetch.
  fetchImpl?: typeof fetch | undefined
}): RpidReauthService {
  const base = opts.apiBase.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  return {
    async verify(userId, password) {
      let res: Response
      try {
        res = await doFetch(`${base}/api/v1/sdk/session/reauth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ user_id: userId, password }),
        })
      } catch (err) {
        throw new Error('rpid_reauth_transport_error', { cause: err })
      }
      if (res.status === 200) return { ok: true }
      if (res.status === 401) return { ok: false, reason: 'reauth_failed' }
      throw new Error(`rpid_reauth_unexpected_status_${res.status}`)
    },
  }
}
