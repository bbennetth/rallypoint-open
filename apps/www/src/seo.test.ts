import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTE_META, SITE_ORIGIN } from './seo.js'

const staticDir = resolve(__dirname, '../static')

describe('ROUTE_META', () => {
  it('has well-formed entries', () => {
    const entries = Object.entries(ROUTE_META)
    expect(entries.length).toBeGreaterThan(0)
    for (const [path, meta] of entries) {
      expect(path.startsWith('/')).toBe(true)
      expect(meta.title.length).toBeGreaterThan(10)
      expect(meta.title.length).toBeLessThanOrEqual(70)
      expect(meta.description.length).toBeGreaterThanOrEqual(50)
      expect(meta.description.length).toBeLessThanOrEqual(170)
      if (meta.ldType) {
        expect(meta.ldName).toBeTruthy()
        expect(meta.ldCategory).toBeTruthy()
      }
    }
  })
})

describe('static SEO files stay in lockstep with ROUTE_META', () => {
  it('sitemap.xml lists exactly the ROUTE_META routes', () => {
    const xml = readFileSync(resolve(staticDir, 'sitemap.xml'), 'utf8')
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    const expected = Object.keys(ROUTE_META).map(
      (path) => SITE_ORIGIN + (path === '/' ? '/' : path),
    )
    expect(new Set(locs)).toEqual(new Set(expected))
    expect(locs.length).toBe(expected.length)
  })

  it('robots.txt points at the sitemap', () => {
    const robots = readFileSync(resolve(staticDir, 'robots.txt'), 'utf8')
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)
  })

  it('index.html defaults match the home route meta', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
    expect(html).toContain(`<title>${ROUTE_META['/'].title}</title>`)
    expect(html).toContain(ROUTE_META['/'].description)
    // The og:/twitter: titles must track the home title exactly; the og:
    // descriptions are an intentionally shorter variant, so only assert
    // they exist and stay in the unfurl-friendly length band.
    expect(html).toContain(`<meta property="og:title" content="${ROUTE_META['/'].title}" />`)
    expect(html).toContain(`<meta name="twitter:title" content="${ROUTE_META['/'].title}" />`)
    const ogDesc = html.match(/property="og:description"\s*\n?\s*content="([^"]+)"/)
    expect(ogDesc?.[1].length).toBeGreaterThanOrEqual(50)
    expect(ogDesc?.[1].length).toBeLessThanOrEqual(170)
  })
})
