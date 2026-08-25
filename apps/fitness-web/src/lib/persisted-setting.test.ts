// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createPersistedSetting } from './persisted-setting.js'

function mkStore(name: string) {
  return createPersistedSetting<number>({
    name,
    sanitize: (v) => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : 42
    },
  })
}

describe('createPersistedSetting', () => {
  it('defaults to sanitize(undefined) and clamps sets', () => {
    const s = mkStore('t-default')
    expect(s.get()).toBe(42)
    s.set(7.6)
    expect(s.get()).toBe(8)
    s.set(-1)
    expect(s.get()).toBe(42)
  })

  it('writes through the registered persister on set', () => {
    const s = mkStore('t-persist')
    const persister = vi.fn()
    s.registerPersister(persister)
    s.set(120)
    expect(persister).toHaveBeenCalledWith(120)
  })

  it('hydrateFromServer does NOT echo a write back through the persister', () => {
    // The hydration-echo guard is the subtle correctness detail this
    // factory centralizes — a server-applied value looping back as a
    // PATCH would ping-pong settings between devices.
    const s = mkStore('t-hydrate')
    const persister = vi.fn()
    s.registerPersister(persister)
    s.hydrateFromServer(150)
    expect(s.get()).toBe(150)
    expect(persister).not.toHaveBeenCalled()
    // undefined = "server has no value" — a no-op, not a reset.
    s.hydrateFromServer(undefined)
    expect(s.get()).toBe(150)
  })
})
