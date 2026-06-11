import { describe, it, expect } from 'vitest'
import { appInitial } from './launcher.js'

describe('appInitial', () => {
  it('uses the uppercased first character of the name', () => {
    expect(appInitial({ name: 'Events', client: 'events' })).toBe('E')
    expect(appInitial({ name: 'lists', client: 'lists' })).toBe('L')
  })

  it('falls back to the client id when the name is blank', () => {
    expect(appInitial({ name: '   ', client: 'money' })).toBe('M')
    expect(appInitial({ name: '', client: 'money' })).toBe('M')
  })

  it('returns ? when both name and client are blank', () => {
    expect(appInitial({ name: '', client: '' })).toBe('?')
  })
})
