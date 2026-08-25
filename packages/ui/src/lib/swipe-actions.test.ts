// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SA_FLICK_MAX_MS,
  SA_IDLE,
  SA_OPEN,
  SA_OVERDRAG,
  SA_OVERDRAG_DAMPING,
  saDisarm,
  saOnCancel,
  saOnEnd,
  saOnMove,
  saOnStart,
  saRegisterOpen,
  saShouldSwallowActivation,
  saTranslate,
  saUnregisterOpen,
} from './swipe-actions.js'
import { isSwipeExcluded } from './swipe-nav.js'

const TRAY = 128

// A claimed leftward drag: start at origin, move dx/dy.
function drag(dx: number, dy = 0, startOpen = false) {
  const start = saOnStart(startOpen ? SA_OPEN : SA_IDLE, 100, 100, 0)
  return saOnMove(start, 100 + dx, 100 + dy)
}

describe('saOnStart', () => {
  it('begins tracking from idle', () => {
    const s = saOnStart(SA_IDLE, 50, 60, 123)
    expect(s.phase).toBe('tracking')
    expect(s.startX).toBe(50)
    expect(s.startY).toBe(60)
    expect(s.startT).toBe(123)
    expect(s.openAtStart).toBe(false)
  })

  it('begins tracking from open with openAtStart set', () => {
    const s = saOnStart(SA_OPEN, 50, 60, 123)
    expect(s.phase).toBe('tracking')
    expect(s.openAtStart).toBe(true)
  })

  it('ignores a start mid-gesture', () => {
    const mid = drag(-30)
    expect(saOnStart(mid, 0, 0, 999)).toBe(mid)
  })
})

describe('saOnMove intent detection', () => {
  it('stays tracking below the slop distance', () => {
    const s = drag(-6, 4)
    expect(s.phase).toBe('tracking')
  })

  it('claims dragging on a dominant horizontal move', () => {
    const s = drag(-12, 2)
    expect(s.phase).toBe('dragging')
    expect(s.dx).toBe(-12)
  })

  it('rejects a vertical-dominant move and stays rejected', () => {
    const s = drag(8, 30)
    expect(s.phase).toBe('rejected')
    // A later sideways drift must not claim the row mid-scroll.
    const later = saOnMove(s, 100 - 80, 100 + 30)
    expect(later.phase).toBe('rejected')
  })

  it('rejects a diagonal where horizontal does not dominate', () => {
    // |dx| 12 ≥ slop but 12 ≤ |dy| 10 × 1.4 → vertical wins.
    const s = drag(-12, 10)
    expect(s.phase).toBe('rejected')
  })

  it('keeps updating dx while dragging', () => {
    const s = saOnMove(drag(-12), 100 - 40, 100)
    expect(s.phase).toBe('dragging')
    expect(s.dx).toBe(-40)
  })
})

describe('saTranslate', () => {
  it('is 0 at rest closed and -trayWidth at rest open', () => {
    expect(saTranslate(SA_IDLE, TRAY)).toBe(0)
    expect(saTranslate(SA_OPEN, TRAY)).toBe(-TRAY)
  })

  it('follows the drag inside the tray range', () => {
    expect(saTranslate(drag(-70), TRAY)).toBe(-70)
  })

  it('clamps a rightward drag from closed at 0', () => {
    expect(saTranslate(drag(30), TRAY)).toBe(0)
  })

  it('rubber-bands past the tray width', () => {
    const s = drag(-200)
    const excess = 200 - TRAY
    expect(saTranslate(s, TRAY)).toBe(-(TRAY + excess * SA_OVERDRAG_DAMPING))
  })

  it('caps the rubber band at SA_OVERDRAG', () => {
    const s = drag(-2000)
    expect(saTranslate(s, TRAY)).toBe(-(TRAY + SA_OVERDRAG))
  })

  it('starts from the open position when the gesture began open', () => {
    const s = drag(40, 0, true)
    expect(saTranslate(s, TRAY)).toBe(-TRAY + 40)
  })
})

describe('saOnEnd snap decision', () => {
  const SLOW = SA_FLICK_MAX_MS + 200

  it('opens past half the tray width', () => {
    const { open, next } = saOnEnd(drag(-70), TRAY, SLOW)
    expect(open).toBe(true)
    expect(next.phase).toBe('open')
  })

  it('closes on a short slow drag', () => {
    const { open, next } = saOnEnd(drag(-50), TRAY, SLOW)
    expect(open).toBe(false)
    expect(next).toEqual(SA_IDLE)
  })

  it('opens on a fast flick despite a short distance', () => {
    const { open } = saOnEnd(drag(-30), TRAY, 120)
    expect(open).toBe(true)
  })

  it('a fast rightward flick closes from open', () => {
    const { open } = saOnEnd(drag(30, 0, true), TRAY, 120)
    expect(open).toBe(false)
  })

  it('a slow rightward drag from open closes by position', () => {
    const { open } = saOnEnd(drag(100, 0, true), TRAY, SLOW)
    expect(open).toBe(false)
  })

  it('an unclaimed gesture restores the resting state it began from', () => {
    const fromClosed = saOnStart(SA_IDLE, 0, 0, 0)
    expect(saOnEnd(fromClosed, TRAY, SLOW)).toEqual({ open: false, next: SA_IDLE })
    const fromOpen = saOnStart(SA_OPEN, 0, 0, 0)
    expect(saOnEnd(fromOpen, TRAY, SLOW)).toEqual({ open: true, next: SA_OPEN })
    const rejected = drag(8, 30)
    expect(saOnEnd(rejected, TRAY, SLOW).open).toBe(false)
  })
})

describe('saOnCancel', () => {
  it('never opens — restores the resting state', () => {
    expect(saOnCancel(drag(-200))).toEqual(SA_IDLE)
    expect(saOnCancel(drag(-200, 0, true))).toEqual(SA_OPEN)
    expect(saOnCancel(SA_OPEN)).toBe(SA_OPEN)
    expect(saOnCancel(SA_IDLE)).toBe(SA_IDLE)
  })
})

describe('saShouldSwallowActivation', () => {
  it('always swallows while the tray is open (click AND keyboard paths)', () => {
    expect(saShouldSwallowActivation(SA_OPEN, 0, 99999)).toBe(true)
  })

  it('swallows inside the post-gesture window when closed', () => {
    expect(saShouldSwallowActivation(SA_IDLE, 1500, 1400)).toBe(true)
  })

  it('lets a later activation through when closed', () => {
    expect(saShouldSwallowActivation(SA_IDLE, 1500, 1501)).toBe(false)
    expect(saShouldSwallowActivation(SA_IDLE, 0, 100)).toBe(false)
  })
})

describe('one-open-at-a-time registry', () => {
  afterEach(() => saDisarm())

  it('registering a second row closes the first', () => {
    const a = vi.fn()
    const b = vi.fn()
    saRegisterOpen(a)
    expect(a).not.toHaveBeenCalled()
    saRegisterOpen(b)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('re-registering the same row is a no-op', () => {
    const a = vi.fn()
    saRegisterOpen(a)
    saRegisterOpen(a)
    expect(a).not.toHaveBeenCalled()
  })

  it('saDisarm closes the open row once and clears the slot', () => {
    const a = vi.fn()
    saRegisterOpen(a)
    saDisarm()
    expect(a).toHaveBeenCalledTimes(1)
    saDisarm()
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('unregister only clears its own slot', () => {
    const a = vi.fn()
    const b = vi.fn()
    saRegisterOpen(a)
    saUnregisterOpen(b)
    saDisarm()
    expect(a).toHaveBeenCalledTimes(1)
  })
})

describe('tab-swipe exclusion composition', () => {
  it('a data-noswipe swipe root excludes its descendants from tab-swipe', () => {
    // Mirrors the DOM SwipeActions renders: root[data-noswipe] > content > row bits.
    const root = document.createElement('div')
    root.className = 'rp-swipe'
    root.setAttribute('data-noswipe', 'true')
    const content = document.createElement('div')
    content.className = 'rp-swipe-content pl-row'
    const check = document.createElement('button')
    content.appendChild(check)
    root.appendChild(content)
    document.body.appendChild(root)
    expect(isSwipeExcluded(check)).toBe(true)
    expect(isSwipeExcluded(root)).toBe(true)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    expect(isSwipeExcluded(outside)).toBe(false)
  })
})
