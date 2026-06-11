import { describe, it, expect } from 'vitest'
import { listChannel, scopeChannel, envelope, LISTS_PHYSICAL_CHANNEL } from './channels.js'

describe('realtime channel builders', () => {
  it('builds a list channel from a list id', () => {
    expect(listChannel('lst_123')).toBe('lists:list:lst_123')
  })

  it('builds a scope channel from a scope type + id', () => {
    expect(scopeChannel('group', 'personal')).toBe('lists:scope:group:personal')
    expect(scopeChannel('group', 'group_abc')).toBe('lists:scope:group:group_abc')
  })

  it('rides one physical channel', () => {
    expect(LISTS_PHYSICAL_CHANNEL).toBe('lists_rt')
  })
})

describe('envelope', () => {
  it('builds a pointer envelope with an ISO timestamp', () => {
    const env = envelope('list_items', 'create', 'lit_1', 'user_42')
    expect(env.resource).toBe('list_items')
    expect(env.operation).toBe('create')
    expect(env.payload).toEqual({ id: 'lit_1' })
    expect(env.authorId).toBe('user_42')
    expect(() => new Date(env.ts).toISOString()).not.toThrow()
    expect(new Date(env.ts).toISOString()).toBe(env.ts)
  })

  it('omits authorId entirely when unknown (no explicit undefined)', () => {
    const env = envelope('lists', 'delete', 'lst_9')
    expect('authorId' in env).toBe(false)
  })
})
