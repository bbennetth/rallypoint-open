import { describe, expect, it } from 'vitest'
import { namesMatch, normalizeExerciseName } from './normalize.js'

describe('normalizeExerciseName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeExerciseName('  Back Squat  ')).toBe('Back Squat')
  })

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeExerciseName('Back   Squat')).toBe('Back Squat')
    expect(normalizeExerciseName('Romanian\tDeadlift')).toBe('Romanian Deadlift')
  })

  it('preserves casing and meaningful punctuation', () => {
    expect(normalizeExerciseName("Farmer's Carry")).toBe("Farmer's Carry")
    expect(normalizeExerciseName('21s')).toBe('21s')
  })

  it('leaves an already-clean name unchanged', () => {
    expect(normalizeExerciseName('Thruster')).toBe('Thruster')
  })
})

describe('namesMatch', () => {
  it('matches case-insensitively after normalization', () => {
    expect(namesMatch('Back  Squat ', 'back squat')).toBe(true)
    expect(namesMatch('THRUSTER', 'thruster')).toBe(true)
  })

  it('does not match genuinely different names', () => {
    expect(namesMatch('Back Squat', 'Front Squat')).toBe(false)
  })

  it('does not collapse meaningful punctuation differences', () => {
    expect(namesMatch("Farmer's Carry", 'Farmers Carry')).toBe(false)
  })
})
