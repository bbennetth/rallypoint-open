import { describe, expect, it } from 'vitest'
import type { DayKey, TrainingPlanItemDto } from '@rallypoint/fitness-shared'
import { findPlacementForTemplate, planScheduleAction } from './plan-schedule.js'

function item(over: Partial<TrainingPlanItemDto>): TrainingPlanItemDto {
  return {
    id: 'tpi_1',
    planId: 'tp_1',
    dayKey: 'mon',
    position: 0,
    sourceKind: 'wod_template',
    sourceId: 'wt_1',
    note: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

describe('planScheduleAction', () => {
  it('skips when nothing is scheduled and no day is picked', () => {
    expect(planScheduleAction(null, null)).toBe('skip')
  })

  it('adds when a day is picked for an unscheduled workout', () => {
    expect(planScheduleAction(null, 'wed')).toBe('add')
  })

  it('skips when the picked day matches where it already is', () => {
    expect(planScheduleAction({ dayKey: 'tue' }, 'tue')).toBe('skip')
  })

  it('moves rather than adds when a scheduled workout changes day', () => {
    expect(planScheduleAction({ dayKey: 'tue' }, 'fri')).toBe('move')
  })

  it('removes when a scheduled workout is set back to not scheduled', () => {
    expect(planScheduleAction({ dayKey: 'sat' }, null)).toBe('remove')
  })
})

describe('findPlacementForTemplate', () => {
  it('finds the item pointing at the template', () => {
    const items = [
      item({ id: 'tpi_a', sourceId: 'wt_other', dayKey: 'mon' }),
      item({ id: 'tpi_b', sourceId: 'wt_1', dayKey: 'thu' }),
    ]
    expect(findPlacementForTemplate(items, 'tp_1', 'wt_1')).toEqual({
      planId: 'tp_1',
      itemId: 'tpi_b',
      dayKey: 'thu',
    })
  })

  it('returns null when no item references the template', () => {
    expect(findPlacementForTemplate([item({ sourceId: 'wt_other' })], 'tp_1', 'wt_1')).toBeNull()
  })

  it('ignores items with a null sourceId (freeform notes)', () => {
    expect(findPlacementForTemplate([item({ sourceId: null })], 'tp_1', 'wt_1')).toBeNull()
  })

  it('picks the earliest weekday when the same template sits on two days', () => {
    // Server order, not weekday order: the API sorts on the `dayKey`
    // text column, so 'fri' arrives before 'tue'. Picking the first row
    // would hydrate this to Friday.
    const items = [
      item({ id: 'tpi_fri', sourceId: 'wt_1', dayKey: 'fri' }),
      item({ id: 'tpi_tue', sourceId: 'wt_1', dayKey: 'tue' }),
    ]
    const found = findPlacementForTemplate(items, 'tp_1', 'wt_1')
    expect(found?.itemId).toBe('tpi_tue')
    expect(found?.dayKey).toBe('tue')
  })

  it('does not let an unrecognized dayKey outrank a real weekday', () => {
    const items = [
      item({ id: 'tpi_junk', sourceId: 'wt_1', dayKey: 'someday' as DayKey }),
      item({ id: 'tpi_wed', sourceId: 'wt_1', dayKey: 'wed' }),
    ]
    expect(findPlacementForTemplate(items, 'tp_1', 'wt_1')?.itemId).toBe('tpi_wed')
  })

  it('treats monday as the earliest weekday and sunday as the latest', () => {
    const items = [
      item({ id: 'tpi_sun', sourceId: 'wt_1', dayKey: 'sun' }),
      item({ id: 'tpi_mon', sourceId: 'wt_1', dayKey: 'mon' }),
    ]
    expect(findPlacementForTemplate(items, 'tp_1', 'wt_1')?.dayKey).toBe('mon')
  })
})
