import { describe, it, expect } from 'vitest'
import {
  PTR_ACTIVATION_SLOP,
  PTR_IDLE,
  PTR_MAX_TRANSLATE,
  PTR_THRESHOLD,
  ptrIndicatorTranslate,
  ptrOnEnd,
  ptrOnMove,
  ptrOnStart,
  ptrSyncCycleStatus,
} from './pull-to-refresh.js'

describe('ptrOnStart', () => {
  it('arms the gesture when the scroller is at the top', () => {
    const s = ptrOnStart(0, 120)
    expect(s.phase).toBe('idle')
    expect(s.startY).toBe(120)
  })

  it('stays idle (no startY) when the scroller is below the top', () => {
    expect(ptrOnStart(40, 120)).toEqual(PTR_IDLE)
  })
})

describe('ptrOnMove', () => {
  const armed = ptrOnStart(0, 100)

  it('stays idle while inside the activation slop', () => {
    const s = ptrOnMove(armed, 0, 100 + PTR_ACTIVATION_SLOP - 1)
    expect(s.phase).toBe('idle')
  })

  it('promotes to pulling once past the slop', () => {
    const s = ptrOnMove(armed, 0, 100 + PTR_ACTIVATION_SLOP + 5)
    expect(s.phase).toBe('pulling')
  })

  it('promotes to committed once past the threshold', () => {
    const s = ptrOnMove(armed, 0, 100 + PTR_THRESHOLD + 10)
    expect(s.phase).toBe('committed')
  })

  it('drops back to idle when the scroller is no longer at the top', () => {
    expect(ptrOnMove(armed, 80, 200)).toEqual(PTR_IDLE)
  })

  it('drops back to idle on an upward drag', () => {
    const s = ptrOnMove(armed, 0, 50)
    expect(s.phase).toBe('idle')
    expect(s.deltaY).toBe(0)
  })

  it('ignores movement while in cooldown', () => {
    const cooldown = { phase: 'cooldown' as const, deltaY: 0, startY: null }
    expect(ptrOnMove(cooldown, 0, 999)).toBe(cooldown)
  })
})

describe('ptrOnEnd', () => {
  it('commits + transitions to cooldown when phase reached committed', () => {
    const r = ptrOnEnd({ phase: 'committed', deltaY: 100, startY: 0 })
    expect(r.commit).toBe(true)
    expect(r.next.phase).toBe('cooldown')
  })

  it('does NOT commit when only pulling', () => {
    const r = ptrOnEnd({ phase: 'pulling', deltaY: 40, startY: 0 })
    expect(r.commit).toBe(false)
    expect(r.next).toEqual(PTR_IDLE)
  })

  it('passes through cooldown unchanged', () => {
    const cooldown = { phase: 'cooldown' as const, deltaY: 0, startY: null }
    expect(ptrOnEnd(cooldown)).toEqual({ commit: false, next: cooldown })
  })
})

describe('ptrIndicatorTranslate', () => {
  it('returns 0 for non-positive pulls', () => {
    expect(ptrIndicatorTranslate(0)).toBe(0)
    expect(ptrIndicatorTranslate(-50)).toBe(0)
  })

  it('damps the pull distance', () => {
    expect(ptrIndicatorTranslate(40)).toBe(20)
  })

  it('clamps to PTR_MAX_TRANSLATE', () => {
    expect(ptrIndicatorTranslate(10_000)).toBe(PTR_MAX_TRANSLATE)
  })
})

describe('ptrSyncCycleStatus', () => {
  it('marks unsynced when the connection drops', () => {
    expect(ptrSyncCycleStatus(false, false)).toEqual({
      sawUnsynced: true,
      complete: false,
    })
  })

  it('reports complete after seeing unsynced and getting a synced welcome', () => {
    expect(ptrSyncCycleStatus(true, true)).toEqual({
      sawUnsynced: false,
      complete: true,
    })
  })

  it('does NOT report complete if synced never dropped (no real reconnect)', () => {
    expect(ptrSyncCycleStatus(false, true)).toEqual({
      sawUnsynced: false,
      complete: false,
    })
  })
})
