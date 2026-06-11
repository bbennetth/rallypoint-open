import { Hono } from 'hono'
import { z } from 'zod'
import { itemNotesField, itemTitleField } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyLists } from '../lib/sdk-error.js'
import { findNotesList, resolveNotesList } from '../lib/personal-scope.js'

// Planner Quick Notes BFF. Notes are stored in Lists as a single per-user
// list of listType='notes' inside the actor's personal `list_group` — the
// same stateless model the task-list routes use, just a different list type.
// planner-api owns no notes storage; it resolves the notes list from what
// the Lists SDK returns for the actor and forwards item CRUD with x-actor.
//
// The notes list is deliberately hidden from the task surfaces (the Tasks
// rail, My Day, Upcoming) — see listPersonalTaskLists — so a user's notes
// never masquerade as tasks. These routes are the only way to reach them.
//
// A note item maps onto the generic list-item columns: `title` is the
// heading (1–200) and `notes` is the free-form body (≤2000). status /
// priority / dueDate stay null because the list isn't a task list.

// A note's heading is required; the body is optional (empty → null).
const CreateNoteSchema = z.object({
  title: itemTitleField,
  notes: itemNotesField,
})

// Sparse edit: either field may change, but at least one must be present.
const UpdateNoteSchema = z
  .object({
    title: itemTitleField.optional(),
    notes: itemNotesField,
  })
  .superRefine((v, ctx) => {
    if (v.title === undefined && v.notes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })

export const notesRoutes = new Hono<HonoApp>()
  // --- the caller's notes ------------------------------------------
  // Read-only: returns [] until the user writes their first note (the
  // notes list is provisioned lazily on first POST, like the task group).
  .get('/api/v1/ui/notes', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const rows = await proxyLists(async () => {
      const notesList = await findNotesList(lists, actor)
      if (!notesList) return []
      return lists.listItems(notesList.id)
    })
    return c.json(rows)
  })

  // --- create a note -----------------------------------------------
  // Provisions the personal group + notes list on first note.
  .post('/api/v1/ui/notes', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const parsed = CreateNoteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      const notesList = await resolveNotesList(lists, actor)
      // Notes items are not task-type; priority stays null (lists-api enforces
      // this by list type, but the SDK type now requires the field explicitly
      // since CreateListItemInput.priority became non-optional after #430).
      return lists.createListItem(notesList.id, { ...parsed.data, priority: null }, actor)
    })
    return c.json(created, 201)
  })

  // --- edit a note -------------------------------------------------
  // Keyed by the caller's own notes list, so a foreign itemId 404s
  // downstream (the SDK scopes the write to that list id).
  .patch('/api/v1/ui/notes/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    const parsed = UpdateNoteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(async () => {
      const notesList = await findNotesList(lists, actor)
      if (!notesList) throw errors.notFound('Note not found.')
      return lists.updateListItem(notesList.id, itemId, parsed.data, actor)
    })
    return c.json(updated)
  })

  // --- delete a note -----------------------------------------------
  .delete('/api/v1/ui/notes/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      const notesList = await findNotesList(lists, actor)
      if (!notesList) throw errors.notFound('Note not found.')
      return lists.deleteListItem(notesList.id, itemId, actor)
    })
    return c.body(null, 204)
  })
