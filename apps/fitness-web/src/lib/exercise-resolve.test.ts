import { describe, expect, it } from 'vitest'
import {
  autoCreateInput,
  matchExerciseId,
  normalizeExerciseName,
  resolveExerciseIds,
  withResolvedId,
} from './exercise-resolve.js'

const catalog = [
  { id: 'fx_seed_back_squat', name: 'Back Squat' },
  { id: 'fx_seed_run', name: 'Run' },
  { id: 'ex_custom_1', name: 'Sled Push (heavy)' },
]

describe('normalizeExerciseName / matchExerciseId', () => {
  it('matches case-, whitespace-, and punctuation-insensitively', () => {
    expect(matchExerciseId('back  squat', catalog)).toBe('fx_seed_back_squat')
    expect(matchExerciseId('  RUN ', catalog)).toBe('fx_seed_run')
    expect(matchExerciseId('sled push heavy', catalog)).toBe('ex_custom_1')
  })

  it('returns null for unknown or blank names', () => {
    expect(matchExerciseId('zercher yoke carry', catalog)).toBeNull()
    expect(matchExerciseId('   ', catalog)).toBeNull()
    expect(normalizeExerciseName('!!!')).toBe('')
  })
})

describe('resolveExerciseIds', () => {
  it('matches catalog names without creating, creates the rest once per distinct name', async () => {
    const created: string[] = []
    let n = 0
    const create = async (input: { name: string }) => {
      created.push(input.name)
      n += 1
      return { id: `tmp_new_${n}` }
    }
    const rows = [
      { name: 'Back Squat', exerciseId: null },
      { name: 'zercher carry', exerciseId: null },
      { name: 'Zercher  Carry', exerciseId: null }, // dup, different spacing
      { name: 'already picked', exerciseId: 'ex_picked' }, // has an id — untouched
      { name: '', exerciseId: null }, // blank — skipped
    ]
    const resolved = await resolveExerciseIds(rows, catalog, create)
    expect(created).toEqual(['zercher carry'])
    expect(resolved.get('back squat')).toBe('fx_seed_back_squat')
    expect(resolved.get('zercher carry')).toBe('tmp_new_1')
    expect(resolved.has('already picked')).toBe(false)
  })

  it('withResolvedId fills only rows lacking an id', async () => {
    const resolved = new Map([['zercher carry', 'tmp_new_1']])
    expect(withResolvedId({ name: 'Zercher Carry', exerciseId: null }, resolved).exerciseId).toBe(
      'tmp_new_1',
    )
    expect(withResolvedId({ name: 'Zercher Carry', exerciseId: 'keep' }, resolved).exerciseId).toBe(
      'keep',
    )
    expect(withResolvedId({ name: 'unknown', exerciseId: null }, resolved).exerciseId).toBeNull()
  })

  it('autoCreateInput builds a schema-valid neutral create', () => {
    expect(autoCreateInput('  Zercher Carry ')).toEqual({
      name: 'Zercher Carry',
      discipline: 'bodyweight',
      movementPattern: 'other',
      metricShape: 'load_reps',
      unilateral: false,
      muscles: [],
    })
  })
})
