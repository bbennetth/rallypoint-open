export const SSO_HINT_COOKIE_NAME = 'rp_sso'

export interface SsoHintCookieOpts {
  maxAgeSeconds: number
  domain?: string // e.g. '.rallypt.app'; omit attribute when undefined/empty
  secure: boolean
}

/**
 * Builds the Set-Cookie header value for the SSO hint cookie.
 *
 * The hint cookie is JS-readable (NOT HttpOnly) and is scoped to the
 * parent domain so app-web subdomains can detect an existing RPID
 * session without probing the HttpOnly session cookie.
 *
 * Attribute order: Path, Max-Age, SameSite, [Domain], [Secure].
 * No HttpOnly — JS must read this cookie.
 */
export function buildSsoHintCookie(opts: SsoHintCookieOpts): string {
  let cookie = `${SSO_HINT_COOKIE_NAME}=1; Path=/; Max-Age=${opts.maxAgeSeconds}; SameSite=Lax`
  if (opts.domain) {
    cookie += `; Domain=${opts.domain}`
  }
  if (opts.secure) {
    cookie += '; Secure'
  }
  return cookie
}

/**
 * Builds the Set-Cookie header value that clears the SSO hint cookie.
 * Use the same Domain/Secure decision as the set variant so the browser
 * matches on scope and actually clears it.
 */
export function buildSsoHintClearCookie(opts: { domain?: string; secure: boolean }): string {
  let cookie = `${SSO_HINT_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`
  if (opts.domain) {
    cookie += `; Domain=${opts.domain}`
  }
  if (opts.secure) {
    cookie += '; Secure'
  }
  return cookie
}
