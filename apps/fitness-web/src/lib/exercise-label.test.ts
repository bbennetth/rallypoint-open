import { describe, expect, it } from 'vitest'
import { buildExerciseNameMap, exerciseLabel, slugLabelFromId } from './exercise-label.js'

// A real catalog id, as minted by exercises.ts (`fx_${ulid()}`). This is
// the exact id that leaked into the WOD hero card as "fx 01KYA7RAF...".
const ULID_ID = 'fx_01KYA7RAF4GS4RE8AG9ZJSP6X4'

describe('slugLabelFromId', () => {
  it('title-cases legacy synthesized fx_seed_<slug> ids', () => {
    expect(slugLabelFromId('fx_seed_wall_ball')).toBe('Wall Ball')
    expect(slugLabelFromId('fx_seed_sit_up')).toBe('Sit Up')
    expect(slugLabelFromId('fx_seed_run')).toBe('Run')
  })

  it('title-cases per word, so acronyms stay capitalized-first only', () => {
    // Known, accepted limitation: \b\w can't know "GHD" is an acronym.
    // Pinned so a future change to the casing rule is a deliberate one.
    expect(slugLabelFromId('fx_seed_ghd_hip_extension')).toBe('Ghd Hip Extension')
  })

  it('never leaks a real fx_<ULID> id into the label', () => {
    const label = slugLabelFromId(ULID_ID)
    expect(label).toBe('Exercise')
    // The regression this module exists for: no fragment of the id may
    // survive into the rendered string.
    expect(label).not.toContain('01KYA')
    expect(label).not.toContain('fx')
  })

  it('falls back for blank, degenerate, and foreign id shapes', () => {
    expect(slugLabelFromId('')).toBe('Exercise')
    // slugify('!!!') === '' would yield this; the trailing + rejects it.
    expect(slugLabelFromId('fx_seed_')).toBe('Exercise')
    expect(slugLabelFromId('ex_custom_1')).toBe('Exercise')
    // Uppercase can't be a slugify() output, so it isn't seed-shaped.
    expect(slugLabelFromId('fx_seed_Wall_Ball')).toBe('Exercise')
  })
})

describe('exerciseLabel', () => {
  it('resolves a real id to its catalog name', () => {
    const names = new Map([[ULID_ID, 'Sandbag Carry']])
    expect(exerciseLabel(ULID_ID, names)).toBe('Sandbag Carry')
  })

  it('falls back to the neutral label when the catalog has no entry', () => {
    expect(exerciseLabel(ULID_ID, new Map())).toBe('Exercise')
  })

  it('falls back to the slug label for an unresolved seed id', () => {
    // Cold cache / offline: the map is empty but seed ids still read well.
    expect(exerciseLabel('fx_seed_wall_ball', new Map())).toBe('Wall Ball')
  })

  it('prefers the catalog name over the slug embedded in the id', () => {
    // A renamed seed exercise shows its current name, not the frozen slug.
    const names = new Map([['fx_seed_wall_ball', 'Wall Ball Shot']])
    expect(exerciseLabel('fx_seed_wall_ball', names)).toBe('Wall Ball Shot')
  })
})

describe('buildExerciseNameMap', () => {
  it('indexes a catalog read by id', () => {
    const map = buildExerciseNameMap([
      { id: ULID_ID, name: 'Sandbag Carry' },
      { id: 'fx_seed_run', name: 'Run' },
    ])
    expect(map.get(ULID_ID)).toBe('Sandbag Carry')
    expect(map.get('fx_seed_run')).toBe('Run')
    expect(map.size).toBe(2)
  })

  it('returns an empty map for an empty catalog', () => {
    expect(buildExerciseNameMap([]).size).toBe(0)
  })
})
