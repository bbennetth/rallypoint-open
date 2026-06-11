import { describe, expect, it } from 'vitest'
import { DRAWER_SHEET_BREAKPOINT, drawerCss, drawerRootClass } from './drawer.js'

describe('drawerRootClass', () => {
  it('returns the base class when mobileSheet is off', () => {
    expect(drawerRootClass(false)).toBe('rp-drawer-root')
  })

  it('adds the sheet modifier when mobileSheet is on', () => {
    expect(drawerRootClass(true)).toBe('rp-drawer-root rp-drawer-root--sheet')
  })
})

describe('drawerCss', () => {
  it('uses the breakpoint constant in the media query by default', () => {
    expect(drawerCss()).toContain(`@media (max-width: ${DRAWER_SHEET_BREAKPOINT}px)`)
  })

  it('honours a custom breakpoint', () => {
    expect(drawerCss(640)).toContain('@media (max-width: 640px)')
  })

  it('drives panel width from the --rp-drawer-width custom property, capped at the viewport', () => {
    expect(drawerCss()).toContain('width: min(var(--rp-drawer-width, 360px), 100vw)')
  })

  it('applies a safe-area bottom inset to the sheet body', () => {
    expect(drawerCss()).toContain('env(safe-area-inset-bottom)')
  })

  it('defines the bottom-sheet treatment: full width, rounded top, slide-up', () => {
    const css = drawerCss()
    expect(css).toContain('width: 100vw')
    expect(css).toContain('border-radius: 16px 16px 0 0')
    expect(css).toContain('max-height: 90dvh')
    expect(css).toContain('@keyframes rp-drawer-slide-up')
  })

  it('keeps the desktop right-side keyframes', () => {
    const css = drawerCss()
    expect(css).toContain('@keyframes rp-drawer-slide-in')
    expect(css).toContain('@keyframes rp-drawer-fade-in')
  })
})
