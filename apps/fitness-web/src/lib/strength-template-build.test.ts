import { describe, expect, it } from 'vitest'
import {
  buildStrengthTemplateBody,
  filterUsableBlock,
  hasUsableStrengthSets,
  isRepUsableSet,
} from './strength-template-build.js'

const block = (
  exerciseId: string,
  exerciseName: string,
  sets: { reps: number | null; loadKg: number | null }[],
) => ({ exerciseId, exerciseName, sets })

describe('isRepUsableSet', () => {
  it('accepts a positive-rep set', () => {
    expect(isRepUsableSet({ reps: 5, loadKg: 60 })).toBe(true)
  })
  it('accepts a bodyweight (loadKg=0) set with positive reps', () => {
    // Bodyweight reps are the load-bearing case here — code-review F11
    // had the old `loadKg > 0` filter erasing them.
    expect(isRepUsableSet({ reps: 12, loadKg: 0 })).toBe(true)
  })
  it('rejects a null-reps (duration-only) set', () => {
    expect(isRepUsableSet({ reps: null, loadKg: 0 })).toBe(false)
  })
  it('rejects a zero-reps set', () => {
    // 0 reps in a template would render as "0×100kg" — meaningless.
    expect(isRepUsableSet({ reps: 0, loadKg: 100 })).toBe(false)
  })
})

describe('filterUsableBlock', () => {
  it('drops null-reps sets but keeps rep-bearing ones', () => {
    const b = block('fx_seed_back_squat', 'Back squat', [
      { reps: 5, loadKg: 100 },
      { reps: null, loadKg: 0 }, // duration-only — dropped
      { reps: 3, loadKg: 110 },
    ])
    expect(filterUsableBlock(b)?.sets).toHaveLength(2)
  })
  it('returns null when every set is unusable', () => {
    const b = block('fx_seed_plank', 'Plank', [
      { reps: null, loadKg: null },
      { reps: 0, loadKg: 0 },
    ])
    expect(filterUsableBlock(b)).toBeNull()
  })
})

describe('hasUsableStrengthSets', () => {
  it('is true when any block has a rep-bearing set', () => {
    expect(
      hasUsableStrengthSets([
        block('fx_seed_plank', 'Plank', [{ reps: null, loadKg: null }]),
        block('fx_seed_back_squat', 'Back squat', [{ reps: 5, loadKg: 100 }]),
      ]),
    ).toBe(true)
  })
  it('is false when every block is duration-only', () => {
    expect(
      hasUsableStrengthSets([
        block('fx_seed_plank', 'Plank', [{ reps: null, loadKg: null }]),
        block('fx_seed_pp', 'Pause-pose', [{ reps: 0, loadKg: null }]),
      ]),
    ).toBe(false)
  })
  it('is false for an empty input', () => {
    expect(hasUsableStrengthSets([])).toBe(false)
  })
})

describe('buildStrengthTemplateBody', () => {
  it('preserves bodyweight (loadKg=0) sets — code-review F11', () => {
    const body = buildStrengthTemplateBody([
      block('fx_seed_pull_up', 'Pull-up', [
        { reps: 10, loadKg: 0 },
        { reps: 8, loadKg: 0 },
        { reps: 6, loadKg: 0 },
      ]),
    ])
    expect(body.blocks).toHaveLength(1)
    expect(body.blocks[0]?.sets).toEqual([
      { reps: 10, loadKg: 0 },
      { reps: 8, loadKg: 0 },
      { reps: 6, loadKg: 0 },
    ])
  })

  it('omits loadKg only when it is null (distinguishes "missing" from "bodyweight")', () => {
    const body = buildStrengthTemplateBody([
      block('fx_seed_squat', 'Squat', [
        { reps: 5, loadKg: null }, // no load info → omit
        { reps: 5, loadKg: 0 }, // bodyweight → preserve as 0
        { reps: 5, loadKg: 100 }, // loaded → preserve as 100
      ]),
    ])
    expect(body.blocks[0]?.sets).toEqual([
      { reps: 5 },
      { reps: 5, loadKg: 0 },
      { reps: 5, loadKg: 100 },
    ])
  })

  it('excludes duration-only sets from the saved template', () => {
    const body = buildStrengthTemplateBody([
      block('fx_seed_back_squat', 'Back squat', [
        { reps: 5, loadKg: 100 },
        { reps: null, loadKg: 0 }, // duration-only — dropped
      ]),
    ])
    expect(body.blocks[0]?.sets).toHaveLength(1)
    expect(body.blocks[0]?.sets[0]).toEqual({ reps: 5, loadKg: 100 })
  })

  it('drops a block entirely when no set is rep-usable', () => {
    const body = buildStrengthTemplateBody([
      block('fx_seed_plank', 'Plank', [{ reps: null, loadKg: null }]),
      block('fx_seed_squat', 'Squat', [{ reps: 5, loadKg: 60 }]),
    ])
    expect(body.blocks).toHaveLength(1)
    expect(body.blocks[0]?.exerciseId).toBe('fx_seed_squat')
  })
})
