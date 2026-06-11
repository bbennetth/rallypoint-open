import { describe, it, expect } from 'vitest'
import { shouldRefetch, type RealtimeEnvelope } from './realtime.js'

function env(authorId?: string): RealtimeEnvelope {
  return {
    resource: 'list_items',
    operation: 'update',
    payload: { id: 'lit_1' },
    ...(authorId !== undefined ? { authorId } : {}),
    ts: new Date().toISOString(),
  }
}

describe('shouldRefetch', () => {
  it('skips an event this client authored (own mutation already refetched)', () => {
    expect(shouldRefetch(env('user_self'), 'user_self')).toBe(false)
  })

  it('refetches an event authored by another user', () => {
    expect(shouldRefetch(env('user_other'), 'user_self')).toBe(true)
  })

  it('refetches an event with an unknown author', () => {
    expect(shouldRefetch(env(undefined), 'user_self')).toBe(true)
  })

  it('refetches when self is unknown (no session id to compare)', () => {
    expect(shouldRefetch(env('user_other'), null)).toBe(true)
  })
})
