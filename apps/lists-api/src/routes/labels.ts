import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateLabelSchema, UpdateLabelSchema } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListLabelRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForRead, loadListForWrite } from './_list-access.js'

// Per-list label CRUD (RPL v1.0.0 slice 12). Mounted under
// /api/v1/ui/lists/:listId/labels. Reads require list read access;
// writes require the list creator (loadListForWrite). No lazy seeding
// — a list starts with no labels. Labels are soft-deleted; join rows
// are hard-purged on delete so labels stop appearing on items
// immediately. Published to the list channel so the UI live-updates.

const TENANT = 'rallypoint'

function serializeLabel(l: ListLabelRecord): Record<string, unknown> {
  return {
    id: l.id,
    list_id: l.listId,
    name: l.name,
    color: l.color,
    position: l.position,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  }
}

export const labelsRoutes = new Hono<HonoApp>()
  // --- list a list's labels (read access) ---------------------------
  .get('/api/v1/ui/lists/:listId/labels', async (c) => {
    const listId = c.req.param('listId')
    await loadListForRead(c, listId)
    const labels = await c.var.repos.listLabels.listForList(listId)
    return c.json({ items: labels.map(serializeLabel) })
  })

  // --- create a label (creator only) --------------------------------
  .post('/api/v1/ui/lists/:listId/labels', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = CreateLabelSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const label = await c.var.repos.listLabels.create({
      id: `lbl_${ulid()}`,
      tenantId: TENANT,
      listId,
      name: body.name,
      color: body.color ?? null,
      ...(body.position !== undefined ? { position: body.position } : {}),
    })
    publish(c, listChannel(listId), envelope('list_labels', 'create', label.id, userId))
    return c.json(serializeLabel(label), 201)
  })

  // --- update a label (creator only) --------------------------------
  .patch('/api/v1/ui/lists/:listId/labels/:labelId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = UpdateLabelSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const label = await c.var.repos.listLabels.findById(c.req.param('labelId'))
    if (!label || label.listId !== listId || label.deletedAt) throw errors.labelNotFound()

    const updated = await c.var.repos.listLabels.update(label.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    })
    if (!updated) throw errors.labelNotFound()

    publish(c, listChannel(listId), envelope('list_labels', 'update', updated.id, userId))
    return c.json(serializeLabel(updated))
  })

  // --- delete a label (creator only) --------------------------------
  // Hard-purges join rows first so the label stops appearing on items
  // immediately, then soft-deletes the label row.
  .delete('/api/v1/ui/lists/:listId/labels/:labelId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)

    const label = await c.var.repos.listLabels.findById(c.req.param('labelId'))
    if (!label || label.listId !== listId || label.deletedAt) throw errors.labelNotFound()

    await c.var.repos.listLabels.removeLabelFromAllItems(label.id)
    await c.var.repos.listLabels.softDelete(label.id, new Date())
    publish(c, listChannel(listId), envelope('list_labels', 'delete', label.id, userId))
    return c.body(null, 204)
  })
