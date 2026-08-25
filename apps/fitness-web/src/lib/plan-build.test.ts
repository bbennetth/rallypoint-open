import { describe, it, expect } from 'vitest'
import type { TrainingPlanItemDto, WodTemplateDto } from '@rallypoint/fitness-shared'
import {
  canPlace,
  filterByName,
  nextPositionInDay,
  selectionToItemSource,
  templateToSelection,
  type PlanSelection,
} from './plan-build.js'

function item(p: Partial<TrainingPlanItemDto> & { dayKey: TrainingPlanItemDto['dayKey'] }): TrainingPlanItemDto {
  return {
    id: p.id ?? 'tpi_x',
    planId: 'tpl_x',
    dayKey: p.dayKey,
    position: p.position ?? 0,
    sourceKind: p.sourceKind ?? 'strength',
    sourceId: p.sourceId ?? null,
    note: p.note ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('selectionToItemSource', () => {
  it('maps a WOD template selection to a wod_template item', () => {
    const sel: PlanSelection = { kind: 'template', templateId: 'wt_1', templateKind: 'wod', name: 'Fran' }
    expect(selectionToItemSource(sel)).toEqual({ sourceKind: 'wod_template', sourceId: 'wt_1' })
  })
  it('maps a strength template selection to a strength_template item (not wod)', () => {
    const sel: PlanSelection = { kind: 'template', templateId: 'wt_2', templateKind: 'strength', name: 'Lower A' }
    expect(selectionToItemSource(sel)).toEqual({ sourceKind: 'strength_template', sourceId: 'wt_2' })
  })
  it('maps an exercise selection to an exercise item', () => {
    const sel: PlanSelection = { kind: 'exercise', exerciseId: 'fx_seed_pull_up', name: 'Pull-up' }
    expect(selectionToItemSource(sel)).toEqual({ sourceKind: 'exercise', sourceId: 'fx_seed_pull_up' })
  })
  it('maps a run selection to a note-only run item (no sourceId)', () => {
    const sel: PlanSelection = { kind: 'run', name: 'Run', note: '5k easy' }
    expect(selectionToItemSource(sel)).toEqual({ sourceKind: 'run', sourceId: null })
  })
})

describe('nextPositionInDay', () => {
  const items = [
    item({ dayKey: 'mon', position: 0 }),
    item({ dayKey: 'mon', position: 1 }),
    item({ dayKey: 'wed', position: 0 }),
  ]
  it('counts only the target day', () => {
    expect(nextPositionInDay(items, 'mon')).toBe(2)
    expect(nextPositionInDay(items, 'wed')).toBe(1)
    expect(nextPositionInDay(items, 'fri')).toBe(0)
  })
})

describe('canPlace', () => {
  const sel: PlanSelection = { kind: 'exercise', exerciseId: 'fx_1', name: 'X' }
  it('is true only with both a selection and a plan id', () => {
    expect(canPlace(sel, 'tpl_1')).toBe(true)
    expect(canPlace(null, 'tpl_1')).toBe(false)
    expect(canPlace(sel, null)).toBe(false)
    expect(canPlace(null, null)).toBe(false)
  })
})

describe('filterByName', () => {
  const rows = [{ name: 'Back Squat' }, { name: 'Front Squat' }, { name: 'Deadlift' }]
  it('returns the whole list (capped) for an empty query', () => {
    expect(filterByName(rows, '', 2)).toHaveLength(2)
    expect(filterByName(rows, '   ', 10)).toHaveLength(3)
  })
  it('case-insensitively substring-matches and caps the count', () => {
    expect(filterByName(rows, 'squat', 10).map((r) => r.name)).toEqual([
      'Back Squat',
      'Front Squat',
    ])
    expect(filterByName(rows, 'squat', 1)).toHaveLength(1)
  })
})

describe('templateToSelection', () => {
  it('carries the template kind through', () => {
    const wod = { id: 'wt_1', name: 'Fran', kind: 'wod' } as WodTemplateDto
    const strength = { id: 'wt_2', name: 'Lower A', kind: 'strength' } as WodTemplateDto
    expect(templateToSelection(wod)).toMatchObject({ kind: 'template', templateKind: 'wod', templateId: 'wt_1' })
    expect(templateToSelection(strength)).toMatchObject({ templateKind: 'strength', templateId: 'wt_2' })
  })
})
