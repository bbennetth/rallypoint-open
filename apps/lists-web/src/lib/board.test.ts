import { describe, it, expect } from 'vitest'
import { groupItemsByStatus, resolveItemStatus } from './board.js'
import type { ListItemDto, ListStatusDto } from './api.js'

function status(partial: Partial<ListStatusDto> & Pick<ListStatusDto, 'id' | 'category' | 'position'>): ListStatusDto {
  return {
    list_id: 'lst_list',
    name: partial.id,
    color: null,
    created_by: 'usr_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

function item(partial: Partial<ListItemDto> & Pick<ListItemDto, 'id'>): ListItemDto {
  return {
    list_id: 'lst_list',
    title: partial.id,
    notes: null,
    assigned_to: null,
    completed: false,
    completed_at: null,
    status: null,
    status_id: null,
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
    ...partial,
  }
}

const STATUSES: ListStatusDto[] = [
  status({ id: 'lst_todo', category: 'todo', position: 0 }),
  status({ id: 'lst_doing', category: 'in_progress', position: 1 }),
  status({ id: 'lst_done', category: 'done', position: 2 }),
]

describe('resolveItemStatus', () => {
  it('matches a live status_id directly', () => {
    expect(resolveItemStatus(item({ id: 'a', status_id: 'lst_doing' }), STATUSES)?.id).toBe('lst_doing')
  })

  it('falls back to the legacy category for a null status_id', () => {
    expect(resolveItemStatus(item({ id: 'a', status: 'done' }), STATUSES)?.id).toBe('lst_done')
  })

  it('treats a null legacy status as todo', () => {
    expect(resolveItemStatus(item({ id: 'a' }), STATUSES)?.id).toBe('lst_todo')
  })

  it('falls back to category when status_id points at a deleted status', () => {
    const it = item({ id: 'a', status_id: 'lst_gone', status: 'in_progress' })
    expect(resolveItemStatus(it, STATUSES)?.id).toBe('lst_doing')
  })

  it('returns null when the list has no statuses', () => {
    expect(resolveItemStatus(item({ id: 'a' }), [])).toBeNull()
  })

  it('falls back to the first status by position when the category is absent', () => {
    const onlyDone = [status({ id: 'lst_done', category: 'done', position: 5 })]
    expect(resolveItemStatus(item({ id: 'a', status: 'todo' }), onlyDone)?.id).toBe('lst_done')
  })
})

describe('groupItemsByStatus', () => {
  it('returns one column per status in position order', () => {
    const cols = groupItemsByStatus([], STATUSES)
    expect(cols.map((c) => c.status.id)).toEqual(['lst_todo', 'lst_doing', 'lst_done'])
  })

  it('honors status position even when statuses arrive out of order', () => {
    const shuffled = [STATUSES[2]!, STATUSES[0]!, STATUSES[1]!]
    const cols = groupItemsByStatus([], shuffled)
    expect(cols.map((c) => c.status.id)).toEqual(['lst_todo', 'lst_doing', 'lst_done'])
  })

  it('places items in their resolved column and preserves input order', () => {
    const items = [
      item({ id: 'a', status_id: 'lst_done' }),
      item({ id: 'b', status: 'todo' }),
      item({ id: 'c', status_id: 'lst_done' }),
      item({ id: 'd' }), // null status → todo
    ]
    const cols = groupItemsByStatus(items, STATUSES)
    const byId = Object.fromEntries(cols.map((c) => [c.status.id, c.items.map((i) => i.id)]))
    expect(byId['lst_todo']).toEqual(['b', 'd'])
    expect(byId['lst_doing']).toEqual([])
    expect(byId['lst_done']).toEqual(['a', 'c'])
  })

  it('returns no columns when the list has no statuses', () => {
    expect(groupItemsByStatus([item({ id: 'a' })], [])).toEqual([])
  })
})
