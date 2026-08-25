import type { Env } from '../../env.js'
import type { OAuthProviderSlug } from '../../repos/oauth-identity.js'
import type { OAuthProvider } from './types.js'
import { JwksCache } from './jwks-cache.js'
import { createGoogleProvider } from './google.js'
import { createGithubProvider } from './github.js'
import { createAppleProvider } from './apple.js'

export type OAuthProviders = Map<OAuthProviderSlug, OAuthProvider>

// Build the enabled-provider map from env. Social login is OFF unless the
// SOCIAL_SIGNIN_ENABLED master switch is 'true' — an empty map means the
// /oauth/* routes 404, /providers returns [], and the UI shows no social
// buttons. When on, a provider is present ONLY when its credentials are
// also configured. One JwksCache is shared across providers so key sets
// are fetched once per isolate.
export function buildOAuthProviders(env: Env, jwks: JwksCache = new JwksCache()): OAuthProviders {
  const map: OAuthProviders = new Map()
  if (env.SOCIAL_SIGNIN_ENABLED !== 'true') return map

  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    map.set(
      'google',
      createGoogleProvider(
        { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET },
        { jwks },
      ),
    )
  }
  if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) {
    map.set(
      'github',
      createGithubProvider(
        { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET },
        { jwks },
      ),
    )
  }
  if (
    env.APPLE_OAUTH_CLIENT_ID &&
    env.APPLE_OAUTH_TEAM_ID &&
    env.APPLE_OAUTH_KEY_ID &&
    env.APPLE_OAUTH_PRIVATE_KEY
  ) {
    map.set(
      'apple',
      createAppleProvider(
        {
          clientId: env.APPLE_OAUTH_CLIENT_ID,
          teamId: env.APPLE_OAUTH_TEAM_ID,
          keyId: env.APPLE_OAUTH_KEY_ID,
          privateKeyPem: env.APPLE_OAUTH_PRIVATE_KEY,
        },
        { jwks },
      ),
    )
  }
  return map
}
