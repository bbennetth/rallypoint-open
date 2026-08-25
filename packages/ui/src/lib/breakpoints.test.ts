import { describe, it, expect, vi } from 'vitest'
import {
  MOBILE_VIEWPORT_MAX,
  MOBILE_VIEWPORT_QUERY,
  isMobileViewport,
} from './breakpoints.js'
import { DRAWER_SHEET_BREAKPOINT } from './drawer.js'

// jsdom ships no `matchMedia` at all, so the predicate takes an
// injectable Window and is tested against a stub — same approach as
// events-web's isStandaloneDisplay.
function fakeWin(input: { matches?: boolean; hasMatchMedia?: boolean }): Window {
  const matchMedia =
    input.hasMatchMedia === false
      ? undefined
      : vi.fn(() => ({ matches: input.matches ?? false }))
  return { matchMedia } as unknown as Window
}

describe('MOBILE_VIEWPORT_QUERY', () => {
  it('is derived from the breakpoint constant', () => {
    expect(MOBILE_VIEWPORT_QUERY).toBe(`(max-width: ${MOBILE_VIEWPORT_MAX}px)`)
  })

  // The shell's sidebar/tab-bar swap, the drawer's panel/sheet swap and
  // any JS behavior branch all have to agree on one number, or a link
  // re-targets at a width where the layout hasn't changed yet.
  it('is the same breakpoint the drawer uses', () => {
    expect(DRAWER_SHEET_BREAKPOINT).toBe(MOBILE_VIEWPORT_MAX)
  })
})

describe('isMobileViewport', () => {
  it('is true when the mobile query matches', () => {
    expect(isMobileViewport(fakeWin({ matches: true }))).toBe(true)
  })

  it('is false on a desktop-width viewport', () => {
    expect(isMobileViewport(fakeWin({ matches: false }))).toBe(false)
  })

  it('asks for the derived mobile query', () => {
    const win = fakeWin({ matches: true })
    isMobileViewport(win)
    expect(win.matchMedia).toHaveBeenCalledWith(MOBILE_VIEWPORT_QUERY)
  })

  // Desktop is the safe fallback: every consumer keeps the behavior it
  // had before the breakpoint check existed.
  it('falls back to desktop when matchMedia is unavailable', () => {
    expect(isMobileViewport(fakeWin({ hasMatchMedia: false }))).toBe(false)
  })
})
