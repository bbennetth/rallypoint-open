import { Hono } from 'hono'
import { z } from 'zod'
import {
  CreateFieldDefSchema,
  CreateListItemSchema,
  CreateSeriesSchema,
  UpdateFieldDefSchema,
  UpdateListItemSchema,
  UpdateSeriesSchema,
  listColorField,
  listNameField,
} from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyLists } from '../lib/sdk-error.js'
import {
  listPersonalLists,
  listPersonalTaskLists,
  resolvePersonalScope,
} from '../lib/personal-scope.js'
import { canDeletePersonalList } from '../lib/list-delete.js'

// Planner Task Lists BFF (slice 6b). A thin proxy over the Lists SDK —
// planner-api owns no task storage. Every route resolves the acting user
// from the planner session and forwards to lists-api with x-actor =
// session.userId; the personal task-list scope is a per-user `list_group`
// the BFF finds (or, on first list-create, provisions). The BFF injects
// listType='tasks', scopeType='list_group' and the caller's own scopeId so
// a client can never target another scope.
//
// Item-read authorization: the Lists READ surface (sdk-lists.ts) trusts its
// caller for scope access, so the BFF must itself confirm a requested list
// belongs to the caller's personal group before reading its items — else a
// user could read another's items by guessing a list id. Item WRITES are
// membership-checked downstream by lists-api, so they need no extra guard.

// The BFF only owns the user-facing fields of a personal task list; it
// supplies listType + scope itself, so the wire body is just name (+ color).
// Reuses the shared Lists field validators so the BFF rejects a bad name at
// its own boundary with the same bounds lists-api enforces.
const CreateListBodySchema = z.object({
  name: listNameField,
  color: listColorField,
})

export const listsRoutes = new Hono<HonoApp>()
  // --- the caller's personal task lists ----------------------------
  // Read-only: returns [] (not a provisioned empty group) until the user
  // creates their first list. The notes list (listType='notes') is hidden
  // here so it never appears in the Tasks rail or the quick-add picker;
  // notes are reached via /api/v1/ui/notes instead. Personal
  // (planner-origin) lists only — RPL lists no longer flow into Planner
  // (#531 separation).
  .get('/api/v1/ui/lists', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const personal = await proxyLists(() => listPersonalTaskLists(lists, actor))
    return c.json(personal)
  })

  // --- create a personal task list ---------------------------------
  // Provisions the personal `list_group` on first create.
  .post('/api/v1/ui/lists', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const parsed = CreateListBodySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      const scopeId = await resolvePersonalScope(lists, actor)
      return lists.createList(
        {
          name: parsed.data.name,
          listType: 'tasks',
          scopeType: 'list_group',
          scopeId,
          visibility: 'all',
          ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        },
        actor,
      )
    })
    return c.json(created, 201)
  })

  // --- delete a personal task list ---------------------------------
  // The notes list (listType='notes') is a first-class per-user surface and
  // must not be deletable here; a clear 409 conflict is returned rather than a
  // misleading 404 (the user owns the list — a clear message is better UX).
  .delete('/api/v1/ui/lists/:listId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      const target = owned.find((l) => l.id === listId)
      if (!target) throw errors.notFound('List not found.')
      if (!canDeletePersonalList(target))
        throw errors.conflict('list_not_deletable', "The Quick Notes list can't be deleted.")
      return lists.deleteList(listId, actor)
    })
    return c.body(null, 204)
  })

  // --- items in one of the caller's task lists ---------------------
  // Personal-scope lists only (#531 separation). Still 404s for any other
  // list. A transient Lists failure surfaces as a 5xx via proxyLists
  // rather than a misleading 404.
  .get('/api/v1/ui/lists/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const items = await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      return lists.listItems(listId)
    })
    return c.json(items)
  })

  // --- custom field defs in one of the caller's task lists ---------
  // Reads go through the Lists READ surface (which trusts its caller for
  // scope access), so the BFF owns the ownership guard here — same posture
  // as item reads above (personal scope only, #531 separation). Writes are
  // membership-checked downstream by the Lists SDK write surface, so they
  // need no extra BFF guard.
  .get('/api/v1/ui/lists/:listId/fields', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const defs = await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      return lists.listFieldDefs(listId)
    })
    return c.json(defs)
  })

  // --- define a custom field ---------------------------------------
  // lists-api membership-checks the actor against the list's group, so a
  // foreign listId 404s downstream — no extra BFF guard needed.
  .post('/api/v1/ui/lists/:listId/fields', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(() => lists.createFieldDef(listId, parsed.data, actor))
    return c.json(created, 201)
  })

  // --- update a custom field ---------------------------------------
  .patch('/api/v1/ui/lists/:listId/fields/:fieldId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const fieldId = c.req.param('fieldId')
    const lists = c.var.services.listsClient
    const parsed = UpdateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(() =>
      lists.updateFieldDef(listId, fieldId, parsed.data, actor),
    )
    return c.json(updated)
  })

  // --- soft-delete a custom field ----------------------------------
  .delete('/api/v1/ui/lists/:listId/fields/:fieldId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const fieldId = c.req.param('fieldId')
    const lists = c.var.services.listsClient
    await proxyLists(() => lists.deleteFieldDef(listId, fieldId, actor))
    return c.body(null, 204)
  })

  // --- recurring series in one of the caller's task lists ----------
  // The Lists series SDK gates only on list existence (sdk-series.ts), and
  // series update/delete are NOT actor-scoped downstream, so the BFF owns
  // the IDOR guard: every series route is keyed by listId and confirms the
  // list belongs to the caller's personal group before touching it.
  .get('/api/v1/ui/lists/:listId/series', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const rows = await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      return lists.listSeries(listId)
    })
    return c.json(rows)
  })

  // --- create a recurring series -----------------------------------
  // Materializes up to 50 occurrence items downstream (slice 1); the new
  // items carry seriesId so the UI can badge them as recurring.
  .post('/api/v1/ui/lists/:listId/series', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      return lists.createListItemSeries(listId, parsed.data, actor)
    })
    return c.json(created, 201)
  })

  // --- update a recurring series -----------------------------------
  // Same two-step IDOR guard as DELETE: confirm the list is owned by the
  // actor, then confirm the seriesId belongs to that list before patching.
  // updateSeries downstream is NOT actor-scoped, so the BFF owns this guard.
  .patch('/api/v1/ui/lists/:listId/series/:seriesId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const seriesId = c.req.param('seriesId')
    const lists = c.var.services.listsClient
    const parsed = UpdateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      const series = await lists.listSeries(listId)
      if (!series.some((s) => s.id === seriesId)) throw errors.notFound('Series not found.')
      return lists.updateSeries(seriesId, parsed.data, actor)
    })
    return c.json(updated)
  })

  // --- delete a recurring series -----------------------------------
  // Keyed by listId (ownership guard) AND confirms the series belongs to
  // that list before deleting, since deleteSeries downstream is by id alone.
  .delete('/api/v1/ui/lists/:listId/series/:seriesId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const seriesId = c.req.param('seriesId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      const owned = await listPersonalLists(lists, actor)
      if (!owned.some((l) => l.id === listId)) throw errors.notFound('List not found.')
      const series = await lists.listSeries(listId)
      if (!series.some((s) => s.id === seriesId)) throw errors.notFound('Series not found.')
      return lists.deleteSeries(seriesId, actor)
    })
    return c.body(null, 204)
  })

  // --- create an item ----------------------------------------------
  // lists-api membership-checks the actor against the list's group, so a
  // foreign listId 404s downstream — no extra BFF guard needed.
  .post('/api/v1/ui/lists/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(() => lists.createListItem(listId, parsed.data, actor))
    return c.json(created, 201)
  })

  // --- update / check-off an item ----------------------------------
  .patch('/api/v1/ui/lists/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(() =>
      lists.updateListItem(listId, itemId, parsed.data, actor),
    )
    return c.json(updated)
  })

  // --- soft-delete an item -----------------------------------------
  .delete('/api/v1/ui/lists/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    await proxyLists(() => lists.deleteListItem(listId, itemId, actor))
    return c.body(null, 204)
  })
