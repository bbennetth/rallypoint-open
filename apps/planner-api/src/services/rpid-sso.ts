import type { RpidSsoService, SsoExchangeResult } from './types.js'

// Calls RPID's SSO exchange. Body `{ code }`, auth via the
// PLANNER_API_KEY bearer. Documented outcomes:
//   200 → the user + freshly-minted RPID session bearer
//   400 sso_code_invalid          → { ok:false, reason:'invalid' }
//   409 sso_code_already_consumed → { ok:false, reason:'already_consumed' }
// Anything else (transport, 5xx, unset/wrong key → 404/403) throws.

interface ExchangeResponseBody {
  user_id: string
  email: string
  email_verified: boolean
  display_name: string | null
  first_name: string | null
  last_name: string | null
  picture_url: string | null
  username: string
  session_bearer: string
  session_absolute_expires_at: string
}

export function createRpidSsoService(opts: {
  apiBase: string
  apiKey: string
  // `| undefined` so callers can pass through an absent service binding
  // under exactOptionalPropertyTypes; internally defaults to global fetch.
  fetchImpl?: typeof fetch | undefined
}): RpidSsoService {
  const base = opts.apiBase.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  return {
    async exchange(code) {
      let res: Response
      try {
        res = await doFetch(`${base}/api/v1/sdk/sso/exchange`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ code }),
        })
      } catch (err) {
        throw new Error('rpid_sso_transport_error', { cause: err })
      }
      if (res.status === 200) {
        const b = (await res.json()) as ExchangeResponseBody
        const result: SsoExchangeResult = {
          userId: b.user_id,
          email: b.email,
          emailVerified: b.email_verified,
          displayName: b.display_name,
          firstName: b.first_name,
          lastName: b.last_name,
          pictureUrl: b.picture_url,
          username: b.username,
          sessionBearer: b.session_bearer,
          sessionAbsoluteExpiresAt: b.session_absolute_expires_at,
        }
        return { ok: true, result }
      }
      if (res.status === 400) return { ok: false, reason: 'invalid' }
      if (res.status === 409) return { ok: false, reason: 'already_consumed' }
      throw new Error(`rpid_sso_unexpected_status_${res.status}`)
    },
  }
}
