import { describe, it, expect } from 'vitest'
import type { GroupDto, ListDto, ListsClient } from '@rallypoint/lists-client'
import {
  PERSONAL_GROUP_NAME,
  SHOPPING_LIST_NAME,
  selectPersonalGroup,
  resolvePersonalScope,
  listPersonalLists,
  selectNotesList,
  excludeNotesList,
  selectShoppingList,
  selectShoppingLists,
  excludeShoppingLists,
  listPersonalTaskLists,
  resolveShoppingList,
} from './personal-scope.js'

// Pure unit coverage for the stateless personal-scope resolver. The Lists
// SDK is a hand-rolled in-memory fake — these tests assert selection /
// find-or-create / ownership-listing logic, not transport.

function group(over: Partial<GroupDto> & { id: string; createdBy: string }): GroupDto {
  return {
    name: PERSONAL_GROUP_NAME,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

// A minimal ListsClient fake: only the methods the resolver touches are
// implemented; the rest throw so an accidental call is loud.
function makeFake(seed: {
  groups?: GroupDto[]
  lists?: ListDto[]
}): { client: ListsClient; created: GroupDto[]; createdLists: ListDto[] } {
  const groups = [...(seed.groups ?? [])]
  const lists = [...(seed.lists ?? [])]
  const created: GroupDto[] = []
  const createdLists: ListDto[] = []
  const notImpl = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`)
  }
  const client = {
    listGroups: async (actor: string) => groups.filter((g) => g.createdBy === actor),
    createGroup: async (input: { name: string }, actor: string) => {
      const g = group({ id: `lgr_new${created.length}`, createdBy: actor, name: input.name })
      groups.push(g)
      created.push(g)
      return g
    },
    listLists: async (scope: { scopeType: string; scopeId: string }) =>
      lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId),
    createList: async (
      input: Omit<ListDto, 'id' | 'incompleteCount' | 'createdBy' | 'createdAt' | 'updatedAt'>,
      actor: string,
    ) => {
      const l: ListDto = {
        id: `lst_new${createdLists.length}`,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      lists.push(l)
      createdLists.push(l)
      return l
    },
    health: notImpl('health'),
    listItems: notImpl('listItems'),
    listFieldDefs: notImpl('listFieldDefs'),
    createListItem: notImpl('createListItem'),
    updateListItem: notImpl('updateListItem'),
    deleteListItem: notImpl('deleteListItem'),
    createListItemSeries: notImpl('createListItemSeries'),
    listSeries: notImpl('listSeries'),
    updateSeries: notImpl('updateSeries'),
    deleteSeries: notImpl('deleteSeries'),
  } as unknown as ListsClient
  return { client, created, createdLists }
}

describe('selectPersonalGroup', () => {
  const actor = 'user_alice'

  it('returns null when the actor has no groups', () => {
    expect(selectPersonalGroup([], actor)).toBeNull()
  })

  it('ignores groups created by another user', () => {
    const groups = [group({ id: 'lgr_1', createdBy: 'user_bob' })]
    expect(selectPersonalGroup(groups, actor)).toBeNull()
  })

  it('ignores the actor’s groups that do not bear the reserved name', () => {
    const groups = [group({ id: 'lgr_1', createdBy: actor, name: 'Groceries' })]
    expect(selectPersonalGroup(groups, actor)).toBeNull()
  })

  it('returns the sole matching group', () => {
    const groups = [group({ id: 'lgr_1', createdBy: actor })]
    expect(selectPersonalGroup(groups, actor)?.id).toBe('lgr_1')
  })

  it('deterministically picks the OLDEST when duplicates exist', () => {
    const groups = [
      group({ id: 'lgr_new', createdBy: actor, createdAt: '2026-05-01T00:00:00.000Z' }),
      group({ id: 'lgr_old', createdBy: actor, createdAt: '2026-01-01T00:00:00.000Z' }),
      group({ id: 'lgr_mid', createdBy: actor, createdAt: '2026-03-01T00:00:00.000Z' }),
    ]
    expect(selectPersonalGroup(groups, actor)?.id).toBe('lgr_old')
  })
})

describe('resolvePersonalScope', () => {
  const actor = 'user_alice'

  it('returns the existing group id without creating one', async () => {
    const { client, created } = makeFake({
      groups: [group({ id: 'lgr_existing', createdBy: actor })],
    })
    expect(await resolvePersonalScope(client, actor)).toBe('lgr_existing')
    expect(created).toHaveLength(0)
  })

  it('provisions a personal group on first call', async () => {
    const { client, created } = makeFake({ groups: [] })
    const scopeId = await resolvePersonalScope(client, actor)
    expect(created).toHaveLength(1)
    expect(scopeId).toBe(created[0]!.id)
    expect(created[0]!.name).toBe(PERSONAL_GROUP_NAME)
    expect(created[0]!.createdBy).toBe(actor)
  })
})

describe('listPersonalLists', () => {
  const actor = 'user_alice'

  it('returns [] without provisioning when no personal group exists', async () => {
    const { client, created } = makeFake({ groups: [] })
    expect(await listPersonalLists(client, actor)).toEqual([])
    expect(created).toHaveLength(0)
  })

  it('returns the lists scoped to the personal group', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const mine: ListDto = {
      id: 'lst_1',
      scopeType: 'list_group',
      scopeId: 'lgr_p',
      listType: 'tasks',
      name: 'Today',
      visibility: 'all',
      color: null,
      incompleteCount: 0,
      createdBy: actor,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const other: ListDto = { ...mine, id: 'lst_2', scopeId: 'lgr_other' }
    const { client } = makeFake({ groups: [personal], lists: [mine, other] })
    const rows = await listPersonalLists(client, actor)
    expect(rows.map((l) => l.id)).toEqual(['lst_1'])
  })
})

function list(over: Partial<ListDto> & { id: string }): ListDto {
  return {
    scopeType: 'list_group',
    scopeId: 'lgr_p',
    listType: 'tasks',
    name: 'A list',
    visibility: 'all',
    color: null,
    incompleteCount: 0,
    createdBy: 'user_alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('selectNotesList', () => {
  it('returns null when there is no notes list', () => {
    expect(selectNotesList([list({ id: 'lst_1' }), list({ id: 'lst_2' })])).toBeNull()
  })

  it('returns the sole notes list', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_n', listType: 'notes' })]
    expect(selectNotesList(lists)?.id).toBe('lst_n')
  })

  it('deterministically picks the OLDEST when duplicate notes lists exist', () => {
    const lists = [
      list({ id: 'lst_new', listType: 'notes', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', listType: 'notes', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectNotesList(lists)?.id).toBe('lst_old')
  })
})

describe('excludeNotesList', () => {
  it('drops notes lists and keeps the rest in order', () => {
    const lists = [
      list({ id: 'lst_1' }),
      list({ id: 'lst_n', listType: 'notes' }),
      list({ id: 'lst_2', listType: 'shopping' }),
    ]
    expect(excludeNotesList(lists).map((l) => l.id)).toEqual(['lst_1', 'lst_2'])
  })

  it('returns all lists unchanged when there is no notes list', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_2' })]
    expect(excludeNotesList(lists).map((l) => l.id)).toEqual(['lst_1', 'lst_2'])
  })
})

describe('selectShoppingList', () => {
  it('returns null when there is no shopping list', () => {
    expect(selectShoppingList([list({ id: 'lst_1' }), list({ id: 'lst_2' })])).toBeNull()
  })

  it('returns the sole shopping list', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_s', listType: 'shopping' })]
    expect(selectShoppingList(lists)?.id).toBe('lst_s')
  })

  it('deterministically picks the OLDEST when duplicate shopping lists exist', () => {
    const lists = [
      list({ id: 'lst_new', listType: 'shopping', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', listType: 'shopping', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectShoppingList(lists)?.id).toBe('lst_old')
  })
})

describe('selectShoppingLists', () => {
  it('returns only shopping-type lists', () => {
    const lists = [
      list({ id: 'lst_t', listType: 'tasks' }),
      list({ id: 'lst_s1', listType: 'shopping' }),
      list({ id: 'lst_n', listType: 'notes' }),
      list({ id: 'lst_s2', listType: 'shopping' }),
    ]
    expect(selectShoppingLists(lists).map((l) => l.id)).toEqual(['lst_s1', 'lst_s2'])
  })

  it('returns [] when there are no shopping lists', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_n', listType: 'notes' })]
    expect(selectShoppingLists(lists)).toEqual([])
  })
})

describe('excludeShoppingLists', () => {
  it('drops shopping lists and keeps the rest in order', () => {
    const lists = [
      list({ id: 'lst_t', listType: 'tasks' }),
      list({ id: 'lst_s', listType: 'shopping' }),
      list({ id: 'lst_n', listType: 'notes' }),
    ]
    expect(excludeShoppingLists(lists).map((l) => l.id)).toEqual(['lst_t', 'lst_n'])
  })

  it('returns all lists unchanged when there are no shopping lists', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_2', listType: 'notes' })]
    expect(excludeShoppingLists(lists).map((l) => l.id)).toEqual(['lst_1', 'lst_2'])
  })
})

describe('listPersonalTaskLists', () => {
  const actor = 'user_alice'

  it('excludes both notes and shopping lists, keeping only task-facing lists', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const taskList: ListDto = list({ id: 'lst_t' })                         // tasks (default)
    const notesList: ListDto = list({ id: 'lst_n', listType: 'notes' })
    const shopList: ListDto = list({ id: 'lst_s', listType: 'shopping' })
    const { client } = makeFake({ groups: [personal], lists: [taskList, notesList, shopList] })
    const result = await listPersonalTaskLists(client, actor)
    expect(result.map((l) => l.id)).toEqual(['lst_t'])
  })

  it('returns [] when the only personal lists are notes and shopping', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const notesList: ListDto = list({ id: 'lst_n', listType: 'notes' })
    const shopList: ListDto = list({ id: 'lst_s', listType: 'shopping' })
    const { client } = makeFake({ groups: [personal], lists: [notesList, shopList] })
    const result = await listPersonalTaskLists(client, actor)
    expect(result).toEqual([])
  })
})

describe('resolveShoppingList', () => {
  const actor = 'user_alice'

  it('returns the existing shopping list without creating one', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const existing: ListDto = list({ id: 'lst_existing', listType: 'shopping', scopeId: 'lgr_p' })
    const { client, createdLists } = makeFake({ groups: [personal], lists: [existing] })
    const result = await resolveShoppingList(client, actor)
    expect(result.id).toBe('lst_existing')
    expect(createdLists).toHaveLength(0)
  })

  it('provisions the shopping list on first call (no personal group yet)', async () => {
    const { client, created, createdLists } = makeFake({ groups: [] })
    const result = await resolveShoppingList(client, actor)
    // Created both a personal group and the shopping list.
    expect(created).toHaveLength(1)
    expect(createdLists).toHaveLength(1)
    expect(result.listType).toBe('shopping')
    expect(result.name).toBe(SHOPPING_LIST_NAME)
    expect(result.visibility).toBe('all')
  })

  it('provisions the shopping list when the personal group exists but has no shopping list', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, created, createdLists } = makeFake({ groups: [personal] })
    const result = await resolveShoppingList(client, actor)
    // No new group created; only the shopping list.
    expect(created).toHaveLength(0)
    expect(createdLists).toHaveLength(1)
    expect(result.listType).toBe('shopping')
    expect(result.scopeId).toBe('lgr_p')
  })

  it('is idempotent: repeated calls return the SAME list, only one shopping list per user', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({ groups: [personal] })
    const first = await resolveShoppingList(client, actor)
    const second = await resolveShoppingList(client, actor)
    const third = await resolveShoppingList(client, actor)
    // Only one list was ever created.
    expect(createdLists).toHaveLength(1)
    // All three calls return the same list id.
    expect(first.id).toBe(second.id)
    expect(second.id).toBe(third.id)
  })
})
