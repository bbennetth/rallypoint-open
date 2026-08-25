import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetCacheSubscribers,
  _subscriberCount,
  notifyCacheWrite,
  subscribeCache,
} from './cache-subscribers.js'

afterEach(() => {
  _resetCacheSubscribers()
})

describe('cache-subscribers — pure registry', () => {
  it('delivers a notify to a subscriber on the same (table, key)', () => {
    const cb = vi.fn()
    subscribeCache('taskItems', 'list_1|UTC', cb)
    notifyCacheWrite('taskItems', 'list_1|UTC', [{ id: 'a' }])
    expect(cb).toHaveBeenCalledExactlyOnceWith([{ id: 'a' }])
  })

  it('does not deliver across tables or keys', () => {
    const cb = vi.fn()
    subscribeCache('taskItems', 'list_1|UTC', cb)
    notifyCacheWrite('taskItems', 'list_2|UTC', [])
    notifyCacheWrite('shoppingItems', 'list_1|UTC', [])
    expect(cb).not.toHaveBeenCalled()
  })

  it('supports multiple subscribers on one channel', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeCache('myDay', 'k', a)
    subscribeCache('myDay', 'k', b)
    notifyCacheWrite('myDay', 'k', 42)
    expect(a).toHaveBeenCalledWith(42)
    expect(b).toHaveBeenCalledWith(42)
  })

  it('unsubscribe removes the listener and empties the channel', () => {
    const cb = vi.fn()
    const off = subscribeCache('myDay', 'k', cb)
    expect(_subscriberCount('myDay', 'k')).toBe(1)
    off()
    expect(_subscriberCount('myDay', 'k')).toBe(0)
    notifyCacheWrite('myDay', 'k', 1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a throwing listener does not block its siblings', () => {
    const bad = vi.fn(() => {
      throw new Error('subscriber bug')
    })
    const good = vi.fn()
    subscribeCache('myDay', 'k', bad)
    subscribeCache('myDay', 'k', good)
    expect(() => notifyCacheWrite('myDay', 'k', 1)).not.toThrow()
    expect(good).toHaveBeenCalledWith(1)
  })

  it('a listener unsubscribing during notify does not skip others', () => {
    const calls: string[] = []
    const offA = subscribeCache('myDay', 'k', () => {
      calls.push('a')
      offA()
    })
    subscribeCache('myDay', 'k', () => calls.push('b'))
    notifyCacheWrite('myDay', 'k', 1)
    expect(calls).toEqual(['a', 'b'])
  })

  it('notify on a channel with no subscribers is a no-op', () => {
    expect(() => notifyCacheWrite('notes', 'nobody', null)).not.toThrow()
  })
})
