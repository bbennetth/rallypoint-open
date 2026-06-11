// Builds a URL to the hosted Rallypoint ID signin page with a
// returnTo round-trip. The hosted UI is responsible for sanitizing
// the returnTo against its own safe-redirect allowlist before
// honoring it.

export interface SigninUrlOptions {
  /** Base URL of the hosted Rallypoint ID UI (e.g. https://id.rallypt.app). */
  hostedUiUrl: string
  /** Absolute URL on YOUR app the user should land on after signing in. */
  returnTo?: string
  /** Hint for the signin form. The user can still type a different one. */
  loginHint?: string
}

export function signinUrl(opts: SigninUrlOptions): string {
  const base = opts.hostedUiUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  if (opts.returnTo) params.set('returnTo', opts.returnTo)
  if (opts.loginHint) params.set('login_hint', opts.loginHint)
  const qs = params.toString()
  return `${base}/signin${qs ? `?${qs}` : ''}`
}

export interface SignupUrlOptions {
  hostedUiUrl: string
  returnTo?: string
}

export function signupUrl(opts: SignupUrlOptions): string {
  const base = opts.hostedUiUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  if (opts.returnTo) params.set('returnTo', opts.returnTo)
  const qs = params.toString()
  return `${base}/signup${qs ? `?${qs}` : ''}`
}
