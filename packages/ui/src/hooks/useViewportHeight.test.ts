import { describe, it, expect } from 'vitest'
import {
  pickViewportHeight,
  pickKeyboardInset,
  pickInitialViewportHeight,
  getViewportRecomputeDelays,
  getViewportResumeRecomputeDelays,
  triggerColdLaunchScrollWakeup,
  type ScrollWakeupContainer,
} from './useViewportHeight.js'

describe('pickViewportHeight', () => {
  it('prefers visualViewport height when not zoomed', () => {
    expect(pickViewportHeight(700, 800, 1)).toBe(700)
  })
  it('prefers innerHeight when pinch-zoomed', () => {
    expect(pickViewportHeight(700, 800, 2)).toBe(800)
  })
  it('falls back to innerHeight when visualViewport is missing or zero', () => {
    expect(pickViewportHeight(undefined, 800)).toBe(800)
    expect(pickViewportHeight(0, 800, 1)).toBe(800)
  })
})

describe('pickKeyboardInset', () => {
  it('returns the gap when the keyboard shrinks the visual viewport', () => {
    expect(pickKeyboardInset(500, 800, 1)).toBe(300)
  })
  it('returns 0 when the gap is below the 100px keyboard threshold', () => {
    expect(pickKeyboardInset(750, 800, 1)).toBe(0)
  })
  it('returns 0 when pinch-zoomed', () => {
    expect(pickKeyboardInset(500, 800, 2)).toBe(0)
  })
  it('returns 0 when an input is missing', () => {
    expect(pickKeyboardInset(undefined, 800)).toBe(0)
    expect(pickKeyboardInset(500, 0, 1)).toBe(0)
  })
})

describe('pickInitialViewportHeight', () => {
  it('prefers the larger of visual and layout when not zoomed', () => {
    expect(pickInitialViewportHeight(700, 800, 1)).toBe(800)
    expect(pickInitialViewportHeight(820, 800, 1)).toBe(820)
  })
  it('uses innerHeight when zoomed', () => {
    expect(pickInitialViewportHeight(900, 800, 2)).toBe(800)
  })
})

describe('recompute delay schedules', () => {
  it('exposes the cold-launch settle delays', () => {
    expect(getViewportRecomputeDelays()).toEqual([120, 480, 1000])
  })
  it('exposes the resume rehydrate delays', () => {
    expect(getViewportResumeRecomputeDelays()).toEqual([120, 500])
  })
})

describe('triggerColdLaunchScrollWakeup', () => {
  function makeContainer(scrollTop: number): ScrollWakeupContainer & {
    appended: unknown[]
    removed: unknown[]
  } {
    const appended: unknown[] = []
    const removed: unknown[] = []
    return {
      scrollTop,
      offsetHeight: 0,
      appendChild: (node: unknown) => {
        appended.push(node)
        return node
      },
      removeChild: (node: unknown) => {
        removed.push(node)
        return node
      },
      appended,
      removed,
    }
  }

  it('no-ops on a missing container', () => {
    expect(triggerColdLaunchScrollWakeup(null)).toBe(false)
  })
  it('no-ops when the container is already scrolled', () => {
    const c = makeContainer(40)
    expect(triggerColdLaunchScrollWakeup(c)).toBe(false)
    expect(c.appended).toHaveLength(0)
  })
  it('appends, scrolls, and reverts on an unscrolled container', () => {
    const c = makeContainer(0)
    const trigger = { style: { cssText: '' } }
    expect(triggerColdLaunchScrollWakeup(c, () => trigger)).toBe(true)
    expect(c.appended).toEqual([trigger])
    expect(c.removed).toEqual([trigger])
    expect(c.scrollTop).toBe(0)
    expect(trigger.style.cssText).toContain('9999px')
  })
})
