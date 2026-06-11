import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  BulkItemActionSchema,
  CreateListItemSchema,
  UpdateListItemSchema,
  ownerTransferForMove,
  parseListQuery,
  validateCustomFields,
  validateListQuery,
  categorize,
  isCategory,
  CATEGORY_KEY,
} from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListItemRecord, ListRecord, UpdateListItemInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForRead } from './_list-access.js'
import { ITEM_SCAN_CAP, applyScanCap } from '../lib/scan-cap.js'

const TENANT = 'rallypoint'

// 30-day soft-delete window; restoring past it is a conflict (the pruner
// hard-purges the row at the boundary).
const RESTORE_GRACE_MS = 30 * 24 * 60 * 60 * 1000

function serializeItem(i: ListItemRecord): Record<string, unknown> {
  return {
    id: i.id,
    list_id: i.listId,
    title: i.title,
    notes: i.notes,
    assigned_to: i.assignedTo,
    completed: i.completed,
    completed_at: i.completedAt ? i.completedAt.toISOString() : null,
    status: i.status,
    priority: i.priority,
    due_date: i.dueDate ? i.dueDate.toISOString() : null,
    custom_fields: i.customFields,
    position: i.position,
    created_by: i.createdBy,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
    deleted_at: i.deletedAt ? i.deletedAt.toISOString() : null,
  }
}

// Load the parent list with full read-authz (#128) — 404 if missing,
// soft-deleted, owned by another app, the caller isn't a scope member,
// or the caller can't see the list under its visibility policy. Items
// are only reachable through a readable parent.
async function loadList(c: Context<HonoApp>, listId: string): Promise<ListRecord> {
  return loadListForRead(c, listId)
}

// Load an item and confirm it belongs to the parent list (Events
// "load parent then check child.parentId" convention). 404 otherwise.
// When allowDeleted is false, a soft-deleted item also 404s.
async function loadItem(
  c: Context<HonoApp>,
  listId: string,
  itemId: string,
  allowDeleted = false,
): Promise<ListItemRecord> {
  const item = await c.var.repos.listItems.findById(itemId)
  if (!item || item.listId !== listId) throw errors.itemNotFound()
  if (item.deletedAt && !allowDeleted) throw errors.itemNotFound()
  return item
}

export const listItemsRoutes = new Hono<HonoApp>()
  // --- create ------------------------------------------------------
  .post('/api/v1/ui/lists/:listId/items', async (c) => {
    const userId = c.var.session!.userId
    const list = await loadList(c, c.req.param('listId'))
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Task lists default status→'todo' and an omitted priority→'medium'
    // (port of festival-planner taskCreateDefaults), while an explicit
    // priority:null persists as no-priority. Non-task lists ignore any
    // client-supplied task fields — the columns are task-only and stay
    // null until a later slice owns them.
    const isTasks = list.listType === 'tasks'

    // Strip the reserved `rp:category` key BEFORE validateCustomFields —
    // it is not a field-def id so the validator would reject it. Handled
    // separately below (shopping auto-categorization).
    const rawCf = body.customFields ?? {}
    const clientCategory = rawCf[CATEGORY_KEY]
    const userFields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawCf)) {
      if (k !== CATEGORY_KEY) userFields[k] = v
    }

    // Validate any custom-field values against the list's active field
    // defs. On a v1 list (no defs) this is `validateCustomFields([], {})`
    // → no-op, so v1 behaviour is unchanged. `required` is enforced here:
    // a create that omits a required field's value is rejected.
    const defs = await c.var.repos.fieldDefs.listForList(list.id)
    const cf = validateCustomFields(defs, userFields)
    if (!cf.ok) throw errors.validation({ issues: cf.issues })

    // Shopping lists: auto-assign category under the reserved system key
    // `rp:category` AFTER validateCustomFields (parity with sdk-writes).
    const persistedFields: Record<string, unknown> = { ...cf.values }
    if (list.listType === 'shopping') {
      if (isCategory(clientCategory)) {
        persistedFields[CATEGORY_KEY] = clientCategory
      } else {
        persistedFields[CATEGORY_KEY] = categorize(body.title)
      }
    }

    const item = await c.var.repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId: TENANT,
      listId: list.id,
      title: body.title,
      notes: body.notes ?? null,
      assignedTo: body.assignedTo ?? null,
      status: isTasks ? (body.status ?? 'todo') : null,
      // body.priority is already resolved: schema default('medium') fills
      // undefined → 'medium'; explicit null passes through as null (no-priority).
      // The old `body.priority ?? 'medium'` would coerce null→'medium', so use
      // direct assignment — the schema guarantee covers the default.
      priority: isTasks ? body.priority : null,
      dueDate: isTasks && body.dueDate != null ? new Date(body.dueDate) : null,
      customFields: persistedFields,
      position: body.position,
      createdBy: userId,
    })
    publish(c, listChannel(list.id), envelope('list_items', 'create', item.id, userId))
    return c.json(serializeItem(item), 201)
  })

  // --- bulk action (Lists v2 slice 6) ------------------------------
  // POST /lists/:listId/items/bulk — apply one action (update | delete)
  // across a set of items in a single repo transaction, emitting ONE
  // coalesced realtime frame. Authz matches single-item mutation
  // (loadListForRead + membership — any reader can mutate items, NOT the
  // creator-guard). Ids outside this list (or already soft-deleted) are
  // silently skipped server-side. The response carries the ids actually
  // affected so the client can reconcile its selection.
  .post('/api/v1/ui/lists/:listId/items/bulk', async (c) => {
    const userId = c.var.session!.userId
    const list = await loadList(c, c.req.param('listId'))
    const parsed = BulkItemActionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    if (body.action === 'delete') {
      const ids = await c.var.repos.listItems.bulkSoftDelete(list.id, body.itemIds, new Date())
      if (ids.length > 0) {
        publish(c, listChannel(list.id), envelope('list_items', 'delete', list.id, userId))
      }
      return c.json({ count: ids.length, ids })
    }

    // action === 'update'. Map the bulk patch to a repo patch; task-only
    // fields apply only on task lists (parity with the single-item PATCH).
    const isTasks = list.listType === 'tasks'
    const base: UpdateListItemInput = {}
    if (body.patch.completed !== undefined) base.completed = body.patch.completed
    if (body.patch.assignedTo !== undefined) base.assignedTo = body.patch.assignedTo
    if (isTasks && body.patch.status !== undefined) base.status = body.patch.status
    if (isTasks && body.patch.priority !== undefined) base.priority = body.patch.priority
    if (isTasks && body.patch.dueDate !== undefined)
      base.dueDate = body.patch.dueDate === null ? null : new Date(body.patch.dueDate)

    const hasBase = Object.keys(base).length > 0
    const cfPatch = body.patch.customFields
    const hasCustom = cfPatch !== undefined && Object.keys(cfPatch).length > 0

    // Nothing survived mapping (e.g. task-only fields sent to a non-task
    // list, with no custom-field change): no-op, touch nothing.
    if (!hasBase && !hasCustom) return c.json({ count: 0, ids: [] })

    // Resolve the live, in-list targets once (excludes soft-deleted +
    // cross-list ids). The repo re-scopes too; this also gives us each
    // item's existing custom_fields for the per-item merge.
    const live = await c.var.repos.listItems.listForList(list.id)
    const byId = new Map(live.map((i) => [i.id, i]))

    const defs = hasCustom ? await c.var.repos.fieldDefs.listForList(list.id) : []
    const activeIds = new Set(defs.map((d) => d.id))

    // Build a per-item patch. For custom fields, merge the bulk patch onto
    // each item's existing values (a `null` clears that key) then validate
    // the FINAL intended state per item so `required` holds row-by-row. A
    // bad value on ANY item throws before any write — the batch is
    // all-or-nothing (the repo runs the updates in one transaction).
    const isShopping = list.listType === 'shopping'

    // Hoist cfPatch-derived values out of the per-item loop — they depend only
    // on the loop-invariant cfPatch, not on any individual item.
    const clientCategory = hasCustom ? cfPatch![CATEGORY_KEY] : undefined
    const userCfPatch: Record<string, unknown> = {}
    if (hasCustom) {
      for (const [k, v] of Object.entries(cfPatch!)) {
        if (k !== CATEGORY_KEY) userCfPatch[k] = v
      }
    }

    const items: { id: string; fields: UpdateListItemInput }[] = []
    for (const id of body.itemIds) {
      const item = byId.get(id)
      if (!item) continue
      const fields: UpdateListItemInput = { ...base }
      if (hasCustom) {
        // Strip rp:category from the client patch before validateCustomFields —
        // it is a reserved system key (not a field-def id) and the validator
        // would reject it. Handled separately below (shopping re-carry).
        // (clientCategory and userCfPatch are hoisted above the loop.)

        const intended: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(item.customFields)) {
          if (activeIds.has(k)) intended[k] = v
        }
        for (const [k, v] of Object.entries(userCfPatch)) {
          if (v === null) delete intended[k]
          else intended[k] = v
        }
        const cf = validateCustomFields(defs, intended)
        if (!cf.ok) throw errors.validation({ issues: cf.issues })
        fields.customFields = { ...cf.values }

        // Shopping lists: re-carry the per-item existing rp:category so it
        // is not silently dropped by the activeIds filter above (which only
        // retains field-def ids). If the client also supplied an explicit
        // category in this patch, honour it (overrides existing); otherwise
        // keep whatever the item already had. Non-shopping lists: no-op.
        if (isShopping) {
          const existingCategory = item.customFields[CATEGORY_KEY]
          if (isCategory(existingCategory)) {
            fields.customFields[CATEGORY_KEY] = existingCategory
          }
          if (isCategory(clientCategory)) {
            fields.customFields[CATEGORY_KEY] = clientCategory
          }
        }
      } else if (isShopping) {
        // No custom-field patch from the client — base-only bulk update.
        // The repo only writes columns present in `fields`; since
        // customFields is absent, D1 will keep the stored value. Nothing
        // to do: the re-carry is implicit when customFields is not set.
      }
      items.push({ id, fields })
    }

    const ids = await c.var.repos.listItems.bulkUpdate(list.id, items)
    if (ids.length > 0) {
      publish(c, listChannel(list.id), envelope('list_items', 'update', list.id, userId))
    }
    return c.json({ count: ids.length, ids })
  })

  // --- list --------------------------------------------------------
  .get('/api/v1/ui/lists/:listId/items', async (c) => {
    const list = await loadList(c, c.req.param('listId'))
    // Filter/sort (Lists v2 slice 4): repeatable `filter`/`sort` query
    // params, parsed then validated against the list's active defs so no
    // raw field name reaches the query builder. Stale/invalid specs are
    // dropped rather than rejected (tolerant of deleted-field drift).
    const query = parseListQuery(c.req.queries('filter') ?? [], c.req.queries('sort') ?? [])
    const defs = await c.var.repos.fieldDefs.listForList(list.id)
    const { filters, sort } = validateListQuery(query, defs)
    // Fetch CAP+1 to detect (without scanning unbounded) whether the list
    // exceeds the cap; `applyScanCap` trims to CAP and flags truncation.
    const rows = await c.var.repos.listItems.listForList(list.id, {
      filters,
      sort,
      limit: ITEM_SCAN_CAP + 1,
    })
    const { items, truncated } = applyScanCap(rows, ITEM_SCAN_CAP)
    if (truncated) {
      c.var.logger.warn(
        { listId: list.id, cap: ITEM_SCAN_CAP, filterCount: filters.length },
        'list items scan hit the cap; results truncated',
      )
    }
    return c.json({ items: items.map(serializeItem), filter_truncated: truncated })
  })

  // --- update (check-off / edit / reorder / assign / move) ---------
  .patch('/api/v1/ui/lists/:listId/items/:itemId', async (c) => {
    const list = await loadList(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'))
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const data = parsed.data

    // A cross-list move only counts when the target differs from the
    // current parent (PATCH-ing the same listId is a no-op).
    const isMove = data.listId !== undefined && data.listId !== list.id
    const isTasks = list.listType === 'tasks'

    // Map the validated body to the repo patch. dueDate arrives as an ISO
    // string and is cast to a Date for the timestamptz column. Task-only
    // fields are applied only on task lists.
    const patch: UpdateListItemInput = {}
    if (data.title !== undefined) patch.title = data.title
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo
    if (data.completed !== undefined) patch.completed = data.completed
    if (isTasks && data.status !== undefined) patch.status = data.status
    if (isTasks && data.priority !== undefined) patch.priority = data.priority
    if (isTasks && data.dueDate !== undefined)
      patch.dueDate = data.dueDate === null ? null : new Date(data.dueDate)
    // A position is honoured only when staying put; a move always
    // re-appends at the target's end (the repo computes max+1).
    if (data.position !== undefined && !isMove) patch.position = data.position

    // Custom-field values: a same-list PATCH merges onto the item's
    // existing values (a `null` value clears that key), then validates the
    // FINAL intended state against the list's active defs so `required` is
    // enforced on the result, not the partial patch. Existing values for
    // now-deleted defs are dropped before merging (they can't be
    // re-validated and would orphan). A cross-list move skips this — the
    // move branch below clears custom_fields wholesale (defs are per-list).
    // An empty `{}` patch can't change anything (and the stored state was
    // already validated when set), so skip it to avoid a no-op write.
    // Shopping lists: `rp:category` is a system-reserved key — separate it
    // from user-defined custom fields before validateCustomFields (which
    // rejects unknown keys) and re-merge after (parity with sdk-writes).
    if (data.customFields !== undefined && !isMove && Object.keys(data.customFields).length > 0) {
      const defs = await c.var.repos.fieldDefs.listForList(list.id)
      const activeIds = new Set(defs.map((d) => d.id))

      const categoryPatch = data.customFields[CATEGORY_KEY]
      const userFields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data.customFields)) {
        if (k !== CATEGORY_KEY) userFields[k] = v
      }

      const intended: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item.customFields)) {
        if (activeIds.has(k)) intended[k] = v
      }
      for (const [k, v] of Object.entries(userFields)) {
        if (v === null) delete intended[k]
        else intended[k] = v
      }

      // Note: if a required field def is later added to the list AFTER item
      // creation, a rp:category-only PATCH (empty userFields + empty intended)
      // skips validateCustomFields and doesn't re-enforce the required field.
      // Acceptable for v1 shopping lists (no field defs expected).
      if (Object.keys(userFields).length > 0 || Object.keys(intended).length > 0) {
        const cf = validateCustomFields(defs, intended)
        if (!cf.ok) throw errors.validation({ issues: cf.issues })
        patch.customFields = { ...cf.values }
      } else {
        patch.customFields = {}
      }

      if (list.listType === 'shopping') {
        const existingCategory = item.customFields[CATEGORY_KEY]
        if (isCategory(existingCategory)) {
          patch.customFields[CATEGORY_KEY] = existingCategory
        }
        if (isCategory(categoryPatch)) {
          patch.customFields[CATEGORY_KEY] = categoryPatch
        } else if (categoryPatch === null) {
          patch.customFields[CATEGORY_KEY] = categorize(
            (patch.title !== undefined ? patch.title : item.title),
          )
        }
      }
    }

    // Cross-list move: validate the target list, then port ownership-on-
    // move (move to a private list reassigns created_by to its owner).
    if (isMove) {
      const target = await loadList(c, data.listId!)
      patch.listId = target.id
      const newOwner = ownerTransferForMove({
        visibility: target.visibility,
        createdBy: target.createdBy,
      })
      if (newOwner !== null) patch.createdBy = newOwner
      // Task columns are task-only: moving into a non-task list clears
      // them so the "other types leave them NULL" invariant holds.
      if (target.listType !== 'tasks') {
        patch.status = null
        patch.priority = null
        patch.dueDate = null
      }
      // Field defs are per-list, so the moved item's values would
      // reference defs absent in the target — clear them (same precedent
      // as the task-column clearing above).
      patch.customFields = {}
    }

    // Nothing survived mapping (e.g. a self-move, or task-only fields sent
    // to a non-task list): return the item untouched rather than bumping
    // updated_at on a no-op write.
    if (Object.keys(patch).length === 0) return c.json(serializeItem(item))

    const updated = await c.var.repos.listItems.update(c.req.param('itemId'), patch)
    if (!updated) throw errors.itemNotFound()
    const userId = c.var.session!.userId
    publish(c, listChannel(list.id), envelope('list_items', 'update', updated.id, userId))
    // A move leaves the source list and joins the target; the target's
    // viewers need the new item, the source's need it gone.
    if (isMove) {
      publish(c, listChannel(patch.listId!), envelope('list_items', 'update', updated.id, userId))
    }
    return c.json(serializeItem(updated))
  })

  // --- soft-delete -------------------------------------------------
  .delete('/api/v1/ui/lists/:listId/items/:itemId', async (c) => {
    const list = await loadList(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'))
    await c.var.repos.listItems.softDelete(item.id, new Date())
    publish(c, listChannel(list.id), envelope('list_items', 'delete', item.id, c.var.session!.userId))
    return c.body(null, 204)
  })

  // --- restore (within the 30-day grace window) --------------------
  .post('/api/v1/ui/lists/:listId/items/:itemId/restore', async (c) => {
    const list = await loadList(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'), true)
    if (!item.deletedAt) {
      throw errors.conflict('item_not_deleted', 'Item is not deleted.')
    }
    if (Date.now() - item.deletedAt.getTime() > RESTORE_GRACE_MS) {
      throw errors.conflict('item_purge_window_elapsed', 'Restore window has elapsed.')
    }
    await c.var.repos.listItems.restore(item.id)
    const fresh = await c.var.repos.listItems.findById(item.id)
    publish(c, listChannel(list.id), envelope('list_items', 'create', item.id, c.var.session!.userId))
    return c.json(serializeItem(fresh ?? item))
  })
