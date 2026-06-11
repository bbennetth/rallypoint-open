import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateListViewSchema, UpdateListViewSchema } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListViewRecord, UpdateListViewInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForRead, loadListForWrite } from './_list-access.js'

// Saved-view CRUD for a list (Lists v2, slice 5). Mounted under
// /api/v1/ui/lists/:listId/views. Reads require list read access; writes
// require the list creator (loadListForWrite) — v2 views are per-list and
// shared (any reader sees them, only the creator edits). The view's
// `config` is the structurally-validated filter/sort/columns/mode blob;
// stale specs inside it are resolved at apply time on the client, mirroring
// slice 4.

const TENANT = 'rallypoint'

function serializeView(v: ListViewRecord): Record<string, unknown> {
  return {
    id: v.id,
    list_id: v.listId,
    name: v.name,
    config: v.config,
    position: v.position,
    created_by: v.createdBy,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  }
}

export const viewsRoutes = new Hono<HonoApp>()
  // --- save a view (creator only) ----------------------------------
  .post('/api/v1/ui/lists/:listId/views', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = CreateListViewSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const view = await c.var.repos.listViews.create({
      id: `lvw_${ulid()}`,
      tenantId: TENANT,
      listId,
      name: body.name,
      config: body.config ?? { filters: [], sort: [], visibleColumns: [], viewMode: 'list' },
      ...(body.position !== undefined ? { position: body.position } : {}),
      createdBy: userId,
    })
    publish(c, listChannel(listId), envelope('list_views', 'create', view.id, userId))
    return c.json(serializeView(view), 201)
  })

  // --- list a list's views (read access) ---------------------------
  .get('/api/v1/ui/lists/:listId/views', async (c) => {
    const listId = c.req.param('listId')
    await loadListForRead(c, listId)
    const views = await c.var.repos.listViews.listForList(listId)
    return c.json({ items: views.map(serializeView) })
  })

  // --- update a view (creator only) --------------------------------
  .patch('/api/v1/ui/lists/:listId/views/:viewId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = UpdateListViewSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const view = await c.var.repos.listViews.findById(c.req.param('viewId'))
    if (!view || view.deletedAt || view.listId !== listId) throw errors.viewNotFound()

    const patch: UpdateListViewInput = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.config !== undefined) patch.config = body.config
    if (body.position !== undefined) patch.position = body.position

    const updated = await c.var.repos.listViews.update(view.id, patch)
    if (!updated) throw errors.viewNotFound()
    publish(c, listChannel(listId), envelope('list_views', 'update', updated.id, userId))
    return c.json(serializeView(updated))
  })

  // --- soft-delete a view (creator only) ---------------------------
  .delete('/api/v1/ui/lists/:listId/views/:viewId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const view = await c.var.repos.listViews.findById(c.req.param('viewId'))
    if (!view || view.deletedAt || view.listId !== listId) throw errors.viewNotFound()
    await c.var.repos.listViews.softDelete(view.id, new Date())
    publish(c, listChannel(listId), envelope('list_views', 'delete', view.id, userId))
    return c.body(null, 204)
  })
