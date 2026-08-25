import { describe, it, expect } from 'vitest'
import { recommendLoad } from './weight-rec.js'

describe('recommendLoad', () => {
  it('returns null when no recent set is provided', () => {
    expect(recommendLoad(5, null)).toBeNull()
  })
  it('returns null when the recent set is zeroed-out', () => {
    expect(recommendLoad(5, { reps: 0, loadKg: 100 })).toBeNull()
    expect(recommendLoad(5, { reps: 5, loadKg: 0 })).toBeNull()
  })
  it('bumps the suggestion when target reps go DOWN vs. the last set', () => {
    // last was 5x100; targeting 3 reps now — heavier session.
    const r = recommendLoad(3, { reps: 5, loadKg: 100 })
    expect(r).not.toBeNull()
    expect(r!.kg).toBeGreaterThanOrEqual(100)
    expect(r!.basis).toContain('+2.5')
  })
  it('does NOT bump when target reps stay the same or higher', () => {
    const same = recommendLoad(5, { reps: 5, loadKg: 100 })
    const higher = recommendLoad(8, { reps: 5, loadKg: 100 })
    expect(same!.basis).not.toContain('+2.5')
    expect(higher!.basis).not.toContain('+2.5')
  })
  it('rounds the suggestion to the nearest 2.5 kg', () => {
    const r = recommendLoad(5, { reps: 5, loadKg: 100 })
    expect(r!.kg % 2.5).toBe(0)
  })
  it('trims when a primary muscle group sits in the fatigued list', () => {
    const fresh = recommendLoad(5, { reps: 5, loadKg: 100 })
    const tired = recommendLoad(5, { reps: 5, loadKg: 100 }, {
      fatiguedGroupIds: ['legs'],
      primaryGroupIds: ['legs'],
    })
    expect(tired!.kg).toBeLessThan(fresh!.kg)
    expect(tired!.fatigued).toBe(true)
    expect(tired!.basis).toContain('muscle loaded')
  })
  it('leaves the load untouched when there is no fatigue overlap', () => {
    const r = recommendLoad(5, { reps: 5, loadKg: 100 }, {
      fatiguedGroupIds: ['back'],
      primaryGroupIds: ['legs'],
    })
    expect(r!.fatigued).toBe(false)
    expect(r!.basis).not.toContain('muscle loaded')
  })
})
