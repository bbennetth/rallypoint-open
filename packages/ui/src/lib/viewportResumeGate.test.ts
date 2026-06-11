import { describe, it, expect } from 'vitest'
import { shouldFireViewportResume } from './viewportResumeGate.js'

const away = { wasAway: true }
const home = { wasAway: false }

describe('shouldFireViewportResume', () => {
  it('visibility hidden marks away, never fires', () => {
    expect(shouldFireViewportResume(home, { kind: 'visibility', hidden: true })).toEqual({
      fire: false,
      next: { wasAway: true },
    })
  })
  it('visibility visible after away fires and clears', () => {
    expect(shouldFireViewportResume(away, { kind: 'visibility', hidden: false })).toEqual({
      fire: true,
      next: { wasAway: false },
    })
  })
  it('visibility visible without prior away is a no-op', () => {
    expect(shouldFireViewportResume(home, { kind: 'visibility', hidden: false })).toEqual({
      fire: false,
      next: home,
    })
  })
  it('pagehide and blur mark away without firing', () => {
    expect(shouldFireViewportResume(home, { kind: 'pagehide' })).toEqual({
      fire: false,
      next: { wasAway: true },
    })
    expect(shouldFireViewportResume(home, { kind: 'blur' })).toEqual({
      fire: false,
      next: { wasAway: true },
    })
  })
  it('focus fires only when previously away', () => {
    expect(shouldFireViewportResume(away, { kind: 'focus' })).toEqual({
      fire: true,
      next: { wasAway: false },
    })
    expect(shouldFireViewportResume(home, { kind: 'focus' })).toEqual({
      fire: false,
      next: home,
    })
  })
  it('pageshow-persisted always fires regardless of away state', () => {
    expect(shouldFireViewportResume(home, { kind: 'pageshow-persisted' })).toEqual({
      fire: true,
      next: { wasAway: false },
    })
    expect(shouldFireViewportResume(away, { kind: 'pageshow-persisted' })).toEqual({
      fire: true,
      next: { wasAway: false },
    })
  })
})
