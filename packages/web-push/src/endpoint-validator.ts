// Web Push endpoint allowlist. The browser-supplied PushSubscription.endpoint
// is later fetched server-side by send.ts on every cron tick, so any non-push
// host accepted here becomes an SSRF vector against the Worker network.
//
// The allowlist is a curated set of the production push services: FCM
// (Chrome/Edge/Brave/Opera), Apple Web Push (Safari/iOS PWA), and Mozilla
// autopush (Firefox). Hosts are matched by exact suffix on the URL host, so
// `*.push.apple.com` accepts `api.push.apple.com` and `web.push.apple.com`
// without permitting arbitrary `*.apple.com`.

const ALLOWED_HOST_SUFFIXES: readonly string[] = [
  // FCM (Chrome, Edge, Brave, Opera, Chromium-based PWAs)
  'fcm.googleapis.com',
  // Apple Web Push (Safari, iOS PWA — uses several subdomains)
  '.push.apple.com',
  // Mozilla autopush (Firefox) — production + dev/stage subdomains
  '.push.services.mozilla.com',
]

export interface PushEndpointValidationOptions {
  /**
   * Additional host suffixes to permit. Intended for development/test where
   * the dev stack may route to localhost or a stub endpoint. NEVER set this
   * in production — the safe default is the curated allowlist only.
   */
  allowExtraHosts?: readonly string[]
}

/**
 * Returns true iff `raw` is a syntactically valid HTTPS URL whose host
 * matches the push-service allowlist. Used as a `.refine()` predicate on
 * the SubscriptionSchema; a false return is the only thing standing between
 * a user-supplied URL and a server-side `fetch()`.
 */
export function isAllowedPushEndpoint(
  raw: string,
  opts: PushEndpointValidationOptions = {},
): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  // HTTPS only — RFC 8030 requires it and any non-https push service is
  // either dev-only or wrong. Blocks file://, javascript:, data:, http://.
  if (url.protocol !== 'https:') return false
  const host = url.host.toLowerCase()
  const suffixes = opts.allowExtraHosts
    ? [...ALLOWED_HOST_SUFFIXES, ...opts.allowExtraHosts]
    : ALLOWED_HOST_SUFFIXES
  return suffixes.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  )
}

/** Human-readable failure message for the zod refine. */
export const PUSH_ENDPOINT_INVALID_MESSAGE =
  'Push subscription endpoint must be an HTTPS URL on a recognised push service.'
