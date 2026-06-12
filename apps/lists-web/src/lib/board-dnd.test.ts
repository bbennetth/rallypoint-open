import { describe, it, expect } from 'vitest'
import { applyBoardDrop, planBoardDrop, reindexPatches, type BoardColumnIds } from './board-dnd.js'
import type { ListItemDto } from './api.js'

function item(id: string, status_id: string | null): ListItemDto {
  return {
    id,
    list_id: 'lst_list',
    title: id,
    notes: null,
    assigned_to: null,
    completed: false,
    completed_at: null,
    status: null,
    status_id,
    parent_id: null,
    label_ids: [],
    priority: null,
    due_date: null,
    custom_fields: {},
    position: 0,
    created_by: 'usr_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
  }
}

// todo: [a, b]  doing: [c]  done: [d, e]
const COLUMNS: BoardColumnIds[] = [
  { statusId: 'todo', itemIds: ['a', 'b'] },
  { statusId: 'doing', itemIds: ['c'] },
  { statusId: 'done', itemIds: ['d', 'e'] },
]

describe('planBoardDrop', () => {
  it('returns null when dropping a card onto itself', () => {
    expect(planBoardDrop(COLUMNS, 'a', { type: 'item', itemId: 'a' })).toBeNull()
  })

  it('returns null for an unknown active card', () => {
    expect(planBoardDrop(COLUMNS, 'zzz', { type: 'column', statusId: 'done' })).toBeNull()
  })

  it('returns null when the order does not change (drop onto own column end)', () => {
    // b is already last in todo → appending it there is a no-op.
    expect(planBoardDrop(COLUMNS, 'b', { type: 'column', statusId: 'todo' })).toBeNull()
  })

  it('moves a card to another column (column drop appends to the end)', () => {
    const plan = planBoardDrop(COLUMNS, 'a', { type: 'column', statusId: 'doing' })
    expect(plan).toEqual({
      itemId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'doing',
      statusChanged: true,
      targetOrder: ['c', 'a'],
    })
  })

  it('inserts before the dropped-on card on a cross-column card drop', () => {
    const plan = planBoardDrop(COLUMNS, 'a', { type: 'item', itemId: 'e' })
    expect(plan).toMatchObject({
      toStatusId: 'done',
      statusChanged: true,
      targetOrder: ['d', 'a', 'e'],
    })
  })

  it('reorders within a column without a status change', () => {
    // drop b before a within todo
    const plan = planBoardDrop(COLUMNS, 'b', { type: 'item', itemId: 'a' })
    expect(plan).toMatchObject({
      fromStatusId: 'todo',
      toStatusId: 'todo',
      statusChanged: false,
      targetOrder: ['b', 'a'],
    })
  })
})

describe('applyBoardDrop', () => {
  const items = [item('a', 'todo'), item('b', 'todo'), item('c', 'doing'), item('d', 'done'), item('e', 'done')]

  it('updates the moved item status_id and seats it before its next neighbour', () => {
    const plan = planBoardDrop(COLUMNS, 'a', { type: 'item', itemId: 'e' })!
    const next = applyBoardDrop(items, plan)
    const moved = next.find((i) => i.id === 'a')!
    expect(moved.status_id).toBe('done')
    // a now sits immediately before e
    const ids = next.map((i) => i.id)
    expect(ids.indexOf('a')).toBe(ids.indexOf('e') - 1)
  })

  it('seats a column-appended card after its previous neighbour', () => {
    const plan = planBoardDrop(COLUMNS, 'a', { type: 'column', statusId: 'doing' })!
    const next = applyBoardDrop(items, plan)
    const ids = next.map((i) => i.id)
    expect(ids.indexOf('a')).toBe(ids.indexOf('c') + 1)
    expect(next.find((i) => i.id === 'a')!.status_id).toBe('doing')
  })

  it('returns the input unchanged when the moved item is absent', () => {
    const plan = { itemId: 'ghost', fromStatusId: 'todo', toStatusId: 'done', statusChanged: true, targetOrder: ['ghost'] }
    expect(applyBoardDrop(items, plan)).toBe(items)
  })
})

describe('reindexPatches', () => {
  it('maps the target order to contiguous positions', () => {
    const plan = planBoardDrop(COLUMNS, 'a', { type: 'item', itemId: 'e' })!
    expect(reindexPatches(plan)).toEqual([
      { id: 'd', position: 0 },
      { id: 'a', position: 1 },
      { id: 'e', position: 2 },
    ])
  })

  it('reindexes a within-column reorder (no status change)', () => {
    const plan = planBoardDrop(COLUMNS, 'b', { type: 'item', itemId: 'a' })!
    expect(plan.statusChanged).toBe(false)
    expect(reindexPatches(plan)).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ])
  })
})
