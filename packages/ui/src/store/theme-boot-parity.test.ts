/**
 * Parity guard for the pre-hydration boot script (#380).
 *
 * `THEME_BOOT_SOURCE` in theme.ts is the single source of truth for the
 * inline `<script>` that each app's index.html embeds. This test reads
 * every index.html and asserts its script body equals THEME_BOOT_SOURCE
 * exactly. A drift in any file causes a deliberate CI failure so the
 * "update one, forget the others" class of bug is caught immediately.
 *
 * To update the script: change THEME_BOOT_SOURCE, then re-run this test —
 * it will tell you which index.html files need to be updated to match.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { THEME_BOOT_SOURCE } from './theme.js'

/** Root of the monorepo — resolved relative to this test file's location:
 *  packages/ui/src/store/ → ../../../../ */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../')

const INDEX_HTML_PATHS: Record<string, string> = {
  'apps/planner-web/index.html': resolve(REPO_ROOT, 'apps/planner-web/index.html'),
  'apps/events-web/index.html': resolve(REPO_ROOT, 'apps/events-web/index.html'),
  'apps/lists-web/index.html': resolve(REPO_ROOT, 'apps/lists-web/index.html'),
  'apps/money-web/index.html': resolve(REPO_ROOT, 'apps/money-web/index.html'),
  'apps/id-web/index.html': resolve(REPO_ROOT, 'apps/id-web/index.html'),
  // apps/www is deliberately absent: the marketing site is dark-only since
  // the Soft Ink redesign and ships no theme boot script (or any inline
  // script) at all.
}

/**
 * Extract the content of the first bare `<script>` block (no `type` or
 * `src` attribute) from an HTML string. Returns the raw inner text with
 * leading/trailing whitespace stripped.
 */
function extractBootScriptBody(html: string, filePath: string): string {
  // Match a bare <script> tag (no attributes) and capture its body.
  const match = html.match(/<script>\n([\s\S]*?)\n\s*<\/script>/)
  if (!match) {
    throw new Error(
      `Could not find a bare <script>…</script> block in ${filePath}. ` +
        'The parity test expects exactly one inline boot script with no attributes.',
    )
  }
  // Strip the consistent 6-space HTML indentation so we compare the logical
  // script content rather than the HTML-level indent.
  const rawBody = match[1]
  // Detect the indent level from the first non-empty line.
  const firstLine = rawBody.split('\n').find((l) => l.trim().length > 0) ?? ''
  const indentMatch = firstLine.match(/^(\s+)/)
  const indent = indentMatch ? indentMatch[1] : ''
  const stripped = indent
    ? rawBody
        .split('\n')
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
        .join('\n')
    : rawBody
  return stripped.trim()
}

describe('THEME_BOOT_SOURCE parity — all index.html boot scripts match the single source of truth (#380)', () => {
  for (const [relPath, absPath] of Object.entries(INDEX_HTML_PATHS)) {
    it(`${relPath} boot script body === THEME_BOOT_SOURCE`, () => {
      const html = readFileSync(absPath, 'utf-8')
      const actual = extractBootScriptBody(html, relPath)
      // Provide a diff-friendly assertion: if the strings differ, vitest
      // will show exactly which lines diverged.
      expect(actual).toBe(THEME_BOOT_SOURCE)
    })
  }
})

// CSP-hash parity (#675): each app's `_headers` CSP allows its inline
// scripts by sha256 hash. If an inline <script> body changes (e.g.
// THEME_BOOT_SOURCE), the hash in `_headers` must be regenerated or the
// browser silently blocks the boot script. This test recomputes the
// hash of every bare inline <script> in each index.html and asserts
// the app's `_headers` script-src carries it.
const HEADERS_PATHS: Record<string, string> = {
  'apps/planner-web': resolve(REPO_ROOT, 'apps/planner-web/public/_headers'),
  'apps/events-web': resolve(REPO_ROOT, 'apps/events-web/public/_headers'),
  'apps/lists-web': resolve(REPO_ROOT, 'apps/lists-web/public/_headers'),
  'apps/money-web': resolve(REPO_ROOT, 'apps/money-web/public/_headers'),
  'apps/id-web': resolve(REPO_ROOT, 'apps/id-web/public/_headers'),
  'apps/fitness-web': resolve(REPO_ROOT, 'apps/fitness-web/public/_headers'),
  // apps/www has no inline scripts (dark-only, no theme boot) so it has no
  // hash entries to check — it appears only in ANALYTICS_HEADERS_PATHS.
}

// CSP connect-src parity: PostHog events flow through the reverse proxy
// t.rallypt.app (VITE_POSTHOG_HOST). Every app's _headers connect-src must
// allowlist it or the browser blocks all analytics requests. admin-web has
// no inline-script hash entry above, but it ships analytics too.
const ANALYTICS_HEADERS_PATHS: Record<string, string> = {
  ...HEADERS_PATHS,
  'apps/admin-web': resolve(REPO_ROOT, 'apps/admin-web/public/_headers'),
  'apps/www': resolve(REPO_ROOT, 'apps/www/_headers'),
}

// The proxy must appear in BOTH directives: connect-src for the event
// POSTs (/e/) and script-src for the extension bundles PostHog injects at
// runtime (surveys.js, web-vitals.js, exception-autocapture.js, the
// array/<key>/config.js loader, session recorder, …). script-src-elem is
// unset, so those <script> loads fall back to script-src.
describe('CSP parity — _headers allow the PostHog reverse proxy in script-src and connect-src', () => {
  for (const [app, headersPath] of Object.entries(ANALYTICS_HEADERS_PATHS)) {
    for (const directive of ['script-src', 'connect-src'] as const) {
      it(`${app}: _headers ${directive} contains https://t.rallypt.app`, () => {
        const headers = readFileSync(headersPath, 'utf-8')
        const csp = headers.match(/Content-Security-Policy:[^\n]*/)?.[0] ?? ''
        const value = csp.match(new RegExp(`${directive}[^;]*`))?.[0]
        expect(value, `${app} _headers has a ${directive} directive`).toBeTruthy()
        expect(value).toContain('https://t.rallypt.app')
      })
    }
  }
})

describe('CSP inline-script hash parity — _headers script-src covers every inline <script> (#675)', () => {
  for (const [app, headersPath] of Object.entries(HEADERS_PATHS)) {
    it(`${app}: _headers script-src contains the sha256 of each index.html inline script`, () => {
      const html = readFileSync(resolve(REPO_ROOT, app, 'index.html'), 'utf-8')
      const headers = readFileSync(headersPath, 'utf-8')
      const csp = headers.match(/Content-Security-Policy:[^\n]*/)?.[0] ?? ''
      const scriptSrc = csp.match(/script-src[^;]*/)?.[0]
      expect(scriptSrc, `${app} _headers has a script-src directive`).toBeTruthy()
      const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
      expect(bodies.length, `${app} index.html has at least one inline script`).toBeGreaterThan(0)
      for (const body of bodies) {
        const digest = createHash('sha256').update(body).digest('base64')
        expect(scriptSrc).toContain(`'sha256-${digest}'`)
      }
    })
  }
})

// CSP session-replay + beacon parity: PostHog session replay loads rrweb,
// which spins up a web worker from a blob: URL — blocked unless worker-src
// carries `blob:`. The Cloudflare Web Analytics beacon (static.cloudflareinsights.com,
// RUM POST to cloudflareinsights.com) is likewise CSP-gated. These are the
// same across every app, so guard them uniformly: dropping any one silently
// re-breaks replay/analytics with only a console error to show for it.
describe('CSP replay/beacon parity — _headers allow the rrweb blob worker + CF beacon', () => {
  for (const [app, headersPath] of Object.entries(ANALYTICS_HEADERS_PATHS)) {
    const csp = () => {
      const headers = readFileSync(headersPath, 'utf-8')
      return headers.match(/Content-Security-Policy:[^\n]*/)?.[0] ?? ''
    }
    it(`${app}: worker-src allows blob: (PostHog rrweb session recorder)`, () => {
      const value = csp().match(/worker-src[^;]*/)?.[0]
      expect(value, `${app} _headers has a worker-src directive`).toBeTruthy()
      expect(value).toContain('blob:')
    })
    it(`${app}: script-src allows the Cloudflare Web Analytics beacon`, () => {
      const value = csp().match(/script-src[^;]*/)?.[0]
      expect(value).toContain('https://static.cloudflareinsights.com')
    })
    it(`${app}: connect-src allows the Cloudflare beacon RUM POST`, () => {
      const value = csp().match(/connect-src[^;]*/)?.[0]
      expect(value).toContain('https://cloudflareinsights.com')
    })
  }
})
