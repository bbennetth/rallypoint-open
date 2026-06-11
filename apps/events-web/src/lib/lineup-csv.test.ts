import { describe, expect, it } from 'vitest'
import { lineupTemplateCsv, planLineupImport } from './lineup-csv.js'
import type { DayDto, LineupSlotDto, StageDto } from './api.js'

const days: DayDto[] = [
  { id: 'evd_1', event_id: 'e', day_label: 'Day 1', date: '2026-05-01', start_time: null, end_time: null, sort_order: 0 },
  { id: 'evd_2', event_id: 'e', day_label: 'Day 2', date: '2026-05-02', start_time: null, end_time: null, sort_order: 1 },
]
const stages: StageDto[] = [
  { id: 'stg_main', event_id: 'e', name: 'Main', sort_order: 0 },
  { id: 'stg_b', event_id: 'e', name: 'Tent B', sort_order: 1 },
]
function slot(p: Partial<LineupSlotDto> & { artist_id: string; day_id: string }): LineupSlotDto {
  return {
    event_id: 'e',
    artist_name: null,
    stage_id: null,
    tier: null,
    genre: null,
    start_time: null,
    end_time: null,
    display_name: null,
    ...p,
  }
}

function plan(text: string, current: LineupSlotDto[] = [], replace = false) {
  return planLineupImport({ text, days, stages, currentSlots: current, replace })
}

describe('lineupTemplateCsv', () => {
  it('emits a header + example using a real day/stage when present', () => {
    const csv = lineupTemplateCsv(days, stages)
    const [header, example] = csv.split('\r\n')
    expect(header).toBe('artist,day,stage,tier,genre,start,end,display_name')
    expect(example!.startsWith('Aphex Twin,Day 1,Main,')).toBe(true)
  })

  it('falls back to placeholders with no days/stages', () => {
    const csv = lineupTemplateCsv()
    expect(csv.split('\r\n')[1]!.startsWith('Aphex Twin,Day 1,,')).toBe(true)
  })
})

describe('planLineupImport', () => {
  it('plans creates, resolving day by label and stage by name (case-insensitive)', () => {
    const p = plan('artist,day,stage,tier,start,end\nBoards of Canada,day 1,main,headliner,20:00,21:30')
    expect(p.errors).toEqual([])
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]).toMatchObject({
      action: 'create',
      artistName: 'Boards of Canada',
      artistId: null,
      dayId: 'evd_1',
      stageId: 'stg_main',
      tier: 'headliner',
      startTime: '20:00',
      endTime: '21:30',
    })
    expect(p.summary).toMatchObject({ create: 1, update: 0, delete: 0, error: 0 })
  })

  it('resolves a day by its date string too', () => {
    const p = plan('artist,day\nAphex Twin,2026-05-02')
    expect(p.rows[0]?.dayId).toBe('evd_2')
  })

  it('marks a row as update when artist+day already exists', () => {
    const current = [slot({ artist_id: 'art_x', artist_name: 'Aphex Twin', day_id: 'evd_1' })]
    const p = plan('artist,day,tier\nAphex Twin,Day 1,support', current)
    expect(p.rows[0]).toMatchObject({ action: 'update', artistId: 'art_x', tier: 'support' })
    expect(p.summary).toMatchObject({ create: 0, update: 1 })
  })

  it('errors on unknown day, unknown stage, bad tier, bad time', () => {
    const p = plan(
      [
        'artist,day,stage,tier,start',
        'A,Day 9,,,',
        'B,Day 1,Ghost Stage,,',
        'C,Day 1,,vip,',
        'D,Day 1,,,99:99',
      ].join('\n'),
    )
    expect(p.rows).toHaveLength(0)
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4, 5])
    expect(p.errors[0]!.message).toMatch(/Unknown day/)
    expect(p.errors[1]!.message).toMatch(/Unknown stage/)
    expect(p.errors[2]!.message).toMatch(/Tier must be/)
    expect(p.errors[3]!.message).toMatch(/Start time/)
  })

  it('requires an artist value', () => {
    const p = plan('artist,day\n,Day 1')
    expect(p.errors[0]).toMatchObject({ line: 2, message: 'Artist is required.' })
  })

  it('flags a missing required column', () => {
    const p = plan('artist,stage\nA,Main')
    expect(p.errors[0]!.message).toMatch(/Missing required column "day"/)
  })

  it('rejects duplicate artist+day rows', () => {
    const p = plan('artist,day\nA,Day 1\nA,Day 1')
    expect(p.rows).toHaveLength(1)
    expect(p.errors[0]!.message).toMatch(/Duplicate row/)
  })

  it('computes deletes for rows absent from the file in replace mode', () => {
    const current = [
      slot({ artist_id: 'art_a', artist_name: 'A', day_id: 'evd_1' }),
      slot({ artist_id: 'art_b', artist_name: 'B', day_id: 'evd_1' }),
    ]
    const p = plan('artist,day\nA,Day 1', current, true)
    expect(p.summary).toMatchObject({ update: 1, delete: 1 })
    expect(p.deletes).toEqual([{ artistId: 'art_b', dayId: 'evd_1', label: 'B' }])
  })

  it('produces no deletes when replace mode is off', () => {
    const current = [slot({ artist_id: 'art_b', artist_name: 'B', day_id: 'evd_1' })]
    const p = plan('artist,day\nA,Day 1', current, false)
    expect(p.deletes).toEqual([])
    expect(p.summary.delete).toBe(0)
  })

  it('reports an empty file', () => {
    const p = plan('')
    expect(p.errors[0]!.message).toMatch(/empty/)
  })

  it('rejects an over-long artist name (server caps at 200)', () => {
    const p = plan(`artist,day\n${'x'.repeat(201)},Day 1`)
    expect(p.rows).toHaveLength(0)
    expect(p.errors[0]).toMatchObject({ line: 2, message: /Artist name must be at most 200/ })
  })

  it('flags a file exceeding the 200-row bulk cap', () => {
    const lines = ['artist,day']
    for (let i = 0; i < 201; i++) lines.push(`Artist ${i},Day 1`)
    const p = plan(lines.join('\n'))
    expect(p.rows).toHaveLength(201)
    expect(p.errors.some((e) => /max is 200/.test(e.message))).toBe(true)
    expect(p.summary.error).toBeGreaterThan(0)
  })
})
