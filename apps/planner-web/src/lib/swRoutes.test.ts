import { describe, it, expect } from 'vitest'
import { isCacheableImage, NAVIGATION_DENYLIST } from './swRoutes.js'

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
