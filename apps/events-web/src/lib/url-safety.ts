// URL safety helper for user-supplied external links rendered to the public.
// Allows only http: and https: schemes; everything else (javascript:, data:,
// vbscript:, empty, relative paths) is rejected so we never present a
// phishing URL or execute a script via href.

export function isSafeHttpUrl(url: string): boolean {
  if (!url) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
