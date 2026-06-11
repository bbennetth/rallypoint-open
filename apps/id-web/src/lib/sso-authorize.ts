// Helpers for the SSO authorize flow — specifically the prompt=none (silent)
// branch where no RPID session exists and the page must redirect back to the
// app rather than landing the user on /signin.

// Derive the parent (eTLD+1) domain for a cookie Domain attribute.
// Returns ".rallypt.dev" for "id.rallypt.dev", ".rallypt.app" for
// "events.rallypt.app", and null for single-label hosts like "localhost".
// NOTE: naive last-two-labels — correct only because the deployment domains
// are the flat `rallypt.app` / `rallypt.dev` (no multi-label eTLDs like
// `co.uk`, which would yield a bare-eTLD `.co.uk`). Revisit if a ccTLD host
// is ever added. Exported for unit testing.
export function parentDomainForHost(hostname: string): string | null {
  const labels = hostname.split('.')
  if (labels.length < 2) return null
  return '.' + labels.slice(-2).join('.')
}

// Is `returnTo` a same-registrable-site destination relative to RPID's own
// host? The prompt=none branch redirects straight back to `returnTo` WITHOUT
// going through the server-side mint (which is where return_to_host is
// normally validated), so we must guard against RPID being used as an open
// redirector. Accept only the same host or a sibling subdomain of RPID's
// parent domain (e.g. id.rallypt.dev → events.rallypt.dev); on localhost dev
// accept the same single-label host. Anything else (attacker.com) → false,
// and the caller falls back to the safe /signin redirect.
export function isTrustedReturnTo(returnTo: string, hostname: string): boolean {
  let host: string
  try {
    host = new URL(returnTo).hostname
  } catch {
    return false
  }
  if (host === hostname) return true
  const parent = parentDomainForHost(hostname)
  return parent != null && host.endsWith(parent)
}

// Append the login_required signal (and round-tripped state) to the app's
// return_to URL, so a prompt=none probe with no RPID session resolves back
// to the app's landing page instead of stranding the user on /signin.
export function buildLoginRequiredUrl(returnTo: string, state: string): string {
  const url = new URL(returnTo)
  url.searchParams.set('error', 'login_required')
  url.searchParams.set('state', state)
  return url.toString()
}

// Best-effort clear of the parent-domain `rp_sso` hint cookie from RPID's
// own origin (e.g. id.rallypt.dev clears Domain=.rallypt.dev). Never throws.
export function clearStaleSsoHint(hostname: string, secure: boolean): void {
  try {
    const parent = parentDomainForHost(hostname)
    const domainAttr = parent != null ? `; Domain=${parent}` : ''
    const secureAttr = secure ? '; Secure' : ''
    document.cookie =
      `rp_sso=; Path=/; Max-Age=0; SameSite=Lax${domainAttr}${secureAttr}`
  } catch {
    // Swallow — jsdom / SSR environments may not expose document.cookie.
  }
}
