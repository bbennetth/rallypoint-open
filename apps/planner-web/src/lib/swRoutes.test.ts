import { describe, it, expect } from 'vitest'
import { isApiCacheableRead, isCacheableImage, NAVIGATION_DENYLIST } from './swRoutes.js'

describe('isCacheableImage', () => {
  it('caches image requests outside the API surface', () => {
    expect(isCacheableImage('image', '/icons/rallypt.svg')).toBe(true)
    expect(isCacheableImage('image', '/assets/logo.png')).toBe(true)
  })
  it('never caches API responses or non-image destinations', () => {
    expect(isCacheableImage('image', '/api/v1/ui/session')).toBe(false)
    expect(isCacheableImage('document', '/me')).toBe(false)
    expect(isCacheableImage('script', '/assets/app.js')).toBe(false)
  })
})

describe('isApiCacheableRead', () => {
  it('caches ordinary /api/v1/ui/ GET reads', () => {
    expect(isApiCacheableRead('GET', '/api/v1/ui/my-day')).toBe(true)
    expect(isApiCacheableRead('GET', '/api/v1/ui/lists')).toBe(true)
  })

  it('exempts the session probe from the runtime cache', () => {
    expect(isApiCacheableRead('GET', '/api/v1/ui/session')).toBe(false)
  })

  it('never caches non-GET methods', () => {
    expect(isApiCacheableRead('POST', '/api/v1/ui/my-day')).toBe(false)
    expect(isApiCacheableRead('DELETE', '/api/v1/ui/lists')).toBe(false)
  })

  it('never caches paths outside the /api/v1/ui/ surface', () => {
    expect(isApiCacheableRead('GET', '/api/v1/other')).toBe(false)
    expect(isApiCacheableRead('GET', '/assets/app.js')).toBe(false)
  })

  it('exempts by exact path, not prefix (sibling paths stay cacheable)', () => {
    expect(isApiCacheableRead('GET', '/api/v1/ui/session-notes')).toBe(true)
  })
})

describe('NAVIGATION_DENYLIST', () => {
  const isDenied = (path: string) => NAVIGATION_DENYLIST.some((re) => re.test(path))

  it('denies backend API paths (ticket download)', () => {
    expect(isDenied('/api/v1/ui/events/abc/tickets/xyz/download')).toBe(true)
  })

  it('denies the session endpoint', () => {
    expect(isDenied('/api/v1/ui/session')).toBe(true)
  })

  it('does not deny SPA app routes', () => {
    expect(isDenied('/my-day')).toBe(false)
    expect(isDenied('/events')).toBe(false)
    expect(isDenied('/')).toBe(false)
  })
})
