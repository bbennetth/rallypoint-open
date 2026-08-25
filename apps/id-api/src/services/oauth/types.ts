import type { OAuthProviderSlug } from '../../repos/oauth-identity.js'

// A provider-neutral view of "who signed in", normalized from either an
// OIDC id_token (Google/Apple) or a provider REST API (GitHub). `subject`
// is the provider's STABLE account id — the join key, never the email.

export interface NormalizedIdentity {
  provider: OAuthProviderSlug
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  firstName: string | null
  lastName: string | null
}

export interface AuthorizeUrlParams {
  state: string
  codeChallenge: string // PKCE S256 (providers that don't support PKCE ignore it)
  nonce: string
  redirectUri: string
}

export interface ExchangeParams {
  code: string
  codeVerifier: string
  redirectUri: string
  nonce: string
}

// Raised by an adapter when the provider round-trip fails (bad code,
// signature/nonce mismatch, HTTP error). The route maps it to a generic
// error redirect — no provider internals leak to the user.
export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthProviderError'
  }
}

export interface OAuthProvider {
  slug: OAuthProviderSlug
  buildAuthorizeUrl(params: AuthorizeUrlParams): string
  // Exchange the authorization code and return the verified identity.
  // OIDC providers verify the id_token (signature + nonce); GitHub calls
  // its user/emails API. Throws OAuthProviderError on any failure.
  exchangeAndFetchIdentity(params: ExchangeParams): Promise<NormalizedIdentity>
}
