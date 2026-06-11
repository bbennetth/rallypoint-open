import { describe, it, expect } from 'vitest'
import { canAccessNamespace } from './settings-access.js'

describe('canAccessNamespace', () => {
  it('allows an app to access its own namespace', () => {
    expect(canAccessNamespace('planner', 'planner')).toBe(true)
    expect(canAccessNamespace('events', 'events')).toBe(true)
  })

  it('allows any app to access the shared namespace', () => {
    expect(canAccessNamespace('planner', 'shared')).toBe(true)
    expect(canAccessNamespace('money', 'shared')).toBe(true)
  })

  it('forbids accessing another app namespace', () => {
    expect(canAccessNamespace('planner', 'events')).toBe(false)
    expect(canAccessNamespace('events', 'lists')).toBe(false)
  })

  it('forbids an unknown namespace', () => {
    expect(canAccessNamespace('planner', 'nope')).toBe(false)
  })
})
