// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollBelowStickyHero } from './scroll-below-hero.js'

const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
})

afterEach(() => {
  document.body.innerHTML = ''
})

/** `.live-main > .live-hero` + a scroll target, mirroring both live
 *  session pages. jsdom lays nothing out, so the hero's offsetHeight is
 *  stubbed to the given value. */
function mount(heroHeight: number | null): HTMLElement {
  const main = document.createElement('div')
  main.className = 'live-main'
  if (heroHeight != null) {
    const hero = document.createElement('div')
    hero.className = 'live-hero'
    Object.defineProperty(hero, 'offsetHeight', { configurable: true, value: heroHeight })
    main.appendChild(hero)
  }
  const block = document.createElement('div')
  block.className = 'live-block'
  main.appendChild(block)
  document.body.appendChild(main)
  return block
}

describe('scrollBelowStickyHero', () => {
  it('offsets the scroll by the hero height plus a gap', () => {
    const block = mount(140)
    scrollBelowStickyHero(block)
    expect(block.style.scrollMarginTop).toBe('152px')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('measures the hero at call time, not once', () => {
    // The WoD hero compacts between calls — each scroll re-reads it.
    const block = mount(180)
    scrollBelowStickyHero(block)
    expect(block.style.scrollMarginTop).toBe('192px')
    const hero = document.querySelector<HTMLElement>('.live-hero')!
    Object.defineProperty(hero, 'offsetHeight', { value: 56 })
    scrollBelowStickyHero(block)
    expect(block.style.scrollMarginTop).toBe('68px')
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('clears a stale margin and still scrolls when no hero exists', () => {
    const block = mount(null)
    block.style.scrollMarginTop = '152px'
    scrollBelowStickyHero(block)
    expect(block.style.scrollMarginTop).toBe('')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('is a no-op for null (unset ref)', () => {
    scrollBelowStickyHero(null)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
