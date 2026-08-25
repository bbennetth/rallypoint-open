import { describe, expect, it } from 'vitest'
import {
  clearBootPending,
  nextBootAction,
  recordLaunch,
  type BootStorage,
} from './boot-watchdog.js'

function memStorage(initial: Record<string, string> = {}): BootStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('nextBootAction', () => {
  it('does nothing when the previous launch booted', () => {
    expect(nextBootAction(false, 0)).toBe('none')
    // A stale fail count without a pending flag never escalates.
    expect(nextBootAction(false, 5)).toBe('none')
  })
  it('activates the waiting SW on the first failure', () => {
    expect(nextBootAction(true, 1)).toBe('activate-waiting')
  })
  it('nukes SW + caches from the second consecutive failure on', () => {
    expect(nextBootAction(true, 2)).toBe('nuke')
    expect(nextBootAction(true, 3)).toBe('nuke')
  })
})

describe('recordLaunch / clearBootPending', () => {
  it('healthy launch: marks pending, no action', () => {
    const s = memStorage()
    expect(recordLaunch(s)).toEqual({ action: 'none', failCount: 0 })
    expect(s.map.get('rp-boot-pending')).toBe('1')
  })

  it('boot success clears both keys, so the next launch is clean', () => {
    const s = memStorage()
    recordLaunch(s)
    clearBootPending(s)
    expect(recordLaunch(s)).toEqual({ action: 'none', failCount: 0 })
  })

  it('escalates across relaunches: activate-waiting, then nuke', () => {
    const s = memStorage()
    recordLaunch(s) // launch 1 — never calls clearBootPending (white screen)
    expect(recordLaunch(s)).toEqual({ action: 'activate-waiting', failCount: 1 })
    expect(recordLaunch(s)).toEqual({ action: 'nuke', failCount: 2 })
    // Still broken → keeps nuking (each relaunch is user-initiated).
    expect(recordLaunch(s)).toEqual({ action: 'nuke', failCount: 3 })
  })

  it('a successful boot after failures fully resets the counter', () => {
    const s = memStorage()
    recordLaunch(s)
    recordLaunch(s) // failure 1
    clearBootPending(s) // this launch made it
    expect(recordLaunch(s)).toEqual({ action: 'none', failCount: 0 })
  })

  it('tolerates garbage in the fail counter', () => {
    const s = memStorage({ 'rp-boot-pending': '1', 'rp-boot-fails': 'lol' })
    expect(recordLaunch(s)).toEqual({ action: 'activate-waiting', failCount: 1 })
  })
})
