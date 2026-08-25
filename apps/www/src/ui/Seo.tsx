import { useEffect } from 'react'
import { ROUTE_META, SITE_ORIGIN } from '../seo.js'

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

// Runtime head manager for the SPA's four routes. index.html carries the
// site-level defaults (home title/description, og:image, favicon, org
// JSON-LD) so crawlers and link unfurlers that don't run JS still get a
// sensible card; this component swaps the per-route bits on navigation.
// Static tags (og:type, og:site_name, og:image, twitter:card) never change
// and live only in index.html.
export function Seo({ path }: { path: keyof typeof ROUTE_META }) {
  useEffect(() => {
    const meta = ROUTE_META[path]
    if (!meta) return
    const url = SITE_ORIGIN + (path === '/' ? '/' : path)

    document.title = meta.title
    upsertMeta('name', 'description', meta.description)
    upsertMeta('property', 'og:title', meta.title)
    upsertMeta('property', 'og:description', meta.description)
    upsertMeta('property', 'og:url', url)
    upsertMeta('name', 'twitter:title', meta.title)
    upsertMeta('name', 'twitter:description', meta.description)

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.rel = 'canonical'
      document.head.appendChild(canonical)
    }
    canonical.href = url

    // Per-product JSON-LD data block (not executable — CSP-exempt).
    const existing = document.getElementById('ld-page')
    if (meta.ldType) {
      const node = existing ?? document.createElement('script')
      node.id = 'ld-page'
      node.setAttribute('type', 'application/ld+json')
      node.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': meta.ldType,
        name: meta.ldName,
        description: meta.description,
        url,
        applicationCategory: meta.ldCategory,
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      })
      if (!existing) document.head.appendChild(node)
    } else {
      existing?.remove()
    }
  }, [path])

  return null
}
