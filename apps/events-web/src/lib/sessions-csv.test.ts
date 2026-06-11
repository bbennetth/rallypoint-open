import { describe, expect, it } from 'vitest'
import { planSessionsImport, sessionsTemplateCsv } from './sessions-csv.js'
import type { DayDto, SessionDtoFull } from './api.js'

const days: DayDto[] = [
  { id: 'evd_1', event_id: 'e', day_label: 'Day 1', date: '2026-05-01', start_time: null, end_time: null, sort_order: 0 },
  { id: 'evd_2', event_id: 'e', day_label: 'Day 2', date: '2026-05-02', start_time: null, end_time: null, sort_order: 1 },
]

function session(p: Partial<SessionDtoFull> & { id: string; title: string }): SessionDtoFull {
  return {
    event_id: 'e',
    description: null,
    location: null,
    day_id: null,
    start_time: null,
    end_time: null,
    category: null,
    host: null,
    approval_status: 'approved',
    visibility: 'group',
    group_id: null,
    shared_with: null,
    created_by_user_id: 'u',
    submitted_by_user_id: null,
    approved_by_user_id: null,
    approved_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...p,
  }
}

function plan(text: string, current: SessionDtoFull[] = [], replace = false) {
  return planSessionsImport({ text, days, currentSessions: current, replace })
}

describe('sessionsTemplateCsv', () => {
  it('emits a header + example with a blank id (create)', () => {
    const [header, example] = sessionsTemplateCsv(days).split('\r\n')
    expect(header).toBe('id,title,day,start,end,location,category,host,visibility,description')
    expect(example!.startsWith(',Sunrise Yoga,Day 1,')).toBe(true)
  })
})

describe('planSessionsImport', () => {
  it('plans a create from a blank-id row', () => {
    const p = plan('id,title,day,start,visibility\n,Keynote,Day 1,09:00,admin')
    expect(p.errors).toEqual([])
    expect(p.creates).toEqual([
      { title: 'Keynote', dayId: 'evd_1', startTime: '09:00', visibility: 'admin' },
    ])
    expect(p.summary).toMatchObject({ create: 1, update: 0 })
    expect(p.rows[0]).toMatchObject({ action: 'create', title: 'Keynote', dayLabel: 'Day 1' })
  })

  it('plans an update from an id row, patching only non-empty cells', () => {
    const current = [session({ id: 'evx_1', title: 'Old' })]
    const p = plan('id,title,day,location\nevx_1,,Day 2,Hall A', current)
    expect(p.errors).toEqual([])
    expect(p.updates).toEqual([{ id: 'evx_1', patch: { dayId: 'evd_2', location: 'Hall A' } }])
    expect(p.summary).toMatchObject({ create: 0, update: 1 })
  })

  it('errors on an unknown session id', () => {
    const p = plan('id,title\nevx_missing,X')
    expect(p.errors[0]).toMatchObject({ line: 2, message: 'Unknown session id "evx_missing".' })
  })

  it('errors when a create row has no title', () => {
    const p = plan('id,title,day\n,,Day 1')
    expect(p.errors[0]!.message).toMatch(/Title is required/)
  })

  it('errors when an update row would change nothing', () => {
    const current = [session({ id: 'evx_1', title: 'Old' })]
    const p = plan('id,title\nevx_1,', current)
    expect(p.errors[0]!.message).toMatch(/no values to change/)
  })

  it('errors on bad visibility / day / time', () => {
    const p = plan(
      ['id,title,day,start,visibility', ',A,Day 9,,', ',B,,25:00,', ',C,,,loud'].join('\n'),
    )
    expect(p.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/Unknown day/),
      expect.stringMatching(/Start time/),
      expect.stringMatching(/Visibility must be/),
    ])
  })

  it('rejects duplicate id rows', () => {
    const current = [session({ id: 'evx_1', title: 'Old' })]
    const p = plan('id,title\nevx_1,A\nevx_1,B', current)
    expect(p.updates).toHaveLength(1)
    expect(p.errors[0]!.message).toMatch(/Duplicate row/)
  })

  it('deletes current sessions absent from the file in replace mode', () => {
    const current = [session({ id: 'evx_1', title: 'Keep' }), session({ id: 'evx_2', title: 'Drop' })]
    const p = plan('id,title\nevx_1,Keep', current, true)
    expect(p.updates).toEqual([{ id: 'evx_1', patch: { title: 'Keep' } }])
    expect(p.deletes).toEqual(['evx_2'])
    expect(p.summary).toMatchObject({ update: 1, delete: 1 })
  })

  it('requires a title column', () => {
    const p = plan('id,day\n,Day 1')
    expect(p.errors[0]!.message).toMatch(/Missing required column "title"/)
  })

  it('rejects over-long location/category/host/description (server caps)', () => {
    const longCat = 'c'.repeat(101)
    const longLoc = 'l'.repeat(201)
    const p = plan(
      [
        'id,title,location,category,host,description',
        `,A,${longLoc},,,`,
        `,B,,${longCat},,`,
        `,C,,,${'h'.repeat(201)},`,
        `,D,,,,${'d'.repeat(5001)}`,
      ].join('\n'),
    )
    expect(p.creates).toHaveLength(0)
    expect(p.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/Location must be at most 200/),
      expect.stringMatching(/Category must be at most 100/),
      expect.stringMatching(/Host must be at most 200/),
      expect.stringMatching(/Description must be at most 5000/),
    ])
  })

  it('does not suppress a replace-mode delete for an errored update row', () => {
    const current = [session({ id: 'evx_1', title: 'Keep' }), session({ id: 'evx_2', title: 'Drop' })]
    // evx_2 row has no values to change → error; in replace mode it should
    // still be eligible for deletion (not marked "seen").
    const p = plan('id,title\nevx_1,Keep\nevx_2,', current, true)
    expect(p.errors.some((e) => /no values to change/.test(e.message))).toBe(true)
    expect(p.deletes).toContain('evx_2')
  })

  it('flags exceeding the 200-create bulk cap', () => {
    const lines = ['id,title']
    for (let i = 0; i < 201; i++) lines.push(`,Session ${i}`)
    const p = plan(lines.join('\n'))
    expect(p.creates).toHaveLength(201)
    expect(p.errors.some((e) => /max is 200/.test(e.message))).toBe(true)
  })
})
