import type { GroupDto, ListDto, ListsClient } from '@rallypoint/lists-client'
import {
  fieldDefCreateInput,
  itemCreateInput,
  planFieldDefs,
  seriesCreateInput,
} from './task-merge.js'

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
//
// Expand/contract rollout (issue #544): the DB migration 0010 renames
// existing rows from 'My Tasks' → 'Planner', but runs before the new
// Worker code is hot. During the rollout window both names are valid —
// selectPersonalGroup matches either. Once all rows have been migrated
// and the contract release ships, PERSONAL_GROUP_NAME_LEGACY can be
// removed and the filter narrowed back to a single name.
export const PERSONAL_GROUP_NAME = 'Planner'
// Legacy name kept for backward-compat during the rollout window; groups
// that were not yet renamed by migration 0010 (e.g. collision rows) are
// still found so no user gets orphaned.
export const PERSONAL_GROUP_NAME_LEGACY = 'My Tasks'

// The reserved display name for the per-user notes list. Like the personal
// group, the BFF finds it by a reserved identity rather than storing a
// mapping — here the `listType === 'notes'` discriminator inside the
// personal group (the name is cosmetic; resolution keys off listType).
export const NOTES_LIST_NAME = 'Notes'

// The reserved display name for the per-user shopping list. Identity is
// resolved the same stateless way as the notes list — keyed off
// `listType === 'shopping'`, not the name.
export const SHOPPING_LIST_NAME = 'Shopping'

// The reserved display name for the per-user chores list. Identity is resolved
// the same stateless way as notes/shopping — keyed off `listType === 'chores'`,
// not the name. Chores is a tasks-shaped list (carries dueDate so recurring
// occurrences land on a day) but is deliberately kept OUT of every task surface
// — the rail, My Day, Upcoming, AND the #543 canonical-Tasks merge — so a
// user's recurring household chores never get swallowed into Tasks (#546).
export const CHORES_LIST_NAME = 'Chores'

// The reserved display name for the per-user diary list. Identity is resolved
// the stateless way (keyed off `listType === 'diary'`, not the name). Like
// chores/notes/shopping it is system-managed and kept OUT of every task surface.
export const DIARY_LIST_NAME = 'Diary'

// The reserved display name minted for the single canonical Tasks list when
// the user has none yet (issue #543 — Tasks became a single system-managed
// list like Shopping/Notes). Unlike notes/shopping there is no dedicated
// `listType` discriminator for tasks (the generic `tasks` type is shared by
// every personal task list), so the canonical list is identified positionally
// — the OLDEST `tasks`-type list in the personal group — and any other
// `tasks` lists are folded into it (see mergeTaskListsInto). The name is
// cosmetic; resolution keys off "oldest tasks list", not the name.
export const TASKS_LIST_NAME = 'Tasks'

// Pure selection over a fetched group list — unit-tested in isolation.
export function selectPersonalGroup(groups: GroupDto[], actor: string): GroupDto | null {
  const mine = groups.filter(
    (g) =>
      g.createdBy === actor &&
      (g.name === PERSONAL_GROUP_NAME || g.name === PERSONAL_GROUP_NAME_LEGACY),
  )
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
  // origin:'planner' stamps provenance — the Lists UI serves this group
  // read-only so RPL-only features (custom statuses, kanban) can't be
  // attached to Planner lists.
  const created = await listsClient.createGroup(
    { name: PERSONAL_GROUP_NAME, origin: 'planner' },
    actor,
  )
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
// authorize. Because it filters by listType === 'notes', ALL notes folders
// (#549 — folders are multiple notes-type lists) are excluded, not just the
// default one. Unit-tested.
export function excludeNotesList(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType !== 'notes')
}

// Pure selection: every notes-type list (folder) in a group's lists, oldest
// first. Folders are multiple `notes`-type lists in the personal group
// (#549); the oldest is the default 'Notes' folder. Deterministically
// ordered (createdAt, then id) so folder lists/pickers are stable. Unit-tested.
export function selectNotesLists(lists: ListDto[]): ListDto[] {
  return lists
    .filter((l) => l.listType === 'notes')
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    )
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

// --- chores list (#546) ----------------------------------------------
// The user's recurring household chores are a single Lists list of
// `list_type = 'chores'` in the SAME personal group as their task lists. It's
// resolved the stateless identity way (listType, not a stored mapping) and is
// kept OUT of every task surface (see excludeChoresLists) AND out of the #543
// canonical-Tasks merge, so a chores list never shows up as a task and never
// gets folded into the Tasks list.

// Pure selection: the chores list out of a group's lists (oldest on the
// unlikely duplicate, mirroring selectNotesList). Unit-tested.
export function selectChoresList(lists: ListDto[]): ListDto | null {
  const mine = lists.filter((l) => l.listType === 'chores')
  if (mine.length === 0) return null
  return mine.reduce((oldest, l) => (l.createdAt < oldest.createdAt ? l : oldest))
}

// Pure filter: the non-chores task-facing lists. Chores lists are excluded
// from the Tasks rail / My Day / Upcoming / merge so they only appear on the
// dedicated Chores tab. Unit-tested.
export function excludeChoresLists(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType !== 'chores')
}

// --- diary list ------------------------------------------------------
// The user's journal lives in a single Lists list of `list_type = 'diary'` in
// the SAME personal group as their task lists, resolved the stateless identity
// way (listType, not a stored mapping). Like chores it is kept OUT of every
// task surface (excludeDiaryLists) AND out of the canonical-Tasks merge, so a
// diary entry never shows up as a task.

// Pure selection: the diary list out of a group's lists (oldest on the
// unlikely duplicate, mirroring selectChoresList). Unit-tested.
export function selectDiaryList(lists: ListDto[]): ListDto | null {
  const mine = lists.filter((l) => l.listType === 'diary')
  if (mine.length === 0) return null
  return mine.reduce((oldest, l) => (l.createdAt < oldest.createdAt ? l : oldest))
}

// Pure filter: the non-diary task-facing lists. Diary lists are excluded from
// the Tasks rail / My Day / Upcoming / merge so journal entries only appear on
// the dedicated Diary tab. Unit-tested.
export function excludeDiaryLists(lists: ListDto[]): ListDto[] {
  return lists.filter((l) => l.listType !== 'diary')
}

// The actor's task lists only — notes, shopping, chores AND diary lists
// filtered out. The single read used by every task surface (rail, My Day,
// Upcoming).
export async function listPersonalTaskLists(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto[]> {
  return excludeDiaryLists(
    excludeChoresLists(
      excludeShoppingLists(excludeNotesList(await listPersonalLists(listsClient, actor))),
    ),
  )
}

// --- canonical Tasks list (issue #543) -------------------------------
// Tasks is now a single system-managed list per user, like Shopping/Notes.
// There is no `tasks`-specific listType (the generic `tasks` type is shared
// by every personal task list, including the legacy multi-list ones), so the
// canonical list is identified POSITIONALLY: the oldest `tasks`-type list in
// the personal group. Any other `tasks` lists are folded into it on resolve
// (mergeTaskListsInto), so the user only ever sees one Tasks list in Planner
// even if they created several before this change.

// Pure selection: the canonical (oldest) task list out of a group's lists.
// Notes + shopping are excluded first so a notes/shopping list can never be
// mistaken for the canonical Tasks list. Oldest-wins mirrors
// selectPersonalGroup / selectNotesList. Unit-tested.
export function selectTasksList(lists: ListDto[]): ListDto | null {
  const taskLists = excludeDiaryLists(
    excludeChoresLists(excludeShoppingLists(excludeNotesList(lists))),
  )
  if (taskLists.length === 0) return null
  return taskLists.reduce((oldest, l) => (l.createdAt < oldest.createdAt ? l : oldest))
}

// Pure selection: the NON-canonical task lists (every task list except the
// oldest) — the ones whose items get folded into the canonical list. Unit-
// tested. Deterministically ordered oldest-first so the merge is stable.
export function selectNonCanonicalTaskLists(lists: ListDto[]): ListDto[] {
  const taskLists = excludeDiaryLists(
    excludeChoresLists(excludeShoppingLists(excludeNotesList(lists))),
  ).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  )
  // Drop the first (oldest = canonical); the rest are sources to fold in.
  return taskLists.slice(1)
}

// Read-only lookup of the actor's canonical Tasks list, or null if they have
// no personal group / no task list yet (never provisions — GET-side mirror
// of findNotesList). Does NOT run the merge; pair with resolveTasksList when
// a write needs the canonical list provisioned + folded.
export async function findTasksList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto | null> {
  return selectTasksList(await listPersonalLists(listsClient, actor))
}

// Fold every NON-canonical task list's contents into `canonical`, then return
// nothing. Idempotent: after a run the source lists hold no live items/series,
// so a re-run copies nothing (no marker table needed). The source LIST rows
// are left in place (per #543 they remain visible in the Lists app); only
// their items + series are moved. The Lists SDK rejects cross-list item moves,
// so "move" = recreate-in-canonical + soft-delete-source.
//
// Per source list, in deterministic (oldest-first) order:
//  1. Field defs — unify the source's custom-field schema into the canonical
//     list by (label, fieldType); reuse a matching canonical def or create a
//     new one. Build an old-def-id → canonical-def-id remap.
//  2. Series — recreate each recurring series in the canonical list (which
//     materializes fresh occurrences carrying a canonical seriesId), then
//     soft-delete the source series (which removes its source occurrences).
//     The recurrence RULE + template are preserved; per-occurrence completion
//     history on past occurrences is regenerated, not copied (the SDK can't
//     set seriesId on a plain item, so a series can only be preserved via
//     re-materialization).
//  3. One-off items (seriesId == null) — recreate in the canonical list with
//     title/notes/completion/priority/dueDate and the remapped customFields,
//     then soft-delete the source item. Duplicate titles are preserved as
//     distinct items (merge folds in, it does not dedupe).
//
// A best-effort operation composed of independent SDK calls: each item/series
// is copied-then-deleted, so a mid-run failure leaves a safe partial state
// (some items already moved, the rest still live on the source) that the next
// resolve completes — never a lost or duplicated item.
async function mergeTaskListsInto(
  listsClient: ListsClient,
  actor: string,
  canonical: ListDto,
  sources: ListDto[],
): Promise<void> {
  for (const source of sources) {
    // (1) Unify custom-field schema. Re-read canonical defs each source pass
    // so defs created for an earlier source are reused, not duplicated.
    const sourceDefs = await listsClient.listFieldDefs(source.id)
    const canonicalDefs = await listsClient.listFieldDefs(canonical.id)
    const plan = planFieldDefs(sourceDefs, canonicalDefs)
    const remap = new Map(plan.remap)
    for (const def of plan.toCreate) {
      const created = await listsClient.createFieldDef(canonical.id, fieldDefCreateInput(def), actor)
      remap.set(def.id, created.id)
    }

    // (2) Recreate recurring series, then delete each source series.
    const series = await listsClient.listSeries(source.id)
    for (const s of series) {
      await listsClient.createListItemSeries(canonical.id, seriesCreateInput(s), actor)
      await listsClient.deleteSeries(s.id, actor)
    }

    // (3) Recreate one-off items, then delete each source item. Series-
    // occurrence items (seriesId != null) are NOT copied — they were
    // regenerated by the recreated series — but they ARE deleted so the
    // source list ends up empty (its series deletion already removed them;
    // belt-and-braces in case any survived).
    const items = await listsClient.listItems(source.id)
    for (const item of items) {
      if (item.seriesId == null) {
        await listsClient.createListItem(canonical.id, itemCreateInput(item, remap), actor)
      }
      await listsClient.deleteListItem(source.id, item.id, actor)
    }
  }
}

// Find-or-create the actor's single canonical Tasks list, folding any other
// personal task lists into it, and return the canonical list. Provisions the
// personal group + a 'Tasks' list on first access (mirroring
// resolveNotesList / resolveShoppingList). The merge runs every resolve but
// is idempotent + cheap once the user is consolidated (one listLists read +,
// for each already-empty residual source list, a couple of empty reads).
export async function resolveTasksList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto> {
  const lists = await listPersonalLists(listsClient, actor)
  let canonical = selectTasksList(lists)
  if (!canonical) {
    const scopeId = await resolvePersonalScope(listsClient, actor)
    canonical = await listsClient.createList(
      {
        name: TASKS_LIST_NAME,
        listType: 'tasks',
        scopeType: 'list_group',
        scopeId,
        visibility: 'all',
      },
      actor,
    )
    // A brand-new canonical list means a fresh user (or one whose only task
    // list we just created) — there is nothing to fold in.
    return canonical
  }
  const sources = selectNonCanonicalTaskLists(lists)
  if (sources.length > 0) await mergeTaskListsInto(listsClient, actor, canonical, sources)
  return canonical
}

// Read-only lookup of the actor's chores list, or null if it doesn't exist yet
// (never provisions — GET-side mirror of findNotesList/findShoppingList).
export async function findChoresList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto | null> {
  return selectChoresList(await listPersonalLists(listsClient, actor))
}

// Find-or-create the actor's single chores list and return it. Provisions the
// personal group (resolvePersonalScope) and the chores list on first access —
// mirroring resolveShoppingList. Created with listType 'chores' so it stays out
// of every task surface (excludeChoresLists) yet carries dueDate on its items.
export async function resolveChoresList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto> {
  const existing = await findChoresList(listsClient, actor)
  if (existing) return existing
  const scopeId = await resolvePersonalScope(listsClient, actor)
  return listsClient.createList(
    {
      name: CHORES_LIST_NAME,
      listType: 'chores',
      scopeType: 'list_group',
      scopeId,
      visibility: 'all',
    },
    actor,
  )
}

// Read-only lookup of the actor's diary list, or null if it doesn't exist yet
// (never provisions — GET-side mirror of findChoresList).
export async function findDiaryList(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto | null> {
  return selectDiaryList(await listPersonalLists(listsClient, actor))
}

// Find-or-create the actor's single diary list. Provisions the personal group
// (resolvePersonalScope) and the diary list on first access — mirroring
// resolveChoresList. Created with listType 'diary' so it stays out of every
// task surface (excludeDiaryLists). Returns `created` so the caller can seed
// the default Mood field exactly once, on creation — seeding lives in the diary
// route (it needs the Lists field SDK), not here. Returning the flag also lets
// the route avoid a second find round-trip on the warm path.
export async function resolveDiaryList(
  listsClient: ListsClient,
  actor: string,
): Promise<{ list: ListDto; created: boolean }> {
  const existing = await findDiaryList(listsClient, actor)
  if (existing) return { list: existing, created: false }
  const scopeId = await resolvePersonalScope(listsClient, actor)
  const list = await listsClient.createList(
    {
      name: DIARY_LIST_NAME,
      listType: 'diary',
      scopeType: 'list_group',
      scopeId,
      visibility: 'all',
    },
    actor,
  )
  return { list, created: true }
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

// Read-only lookup of the actor's notes folders (every notes-type list in the
// personal group), oldest first — the default 'Notes' folder leads. Returns
// [] when the user has no personal group / no notes list yet (never
// provisions — GET-side). The default folder is selectNotesList's pick (the
// oldest), i.e. result[0] when non-empty.
export async function listNotesFolders(
  listsClient: ListsClient,
  actor: string,
): Promise<ListDto[]> {
  return selectNotesLists(await listPersonalLists(listsClient, actor))
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
