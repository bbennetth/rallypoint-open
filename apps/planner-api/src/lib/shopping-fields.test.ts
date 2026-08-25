import { describe, it, expect, vi } from 'vitest'
import type { FieldDefDto, ListsClient } from '@rallypoint/lists-client'
import {
  QUANTITY_FIELD_KEY,
  ensureQuantityFieldDef,
  selectQuantityFieldId,
} from './shopping-fields.js'

function def(id: string, key: string): FieldDefDto {
  return {
    id,
    listId: 'lst_1',
    key,
    label: key,
    fieldType: 'text',
    options: {},
    required: false,
    defaultValue: null,
    position: 0,
    createdBy: 'user_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as FieldDefDto
}

// A lists client exposing only the two field-def methods the ensure touches.
function fakeLists(over: Partial<ListsClient>): ListsClient {
  return over as ListsClient
}

describe('selectQuantityFieldId()', () => {
  it('finds the def by its derived key', () => {
    expect(selectQuantityFieldId([def('lfd_a', 'notes'), def('lfd_b', QUANTITY_FIELD_KEY)])).toBe(
      'lfd_b',
    )
  })

  it('returns null when no quantity def exists', () => {
    expect(selectQuantityFieldId([def('lfd_a', 'notes')])).toBeNull()
    expect(selectQuantityFieldId([])).toBeNull()
  })

  // The user can rename the label from the Lists UI; the key is what the
  // planner reads, so a renamed label must still resolve.
  it('ignores the label and matches only the key', () => {
    const renamed = { ...def('lfd_b', QUANTITY_FIELD_KEY), label: 'How many' }
    expect(selectQuantityFieldId([renamed])).toBe('lfd_b')
  })

  // A concurrent double-create leaves a deduped 'quantity_2' def behind; only
  // the canonical key counts.
  it('ignores a deduped near-miss key', () => {
    expect(selectQuantityFieldId([def('lfd_dup', 'quantity_2')])).toBeNull()
  })
})

describe('ensureQuantityFieldDef()', () => {
  it('returns the existing def id without creating one', async () => {
    const createFieldDef = vi.fn()
    const lists = fakeLists({
      listFieldDefs: async () => [def('lfd_b', QUANTITY_FIELD_KEY)],
      createFieldDef,
    })
    expect(await ensureQuantityFieldDef(lists, 'lst_1', 'user_1')).toBe('lfd_b')
    expect(createFieldDef).not.toHaveBeenCalled()
  })

  it('creates a free-form text def when absent, then returns its id', async () => {
    let defs: FieldDefDto[] = []
    const createFieldDef = vi.fn(async () => {
      defs = [def('lfd_new', QUANTITY_FIELD_KEY)]
      return defs[0]!
    })
    const lists = fakeLists({ listFieldDefs: async () => defs, createFieldDef })
    expect(await ensureQuantityFieldDef(lists, 'lst_1', 'user_1')).toBe('lfd_new')
    expect(createFieldDef).toHaveBeenCalledWith(
      'lst_1',
      { label: 'Quantity', fieldType: 'text', required: false },
      'user_1',
    )
  })

  // Concurrent first-loads can both create; the loser's def gets key
  // 'quantity_2'. Re-listing after the create makes both callers agree on
  // whichever def owns the canonical key.
  it('re-reads after creating so a raced double-create converges on one id', async () => {
    const defs: FieldDefDto[] = []
    const lists = fakeLists({
      listFieldDefs: async () => [...defs],
      createFieldDef: async () => {
        // The other request won the key; this create is deduped.
        defs.push(def('lfd_winner', QUANTITY_FIELD_KEY), def('lfd_loser', 'quantity_2'))
        return def('lfd_loser', 'quantity_2')
      },
    })
    expect(await ensureQuantityFieldDef(lists, 'lst_1', 'user_1')).toBe('lfd_winner')
  })

  // The shopping page must still load if the field can't be resolved.
  it('returns null instead of throwing when the list read fails', async () => {
    const lists = fakeLists({
      listFieldDefs: async () => {
        throw new Error('lists down')
      },
    })
    expect(await ensureQuantityFieldDef(lists, 'lst_1', 'user_1')).toBeNull()
  })

  it('returns null instead of throwing when the create fails', async () => {
    const lists = fakeLists({
      listFieldDefs: async () => [],
      createFieldDef: async () => {
        throw new Error('forbidden')
      },
    })
    expect(await ensureQuantityFieldDef(lists, 'lst_1', 'user_1')).toBeNull()
  })
})
