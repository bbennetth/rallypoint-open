import { describe, it, expect } from 'vitest'
import { isCacheableImage } from './swRoutes.js'

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
