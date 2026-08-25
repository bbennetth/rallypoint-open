// Shared RPID SSO-exchange service (R2). Each consumer app wrapped the
// `IdRPC.exchangeSsoCode` binding in an identical adapter that differed only
// by the `client` name. Extracted once; apps call
// `createRpidSsoService(binding, 'lists')`.

import { withTimeout, DEFAULT_RPC_TIMEOUT_MS } from './with-timeout.js'

export interface SsoExchangeResult {
  userId: string
  email: string
  emailVerified: boolean
  displayName: string | null
  firstName: string | null
  lastName: string | null
  pictureUrl: string | null
  username: string
  sessionBearer: string
  sessionAbsoluteExpiresAt: string // ISO-8601
}

export interface RpidSsoService {
  exchange(
    code: string,
  ): Promise<
    { ok: true; result: SsoExchangeResult } | { ok: false; reason: 'invalid' | 'already_consumed' }
  >
}

// Structural view of the id-api RPC binding's exchange method — keeps api-kit
// decoupled from the id-api Worker type. The app's `Service<IdRPC>` binding is
// structurally compatible.
interface SsoExchangeData {
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
export interface SsoExchangeBinding {
  exchangeSsoCode(
    code: string,
    caller: { client: string },
  ): Promise<{ kind: 'invalid' } | { kind: 'already_consumed' } | { kind: 'ok'; data: SsoExchangeData }>
}

export function createRpidSsoService(
  binding: SsoExchangeBinding,
  clientName: string,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): RpidSsoService {
  return {
    async exchange(code) {
      let result: Awaited<ReturnType<SsoExchangeBinding['exchangeSsoCode']>>
      try {
        result = await withTimeout(
          binding.exchangeSsoCode(code, { client: clientName }),
          timeoutMs,
          'binding.exchangeSsoCode',
        )
      } catch (err) {
        throw new Error('rpid_sso_transport_error', { cause: err })
      }
      if (result.kind === 'invalid') return { ok: false, reason: 'invalid' }
      if (result.kind === 'already_consumed') return { ok: false, reason: 'already_consumed' }
      const d = result.data
      return {
        ok: true,
        result: {
          userId: d.user_id,
          email: d.email,
          emailVerified: d.email_verified,
          displayName: d.display_name,
          firstName: d.first_name,
          lastName: d.last_name,
          pictureUrl: d.picture_url,
          username: d.username,
          sessionBearer: d.session_bearer,
          sessionAbsoluteExpiresAt: d.session_absolute_expires_at,
        },
      }
    },
  }
}
