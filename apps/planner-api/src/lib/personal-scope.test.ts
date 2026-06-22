import { describe, it, expect } from 'vitest'
import type { GroupDto, ListDto, ListsClient } from '@rallypoint/lists-client'
import {
  PERSONAL_GROUP_NAME,
  PERSONAL_GROUP_NAME_LEGACY,
  SHOPPING_LIST_NAME,
  TASKS_LIST_NAME,
  selectPersonalGroup,
  resolvePersonalScope,
  listPersonalLists,
  selectNotesList,
  selectNotesLists,
  excludeNotesList,
  selectShoppingList,
  selectShoppingLists,
  excludeShoppingLists,
  listPersonalTaskLists,
  resolveShoppingList,
  selectTasksList,
  selectNonCanonicalTaskLists,
  findTasksList,
  resolveTasksList,
  CHORES_LIST_NAME,
  selectChoresList,
  excludeChoresLists,
  findChoresList,
  resolveChoresList,
  DIARY_LIST_NAME,
  selectDiaryList,
  excludeDiaryLists,
  findDiaryList,
  resolveDiaryList,
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

  // --- expand/contract dual-name window (issue #544) ---

  it('matches the new name "Planner" (post-migration)', () => {
    const groups = [group({ id: 'lgr_new_name', createdBy: actor, name: PERSONAL_GROUP_NAME })]
    expect(selectPersonalGroup(groups, actor)?.id).toBe('lgr_new_name')
  })

  it('matches the legacy name "My Tasks" (pre-migration rollout window)', () => {
    const groups = [
      group({ id: 'lgr_legacy', createdBy: actor, name: PERSONAL_GROUP_NAME_LEGACY }),
    ]
    expect(selectPersonalGroup(groups, actor)?.id).toBe('lgr_legacy')
  })

  it('picks the oldest when both old and new names coexist (collision during rollout)', () => {
    // A user who had a 'My Tasks' group (not yet renamed by migration) AND
    // somehow also has a 'Planner' group — oldest wins regardless of name.
    const groups = [
      group({
        id: 'lgr_planner_newer',
        createdBy: actor,
        name: PERSONAL_GROUP_NAME,
        createdAt: '2026-05-01T00:00:00.000Z',
      }),
      group({
        id: 'lgr_mytasks_older',
        createdBy: actor,
        name: PERSONAL_GROUP_NAME_LEGACY,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]
    expect(selectPersonalGroup(groups, actor)?.id).toBe('lgr_mytasks_older')
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

  it('excludes EVERY notes folder, not just the default (#549)', () => {
    const lists = [
      list({ id: 'lst_task' }),
      list({ id: 'lst_n1', listType: 'notes' }),
      list({ id: 'lst_n2', listType: 'notes' }),
    ]
    // All notes-type folders are dropped from task surfaces — the filter keys
    // off listType, so adding more notes lists never leaks any into Tasks.
    expect(excludeNotesList(lists).map((l) => l.id)).toEqual(['lst_task'])
  })
})

describe('selectNotesLists (#549 folders)', () => {
  it('returns [] when there are no notes lists', () => {
    expect(selectNotesLists([list({ id: 'lst_1' })])).toEqual([])
  })

  it('returns every notes folder, oldest first', () => {
    const lists = [
      list({ id: 'lst_new', listType: 'notes', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_task' }),
      list({ id: 'lst_old', listType: 'notes', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectNotesLists(lists).map((l) => l.id)).toEqual(['lst_old', 'lst_new'])
  })

  it('breaks createdAt ties deterministically by id', () => {
    const lists = [
      list({ id: 'lst_b', listType: 'notes', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_a', listType: 'notes', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectNotesLists(lists).map((l) => l.id)).toEqual(['lst_a', 'lst_b'])
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

describe('selectTasksList', () => {
  it('returns null when there are no task lists', () => {
    expect(selectTasksList([])).toBeNull()
    expect(selectTasksList([list({ id: 'lst_n', listType: 'notes' })])).toBeNull()
  })

  it('returns the sole task list', () => {
    expect(selectTasksList([list({ id: 'lst_t' })])?.id).toBe('lst_t')
  })

  it('excludes notes + shopping before picking', () => {
    const lists = [
      list({ id: 'lst_n', listType: 'notes', createdAt: '2025-01-01T00:00:00.000Z' }),
      list({ id: 'lst_s', listType: 'shopping', createdAt: '2025-01-01T00:00:00.000Z' }),
      list({ id: 'lst_t', listType: 'tasks', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    // Even though notes/shopping are older, the canonical TASK list is lst_t.
    expect(selectTasksList(lists)?.id).toBe('lst_t')
  })

  it('picks the OLDEST task list as canonical', () => {
    const lists = [
      list({ id: 'lst_new', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_mid', createdAt: '2026-03-01T00:00:00.000Z' }),
    ]
    expect(selectTasksList(lists)?.id).toBe('lst_old')
  })
})

describe('selectNonCanonicalTaskLists', () => {
  it('returns [] when there is one or zero task lists', () => {
    expect(selectNonCanonicalTaskLists([])).toEqual([])
    expect(selectNonCanonicalTaskLists([list({ id: 'lst_t' })])).toEqual([])
  })

  it('returns every task list except the oldest, oldest-first', () => {
    const lists = [
      list({ id: 'lst_new', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_mid', createdAt: '2026-03-01T00:00:00.000Z' }),
      list({ id: 'lst_n', listType: 'notes' }),
    ]
    expect(selectNonCanonicalTaskLists(lists).map((l) => l.id)).toEqual(['lst_mid', 'lst_new'])
  })

  it('breaks createdAt ties deterministically by id', () => {
    const lists = [
      list({ id: 'lst_b', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_a', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_c', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    // lst_a is canonical (oldest tie → smallest id); rest oldest-first by id.
    expect(selectNonCanonicalTaskLists(lists).map((l) => l.id)).toEqual(['lst_b', 'lst_c'])
  })
})

describe('findTasksList', () => {
  const actor = 'user_alice'

  it('returns null when the actor has no personal group', async () => {
    const { client } = makeFake({ groups: [] })
    expect(await findTasksList(client, actor)).toBeNull()
  })

  it('returns the canonical (oldest) task list, never provisioning', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({
      groups: [personal],
      lists: [
        list({ id: 'lst_new', scopeId: 'lgr_p', createdAt: '2026-05-01T00:00:00.000Z' }),
        list({ id: 'lst_old', scopeId: 'lgr_p', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
    })
    expect((await findTasksList(client, actor))?.id).toBe('lst_old')
    expect(createdLists).toHaveLength(0)
  })
})

describe('resolveTasksList (provision-only paths)', () => {
  const actor = 'user_alice'

  it('provisions a Tasks list on first call (fresh user, no merge)', async () => {
    const { client, created, createdLists } = makeFake({ groups: [] })
    const result = await resolveTasksList(client, actor)
    expect(created).toHaveLength(1) // personal group
    expect(createdLists).toHaveLength(1) // the Tasks list
    expect(result.listType).toBe('tasks')
    expect(result.name).toBe(TASKS_LIST_NAME)
    expect(result.visibility).toBe('all')
  })

  it('returns the existing sole task list without provisioning or merging', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const existing = list({ id: 'lst_t', scopeId: 'lgr_p' })
    const { client, createdLists } = makeFake({ groups: [personal], lists: [existing] })
    const result = await resolveTasksList(client, actor)
    expect(result.id).toBe('lst_t')
    expect(createdLists).toHaveLength(0)
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

// --- chores list (#546) ------------------------------------------------

describe('selectChoresList', () => {
  it('returns null when there is no chores list', () => {
    expect(selectChoresList([])).toBeNull()
    expect(selectChoresList([list({ id: 'lst_t' })])).toBeNull()
  })

  it('picks the chores-type list', () => {
    const lists = [list({ id: 'lst_t' }), list({ id: 'lst_c', listType: 'chores' })]
    expect(selectChoresList(lists)?.id).toBe('lst_c')
  })

  it('picks the OLDEST on the unlikely duplicate', () => {
    const lists = [
      list({ id: 'lst_new', listType: 'chores', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', listType: 'chores', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectChoresList(lists)?.id).toBe('lst_old')
  })
})

describe('excludeChoresLists', () => {
  it('drops chores-type lists, keeps the rest', () => {
    const lists = [
      list({ id: 'lst_t', listType: 'tasks' }),
      list({ id: 'lst_c', listType: 'chores' }),
      list({ id: 'lst_n', listType: 'notes' }),
    ]
    expect(excludeChoresLists(lists).map((l) => l.id)).toEqual(['lst_t', 'lst_n'])
  })

  it('is a no-op when there is no chores list', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_2', listType: 'notes' })]
    expect(excludeChoresLists(lists).map((l) => l.id)).toEqual(['lst_1', 'lst_2'])
  })
})

describe('listPersonalTaskLists excludes chores', () => {
  const actor = 'user_alice'

  it('filters out the chores list alongside notes + shopping', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const taskList = list({ id: 'lst_t' })
    const choresList = list({ id: 'lst_c', listType: 'chores' })
    const { client } = makeFake({ groups: [personal], lists: [taskList, choresList] })
    const result = await listPersonalTaskLists(client, actor)
    expect(result.map((l) => l.id)).toEqual(['lst_t'])
  })
})

describe('chores never swallowed by the #543 canonical-Tasks merge', () => {
  it('selectTasksList ignores a chores list even when it is the oldest', () => {
    const lists = [
      list({ id: 'lst_c', listType: 'chores', createdAt: '2025-01-01T00:00:00.000Z' }),
      list({ id: 'lst_t', listType: 'tasks', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    // Even though the chores list is older, the canonical TASK list is lst_t.
    expect(selectTasksList(lists)?.id).toBe('lst_t')
  })

  it('selectNonCanonicalTaskLists never includes a chores list among merge sources', () => {
    const lists = [
      list({ id: 'lst_old', listType: 'tasks', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_new', listType: 'tasks', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_c', listType: 'chores', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]
    // lst_old is canonical; only lst_new is a merge source — the chores list
    // (lst_c) is excluded so the merge cannot fold it into Tasks.
    expect(selectNonCanonicalTaskLists(lists).map((l) => l.id)).toEqual(['lst_new'])
  })
})

describe('findChoresList', () => {
  const actor = 'user_alice'

  it('returns null when the actor has no personal group', async () => {
    const { client } = makeFake({ groups: [] })
    expect(await findChoresList(client, actor)).toBeNull()
  })

  it('returns the chores list without provisioning', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({
      groups: [personal],
      lists: [list({ id: 'lst_c', scopeId: 'lgr_p', listType: 'chores' })],
    })
    expect((await findChoresList(client, actor))?.id).toBe('lst_c')
    expect(createdLists).toHaveLength(0)
  })
})

describe('resolveChoresList', () => {
  const actor = 'user_alice'

  it('provisions a chores list (and the group) on first access', async () => {
    const { client, created, createdLists } = makeFake({ groups: [] })
    const result = await resolveChoresList(client, actor)
    expect(created).toHaveLength(1) // personal group
    expect(createdLists).toHaveLength(1)
    expect(result.listType).toBe('chores')
    expect(result.name).toBe(CHORES_LIST_NAME)
  })

  it('is idempotent: repeated calls return the SAME chores list', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({ groups: [personal] })
    const first = await resolveChoresList(client, actor)
    const second = await resolveChoresList(client, actor)
    expect(createdLists).toHaveLength(1)
    expect(first.id).toBe(second.id)
  })
})

// --- diary list (Phase B) ----------------------------------------------

describe('selectDiaryList', () => {
  it('returns null when there is no diary list', () => {
    expect(selectDiaryList([])).toBeNull()
    expect(selectDiaryList([list({ id: 'lst_t' })])).toBeNull()
  })

  it('picks the diary-type list', () => {
    const lists = [list({ id: 'lst_t' }), list({ id: 'lst_d', listType: 'diary' })]
    expect(selectDiaryList(lists)?.id).toBe('lst_d')
  })

  it('picks the OLDEST on the unlikely duplicate', () => {
    const lists = [
      list({ id: 'lst_new', listType: 'diary', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_old', listType: 'diary', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectDiaryList(lists)?.id).toBe('lst_old')
  })
})

describe('excludeDiaryLists', () => {
  it('drops diary-type lists, keeps the rest', () => {
    const lists = [
      list({ id: 'lst_t', listType: 'tasks' }),
      list({ id: 'lst_d', listType: 'diary' }),
      list({ id: 'lst_n', listType: 'notes' }),
    ]
    expect(excludeDiaryLists(lists).map((l) => l.id)).toEqual(['lst_t', 'lst_n'])
  })

  it('is a no-op when there is no diary list', () => {
    const lists = [list({ id: 'lst_1' }), list({ id: 'lst_2', listType: 'notes' })]
    expect(excludeDiaryLists(lists).map((l) => l.id)).toEqual(['lst_1', 'lst_2'])
  })
})

describe('listPersonalTaskLists excludes diary', () => {
  const actor = 'user_alice'

  it('filters out the diary list alongside notes + shopping + chores', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const taskList = list({ id: 'lst_t' })
    const diaryList = list({ id: 'lst_d', listType: 'diary' })
    const choresList = list({ id: 'lst_c', listType: 'chores' })
    const { client } = makeFake({ groups: [personal], lists: [taskList, diaryList, choresList] })
    const result = await listPersonalTaskLists(client, actor)
    expect(result.map((l) => l.id)).toEqual(['lst_t'])
  })
})

describe('diary never swallowed by the #543 canonical-Tasks merge', () => {
  it('selectTasksList ignores a diary list even when it is the oldest', () => {
    const lists = [
      list({ id: 'lst_d', listType: 'diary', createdAt: '2025-01-01T00:00:00.000Z' }),
      list({ id: 'lst_t', listType: 'tasks', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(selectTasksList(lists)?.id).toBe('lst_t')
  })

  it('selectNonCanonicalTaskLists never includes a diary list among merge sources', () => {
    const lists = [
      list({ id: 'lst_old', listType: 'tasks', createdAt: '2026-01-01T00:00:00.000Z' }),
      list({ id: 'lst_new', listType: 'tasks', createdAt: '2026-05-01T00:00:00.000Z' }),
      list({ id: 'lst_d', listType: 'diary', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(selectNonCanonicalTaskLists(lists).map((l) => l.id)).toEqual(['lst_new'])
  })
})

describe('findDiaryList', () => {
  const actor = 'user_alice'

  it('returns null when the actor has no personal group', async () => {
    const { client } = makeFake({ groups: [] })
    expect(await findDiaryList(client, actor)).toBeNull()
  })

  it('returns the diary list without provisioning', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({
      groups: [personal],
      lists: [list({ id: 'lst_d', scopeId: 'lgr_p', listType: 'diary' })],
    })
    expect((await findDiaryList(client, actor))?.id).toBe('lst_d')
    expect(createdLists).toHaveLength(0)
  })
})

describe('resolveDiaryList', () => {
  const actor = 'user_alice'

  it('provisions a diary list (and the group) on first access, flagged created', async () => {
    const { client, created, createdLists } = makeFake({ groups: [] })
    const result = await resolveDiaryList(client, actor)
    expect(created).toHaveLength(1) // personal group
    expect(createdLists).toHaveLength(1)
    expect(result.created).toBe(true)
    expect(result.list.listType).toBe('diary')
    expect(result.list.name).toBe(DIARY_LIST_NAME)
  })

  it('is idempotent: repeated calls return the SAME diary list, created=false on warm calls', async () => {
    const personal = group({ id: 'lgr_p', createdBy: actor })
    const { client, createdLists } = makeFake({ groups: [personal] })
    const first = await resolveDiaryList(client, actor)
    const second = await resolveDiaryList(client, actor)
    expect(createdLists).toHaveLength(1)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(first.list.id).toBe(second.list.id)
  })
})
