import { verifyIdToken } from '../../crypto/jwt.js'
import {
  type OAuthProvider,
  type NormalizedIdentity,
  OAuthProviderError,
} from './types.js'
import { type ProviderDeps, coerceVerified, asString } from './util.js'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export function createGoogleProvider(
  cfg: { clientId: string; clientSecret: string },
  deps: ProviderDeps,
): OAuthProvider {
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    slug: 'google',
    buildAuthorizeUrl(p) {
      const u = new URL(AUTHORIZE_URL)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', p.redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', 'openid email profile')
      u.searchParams.set('state', p.state)
      u.searchParams.set('code_challenge', p.codeChallenge)
      u.searchParams.set('code_challenge_method', 'S256')
      u.searchParams.set('nonce', p.nonce)
      u.searchParams.set('prompt', 'select_account')
      return u.toString()
    },
    async exchangeAndFetchIdentity(p): Promise<NormalizedIdentity> {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: p.code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: p.redirectUri,
          code_verifier: p.codeVerifier,
        }),
      })
      if (!res.ok) throw new OAuthProviderError(`google token exchange failed (${res.status})`)
      const tok = (await res.json()) as { id_token?: string }
      if (!tok.id_token) throw new OAuthProviderError('google token response missing id_token')

      const jwks = await deps.jwks.get(JWKS_URL)
      let claims: Record<string, unknown>
      try {
        claims = await verifyIdToken({
          idToken: tok.id_token,
          jwks,
          issuers: ISSUERS,
          audience: cfg.clientId,
          nonce: p.nonce,
          ...(deps.now ? { now: deps.now() } : {}),
        })
      } catch (err: unknown) {
        throw new OAuthProviderError(
          `google id_token invalid: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return {
        provider: 'google',
        subject: String(claims['sub']),
        email: asString(claims['email']),
        emailVerified: coerceVerified(claims['email_verified']),
        name: asString(claims['name']),
        firstName: asString(claims['given_name']),
        lastName: asString(claims['family_name']),
      }
    },
  }
}
