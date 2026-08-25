import { describe, expect, it } from 'vitest'
import {
  planLineupChanges,
  type LineupChangeRowInput,
  type PlanCurrentSlot,
  type PlanDayRef,
  type PlanStageRef,
} from './lineup-plan.js'

// CRSSD-shaped fixtures: two days, three stages.
const days: PlanDayRef[] = [
  { id: 'evd_sat', day_label: 'Saturday', date: '2026-09-26' },
  { id: 'evd_sun', day_label: 'Sunday', date: '2026-09-27' },
]
const stages: PlanStageRef[] = [
  { id: 'evs_ocean', name: 'Ocean View' },
  { id: 'evs_steps', name: 'City Steps' },
  { id: 'evs_palms', name: 'The Palms' },
]

let nextLine = 0
function row(p: Partial<LineupChangeRowInput> & { artist: string; day: string }): LineupChangeRowInput {
  return { line: ++nextLine, ...p }
}

function current(p: Partial<PlanCurrentSlot> & { artist_id: string; day_id: string }): PlanCurrentSlot {
  return { artist_name: null, display_name: null, ...p }
}

describe('planLineupChanges', () => {
  it('plans creates with day matched by label (case-insensitive) or date', () => {
    const plan = planLineupChanges({
      rows: [
        row({ artist: 'Mochakk', day: 'saturday', stage: 'Ocean View', tier: 'headliner' }),
        row({ artist: 'Ben UFO', day: '2026-09-27', stage: 'city steps' }),
      ],
      days,
      stages,
      currentSlots: [],
    })
    expect(plan.errors).toEqual([])
    expect(plan.rows).toHaveLength(2)
    expect(plan.rows[0]).toMatchObject({
      action: 'create',
      artistName: 'Mochakk',
      dayId: 'evd_sat',
      stageId: 'evs_ocean',
      // Canonical stage name resolved for review surfaces, even when the
      // input token differed in case.
      stageName: 'Ocean View',
      tier: 'headliner',
    })
    expect(plan.rows[1]).toMatchObject({ dayId: 'evd_sun', stageId: 'evs_steps' })
    expect(plan.summary).toEqual({ create: 2, update: 0, delete: 0, error: 0 })
  })

  it('detects updates by artist name + day against current slots', () => {
    const plan = planLineupChanges({
      rows: [row({ artist: 'VTSS', day: 'Saturday', start: '22:00', end: '23:30' })],
      days,
      stages,
      currentSlots: [current({ artist_id: 'art_vtss', artist_name: 'VTSS', day_id: 'evd_sat' })],
    })
    expect(plan.rows[0]).toMatchObject({
      action: 'update',
      artistId: 'art_vtss',
      startTime: '22:00',
      endTime: '23:30',
    })
  })

  it('normalizes HH:MM:SS to HH:MM and rejects malformed times', () => {
    const plan = planLineupChanges({
      rows: [
        row({ artist: 'salute', day: 'Saturday', start: '21:00:00' }),
        row({ artist: 'Prospa', day: 'Saturday', start: '9pm' }),
      ],
      days,
      stages,
      currentSlots: [],
    })
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]!.startTime).toBe('21:00')
    expect(plan.errors[0]!.message).toMatch(/Start time must be HH:MM/)
  })

  it('rejects unknown days, unknown stages, and bad tiers with per-line errors', () => {
    const plan = planLineupChanges({
      rows: [
        row({ artist: 'KETTAMA', day: 'Friday' }),
        row({ artist: 'Helena Hauff', day: 'Saturday', stage: 'Main' }),
        row({ artist: 'AYYBO', day: 'Saturday', tier: 'legend' }),
      ],
      days,
      stages,
      currentSlots: [],
    })
    expect(plan.rows).toEqual([])
    expect(plan.errors.map((e) => e.message)).toEqual([
      'Unknown day "Friday".',
      'Unknown stage "Main".',
      'Tier must be headliner, support, or opener (got "legend").',
    ])
  })

  it('flags duplicate artist+day rows', () => {
    const plan = planLineupChanges({
      rows: [
        row({ artist: 'Sonny Fodera', day: 'Saturday' }),
        row({ artist: 'sonny fodera', day: 'Saturday' }),
      ],
      days,
      stages,
      currentSlots: [],
    })
    expect(plan.rows).toHaveLength(1)
    expect(plan.errors[0]!.message).toMatch(/Duplicate row/)
  })

  it('replace mode deletes current slots missing from the new rows', () => {
    const plan = planLineupChanges({
      rows: [row({ artist: 'Mochakk', day: 'Saturday' })],
      days,
      stages,
      currentSlots: [
        current({ artist_id: 'art_mochakk', artist_name: 'Mochakk', day_id: 'evd_sat' }),
        current({ artist_id: 'art_gone', artist_name: 'Dropped Act', day_id: 'evd_sun' }),
      ],
      replace: true,
    })
    expect(plan.rows[0]!.action).toBe('update')
    expect(plan.deletes).toEqual([{ artistId: 'art_gone', dayId: 'evd_sun', label: 'Dropped Act' }])
    expect(plan.summary.delete).toBe(1)
  })

  it('without replace, absent current slots are left alone', () => {
    const plan = planLineupChanges({
      rows: [row({ artist: 'Mochakk', day: 'Saturday' })],
      days,
      stages,
      currentSlots: [current({ artist_id: 'art_keep', artist_name: 'Kept Act', day_id: 'evd_sun' })],
    })
    expect(plan.deletes).toEqual([])
  })

  it('caps rows at 200', () => {
    const rows = Array.from({ length: 201 }, (_, i) =>
      row({ artist: `Artist ${i}`, day: 'Saturday' }),
    )
    const plan = planLineupChanges({ rows, days, stages, currentSlots: [] })
    expect(plan.errors.some((e) => e.message.includes('max is 200'))).toBe(true)
  })
})
