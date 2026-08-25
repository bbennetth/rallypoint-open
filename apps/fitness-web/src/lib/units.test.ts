import { describe, it, expect } from 'vitest'
import {
  displayToM,
  mToDisplay,
  naturalDistanceUnit,
  formatDistanceM,
  KG_PER_LB,
  displayToKg,
  formatLoad,
  formatTonnage,
  kgToDisplay,
  sanitizeWeightUnit,
} from './units.js'

describe('sanitizeWeightUnit', () => {
  it('defaults unknown values to pounds', () => {
    expect(sanitizeWeightUnit(undefined)).toBe('lb')
    expect(sanitizeWeightUnit('metric')).toBe('lb')
    expect(sanitizeWeightUnit(null)).toBe('lb')
  })
  it('passes through the two known units', () => {
    expect(sanitizeWeightUnit('kg')).toBe('kg')
    expect(sanitizeWeightUnit('lb')).toBe('lb')
  })
})

describe('kgToDisplay / displayToKg', () => {
  it('rounds a stored kg to whole pounds (Fran thruster 43 kg → 95 lb)', () => {
    expect(kgToDisplay(43, 'lb')).toBe(95)
  })
  it('keeps one decimal of pounds when dp=1 (fractional bodyweight)', () => {
    // 158.2 lb stored as 71.76 kg re-displays as 158.2 lb, not 158.
    const kg = displayToKg(158.2, 'lb')
    expect(kgToDisplay(kg, 'lb')).toBe(158) // default dp=0 still whole-lb
    expect(kgToDisplay(kg, 'lb', 1)).toBe(158.2)
  })
  it('keeps kg values (trimming float noise)', () => {
    expect(kgToDisplay(43.086, 'kg')).toBe(43.09)
    expect(kgToDisplay(60, 'kg')).toBe(60)
  })
  it('round-trips 95 lb back to a kg that re-displays as 95 lb', () => {
    const kg = displayToKg(95, 'lb')
    expect(kg).toBeCloseTo(43.09, 2)
    expect(kgToDisplay(kg, 'lb')).toBe(95)
  })
  it('is the identity in kg mode', () => {
    expect(displayToKg(60, 'kg')).toBe(60)
  })
  it('keeps zero at zero in both directions', () => {
    expect(kgToDisplay(0, 'lb')).toBe(0)
    expect(kgToDisplay(0, 'kg')).toBe(0)
    expect(displayToKg(0, 'lb')).toBe(0)
  })
  it('KG_PER_LB is the standard avoirdupois constant', () => {
    expect(KG_PER_LB).toBeCloseTo(0.45359237, 8)
  })
})

describe('formatLoad', () => {
  it('renders the unit suffix', () => {
    expect(formatLoad(43, 'lb')).toBe('95 lb')
    expect(formatLoad(60, 'kg')).toBe('60 kg')
  })
})

describe('formatTonnage', () => {
  it('formats kg with a tonne rollover', () => {
    expect(formatTonnage(850, 'kg')).toBe('850 kg')
    expect(formatTonnage(1200, 'kg')).toBe('1.2 t')
  })
  it('formats lb with a 10k compaction and thousands separators', () => {
    expect(formatTonnage(453.59237, 'lb')).toBe('1,000 lb')
    // 20,000 kg ≈ 44,092 lb → compacts to 44.1k lb
    expect(formatTonnage(20000, 'lb')).toBe('44.1k lb')
  })
})

describe('distance units (running)', () => {
  it('converts miles to storage metres at 2 dp', () => {
    expect(displayToM(5, 'mi')).toBe(8046.72)
    expect(displayToM(1, 'mi')).toBe(1609.34)
    expect(displayToM(400, 'm')).toBe(400)
  })
  it('converts stored metres to display miles at 2 dp', () => {
    expect(mToDisplay(8046.72, 'mi')).toBe(5)
    expect(mToDisplay(400, 'm')).toBe(400)
  })
  it('naturalDistanceUnit recovers miles for quarter-mile multiples', () => {
    expect(naturalDistanceUnit(displayToM(5, 'mi'))).toBe('mi')
    expect(naturalDistanceUnit(displayToM(3.25, 'mi'))).toBe('mi')
    expect(naturalDistanceUnit(5000)).toBe('m')
    expect(naturalDistanceUnit(400)).toBe('m')
    expect(naturalDistanceUnit(0)).toBe('m')
  })
  it('formatDistanceM renders the natural unit', () => {
    expect(formatDistanceM(displayToM(5, 'mi'))).toBe('5 mi')
    expect(formatDistanceM(5000)).toBe('5,000 m')
  })
})
