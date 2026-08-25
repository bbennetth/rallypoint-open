import { describe, it, expect } from 'vitest'
import {
  createTrainingPlanItemSchema,
  PLAN_SOURCE_KINDS,
} from './training-plans.js'

describe('createTrainingPlanItemSchema — source kinds', () => {
  const base = { dayKey: 'mon' as const, position: 0 }

  it('exposes the source kinds including exercise and run', () => {
    expect(PLAN_SOURCE_KINDS).toEqual([
      'wod_template',
      'strength_template',
      'exercise',
      'strength',
      'run',
    ])
  })

  it('accepts an exercise item with a sourceId', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'exercise',
      sourceId: 'fx_seed_pull_up',
    })
    expect(v.success).toBe(true)
  })

  it('rejects an exercise item without a sourceId', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'exercise',
    })
    expect(v.success).toBe(false)
    if (!v.success) {
      expect(v.error.issues.some((i) => i.path.includes('sourceId'))).toBe(true)
    }
  })

  it('still requires a sourceId for both template kinds', () => {
    for (const sourceKind of ['wod_template', 'strength_template'] as const) {
      expect(
        createTrainingPlanItemSchema.safeParse({ ...base, sourceKind }).success,
      ).toBe(false)
    }
  })

  it('still forbids a sourceId on a free-form strength item', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'strength',
      sourceId: 'nope',
    })
    expect(v.success).toBe(false)
  })

  it('accepts a free-form strength item with just a note', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'strength',
      note: '5x5 squat',
    })
    expect(v.success).toBe(true)
  })

  it('accepts a run item with just a note (no sourceId)', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'run',
      note: '5k easy',
    })
    expect(v.success).toBe(true)
  })

  it('accepts a run item with no note at all', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'run',
    })
    expect(v.success).toBe(true)
  })

  it('forbids a sourceId on a run item', () => {
    const v = createTrainingPlanItemSchema.safeParse({
      ...base,
      sourceKind: 'run',
      sourceId: 'nope',
    })
    expect(v.success).toBe(false)
  })
})
