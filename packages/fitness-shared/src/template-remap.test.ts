import { describe, expect, it } from 'vitest'
import { remapTemplateBody, remapTemplateBodyExerciseIds } from './template-remap.js'

const strengthBody = {
  blocks: [
    { exerciseId: 'fx_old', name: 'Barbell Press', sets: [{ reps: 5 }] },
    { exerciseId: 'fx_other', name: 'Dip', sets: [{ reps: 8 }] },
  ],
}

const wodBody = {
  wodType: 'for_time',
  movements: [
    { exerciseId: 'fx_old', reps: 21 },
    { exerciseId: 'fx_other', reps: 21 },
  ],
  perMinuteBuyIn: { exerciseId: 'fx_old', reps: 5 },
}

describe('remapTemplateBody', () => {
  it('remaps strength blocks[].exerciseId, leaving siblings untouched', () => {
    const out = remapTemplateBody(strengthBody, 'fx_old', 'fx_new')
    expect(out.blocks[0]).toMatchObject({ exerciseId: 'fx_new', name: 'Barbell Press' })
    // Untouched block keeps its identity (no gratuitous clones).
    expect(out.blocks[1]).toBe(strengthBody.blocks[1])
    expect(out.blocks[0]?.sets).toBe(strengthBody.blocks[0]?.sets)
  })

  it('remaps wod movements[].exerciseId and perMinuteBuyIn.exerciseId', () => {
    const out = remapTemplateBody(wodBody, 'fx_old', 'fx_new')
    expect(out.movements.map((m) => m.exerciseId)).toEqual(['fx_new', 'fx_other'])
    expect(out.perMinuteBuyIn).toMatchObject({ exerciseId: 'fx_new', reps: 5 })
  })

  it('returns the same reference when no id matches', () => {
    expect(remapTemplateBody(strengthBody, 'fx_absent', 'fx_new')).toBe(strengthBody)
    expect(remapTemplateBody(wodBody, 'fx_absent', 'fx_new')).toBe(wodBody)
  })
})

describe('remapTemplateBodyExerciseIds (resolver form)', () => {
  it('maps multiple distinct ids in one pass', () => {
    const map = new Map([
      ['fx_old', 'fx_new'],
      ['fx_other', 'fx_other2'],
    ])
    const out = remapTemplateBodyExerciseIds(wodBody, (id) => map.get(id) ?? id)
    expect(out.movements.map((m) => m.exerciseId)).toEqual(['fx_new', 'fx_other2'])
    expect(out.perMinuteBuyIn.exerciseId).toBe('fx_new')
  })

  it('identity resolver returns the same reference', () => {
    expect(remapTemplateBodyExerciseIds(strengthBody, (id) => id)).toBe(strengthBody)
  })

  it('tolerates a body without movements/blocks/buy-in', () => {
    const bare = { wodType: 'for_time' }
    expect(remapTemplateBodyExerciseIds(bare, () => 'fx_x')).toBe(bare)
  })
})
