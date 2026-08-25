import { verifyIdToken, signAppleClientSecret } from '../../crypto/jwt.js'
import { type OAuthProvider, type NormalizedIdentity, OAuthProviderError } from './types.js'
import { type ProviderDeps, coerceVerified, asString } from './util.js'

const AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize'
const TOKEN_URL = 'https://appleid.apple.com/auth/token'
const JWKS_URL = 'https://appleid.apple.com/auth/keys'
const ISSUER = 'https://appleid.apple.com'

// Apple: OIDC, but the client_secret is an ES256 JWT we sign per request,
// and the name/email scope forces response_mode=form_post. The id_token
// carries the sub + email; the display name arrives (first auth only) in
// the form POST `user` field, overlaid by the route — not here.
export function createAppleProvider(
  cfg: { clientId: string; teamId: string; keyId: string; privateKeyPem: string },
  deps: ProviderDeps,
): OAuthProvider {
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    slug: 'apple',
    buildAuthorizeUrl(p) {
      const u = new URL(AUTHORIZE_URL)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', p.redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', 'name email')
      u.searchParams.set('response_mode', 'form_post')
      u.searchParams.set('state', p.state)
      u.searchParams.set('nonce', p.nonce)
      return u.toString()
    },
    async exchangeAndFetchIdentity(p): Promise<NormalizedIdentity> {
      const clientSecret = await signAppleClientSecret({
        teamId: cfg.teamId,
        keyId: cfg.keyId,
        clientId: cfg.clientId,
        privateKeyPkcs8Pem: cfg.privateKeyPem,
        ...(deps.now ? { now: deps.now() } : {}),
      })
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: p.code,
          client_id: cfg.clientId,
          client_secret: clientSecret,
          redirect_uri: p.redirectUri,
        }),
      })
      if (!res.ok) throw new OAuthProviderError(`apple token exchange failed (${res.status})`)
      const tok = (await res.json()) as { id_token?: string }
      if (!tok.id_token) throw new OAuthProviderError('apple token response missing id_token')

      const jwks = await deps.jwks.get(JWKS_URL)
      let claims: Record<string, unknown>
      try {
        claims = await verifyIdToken({
          idToken: tok.id_token,
          jwks,
          issuers: [ISSUER],
          audience: cfg.clientId,
          nonce: p.nonce,
          ...(deps.now ? { now: deps.now() } : {}),
        })
      } catch (err: unknown) {
        throw new OAuthProviderError(
          `apple id_token invalid: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return {
        provider: 'apple',
        subject: String(claims['sub']),
        email: asString(claims['email']),
        emailVerified: coerceVerified(claims['email_verified']),
        name: null,
        firstName: null,
        lastName: null,
      }
    },
  }
}
