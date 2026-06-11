// Cookie helpers shared by every backend app's session, CSRF, and
// SSO-state middleware plus the signout route, so cookie attributes
// stay consistent across apps.

export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || null
    }
  }
  return null
}

export interface CookieAttrs {
  maxAge: number
  /** CSRF cookie must be readable by JS; session cookie must NOT. */
  httpOnly: boolean
  /** SameSite policy. Default 'Lax'. */
  sameSite?: 'Lax' | 'Strict' | 'None'
  /**
   * Secure attribute — pass explicitly from the runtime env binding
   * (e.g. env.NODE_ENV === 'production'). Never derive from
   * process.env at module scope: on Cloudflare Workers, [vars] are
   * runtime bindings, not build-time defines, so process.env is
   * undefined at module load. Pass false for http://localhost dev.
   */
  secure: boolean
}

// We emit Path=/ so a non-prefixed dev cookie gets the same shape the
// __Host- prefix would mandate in production.
export function buildSetCookie(name: string, value: string, attrs: CookieAttrs): string {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${attrs.maxAge}`]
  if (attrs.secure) parts.push('Secure')
  parts.push(`SameSite=${attrs.sameSite ?? 'Lax'}`)
  if (attrs.httpOnly) parts.push('HttpOnly')
  return parts.join('; ')
}

// Expire a cookie immediately (Max-Age=0). Used on signout and on
// the session-revocation cascade.
export function buildClearCookie(name: string, httpOnly: boolean, secure: boolean): string {
  return buildSetCookie(name, '', { maxAge: 0, httpOnly, secure })
}
