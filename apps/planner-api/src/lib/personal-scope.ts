import type { GroupDto, ListDto, ListsClient } from '@rallypoint/lists-client'

// Planner models a user's personal task lists as a per-user Lists
// `list_group` (see docs/design/planner-v1.md). planner-api is stateless
// — it keeps NO user→group mapping table — so it identifies the personal
// group purely from what the Lists SDK returns for the actor.
//
// Identity rule: the personal group is the one the actor created
// (`createdBy === actor`) bearing the reserved name below. In Planner's
// world the actor only ever has groups Planner itself provisioned, so this
// is unambiguous; if a duplicate ever slipped in we deterministically pick
// the OLDEST match so resolution is stable across concurrent requests.
export const PERSONAL_GROUP_NAME = 'My Tasks'

// The reserved display name for the per-user notes list. Like the personal
// group, the BFF finds it by a reserved identity rather than storing a
// mapping — here the `listType === 'notes'` discriminator inside the
// personal group (the name is cosmetic; resolution keys off listType).
export const NOTES_LIST_NAME = 'Notes'

// The reserved display name for the per-user shopping list. Identity is
// resolved the same stateless way as the notes list — keyed off
// `listType === 'shopping'`, not the name.
export const SHOPPING_LIST_NAME = 'Shopping'

// Pure selection over a fetched group list — unit-tested in isolation.
export function selectPersonalGroup(groups: GroupDto[], actor: string): GroupDto | null {
  const mine = groups.filter((g) => g.createdBy === actor && g.name === PERSONAL_GROUP_NAME)
  if (mine.length === 0) return null
  return mine.reduce((oldest, g) => (g.createdAt < oldest.createdAt ? g : oldest))
}

// Resolve (find-or-create) the actor's personal `list_group` and return
// its scopeId. First write of a fresh user provisions the group.
export async function resolvePersonalScope(
  listsClient: ListsClient,
  actor: string,
): Promise<string> {
  const existing = selectPersonalGroup(await listsClient.listGroups(actor), actor)
  if (existing) return existing.id
  const created = await listsClient.createGroup({ name: PERSONAL_GROUP_NAME }, actor)
  return created.id
}

// The lists in the actor's personal group, or [] if it hasn't been
// provisioned yet (read-only — never creates the group). Item routes use
// this to authorize a listId before touching the Lists READ surface, which
// trusts its caller for scope access (sdk-lists.ts) and so would otherwise
// let one user read another's items by guessing a list id.
export async function listPersonalLists(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto[]> {
  const group = selectPersonalGroup(await listsClient.listGroups(actor), actor)
  if (!group) return []
  return listsClient.listLists({ scopeType: 'list_group', scopeId: group.id })
}

// --- notes list ------------------------------------------------------
// The user's quick-notes are a single Lists list of `list_type = 'notes'`
// living in the SAME personal group as their task lists. It's resolved the
// same stateless way (identity, not a stored mapping) and is deliberately
// kept OUT of the task-list surfaces (see excludeNotesList), so a user's
// notes never show up as tasks in the rail / My Day / Upcoming.

// Pure selection: the notes list out of a group's lists (oldest on the
// unlikely duplicate, mirroring selectPersonalGroup). Unit-tested.
export function selectNotesList(lists: ListDto[]): ListDto | null {
  const mine = lists.filter((l) => l.listType === 'notes')
  if (mine.length === 0) return null
  return mine.reduce((oldest, l) => (l.createdAt < oldest.createdAt ? l : oldest))
}

// Pure filter: the task-facing lists (everything that ISN'T the notes
// list). The task surfaces use this; ownership guards keep using the
// unfiltered listPersonalLists so item reads on the notes list still
// authorize. Unit-tested.
export function excludeNotesList(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType !== 'notes')
}

// Pure selection: the shopping list out of a group's lists (oldest on the
// unlikely duplicate, mirroring selectNotesList). Unit-tested.
export function selectShoppingList(lists: ListDto[]): ListDto | null {
  const mine = lists.filter((l) => l.listType === 'shopping')
  if (mine.length === 0) return null
  return mine.reduce((oldest, l) => (l.createdAt < oldest.createdAt ? l : oldest))
}

// Pure filter: keep shopping-type lists (for backwards-compatible callers
// that need an array; single-list resolution should prefer selectShoppingList).
// Unit-tested.
export function selectShoppingLists(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType === 'shopping')
}

// Pure filter: the non-shopping task-facing lists. Shopping lists are
// intentionally excluded from the Tasks rail so they appear only on the
// dedicated Shopping tab. Unit-tested.
export function excludeShoppingLists(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType !== 'shopping')
}

// The actor's task lists only — notes AND shopping lists filtered out. The
// single read used by every task surface (rail, My Day, Upcoming).
export async function listPersonalTaskLists(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto[]> {
  return excludeShoppingLists(excludeNotesList(await listPersonalLists(listsClient, actor)))
}

// Read-only lookup of the actor's shopping list, or null if it doesn't
// exist yet (never provisions — GET-side mirror of findNotesList).
export async function findShoppingList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto | null> {
  return selectShoppingList(await listPersonalLists(listsClient, actor))
}

// Find-or-create the actor's single shopping list and return it. Provisions
// the personal group (resolvePersonalScope) and the shopping list on first
// access — mirroring resolveNotesList. Created with visibility 'all' so the
// Lists READ surface keeps returning it; hiding from task surfaces is done
// by listType, not by visibility.
export async function resolveShoppingList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto> {
  const existing = await findShoppingList(listsClient, actor)
  if (existing) return existing
  const scopeId = await resolvePersonalScope(listsClient, actor)
  return listsClient.createList(
    {
      name: SHOPPING_LIST_NAME,
      listType: 'shopping',
      scopeType: 'list_group',
      scopeId,
      visibility: 'all',
    },
    actor,
  )
}

// Read-only lookup of the actor's notes list, or null if they have no
// personal group / no notes list yet (never provisions — GET-side).
export async function findNotesList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto | null> {
  return selectNotesList(await listPersonalLists(listsClient, actor))
}

// Find-or-create the actor's notes list and return it. Provisions the
// personal group (resolvePersonalScope) and the notes list on first note.
// Created with visibility 'all' so the Lists READ surface keeps returning
// it to this resolver — hiding from task surfaces is done by listType, not
// by visibility.
export async function resolveNotesList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto> {
  const existing = await findNotesList(listsClient, actor)
  if (existing) return existing
  const scopeId = await resolvePersonalScope(listsClient, actor)
  return listsClient.createList(
    {
      name: NOTES_LIST_NAME,
      listType: 'notes',
      scopeType: 'list_group',
      scopeId,
      visibility: 'all',
    },
    actor,
  )
}
