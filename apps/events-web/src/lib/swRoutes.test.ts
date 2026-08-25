import { describe, it, expect } from 'vitest'
import { isCacheableImage, isTemplatedNavigation } from './swRoutes.js'

describe('isCacheableImage', () => {
  it('caches same-origin static images', () => {
    expect(isCacheableImage('image', '/icons/rallypt-192.png')).toBe(true)
    expect(isCacheableImage('image', '/assets/logo-abc123.svg')).toBe(true)
  })

  it('never caches non-image destinations', () => {
    for (const d of ['document', 'script', 'style', '']) {
      expect(isCacheableImage(d, '/icons/rallypt-192.png')).toBe(false)
    }
  })

  // Private user-scoped uploads (e.g. event map images) are served under
  // /api/* and would carry the same cross-user replay risk as data reads.
  it('never caches /api images', () => {
    expect(isCacheableImage('image', '/api/v1/ui/events/abc/map.png')).toBe(false)
    expect(isCacheableImage('image', '/api/maps/xyz')).toBe(false)
  })
})

describe('isTemplatedNavigation', () => {
  it('matches public event pages', () => {
    expect(isTemplatedNavigation('/e/harvest-moon-demo')).toBe(true)
    expect(isTemplatedNavigation('/e/some-fest-a3m2')).toBe(true)
  })

  // Bare /e is the same events-api surface; don't leave it network-only
  // by accident.
  it('matches the bare /e path', () => {
    expect(isTemplatedNavigation('/e')).toBe(true)
  })

  // The prefix must not swallow unrelated routes that merely start with
  // the letter e — /events/* is the whole authenticated app.
  it('does not match the authenticated app routes', () => {
    for (const p of ['/events/abc', '/events/abc/attending/now', '/me/events', '/']) {
      expect(isTemplatedNavigation(p)).toBe(false)
    }
  })

  it('does not match /api', () => {
    expect(isTemplatedNavigation('/api/v1/sdk/events/abc')).toBe(false)
  })
})
