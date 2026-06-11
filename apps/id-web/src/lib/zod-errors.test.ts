import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  apiValidationToFieldErrors,
  issuesToFieldErrors,
  zodToFieldErrors,
} from './zod-errors.js'

describe('issuesToFieldErrors', () => {
  it('keys by the first path element', () => {
    const result = issuesToFieldErrors([
      { code: 'too_small', minimum: 12, path: ['password'], message: 'too short', type: 'string', inclusive: true } as never,
      { code: 'invalid_type', path: ['email'], message: 'bad', expected: 'string', received: 'undefined' } as never,
    ])
    expect(result).toEqual({ password: 'too short', email: 'bad' })
  })

  it('keeps the FIRST issue per field (no overwrite)', () => {
    const result = issuesToFieldErrors([
      { code: 'a', path: ['p'], message: 'first' } as never,
      { code: 'b', path: ['p'], message: 'second' } as never,
    ])
    expect(result.p).toBe('first')
  })

  it('uses _ as the key when path is empty (form-level error)', () => {
    const result = issuesToFieldErrors([
      { code: 'custom', path: [], message: 'form invalid' } as never,
    ])
    expect(result._).toBe('form invalid')
  })
})

describe('zodToFieldErrors', () => {
  it('decodes a real ZodError', () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(18) })
    const result = schema.safeParse({ email: 'nope', age: 12 })
    if (result.success) throw new Error('expected failure')
    const fieldErrors = zodToFieldErrors(result.error)
    expect(Object.keys(fieldErrors).sort()).toEqual(['age', 'email'])
  })
})

describe('apiValidationToFieldErrors', () => {
  it('returns empty when details is undefined', () => {
    expect(apiValidationToFieldErrors(undefined)).toEqual({})
  })

  it('returns empty when issues is not an array', () => {
    expect(apiValidationToFieldErrors({ issues: 'nope' as never })).toEqual({})
  })

  it('decodes an issues array from API details', () => {
    const out = apiValidationToFieldErrors({
      issues: [
        { code: 'too_small', path: ['password'], message: 'too short' } as never,
      ],
    })
    expect(out.password).toBe('too short')
  })
})
