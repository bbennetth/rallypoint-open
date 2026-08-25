import { describe, expect, it } from 'vitest'
import { refField } from './validators.js'

// refField is the offline-create idempotency key shared by every
// ref-bearing create schema (workouts, metrics, exercises, wod
// templates, training plans) — mirrors money-shared's expenseRefField.
// Bounds mirror the fitness-db partial-unique indexes: 1..256 chars.

describe('refField', () => {
  it('accepts a typical tmp_<uuid> idempotency key', () => {
    const r = refField.safeParse('tmp_3fa85f64-5717-4562-b3fc-2c963f66afa6')
    expect(r.success).toBe(true)
  })

  it('accepts exactly 40 characters (the documented tmpId length)', () => {
    const ref = 'a'.repeat(40)
    expect(refField.safeParse(ref).success).toBe(true)
  })

  it('accepts exactly 256 characters (the upper bound)', () => {
    const ref = 'a'.repeat(256)
    expect(refField.safeParse(ref).success).toBe(true)
  })

  it('rejects a ref over 256 characters', () => {
    const ref = 'a'.repeat(257)
    const r = refField.safeParse(ref)
    expect(r.success).toBe(false)
  })

  it('rejects an empty or whitespace-only ref', () => {
    expect(refField.safeParse('').success).toBe(false)
    expect(refField.safeParse('   ').success).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    const r = refField.safeParse('  tmp_abc  ')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('tmp_abc')
  })
})
