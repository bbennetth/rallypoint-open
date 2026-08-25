// Unit tests for the UniqueConstraintError repo-layer error type.

import { describe, it, expect } from 'vitest'
import { UniqueConstraintError } from './repo-errors.js'

describe('UniqueConstraintError', () => {
  it('sets name, message, and constraint from the constructor arg', () => {
    const err = new UniqueConstraintError('groups_event_name_idx')
    expect(err.name).toBe('UniqueConstraintError')
    expect(err.message).toBe('groups_event_name_idx')
    expect(err.constraint).toBe('groups_event_name_idx')
  })

  it('is an instanceof Error', () => {
    expect(new UniqueConstraintError('x')).toBeInstanceOf(Error)
  })
})
