// Server-side returnTo sanitizer for the OAuth redirect flow. id-web's
// safeReturnTo is client-only and cannot be trusted at the callback, so
// we re-validate here and ALWAYS return an absolute URL (the callback
// runs on the API origin, so a bare path would resolve against the wrong
// host). Relative paths are anchored to UI_ORIGIN; absolute URLs are
// allowed only when their host is UI_ORIGIN's or an explicitly allowed
// sibling app host. Anything else falls back to UI_ORIGIN's root.

export function resolveReturnTo(
  input: string | null | undefined,
  opts: { uiOrigin: string; allowedHosts: readonly string[] },
): string {
  const base = opts.uiOrigin.replace(/\/$/, '')
  const fallback = `${base}/`
  if (!input) return fallback

  // Relative path (but not a protocol-relative "//host" URL).
  if (input.startsWith('/') && !input.startsWith('//')) return `${base}${input}`

  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    const uiHost = new URL(opts.uiOrigin).host
    if (url.host === uiHost || opts.allowedHosts.includes(url.host)) return url.toString()
  } catch {
    // not a valid absolute URL — fall through
  }
  return fallback
}
