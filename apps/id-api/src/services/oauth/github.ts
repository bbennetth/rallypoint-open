import { type OAuthProvider, type NormalizedIdentity, OAuthProviderError } from './types.js'
import { type ProviderDeps, splitName } from './util.js'

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const EMAILS_URL = 'https://api.github.com/user/emails'

// GitHub is OAuth2 (no OIDC id_token). We exchange the code for an access
// token, then read /user + /user/emails and treat the account as verified
// only if it has a VERIFIED email — preferring the verified primary, else
// any verified address. An account with no verified email links as
// emailVerified=false (so it never auto-merges onto an existing account).
export function createGithubProvider(
  cfg: { clientId: string; clientSecret: string },
  deps: ProviderDeps,
): OAuthProvider {
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    slug: 'github',
    buildAuthorizeUrl(p) {
      const u = new URL(AUTHORIZE_URL)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', p.redirectUri)
      u.searchParams.set('scope', 'read:user user:email')
      u.searchParams.set('state', p.state)
      u.searchParams.set('allow_signup', 'true')
      return u.toString()
    },
    async exchangeAndFetchIdentity(p): Promise<NormalizedIdentity> {
      // Accept: application/json — GitHub otherwise returns a
      // form-encoded token response, not JSON.
      const tokenRes = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code: p.code,
          redirect_uri: p.redirectUri,
        }),
      })
      if (!tokenRes.ok) throw new OAuthProviderError(`github token exchange failed (${tokenRes.status})`)
      const tok = (await tokenRes.json()) as { access_token?: string }
      if (!tok.access_token) throw new OAuthProviderError('github token response missing access_token')

      const authHeaders = {
        Authorization: `Bearer ${tok.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rallypoint-id', // GitHub rejects API calls without a UA
      }
      const userRes = await fetchImpl(USER_URL, { headers: authHeaders })
      if (!userRes.ok) throw new OAuthProviderError(`github /user failed (${userRes.status})`)
      const user = (await userRes.json()) as { id?: number; login?: string; name?: string | null }
      if (user.id === undefined || user.id === null) {
        throw new OAuthProviderError('github /user missing id')
      }

      let email: string | null = null
      let emailVerified = false
      const emailsRes = await fetchImpl(EMAILS_URL, { headers: authHeaders })
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string
          primary: boolean
          verified: boolean
        }>
        const chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
        if (chosen) {
          email = chosen.email
          emailVerified = true
        }
      }

      const name = typeof user.name === 'string' ? user.name : null
      const { firstName, lastName } = splitName(name)
      return { provider: 'github', subject: String(user.id), email, emailVerified, name, firstName, lastName }
    },
  }
}
