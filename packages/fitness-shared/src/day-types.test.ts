import { describe, it, expect } from 'vitest'
import {
  DAY_TYPE_VALUE_MAX,
  dayTypeDisplayLabel,
  dayTypeSchema,
  dayTypeValueSchema,
  dayTypesMapSchema,
  isPresetDayType,
  normalizeDayTypesMap,
} from './day-types.js'

describe('dayTypeSchema (presets only)', () => {
  it('accepts every known day type', () => {
    for (const t of ['strength', 'cardio', 'hiit', 'mobility', 'rest']) {
      expect(dayTypeSchema.safeParse(t).success).toBe(true)
    }
  })
  it('rejects a non-preset value (free-text is not a preset)', () => {
    expect(dayTypeSchema.safeParse('yoga').success).toBe(false)
  })
})

describe('dayTypeValueSchema (preset or free-text)', () => {
  it('accepts presets and arbitrary free-text labels', () => {
    expect(dayTypeValueSchema.safeParse('strength').success).toBe(true)
    expect(dayTypeValueSchema.safeParse('CrossFit class').success).toBe(true)
    expect(dayTypeValueSchema.safeParse('yoga').success).toBe(true)
  })
  it('trims surrounding whitespace', () => {
    expect(dayTypeValueSchema.parse('  CrossFit  ')).toBe('CrossFit')
  })
  it('rejects empty / whitespace-only strings', () => {
    expect(dayTypeValueSchema.safeParse('').success).toBe(false)
    expect(dayTypeValueSchema.safeParse('   ').success).toBe(false)
  })
  it('rejects labels longer than the cap', () => {
    expect(dayTypeValueSchema.safeParse('x'.repeat(DAY_TYPE_VALUE_MAX)).success).toBe(true)
    expect(dayTypeValueSchema.safeParse('x'.repeat(DAY_TYPE_VALUE_MAX + 1)).success).toBe(false)
  })
  it('rejects non-string values', () => {
    expect(dayTypeValueSchema.safeParse(123).success).toBe(false)
    expect(dayTypeValueSchema.safeParse({}).success).toBe(false)
  })
})

describe('isPresetDayType', () => {
  it('is true for presets, false for free-text', () => {
    expect(isPresetDayType('rest')).toBe(true)
    expect(isPresetDayType('CrossFit class')).toBe(false)
  })
})

describe('dayTypeDisplayLabel', () => {
  it('title-cases presets and passes free-text through verbatim', () => {
    expect(dayTypeDisplayLabel('hiit')).toBe('HIIT')
    expect(dayTypeDisplayLabel('strength')).toBe('Strength')
    expect(dayTypeDisplayLabel('CrossFit class')).toBe('CrossFit class')
  })
})

describe('dayTypesMapSchema', () => {
  it('accepts an empty object', () => {
    expect(dayTypesMapSchema.safeParse({}).success).toBe(true)
  })
  it('accepts a partial map of presets and free-text', () => {
    const result = dayTypesMapSchema.safeParse({ mon: 'strength', wed: 'CrossFit class' })
    expect(result.success).toBe(true)
  })
  it('rejects an empty-string value', () => {
    expect(dayTypesMapSchema.safeParse({ mon: '' }).success).toBe(false)
  })
})

describe('normalizeDayTypesMap', () => {
  it('returns an empty object for null/undefined/non-object input', () => {
    expect(normalizeDayTypesMap(null)).toEqual({})
    expect(normalizeDayTypesMap(undefined)).toEqual({})
    expect(normalizeDayTypesMap('nope')).toEqual({})
    expect(normalizeDayTypesMap(42)).toEqual({})
  })
  it('passes through valid preset entries', () => {
    expect(normalizeDayTypesMap({ mon: 'strength', fri: 'hiit' })).toEqual({
      mon: 'strength',
      fri: 'hiit',
    })
  })
  it('keeps free-text labels (trimming them)', () => {
    expect(normalizeDayTypesMap({ mon: 'strength', tue: '  CrossFit class  ' })).toEqual({
      mon: 'strength',
      tue: 'CrossFit class',
    })
  })
  it('drops unknown keys, empty strings, over-long labels, and non-strings', () => {
    expect(
      normalizeDayTypesMap({
        mon: 'strength',
        tue: '',
        wed: 'x'.repeat(DAY_TYPE_VALUE_MAX + 1),
        thu: 123,
        notADay: 'strength',
      }),
    ).toEqual({ mon: 'strength' })
  })
  it('returns an empty object when every value is invalid', () => {
    expect(normalizeDayTypesMap({ mon: '', tue: 123 })).toEqual({})
  })
})
