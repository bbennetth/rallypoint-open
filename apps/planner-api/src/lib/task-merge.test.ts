import { describe, it, expect } from 'vitest'
import type { FieldDefDto, ListItemDto, ListItemSeriesDto } from '@rallypoint/lists-client'
import {
  fieldDefKey,
  fieldDefCreateInput,
  planFieldDefs,
  remapCustomFields,
  itemCreateInput,
  seriesCreateInput,
} from './task-merge.js'

// Pure unit coverage for the task-merge decision helpers (#543). No I/O —
// these assert the branch logic the orchestrator composes.

const ISO = '2026-01-01T00:00:00.000Z'

function def(over: Partial<FieldDefDto> & { id: string; label: string; fieldType: FieldDefDto['fieldType'] }): FieldDefDto {
  return {
    listId: 'lst_x',
    key: 'k',
    options: {},
    required: false,
    defaultValue: null,
    position: 0,
    createdBy: 'u',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

function item(over: Partial<ListItemDto> & { id: string }): ListItemDto {
  return {
    listId: 'lst_src',
    title: 'T',
    notes: null,
    assignedTo: null,
    completed: false,
    completedAt: null,
    status: null,
    statusId: null,
    parentId: null,
    priority: null,
    dueDate: null,
    position: 0,
    customFields: {},
    seriesId: null,
    createdBy: 'u',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

function series(over: Partial<ListItemSeriesDto> & { id: string }): ListItemSeriesDto {
  return {
    listId: 'lst_src',
    title: 'S',
    notes: null,
    assignedTo: null,
    priority: null,
    freq: 'weekly',
    interval: 1,
    byDay: null,
    dtstart: '2026-01-01',
    until: null,
    count: null,
    timeOfDay: null,
    createdBy: 'u',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

describe('fieldDefKey', () => {
  it('keys on (fieldType, lowercased trimmed label)', () => {
    expect(fieldDefKey({ label: '  Effort ', fieldType: 'number' })).toBe('number::effort')
  })
  it('same label different type → different key', () => {
    expect(fieldDefKey({ label: 'X', fieldType: 'text' })).not.toBe(
      fieldDefKey({ label: 'X', fieldType: 'number' }),
    )
  })
  it('case/whitespace-insensitive on label', () => {
    expect(fieldDefKey({ label: 'Due Soon', fieldType: 'checkbox' })).toBe(
      fieldDefKey({ label: 'due soon', fieldType: 'checkbox' }),
    )
  })
})

describe('fieldDefCreateInput', () => {
  it('carries label/type/required for a plain field', () => {
    const out = fieldDefCreateInput(def({ id: 'lfd_1', label: 'Notes2', fieldType: 'text', required: true }))
    expect(out).toEqual({ label: 'Notes2', fieldType: 'text', required: true })
  })
  it('carries multiline for a multiline text field', () => {
    const out = fieldDefCreateInput(
      def({ id: 'lfd_1', label: 'Body', fieldType: 'text', options: { multiline: true } }),
    )
    expect(out.multiline).toBe(true)
  })
  it('carries live (non-archived) choices for a select field, label-only', () => {
    const out = fieldDefCreateInput(
      def({
        id: 'lfd_1',
        label: 'Pri',
        fieldType: 'single_select',
        options: {
          choices: [
            { id: 'opt_a', label: 'Low' },
            { id: 'opt_b', label: 'High', archived: true },
          ],
        },
      }),
    )
    expect(out.choices).toEqual([{ label: 'Low' }])
  })
})

describe('planFieldDefs', () => {
  it('reuses a canonical def with matching (label,type); creates the rest', () => {
    const sourceDefs = [
      def({ id: 'lfd_s1', label: 'Effort', fieldType: 'number' }),
      def({ id: 'lfd_s2', label: 'Tag', fieldType: 'text' }),
    ]
    const canonicalDefs = [def({ id: 'lfd_c1', label: 'effort', fieldType: 'number' })]
    const plan = planFieldDefs(sourceDefs, canonicalDefs)
    expect(plan.remap.get('lfd_s1')).toBe('lfd_c1')
    expect(plan.toCreate.map((d) => d.id)).toEqual(['lfd_s2'])
  })
  it('empty source → empty plan', () => {
    const plan = planFieldDefs([], [def({ id: 'lfd_c1', label: 'x', fieldType: 'text' })])
    expect(plan.toCreate).toEqual([])
    expect(plan.remap.size).toBe(0)
  })
})

describe('remapCustomFields', () => {
  it('translates source def-id keys to canonical ids', () => {
    const remap = new Map([['lfd_s1', 'lfd_c1']])
    expect(remapCustomFields({ lfd_s1: 5 }, remap)).toEqual({ lfd_c1: 5 })
  })
  it('drops keys not in the remap (e.g. reserved or unresolved)', () => {
    const remap = new Map([['lfd_s1', 'lfd_c1']])
    expect(remapCustomFields({ lfd_s1: 5, 'rp:category': 'produce', lfd_unknown: 1 }, remap)).toEqual({
      lfd_c1: 5,
    })
  })
  it('does not mutate the input', () => {
    const input = { lfd_s1: 'v' }
    remapCustomFields(input, new Map([['lfd_s1', 'lfd_c1']]))
    expect(input).toEqual({ lfd_s1: 'v' })
  })
})

describe('itemCreateInput', () => {
  const noRemap = new Map<string, string>()
  it('preserves title/notes/priority/dueDate and maps completion → status', () => {
    const out = itemCreateInput(
      item({
        id: 'lit_1',
        title: 'Buy milk',
        notes: 'whole',
        priority: 'high',
        dueDate: '2026-02-01',
        completed: true,
      }),
      noRemap,
    )
    expect(out).toMatchObject({
      title: 'Buy milk',
      notes: 'whole',
      priority: 'high',
      dueDate: '2026-02-01',
      status: 'done',
    })
  })
  it('incomplete item → status todo', () => {
    expect(itemCreateInput(item({ id: 'lit_1', completed: false }), noRemap).status).toBe('todo')
  })
  it('preserves an explicit in_progress status (not downgraded to todo)', () => {
    // Items created in the Lists UI can be 'in_progress' (completed=false);
    // the merge must carry that through rather than collapse it to todo.
    expect(
      itemCreateInput(item({ id: 'lit_1', status: 'in_progress', completed: false }), noRemap).status,
    ).toBe('in_progress')
  })
  it('omits customFields when empty', () => {
    expect(itemCreateInput(item({ id: 'lit_1' }), noRemap).customFields).toBeUndefined()
  })
  it('remaps source def-id keys to canonical ids (drops unmapped keys)', () => {
    const remap = new Map([['lfd_x', 'lfd_canon']])
    expect(
      itemCreateInput(item({ id: 'lit_1', customFields: { lfd_x: 1, lfd_gone: 2 } }), remap).customFields,
    ).toEqual({ lfd_canon: 1 })
  })
})

describe('seriesCreateInput', () => {
  it('carries the full recurrence rule + template', () => {
    const out = seriesCreateInput(
      series({
        id: 'lse_1',
        title: 'Standup',
        freq: 'weekly',
        interval: 2,
        byDay: ['MO', 'WE'],
        dtstart: '2026-01-05',
        count: 8,
        timeOfDay: '09:00',
        priority: 'medium',
      }),
    )
    expect(out).toEqual({
      title: 'Standup',
      notes: null,
      assignedTo: null,
      priority: 'medium',
      freq: 'weekly',
      interval: 2,
      byDay: ['MO', 'WE'],
      dtstart: '2026-01-05',
      count: 8,
      timeOfDay: '09:00',
    })
  })
  it('drops empty byDay (would fail server min(1)) and null bounds', () => {
    const out = seriesCreateInput(series({ id: 'lse_1', freq: 'daily', byDay: [], until: null, count: null }))
    expect(out).not.toHaveProperty('byDay')
    expect(out).not.toHaveProperty('until')
    expect(out).not.toHaveProperty('count')
  })
  it('omits priority when source has none', () => {
    expect(seriesCreateInput(series({ id: 'lse_1', priority: null }))).not.toHaveProperty('priority')
  })
})
