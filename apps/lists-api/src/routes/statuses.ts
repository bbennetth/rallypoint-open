import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateStatusSchema,
  UpdateStatusSchema,
  ReorderStatusesSchema,
  categoryMirrorsCompleted,
  defaultStatusForCategory,
  isLastDoneStatus,
} from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListStatusRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForRead, loadListForWrite } from './_list-access.js'
import { ensureStatuses } from './_statuses.js'

// Per-list custom-status CRUD (RPL v1.0.0 slice 1). Mounted under
// /api/v1/ui/lists/:listId/statuses. Reads require list read access and
// lazily seed the three defaults on first use; writes require the list
// creator (loadListForWrite). `category` is the load-bearing classifier —
// completion, kanban grouping, and GitHub auto-close all key off it.

const TENANT = 'rallypoint'

function serializeStatus(s: ListStatusRecord): Record<string, unknown> {
  return {
    id: s.id,
    list_id: s.listId,
    name: s.name,
    color: s.color,
    category: s.category,
    position: s.position,
    created_by: s.createdBy,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  }
}

export const statusesRoutes = new Hono<HonoApp>()
  // --- list a list's statuses (read access; lazy-seeds defaults) ----
  .get('/api/v1/ui/lists/:listId/statuses', async (c) => {
    const listId = c.req.param('listId')
    const list = await loadListForRead(c, listId)
    // Seed under the list owner (not the requesting reader) so a non-owner's
    // first read doesn't stamp them as the statuses' creator.
    const statuses = await ensureStatuses(c, listId, list.createdBy)
    return c.json({ items: statuses.map(serializeStatus) })
  })

  // --- create a status (creator only) ------------------------------
  .post('/api/v1/ui/lists/:listId/statuses', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const list = await loadListForWrite(c, listId)
    const parsed = CreateStatusSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Seed defaults first so a list's status set is never partial (a
    // created status appends after the seeded three).
    await ensureStatuses(c, listId, list.createdBy)

    const status = await c.var.repos.listStatuses.create({
      id: `lst_${ulid()}`,
      tenantId: TENANT,
      listId,
      name: body.name,
      color: body.color ?? null,
      category: body.category,
      ...(body.position !== undefined ? { position: body.position } : {}),
      createdBy: userId,
    })
    publish(c, listChannel(listId), envelope('list_statuses', 'create', status.id, userId))
    return c.json(serializeStatus(status), 201)
  })

  // --- update a status (creator only) ------------------------------
  .patch('/api/v1/ui/lists/:listId/statuses/:statusId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const list = await loadListForWrite(c, listId)
    const parsed = UpdateStatusSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const statuses = await ensureStatuses(c, listId, list.createdBy)
    const status = statuses.find((s) => s.id === c.req.param('statusId'))
    if (!status) throw errors.statusNotFound()

    // Recategorizing the last done status away from `done` would strip the
    // list of any completable state — reject it, same invariant the delete
    // guard enforces.
    if (
      body.category !== undefined &&
      body.category !== 'done' &&
      isLastDoneStatus(statuses, status.id)
    ) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['category'],
            message: 'A list must keep at least one done status.',
          },
        ],
      })
    }

    // A category change flips the completed mirror for every item on this
    // status (e.g. a column renamed-and-recategorized to `done` completes
    // its items). Re-point items FIRST, then flip the status row — if the
    // reassign throws, the status category hasn't moved yet, so the guard
    // above (`body.category !== status.category`) still fires on retry and
    // both steps re-run. Doing the status update first would leave the row
    // recategorized but items un-migrated, and the guard would then skip
    // the reassign forever (D1 has no multi-statement transaction here).
    if (body.category !== undefined && body.category !== status.category) {
      await c.var.repos.listStatuses.reassignItems(listId, status.id, {
        statusId: status.id,
        status: body.category,
        completed: categoryMirrorsCompleted(body.category).completed,
      })
    }

    const updated = await c.var.repos.listStatuses.update(status.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    })
    if (!updated) throw errors.statusNotFound()

    publish(c, listChannel(listId), envelope('list_statuses', 'update', updated.id, userId))
    return c.json(serializeStatus(updated))
  })

  // --- reorder the full set (creator only) -------------------------
  .put('/api/v1/ui/lists/:listId/statuses/order', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const list = await loadListForWrite(c, listId)
    const parsed = ReorderStatusesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const statuses = await ensureStatuses(c, listId, list.createdBy)
    const known = new Set(statuses.map((s) => s.id))
    // Apply the requested order to ids that belong to this list; any
    // omitted statuses keep their relative order after the listed ones.
    let position = 0
    for (const id of parsed.data.orderedIds) {
      if (!known.has(id)) continue
      await c.var.repos.listStatuses.update(id, { position })
      position++
    }
    for (const s of statuses) {
      if (parsed.data.orderedIds.includes(s.id)) continue
      await c.var.repos.listStatuses.update(s.id, { position })
      position++
    }
    const fresh = await c.var.repos.listStatuses.listForList(listId)
    publish(c, listChannel(listId), envelope('list_statuses', 'update', listId, userId))
    return c.json({ items: fresh.map(serializeStatus) })
  })

  // --- delete a status (creator only) ------------------------------
  // Reassigns items on the deleted status to a fallback before soft-
  // deleting so no item is left dangling. The last done-category status
  // cannot be deleted (a list must stay completable).
  .delete('/api/v1/ui/lists/:listId/statuses/:statusId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const list = await loadListForWrite(c, listId)
    const statuses = await ensureStatuses(c, listId, list.createdBy)
    const status = statuses.find((s) => s.id === c.req.param('statusId'))
    if (!status) throw errors.statusNotFound()

    if (isLastDoneStatus(statuses, status.id)) {
      throw errors.conflict('last_done_status', 'A list must keep at least one done status.')
    }
    if (statuses.length <= 1) {
      throw errors.conflict('last_status', 'A list must keep at least one status.')
    }

    // Fallback target: prefer another status of the same category, else the
    // first remaining status by position.
    const remaining = statuses.filter((s) => s.id !== status.id)
    const fallback =
      defaultStatusForCategory(remaining, status.category) ??
      remaining.slice().sort((a, b) => a.position - b.position)[0]!

    await c.var.repos.listStatuses.reassignItems(listId, status.id, {
      statusId: fallback.id,
      status: fallback.category,
      completed: categoryMirrorsCompleted(fallback.category).completed,
    })
    await c.var.repos.listStatuses.softDelete(status.id, new Date())
    publish(c, listChannel(listId), envelope('list_statuses', 'delete', status.id, userId))
    return c.body(null, 204)
  })
