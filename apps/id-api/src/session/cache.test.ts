import { describe, it, expect } from 'vitest'
import { SessionCache } from './cache.js'
import type { SessionRecord } from '../repos/session.js'

function makeRecord(idHash: string): SessionRecord {
  return {
    idHash,
    userId: 'user_test',
    tenantId: 'rallypoint',
    createdAt: new Date(),
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
  }
}

describe('SessionCache', () => {
  it('returns undefined for an unseen key', () => {
    const c = new SessionCache()
    expect(c.get('missing')).toBeUndefined()
  })

  it('returns the stored record on hit', () => {
    const c = new SessionCache()
    const r = makeRecord('abc')
    c.put('abc', r)
    expect(c.get('abc')).toBe(r)
  })

  it('returns null for a negative cache entry (distinguishable from miss)', () => {
    const c = new SessionCache()
    c.put('abc', null)
    expect(c.get('abc')).toBeNull()
    expect(c.get('different')).toBeUndefined()
  })

  it('expires entries after ttlMs', () => {
    let t = 0
    const c = new SessionCache({ ttlMs: 100, now: () => t })
    c.put('abc', makeRecord('abc'))
    t = 50
    expect(c.get('abc')).not.toBeUndefined()
    t = 200
    expect(c.get('abc')).toBeUndefined()
  })

  it('evicts the LRU entry when capacity is exceeded', () => {
    const c = new SessionCache({ capacity: 2 })
    c.put('a', makeRecord('a'))
    c.put('b', makeRecord('b'))
    c.put('c', makeRecord('c')) // evicts 'a'
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).not.toBeUndefined()
    expect(c.get('c')).not.toBeUndefined()
  })

  it('refreshes LRU position on get', () => {
    const c = new SessionCache({ capacity: 2 })
    c.put('a', makeRecord('a'))
    c.put('b', makeRecord('b'))
    c.get('a') // refresh
    c.put('c', makeRecord('c')) // should evict 'b', not 'a'
    expect(c.get('a')).not.toBeUndefined()
    expect(c.get('b')).toBeUndefined()
  })

  it('invalidate() and invalidateAll() drop entries', () => {
    const c = new SessionCache()
    c.put('a', makeRecord('a'))
    c.put('b', makeRecord('b'))
    c.invalidate('a')
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).not.toBeUndefined()
    c.invalidateAll()
    expect(c.get('b')).toBeUndefined()
    expect(c.size()).toBe(0)
  })
})
