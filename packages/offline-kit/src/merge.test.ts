import { describe, expect, it } from 'vitest'
import { mergeItemPatch } from './merge.js'

interface Row {
  id: string
  listId: string
  title: string
  completed: boolean
  priority: string | null
}

const cached: Row = {
  id: 'item_1',
  listId: 'list_1',
  title: 'Buy milk',
  completed: false,
  priority: 'high',
}

describe('mergeItemPatch', () => {
  it('merges the patch over the cached row, keeping untouched fields', () => {
    const out = mergeItemPatch<Row>(cached, { id: 'item_1', listId: 'list_1' } as Partial<Row> & {
      id: string
    }, { completed: true })
    expect(out).toEqual({ ...cached, completed: true })
  })

  it('falls back to the skeleton when there is no cached row', () => {
    const out = mergeItemPatch<Row>(
      undefined,
      { id: 'item_9', listId: 'list_1' } as Partial<Row> & { id: string },
      { completed: true },
    )
    expect(out).toMatchObject({ id: 'item_9', listId: 'list_1', completed: true })
  })

  it('drops undefined patch values so they cannot clobber cached fields', () => {
    const out = mergeItemPatch<Row>(
      cached,
      { id: 'item_1' } as Partial<Row> & { id: string },
      { title: undefined, priority: null } as unknown as Partial<Row>,
    )
    expect(out.title).toBe('Buy milk')
    expect(out.priority).toBeNull()
  })

  it('does not mutate the cached row', () => {
    const before = { ...cached }
    mergeItemPatch<Row>(cached, { id: 'item_1' } as Partial<Row> & { id: string }, {
      completed: true,
    })
    expect(cached).toEqual(before)
  })
})
