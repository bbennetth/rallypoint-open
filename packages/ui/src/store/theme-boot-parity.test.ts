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
  'apps/www/index.html': resolve(REPO_ROOT, 'apps/www/index.html'),
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
