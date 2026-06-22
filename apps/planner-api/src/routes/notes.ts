import { Hono } from 'hono'
import { z } from 'zod'
import { itemNotesField, itemTitleField } from '@rallypoint/lists-shared'
import { ListsClientError } from '@rallypoint/lists-client'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyLists } from '../lib/sdk-error.js'
import {
  listNotesFolders,
  resolveNotesList,
  resolvePersonalScope,
} from '../lib/personal-scope.js'
import {
  defaultFolder,
  folderNameTaken,
  isOwnedFolder,
  tagNotes,
  type NoteWithFolder,
} from '../lib/notes-folders.js'

// Planner Quick Notes BFF. Notes are stored in Lists as items of per-user
// lists of listType='notes' inside the actor's personal `list_group` — the
// same stateless model the task-list routes use. Since #549 notes support
// FOLDERS: each folder is a separate notes-type list, the oldest of which is
// the default 'Notes' folder (resolveNotesList). planner-api owns no notes
// storage; it resolves the notes lists from what the Lists SDK returns and
// forwards item CRUD (incl. cross-folder MOVE via the SDK move endpoint) with
// x-actor.
//
// All notes lists are hidden from the task surfaces (the Tasks rail, My Day,
// Upcoming) — see excludeNotesList, which filters by listType so every folder
// is excluded, not just the default. These routes are the only way to reach
// notes.
//
// A note item maps onto the generic list-item columns: `title` is the
// heading (1–200) and `notes` is the free-form body (≤2000). status /
// priority / dueDate stay null because the list isn't a task list.

// A note's heading is required; the body is optional (empty → null).
const CreateNoteSchema = z.object({
  title: itemTitleField,
  notes: itemNotesField,
})

// Sparse edit: title/notes/folderId may change, but at least one must be
// present. folderId (#549) triggers a cross-folder MOVE of the note.
const UpdateNoteSchema = z
  .object({
    title: itemTitleField.optional(),
    notes: itemNotesField,
    folderId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.title === undefined && v.notes === undefined && v.folderId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })

// A folder's display name (1–80, trimmed).
const CreateFolderSchema = z.object({
  name: z.string().trim().min(1, 'Folder name is required.').max(80, 'Folder name is too long.'),
})

// camelCase folder DTO surfaced to the web client. `isDefault` marks the
// oldest folder (the undeletable default 'Notes' folder).
function folderDto(
  l: { id: string; name: string; createdAt: string },
  isDefault: boolean,
): Record<string, unknown> {
  return { id: l.id, name: l.name, createdAt: l.createdAt, isDefault }
}

export const notesRoutes = new Hono<HonoApp>()
  // --- the caller's notes ------------------------------------------
  // Read-only. Without ?folderId, returns notes across ALL folders, each
  // tagged with its folderId (folder attribution for the UI). With
  // ?folderId, returns only that folder's notes (404 if it's not one of the
  // actor's folders). Returns [] until the user writes their first note.
  .get('/api/v1/ui/notes', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const folderId = c.req.query('folderId')
    const rows = await proxyLists(async (): Promise<NoteWithFolder[]> => {
      const folders = await listNotesFolders(lists, actor)
      if (folders.length === 0) return []
      if (folderId !== undefined) {
        const folder = folders.find((f) => f.id === folderId)
        if (!folder) throw errors.notFound('Folder not found.')
        return tagNotes(await lists.listItems(folder.id), folder.id)
      }
      // Across-all: fan out per folder, tagging each note with its folder.
      const perFolder = await Promise.all(
        folders.map(async (f) => tagNotes(await lists.listItems(f.id), f.id)),
      )
      return perFolder.flat()
    })
    return c.json(rows)
  })

  // --- the caller's folders ----------------------------------------
  // Read-only. Returns [] before any notes list exists (provisions nothing).
  // The oldest folder is flagged isDefault.
  .get('/api/v1/ui/notes/folders', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const folders = await proxyLists(() => listNotesFolders(lists, actor))
    const defaultId = defaultFolder(folders)?.id ?? null
    return c.json(folders.map((f) => folderDto(f, f.id === defaultId)))
  })

  // --- create a folder ---------------------------------------------
  // A new notes-type list in the personal group. Rejects a duplicate live
  // folder name (case-insensitive) for the user with 409. Provisions the
  // personal group + the default notes list first so the default 'Notes'
  // folder always exists and a brand-new folder never becomes the default.
  .post('/api/v1/ui/notes/folders', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const parsed = CreateFolderSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      // Ensure the default folder exists so it stays the oldest (default).
      await resolveNotesList(lists, actor)
      const folders = await listNotesFolders(lists, actor)
      if (folderNameTaken(folders, parsed.data.name)) {
        throw errors.conflict('folder_name_taken', 'A folder with that name already exists.')
      }
      const scopeId = await resolvePersonalScope(lists, actor)
      try {
        return await lists.createList(
          {
            name: parsed.data.name,
            listType: 'notes',
            scopeType: 'list_group',
            scopeId,
            visibility: 'all',
          },
          actor,
        )
      } catch (err) {
        // Race backstop: a concurrent same-name create slipped past the
        // pre-check above and lost the lists_notes_folder_name_uq race
        // (#559). The SDK create route surfaces exactly that as a 409
        // `list_name_conflict`; map it to the same folder_name_taken the
        // pre-check returns. Match the specific code (not any 409) so an
        // unrelated future conflict propagates verbatim. (errors.conflict
        // throws an ApiError, which proxyLists passes through untouched.)
        if (err instanceof ListsClientError && err.status === 409 && err.code === 'list_name_conflict') {
          throw errors.conflict('folder_name_taken', 'A folder with that name already exists.')
        }
        throw err
      }
    })
    return c.json(folderDto(created, false), 201)
  })

  // --- delete a folder ---------------------------------------------
  // Only when the folder is empty (no live notes) and is NOT the default
  // 'Notes' folder; 409 otherwise. 404 when it's not one of the actor's
  // folders.
  .delete('/api/v1/ui/notes/folders/:folderId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const folderId = c.req.param('folderId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      const folders = await listNotesFolders(lists, actor)
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) throw errors.notFound('Folder not found.')
      if (defaultFolder(folders)?.id === folder.id) {
        throw errors.conflict('default_folder_undeletable', 'The default Notes folder cannot be deleted.')
      }
      const items = await lists.listItems(folder.id)
      if (items.length > 0) {
        throw errors.conflict('folder_not_empty', 'Move or delete the folder’s notes first.')
      }
      await lists.deleteList(folder.id, actor)
    })
    return c.body(null, 204)
  })

  // --- create a note -----------------------------------------------
  // Provisions the personal group + default notes list on first note.
  .post('/api/v1/ui/notes', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const parsed = CreateNoteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async (): Promise<NoteWithFolder> => {
      const notesList = await resolveNotesList(lists, actor)
      // Notes items are not task-type; priority stays null (lists-api enforces
      // this by list type, but the SDK type now requires the field explicitly
      // since CreateListItemInput.priority became non-optional after #430).
      const item = await lists.createListItem(notesList.id, { ...parsed.data, priority: null }, actor)
      // Tag with the (default) folder so the client stays consistent with the
      // folder-attributed GET.
      return { ...item, folderId: notesList.id }
    })
    return c.json(created, 201)
  })

  // --- edit / move a note ------------------------------------------
  // title/notes edits go to the note's current folder; a `folderId` triggers
  // a cross-folder MOVE via the SDK move endpoint (target validated as one of
  // the actor's notes folders first). When both are present, the content edit
  // is applied first, then the move.
  .patch('/api/v1/ui/notes/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    const parsed = UpdateNoteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { folderId, ...content } = parsed.data
    const updated = await proxyLists(async (): Promise<NoteWithFolder> => {
      const folders = await listNotesFolders(lists, actor)
      if (folders.length === 0) throw errors.notFound('Note not found.')
      // Resolve the note to its folder in ONE scoped lookup instead of a
      // per-folder items fan-out (#559). The personal scope is the folders'
      // shared list_group. The lookup spans the whole scope — which also
      // holds the tasks list — so restrict the hit to a NOTES folder:
      // isOwnedFolder(folders, …) 404s a non-note (or foreign) item id.
      const scopeId = folders[0]!.scopeId
      const currentItem = await lists.findItemInScope(
        { scopeType: 'list_group', scopeId },
        itemId,
        actor,
      )
      if (currentItem === null || !isOwnedFolder(folders, currentItem.listId)) {
        throw errors.notFound('Note not found.')
      }
      const currentFolderId = currentItem.listId

      // Validate the move target up front (404 a foreign folder).
      const wantsMove = folderId !== undefined && folderId !== currentFolderId
      if (wantsMove && !isOwnedFolder(folders, folderId!)) {
        throw errors.notFound('Folder not found.')
      }

      // Move FIRST, then apply content edits in the target folder. The two
      // SDK calls are not atomic; this order leaves the safer partial state
      // on a mid-handler failure: a failed move leaves the note untouched,
      // and a failed content edit after a successful move leaves the note in
      // the right folder with stale content (retryable). The reverse order
      // could commit the content edit and then strand it in the old folder.
      let result = currentItem
      let finalFolderId = currentFolderId
      if (wantsMove) {
        result = await lists.moveListItem(currentFolderId, itemId, folderId!, actor)
        finalFolderId = folderId!
      }
      if (Object.keys(content).length > 0) {
        result = await lists.updateListItem(finalFolderId, itemId, content, actor)
      }
      // Tag the response with its (final) folder so the client stays
      // consistent with the folder-attributed GET.
      return { ...result, folderId: finalFolderId }
    })
    return c.json(updated)
  })

  // --- delete a note -----------------------------------------------
  // Probes the actor's folders for the item so a note in any folder can be
  // deleted (a foreign itemId 404s).
  .delete('/api/v1/ui/notes/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      const folders = await listNotesFolders(lists, actor)
      if (folders.length === 0) throw errors.notFound('Note not found.')
      // One scoped lookup instead of a per-folder items fan-out (#559).
      // Restrict the hit to a NOTES folder — the scope also holds the tasks
      // list, so a non-note (or foreign) item id must still 404 here.
      const scopeId = folders[0]!.scopeId
      const item = await lists.findItemInScope(
        { scopeType: 'list_group', scopeId },
        itemId,
        actor,
      )
      if (item === null || !isOwnedFolder(folders, item.listId)) {
        throw errors.notFound('Note not found.')
      }
      await lists.deleteListItem(item.listId, itemId, actor)
    })
    return c.body(null, 204)
  })
