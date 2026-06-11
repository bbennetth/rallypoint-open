import { describe, it, expect } from 'vitest'
import { SHARED_SETTINGS_NAMESPACE, SETTINGS_MAX_BYTES } from './index.js'

describe('settings store constants', () => {
  it('exposes the shared cross-app namespace name', () => {
    expect(SHARED_SETTINGS_NAMESPACE).toBe('shared')
  })

  it('caps a settings document at a sane positive byte size', () => {
    expect(SETTINGS_MAX_BYTES).toBeGreaterThan(0)
    expect(SETTINGS_MAX_BYTES).toBe(16 * 1024)
  })
})
